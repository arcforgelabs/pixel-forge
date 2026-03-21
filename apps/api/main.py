"""
Pixel Forge API Backend

Routes screenshot bootstrap and live-edit requests through Claude Code CLI
to use subscription billing instead of raw API credits.
"""

import asyncio
import base64
import io
import json
import math
import mimetypes
import os
import re
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode

from agent_deck_bridge import (
    AgentDeckBridgeError,
    AgentDeckDeleteAssessment,
    AgentDeckSessionTarget,
    assess_agent_deck_delete_state,
    create_agent_deck_session_target,
    delete_agent_deck_session_target,
    get_agent_deck_session_activity,
    get_last_output,
    ensure_agent_deck_session,
    launch_agent_deck_closeout_session,
    list_project_agent_deck_sessions,
    list_live_editor_agent_deck_sessions,
    send_agent_deck_prompt_reliably,
    rename_agent_deck_session_target,
    stream_claude_jsonl,
    stream_codex_session_output,
    wait_for_agent_deck_turn_completion,
)
from acpx_bridge import AcpxBridgeError, prompt_acpx_session
from desktop_dialogs import DirectoryBrowseError, browse_for_directory
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect
from live_editor_threads import (
    detach_missing_agent_deck_thread_bindings,
    delete_live_editor_thread,
    get_live_editor_thread,
    get_or_create_live_editor_thread,
    update_live_editor_thread,
)
from project_store import (
    detach_missing_agent_deck_session_bindings,
    delete_project,
    ensure_state_store_initialized,
    get_profile_state,
    delete_session,
    get_project_session,
    list_project_sessions,
    list_project_urls,
    list_projects,
    project_name_for_path,
    touch_project_url,
    update_session_title,
    upsert_project,
    upsert_profile_state,
    upsert_session,
)
from project_chats import (
    find_project_chat_by_agent_deck_session_id,
    find_project_chat_by_thread_id,
    reconcile_project_chats,
)
from pydantic import BaseModel
from PIL import Image
from moviepy import VideoFileClip
from request_packs import create_request_pack, extract_requested_skills, normalize_requested_skills
from skill_registry import load_skill_registry_snapshot
from browser_preview import MANAGED_BROWSER_PREVIEW, resolve_preview_mode
from controller_update_state import (
    clear_pending_controller_update,
    read_pending_controller_update,
    write_pending_controller_update,
)
from published_update_state import (
    clear_pending_preview_update,
    read_latest_pending_preview_update,
    write_pending_preview_update,
)
from runtime_version import read_runtime_info
from local_targets import (
    list_pixel_forge_targets,
    serialize_local_target,
    start_pixel_forge_target,
)
from runtime_config import api_port as runtime_api_port

from session_manager import (
    generate_session_id,
    is_session_active,
    mark_session_active,
)

# Video processing settings
TARGET_NUM_FRAMES = 16  # Extract up to 16 frames from video
GRID_COLS = 4  # 4 columns in the frame grid
FRAME_WIDTH = 480  # Width of each frame in the grid (larger = better quality)
LIVE_EDITOR_AGENT_COMPLETION_TIMEOUT_SECONDS = 60 * 60
LIVE_EDITOR_AGENT_STATUS_HEARTBEAT_INTERVAL_SECONDS = 20.0
INFORMATIONAL_REQUEST_HINTS = (
    "what is",
    "what's",
    "what element",
    "which element",
    "tell me what",
    "tell me about",
    "describe",
    "identify",
    "explain",
    "share a screenshot",
    "show me a screenshot",
)
MUTATING_REQUEST_HINTS = (
    "change",
    "edit",
    "update",
    "modify",
    "fix",
    "make ",
    "make it",
    "add ",
    "remove",
    "delete",
    "replace",
    "implement",
    "refactor",
    "rename",
    "restyle",
    "move ",
)


def _format_elapsed_duration(elapsed_seconds: float) -> str:
    total_seconds = max(0, int(elapsed_seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)

    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


async def _emit_live_editor_wait_heartbeat(
    websocket: WebSocket,
    *,
    tool: str,
    wait_task: asyncio.Task[None],
    interval_seconds: float = LIVE_EDITOR_AGENT_STATUS_HEARTBEAT_INTERVAL_SECONDS,
) -> None:
    loop = asyncio.get_running_loop()
    started_at = loop.time()
    tool_label = (tool or "agent").strip().capitalize() or "Agent"

    while not wait_task.done():
        await asyncio.sleep(interval_seconds)
        if wait_task.done():
            return
        try:
            await websocket.send_json(
                {
                    "type": "status",
                    "message": (
                        f"{tool_label} is still working in Agent Deck... "
                        f"{_format_elapsed_duration(loop.time() - started_at)} elapsed."
                    ),
                }
            )
        except Exception:
            return


def extract_video_frames(video_data_url: str) -> list[Image.Image]:
    """Extract frames from a base64-encoded video."""
    # Decode the base64 URL to get the video bytes
    video_encoded_data = video_data_url.split(",")[1]
    video_bytes = base64.b64decode(video_encoded_data)

    mime_type = video_data_url.split(";")[0].split(":")[1]
    suffix = mimetypes.guess_extension(mime_type)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as temp_video_file:
        temp_video_file.write(video_bytes)
        temp_video_file.flush()

        clip = VideoFileClip(temp_video_file.name)
        images: list[Image.Image] = []
        # moviepy 2.x uses n_frames on clip, not reader.nframes
        total_frames = clip.n_frames if clip.n_frames else int(clip.duration * clip.fps)

        # Calculate frame skip interval
        frame_skip = max(1, math.ceil(total_frames / TARGET_NUM_FRAMES))

        for i, frame in enumerate(clip.iter_frames()):
            if i % frame_skip == 0:
                frame_image = Image.fromarray(frame)
                images.append(frame_image)
                if len(images) >= TARGET_NUM_FRAMES:
                    break

        clip.close()
        return images


def create_frame_grid(frames: list[Image.Image]) -> Image.Image:
    """Create a grid/mosaic image from video frames."""
    if not frames:
        raise ValueError("No frames to create grid from")

    # Resize frames to consistent width while maintaining aspect ratio
    resized_frames = []
    for frame in frames:
        aspect_ratio = frame.height / frame.width
        new_height = int(FRAME_WIDTH * aspect_ratio)
        resized = frame.resize((FRAME_WIDTH, new_height), Image.Resampling.LANCZOS)
        resized_frames.append(resized)

    # Calculate grid dimensions
    num_frames = len(resized_frames)
    num_cols = min(GRID_COLS, num_frames)
    num_rows = math.ceil(num_frames / num_cols)

    # Get max frame height for consistent row heights
    max_height = max(f.height for f in resized_frames)

    # Create the grid image
    grid_width = num_cols * FRAME_WIDTH
    grid_height = num_rows * max_height
    grid_image = Image.new("RGB", (grid_width, grid_height), color=(30, 30, 30))

    # Paste frames into grid
    for idx, frame in enumerate(resized_frames):
        row = idx // num_cols
        col = idx % num_cols
        x = col * FRAME_WIDTH
        y = row * max_height
        # Center frame vertically in its cell
        y_offset = (max_height - frame.height) // 2
        grid_image.paste(frame, (x, y + y_offset))

    return grid_image


def process_video_to_image(video_data_url: str) -> str:
    """Process video into a grid image and save to temp file."""
    print("Extracting frames from video...", flush=True)
    frames = extract_video_frames(video_data_url)
    print(f"Extracted {len(frames)} frames", flush=True)

    print("Creating frame grid...", flush=True)
    grid_image = create_frame_grid(frames)

    # Save grid to temp file
    fd, path = tempfile.mkstemp(suffix=".jpg")
    with os.fdopen(fd, "wb") as f:
        grid_image.save(f, format="JPEG", quality=90)

    print(f"Saved frame grid to: {path}")
    return path


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^https?://((?:[a-z0-9-]+\.)?localhost|127\.0\.0\.1)(?::\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Built frontend serving (production mode)
# When apps/web/dist exists, serve the built React app from the backend.
# All API/WS routes registered below take priority; unmatched GETs fall
# through to the SPA index.html via StaticFiles(html=True).
# ---------------------------------------------------------------------------
from pathlib import Path

_FRONTEND_DIST_OVERRIDE = os.environ.get("PIXEL_FORGE_FRONTEND_DIST")
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
_INSTALLED_DIST = Path(__file__).resolve().parent / "frontend"
_SERVING_FRONTEND = False
_FRONTEND_DIST_CANDIDATES: list[Path] = []

if _FRONTEND_DIST_OVERRIDE:
    _FRONTEND_DIST_CANDIDATES.append(Path(_FRONTEND_DIST_OVERRIDE).expanduser().resolve())
_FRONTEND_DIST_CANDIDATES.extend((_INSTALLED_DIST, _FRONTEND_DIST))

for _dist_candidate in _FRONTEND_DIST_CANDIDATES:
    if (_dist_candidate / "index.html").is_file():
        # Serve sub-asset directories explicitly so they take priority over
        # the catch-all proxy router, which would otherwise eat these paths.
        for _subdir in ("assets", "favicon", "brand"):
            _subdir_path = _dist_candidate / _subdir
            if _subdir_path.is_dir():
                app.mount(
                    f"/{_subdir}",
                    StaticFiles(directory=str(_subdir_path)),
                    name=f"frontend-{_subdir}",
                )

        @app.get("/")
        async def serve_frontend_index():
            response = FileResponse(
                str(_dist_candidate / "index.html"),
                media_type="text/html",
            )
            response.headers["Cache-Control"] = "no-store"
            return response

        _SERVING_FRONTEND = True
        print(f"[pixel-forge] Serving built frontend from {_dist_candidate}")
        break

if not _SERVING_FRONTEND:
    print("[pixel-forge] No built frontend found — run 'pnpm build' in apps/web/ or use start-dev.sh")


# Static file routes for testing - MUST be registered before catch-all proxy router
@app.get("/test-harness.html")
async def serve_test_harness():
    """Serve the test harness HTML file."""
    return FileResponse("test-harness.html", media_type="text/html")


# Mount test-app as static files - MUST be registered before catch-all proxy router
app.mount("/test-app", StaticFiles(directory="test-app", html=True), name="test-app")


# Import app proxy router and session helpers
# NOTE: Router inclusion moved to end of file - catch-all route must be last!
from app_proxy import (
    PROXY_SESSION_COOKIE,
    PROXY_SESSION_TTL_SECONDS,
    clear_proxy_session,
    configure_proxy_target,
    get_proxy_target_url,
    router as app_proxy_router,
)


# Pydantic models for API
class AppProxyConfig(BaseModel):
    target_url: str | None = None
    url: str | None = None
    session_id: str | None = None


class BrowseDirectoryRequest(BaseModel):
    initial_path: str | None = None


class SaveCodeRequest(BaseModel):
    code: str
    project_path: str
    file_path: str | None = None  # Default: .pixel-forge/generated/{filename based on stack}
    stack: str = "html_tailwind"


class ProjectRequest(BaseModel):
    path: str
    name: str | None = None
    output_mode: Literal["scratch", "custom"] = "scratch"
    custom_output_path: str | None = None


class ProjectUrlRequest(BaseModel):
    url: str


class ProjectSessionUpsertRequest(BaseModel):
    thread_id: str
    backend: str = "agent-deck"
    workspace_path: str | None = None
    agent_deck_session_id: str | None = None
    agent_deck_session_title: str | None = None
    agent_deck_tool: str | None = None
    editor_state: dict[str, object] | None = None


class ProfileStateRequest(BaseModel):
    profile_id: str | None = None
    active_project_path: str | None = None
    active_mode: Literal["screenshot", "live-editor"] = "screenshot"
    active_live_editor_thread_id: str | None = None
    default_agent_type: Literal["claude", "codex"] = "claude"


class AgentDeckSessionRequest(BaseModel):
    agent_type: str = "claude"
    title: str | None = None
    workspace_mode: Literal["clone", "root"] = "clone"


class ChatItemRenameRequest(BaseModel):
    thread_id: str | None = None
    agent_deck_session_id: str | None = None
    title: str


class ChatItemDeleteRequest(BaseModel):
    thread_id: str | None = None
    agent_deck_session_id: str | None = None
    force_clone_remove: bool = False


class ChatItemCloseoutRequest(BaseModel):
    thread_id: str | None = None
    agent_deck_session_id: str | None = None
    tool: str = "codex"
    prompt: str | None = None


class LivePreviewLoadRequest(BaseModel):
    target_url: str
    proxy_session_id: str | None = None
    browser_tab_id: str | None = None
    preferred_mode: Literal["auto", "proxy", "browser"] = "auto"


class AppliedSelectionRequest(BaseModel):
    id: str
    xpath: str
    selectorKind: Literal["dom", "region"] = "dom"
    surfaceKind: str = "dom"
    pageKey: str = ""
    globalIndex: int
    tagName: str
    elementId: str | None = None
    classList: list[str] = []
    textSample: str = ""
    rootXPath: str | None = None
    rootTagName: str | None = None
    rootElementId: str | None = None
    rootClassList: list[str] = []
    region: dict[str, float] | None = None


class BrowserPreviewCommandRequest(BaseModel):
    browser_tab_id: str
    action: Literal[
        "focus",
        "set_select_mode",
        "clear",
        "deselect",
        "apply",
        "refresh",
    ]
    enabled: bool | None = None
    selectionId: str | None = None
    xpath: str | None = None
    xpaths: list[str] | None = None
    selections: list[AppliedSelectionRequest] | None = None


class LocalTargetStartRequest(BaseModel):
    project_path: str
    runtime_kind: Literal["mirror", "dev"] = "mirror"
    force_restart: bool = True
    source_root: str | None = None


class PendingControllerUpdateRequest(BaseModel):
    project_path: str
    preview_url: str | None = None
    active_mode: Literal["live-editor", "screenshot"] | None = None
    summary: str | None = None
    source: str | None = None
    request_id: str | None = None
    commit_hash: str | None = None
    git_ref: str | None = None
    allow_noncanonical_project: bool = False


class PendingPreviewUpdateRequest(BaseModel):
    project_path: str
    workspace_path: str
    preview_url: str | None = None
    active_mode: Literal["live-editor", "screenshot"] | None = None
    summary: str | None = None
    source: str | None = None
    request_id: str | None = None
    agent_deck_session_id: str | None = None


# Stack to file extension mapping
STACK_EXTENSIONS = {
    "html_tailwind": (".html", "index.html"),
    "html_css": (".html", "index.html"),
    "bootstrap": (".html", "index.html"),
    "ionic_tailwind": (".html", "index.html"),
    "react_tailwind": (".tsx", "Component.tsx"),
    "vue_tailwind": (".vue", "Component.vue"),
    "svg": (".svg", "graphic.svg"),
}


def normalize_project_path(project_path: str) -> str:
    return os.path.abspath(os.path.expanduser(project_path))


def resolve_project_file_path(project_path: str, rel_path: str) -> tuple[str, str]:
    normalized_project_path = normalize_project_path(project_path)
    normalized_rel_path = rel_path.strip().lstrip("/")

    if not normalized_rel_path:
        raise ValueError("File path cannot be empty")

    if os.path.isabs(rel_path):
        raise ValueError("File path must be relative to the workspace")

    full_path = os.path.abspath(
        os.path.join(normalized_project_path, normalized_rel_path)
    )

    if os.path.commonpath([normalized_project_path, full_path]) != normalized_project_path:
        raise ValueError("Invalid file path: path traversal not allowed")

    return normalized_rel_path, full_path


def serialize_project_url(url_record) -> dict[str, object]:
    return {
        "url": url_record.url,
        "last_used": url_record.last_used,
        "use_count": url_record.use_count,
    }


def serialize_project(project_record) -> dict[str, object]:
    return {
        "path": project_record.path,
        "name": project_record.name,
        "output_mode": project_record.output_mode,
        "custom_output_path": project_record.custom_output_path,
        "created_at": project_record.created_at,
        "last_opened": project_record.last_opened,
        "urls": [serialize_project_url(url_record) for url_record in project_record.urls],
    }


def serialize_session(session_record) -> dict[str, object]:
    return {
        "id": session_record.id,
        "project_path": session_record.project_path,
        "workspace_path": session_record.workspace_path,
        "thread_id": session_record.thread_id,
        "backend": session_record.backend,
        "agent_deck_session_id": session_record.agent_deck_session_id,
        "agent_deck_session_title": session_record.agent_deck_session_title,
        "agent_deck_tool": session_record.agent_deck_tool,
        "editor_state": session_record.editor_state,
        "created_at": session_record.created_at,
        "last_active": session_record.last_active,
    }


def serialize_agent_deck_session_target(
    session_target: AgentDeckSessionTarget,
) -> dict[str, object]:
    return {
        "id": session_target.id,
        "title": session_target.title,
        "path": session_target.path,
        "group": session_target.group,
        "tool": session_target.tool,
        "command": session_target.command,
        "status": session_target.status,
        "created_at": session_target.created_at,
    }


def serialize_project_chat(chat_record) -> dict[str, object]:
    return {
        "id": chat_record.id,
        "project_path": chat_record.project_path,
        "title": chat_record.title,
        "thread_id": chat_record.thread_id,
        "workspace_path": chat_record.workspace_path,
        "backend": chat_record.backend,
        "agent_deck_session_id": chat_record.agent_deck_session_id,
        "agent_deck_session_title": chat_record.agent_deck_session_title,
        "agent_deck_tool": chat_record.agent_deck_tool,
        "agent_deck_session_status": chat_record.agent_deck_session_status,
        "binding_state": chat_record.binding_state,
        "workspace_kind": chat_record.workspace_kind,
        "origin_kind": chat_record.origin_kind,
        "created_at": chat_record.created_at,
        "last_active": chat_record.last_active,
    }


def serialize_profile_state(profile_state) -> dict[str, object]:
    return {
        "profile_id": profile_state.profile_id,
        "active_project_path": profile_state.active_project_path,
        "active_mode": profile_state.active_mode,
        "active_live_editor_thread_id": profile_state.active_live_editor_thread_id,
        "default_agent_type": profile_state.default_agent_type,
        "updated_at": profile_state.updated_at,
    }


def _resolve_chat_item_context(
    project_path: str,
    *,
    thread_id: str | None,
    agent_deck_session_id: str | None,
) -> tuple[str, str | None, object | None, object | None, str | None]:
    normalized_project_path = normalize_project_path(project_path)
    normalized_thread_id = thread_id.strip() if isinstance(thread_id, str) and thread_id.strip() else None
    session_record = (
        get_project_session(normalized_project_path, normalized_thread_id)
        if normalized_thread_id
        else None
    )
    thread_record = (
        get_live_editor_thread(normalized_thread_id)
        if normalized_thread_id
        else None
    )

    if thread_record is not None and thread_record.project_path != normalized_project_path:
        raise HTTPException(status_code=404, detail="Chat thread does not belong to this project")

    resolved_agent_deck_session_id = (
        agent_deck_session_id.strip()
        if isinstance(agent_deck_session_id, str) and agent_deck_session_id.strip()
        else None
    )
    if not resolved_agent_deck_session_id and session_record is not None:
        resolved_agent_deck_session_id = session_record.agent_deck_session_id
    if not resolved_agent_deck_session_id and thread_record is not None:
        resolved_agent_deck_session_id = thread_record.agent_deck_session_id

    return (
        normalized_project_path,
        normalized_thread_id,
        session_record,
        thread_record,
        resolved_agent_deck_session_id,
    )


def _thread_has_activity(thread_record: object | None) -> bool:
    last_request_id = getattr(thread_record, "last_request_id", None)
    return isinstance(last_request_id, str) and bool(last_request_id.strip())


def _is_missing_agent_deck_session_error(error: BaseException | str) -> bool:
    message = str(error).lower()
    return (
        "not_found" in message
        or "not found" in message
        or "session missing" in message
    )


def _serialize_delete_assessment(
    assessment: AgentDeckDeleteAssessment,
) -> dict[str, object]:
    return {
        "session_id": assessment.session_id,
        "session_title": assessment.session_title,
        "workspace_path": assessment.workspace_path,
        "repo_root": assessment.repo_root,
        "target_branch": assessment.target_branch,
        "is_clone": assessment.is_clone,
        "is_worktree": assessment.is_worktree,
        "has_activity": assessment.has_activity,
        "requires_closeout": assessment.requires_closeout,
        "can_force_delete": assessment.can_force_delete,
        "detail": assessment.detail,
    }


async def _load_reconciled_project_chats(
    project_path: str,
    *,
    extra_visible_targets: list[AgentDeckSessionTarget] | None = None,
) -> tuple[str, list[object]]:
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    try:
        live_sessions = await list_live_editor_agent_deck_sessions(normalized_project_path)
        visible_sessions = await list_project_agent_deck_sessions(normalized_project_path)
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    visible_sessions_by_id = {session.id: session for session in visible_sessions}
    for session in extra_visible_targets or []:
        visible_sessions_by_id.setdefault(session.id, session)

    live_session_ids = {session.id for session in live_sessions}
    sessions = detach_missing_agent_deck_session_bindings(
        normalized_project_path,
        live_session_ids,
    )
    detach_missing_agent_deck_thread_bindings(
        normalized_project_path,
        live_session_ids,
    )

    chats = reconcile_project_chats(
        normalized_project_path,
        sessions=sessions,
        visible_targets=list(visible_sessions_by_id.values()),
    )
    return normalized_project_path, chats


def serialize_skill_registry_location(location: object) -> dict[str, object]:
    return {
        "id": getattr(location, "id"),
        "label": getattr(location, "label"),
        "path": getattr(location, "path"),
        "role": getattr(location, "role"),
        "target": getattr(location, "target"),
        "managed": getattr(location, "managed"),
        "exists": Path(getattr(location, "path")).expanduser().is_dir(),
    }


def serialize_registered_skill(skill: object) -> dict[str, object]:
    return {
        "name": getattr(skill, "name"),
        "description": getattr(skill, "description"),
        "source_paths": getattr(skill, "source_paths"),
        "install_paths": getattr(skill, "install_paths"),
        "installed_targets": getattr(skill, "installed_targets"),
        "installed_in_pixel_forge": getattr(skill, "installed_in_pixel_forge"),
    }


@app.get("/api/projects")
async def get_projects():
    return {"projects": [serialize_project(project) for project in list_projects()]}


@app.get("/api/profile-state")
async def get_default_profile_state():
    return serialize_profile_state(get_profile_state())


@app.post("/api/profile-state")
async def save_default_profile_state(request: ProfileStateRequest):
    return serialize_profile_state(
        upsert_profile_state(
            profile_id=request.profile_id or "default",
            active_project_path=request.active_project_path,
            active_mode=request.active_mode,
            active_live_editor_thread_id=request.active_live_editor_thread_id,
            default_agent_type=request.default_agent_type,
        )
    )


@app.post("/api/projects")
async def save_project(request: ProjectRequest):
    project = upsert_project(
        request.path,
        name=request.name or project_name_for_path(request.path),
        output_mode=request.output_mode,
        custom_output_path=request.custom_output_path,
    )
    return serialize_project(project)


@app.delete("/api/projects/{project_path:path}")
async def remove_project(project_path: str):
    deleted = delete_project(project_path)
    if not deleted:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"status": "deleted"}


@app.get("/api/projects/{project_path:path}/urls")
async def get_project_urls(project_path: str):
    return {"urls": [serialize_project_url(url) for url in list_project_urls(project_path)]}


@app.post("/api/projects/{project_path:path}/urls")
async def add_project_url(project_path: str, request: ProjectUrlRequest):
    try:
        urls = touch_project_url(project_path, request.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"urls": [serialize_project_url(url) for url in urls]}


@app.get("/api/projects/{project_path:path}/sessions")
async def get_project_sessions(project_path: str):
    return {
        "sessions": [
            serialize_session(session)
            for session in list_project_sessions(project_path)
        ]
    }


@app.get("/api/projects/{project_path:path}/chats")
async def get_project_chats(project_path: str):
    _, chats = await _load_reconciled_project_chats(project_path)

    return {
        "chats": [serialize_project_chat(chat) for chat in chats]
    }


@app.post("/api/projects/{project_path:path}/sessions")
async def upsert_project_session(project_path: str, request: ProjectSessionUpsertRequest):
    normalized_project_path = normalize_project_path(project_path)
    if not normalized_project_path.strip():
        raise HTTPException(status_code=400, detail="Project path is required")

    upsert_project(
        normalized_project_path,
        name=project_name_for_path(normalized_project_path),
    )

    try:
        thread = get_or_create_live_editor_thread(
            normalized_project_path,
            thread_id=request.thread_id,
        )
        if (
            request.workspace_path
            or request.agent_deck_session_id
            or request.agent_deck_session_title
        ):
            update_live_editor_thread(
                thread.thread_id,
                workspace_path=request.workspace_path,
                agent_deck_session_id=request.agent_deck_session_id,
                agent_deck_session_title=request.agent_deck_session_title,
            )

        session = upsert_session(
            normalized_project_path,
            thread_id=request.thread_id,
            backend=request.backend,
            workspace_path=request.workspace_path,
            agent_deck_session_id=request.agent_deck_session_id,
            agent_deck_session_title=request.agent_deck_session_title,
            agent_deck_tool=request.agent_deck_tool,
            editor_state=request.editor_state,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return serialize_session(session)


@app.get("/api/projects/{project_path:path}/agent-deck-sessions")
async def get_project_agent_deck_sessions(project_path: str):
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    try:
        live_sessions = await list_live_editor_agent_deck_sessions(normalized_project_path)
        sessions = await list_project_agent_deck_sessions(normalized_project_path)
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    live_session_ids = {session.id for session in live_sessions}
    detach_missing_agent_deck_session_bindings(
        normalized_project_path,
        live_session_ids,
    )
    detach_missing_agent_deck_thread_bindings(
        normalized_project_path,
        live_session_ids,
    )

    return {
        "sessions": [
            serialize_agent_deck_session_target(session)
            for session in sessions
        ]
    }


@app.post("/api/projects/{project_path:path}/agent-deck-sessions")
async def create_project_agent_deck_session(
    project_path: str,
    request: AgentDeckSessionRequest,
):
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    upsert_project(
        normalized_project_path,
        name=project_name_for_path(normalized_project_path),
    )

    try:
        session = await create_agent_deck_session_target(
            normalized_project_path,
            agent_type=request.agent_type,
            title=request.title,
            workspace_mode=request.workspace_mode,
        )
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return serialize_agent_deck_session_target(session)


@app.post("/api/projects/{project_path:path}/chats")
async def create_project_chat(
    project_path: str,
    request: AgentDeckSessionRequest,
):
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    upsert_project(
        normalized_project_path,
        name=project_name_for_path(normalized_project_path),
    )

    thread_id = generate_session_id(normalized_project_path)
    draft_title = request.title.strip() if request.title and request.title.strip() else f"Chat {thread_id[:8]}"

    try:
        upsert_session(
            normalized_project_path,
            thread_id=thread_id,
            backend="agent-deck",
            workspace_path=normalized_project_path,
            agent_deck_session_id=None,
            agent_deck_session_title=draft_title,
            agent_deck_tool=None,
            editor_state={
                "draftAgentType": request.agent_type,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _, chats = await _load_reconciled_project_chats(normalized_project_path)
    created_chat = find_project_chat_by_thread_id(
        chats,
        thread_id,
    )
    if created_chat is None:
        raise HTTPException(
            status_code=500,
            detail="Created chat could not be reconciled",
        )

    return serialize_project_chat(created_chat)


@app.post("/api/projects/{project_path:path}/chat-items/rename")
async def rename_project_chat_item(
    project_path: str,
    request: ChatItemRenameRequest,
):
    normalized_project_path, normalized_thread_id, session_record, thread_record, resolved_agent_deck_session_id = (
        _resolve_chat_item_context(
            project_path,
            thread_id=request.thread_id,
            agent_deck_session_id=request.agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    normalized_title = request.title.strip()
    if not normalized_title:
        raise HTTPException(status_code=400, detail="Chat title cannot be empty")

    if (
        normalized_thread_id is None
        and resolved_agent_deck_session_id is None
        and session_record is None
        and thread_record is None
    ):
        raise HTTPException(status_code=404, detail="Chat item not found")

    if resolved_agent_deck_session_id:
        try:
            await rename_agent_deck_session_target(
                normalized_project_path,
                resolved_agent_deck_session_id,
                normalized_title,
            )
        except AgentDeckBridgeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if normalized_thread_id:
        update_session_title(normalized_project_path, normalized_thread_id, normalized_title)
        if thread_record is not None:
            update_live_editor_thread(
                normalized_thread_id,
                agent_deck_session_title=normalized_title,
            )

    return {
        "status": "renamed",
        "thread_id": normalized_thread_id,
        "agent_deck_session_id": resolved_agent_deck_session_id,
        "title": normalized_title,
    }


@app.post("/api/projects/{project_path:path}/chat-items/delete")
async def delete_project_chat_item(
    project_path: str,
    request: ChatItemDeleteRequest,
):
    normalized_project_path, normalized_thread_id, session_record, thread_record, resolved_agent_deck_session_id = (
        _resolve_chat_item_context(
            project_path,
            thread_id=request.thread_id,
            agent_deck_session_id=request.agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    if (
        normalized_thread_id is None
        and resolved_agent_deck_session_id is None
        and session_record is None
        and thread_record is None
    ):
        raise HTTPException(status_code=404, detail="Chat item not found")

    assessment: AgentDeckDeleteAssessment | None = None
    if resolved_agent_deck_session_id:
        try:
            assessment = await assess_agent_deck_delete_state(
                normalized_project_path,
                resolved_agent_deck_session_id,
                thread_has_activity=_thread_has_activity(thread_record),
            )
        except AgentDeckBridgeError as exc:
            if _is_missing_agent_deck_session_error(exc):
                resolved_agent_deck_session_id = None
            else:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

        if resolved_agent_deck_session_id is None:
            assessment = None

    if resolved_agent_deck_session_id:
        if assessment is not None and assessment.requires_closeout and not request.force_clone_remove:
            return {
                "status": "requires_closeout",
                "assessment": _serialize_delete_assessment(assessment),
            }

        try:
            await delete_agent_deck_session_target(
                normalized_project_path,
                resolved_agent_deck_session_id,
                force_clone_remove=bool(
                    request.force_clone_remove
                    and assessment is not None
                    and assessment.can_force_delete
                ),
            )
        except AgentDeckBridgeError as exc:
            if _is_missing_agent_deck_session_error(exc):
                resolved_agent_deck_session_id = None
            elif assessment is not None and assessment.can_force_delete and not request.force_clone_remove:
                fallback_assessment = AgentDeckDeleteAssessment(
                    session_id=assessment.session_id,
                    session_title=assessment.session_title,
                    workspace_path=assessment.workspace_path,
                    repo_root=assessment.repo_root,
                    target_branch=assessment.target_branch,
                    is_clone=assessment.is_clone,
                    is_worktree=assessment.is_worktree,
                    has_activity=True,
                    requires_closeout=True,
                    can_force_delete=assessment.can_force_delete,
                    detail=str(exc),
                )
                return {
                    "status": "requires_closeout",
                    "assessment": _serialize_delete_assessment(fallback_assessment),
                }
            else:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

    if normalized_thread_id:
        delete_session(normalized_project_path, normalized_thread_id)
        delete_live_editor_thread(normalized_thread_id)

    return {
        "status": "deleted",
        "thread_id": normalized_thread_id,
        "agent_deck_session_id": resolved_agent_deck_session_id,
    }


@app.post("/api/projects/{project_path:path}/chat-items/closeout")
async def start_project_chat_item_closeout(
    project_path: str,
    request: ChatItemCloseoutRequest,
):
    normalized_project_path, normalized_thread_id, session_record, thread_record, resolved_agent_deck_session_id = (
        _resolve_chat_item_context(
            project_path,
            thread_id=request.thread_id,
            agent_deck_session_id=request.agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")
    if (
        normalized_thread_id is None
        and resolved_agent_deck_session_id is None
        and session_record is None
        and thread_record is None
    ):
        raise HTTPException(status_code=404, detail="Chat item not found")
    if not resolved_agent_deck_session_id:
        raise HTTPException(status_code=400, detail="Chat is not bound to an Agent Deck session")

    try:
        closeout_session = await launch_agent_deck_closeout_session(
            normalized_project_path,
            resolved_agent_deck_session_id,
            tool=request.tool,
            user_prompt=request.prompt,
        )
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "status": "started",
        "session": serialize_agent_deck_session_target(closeout_session),
    }


@app.get("/api/projects/{project_path:path}/chat-items/activity")
async def get_project_chat_item_activity(
    project_path: str,
    thread_id: str | None = None,
    agent_deck_session_id: str | None = None,
):
    normalized_project_path, normalized_thread_id, session_record, thread_record, resolved_agent_deck_session_id = (
        _resolve_chat_item_context(
            project_path,
            thread_id=thread_id,
            agent_deck_session_id=agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    if not resolved_agent_deck_session_id:
        return {
            "thread_id": normalized_thread_id,
            "agent_deck_session_id": None,
            "agent_deck_session_title": getattr(session_record, "agent_deck_session_title", None),
            "agent_deck_tool": getattr(session_record, "agent_deck_tool", None),
            "agent_deck_session_status": None,
            "workspace_path": getattr(session_record, "workspace_path", None)
            or getattr(thread_record, "workspace_path", normalized_project_path),
            "binding_state": "detached",
            "output": "",
        }

    try:
        activity = await get_agent_deck_session_activity(
            normalized_project_path,
            resolved_agent_deck_session_id,
        )
    except AgentDeckBridgeError as exc:
        if _is_missing_agent_deck_session_error(exc):
            return {
                "thread_id": normalized_thread_id,
                "agent_deck_session_id": None,
                "agent_deck_session_title": getattr(session_record, "agent_deck_session_title", None),
                "agent_deck_tool": getattr(session_record, "agent_deck_tool", None),
                "agent_deck_session_status": None,
                "workspace_path": getattr(session_record, "workspace_path", None)
                or getattr(thread_record, "workspace_path", normalized_project_path),
                "binding_state": "detached",
                "output": "",
            }
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "thread_id": normalized_thread_id,
        "agent_deck_session_id": activity.session_id,
        "agent_deck_session_title": activity.session_title,
        "agent_deck_tool": activity.tool,
        "agent_deck_session_status": activity.status,
        "workspace_path": activity.workspace_path,
        "binding_state": "attached",
        "output": activity.output,
    }


@app.get("/api/skills")
async def get_registered_skills():
    snapshot = load_skill_registry_snapshot()
    return {
        "skills": [serialize_registered_skill(skill) for skill in snapshot.skills],
        "source_roots": [
            serialize_skill_registry_location(location)
            for location in snapshot.source_roots
        ],
        "install_destinations": [
            serialize_skill_registry_location(location)
            for location in snapshot.install_destinations
        ],
    }


@app.post("/api/local-targets/pixel-forge/start")
async def start_local_pixel_forge_target(payload: LocalTargetStartRequest):
    try:
        record = await asyncio.to_thread(
            start_pixel_forge_target,
            payload.project_path,
            payload.runtime_kind,
            payload.force_restart,
            payload.source_root,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return serialize_local_target(record)


@app.get("/api/local-targets/pixel-forge")
async def list_local_pixel_forge_targets(
    project_path: str,
    runtime_kind: Literal["mirror", "dev"] = "mirror",
):
    try:
        records = await asyncio.to_thread(
            list_pixel_forge_targets,
            project_path,
            runtime_kind,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"targets": [serialize_local_target(record) for record in records]}


@app.get("/api/controller-update")
async def get_pending_controller_update():
    update = await asyncio.to_thread(read_pending_controller_update)
    return {"update": update}


@app.get("/api/runtime-info")
async def get_runtime_info():
    return await asyncio.to_thread(read_runtime_info)


@app.post("/api/controller-update")
async def stage_pending_controller_update(payload: PendingControllerUpdateRequest):
    try:
        update = await asyncio.to_thread(
            write_pending_controller_update,
            {
                "projectPath": payload.project_path,
                "previewUrl": payload.preview_url,
                "activeMode": payload.active_mode,
                "summary": payload.summary,
                "source": payload.source,
                "requestId": payload.request_id,
                "commitHash": payload.commit_hash,
                "gitRef": payload.git_ref,
                "allowNoncanonicalProject": payload.allow_noncanonical_project,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"update": update}


@app.delete("/api/controller-update")
async def delete_pending_controller_update():
    cleared = await asyncio.to_thread(clear_pending_controller_update)
    return {"ok": cleared}


@app.get("/api/preview-updates/latest")
async def get_latest_pending_preview_update(
    project_path: str,
    workspace_path: str | None = None,
    agent_deck_session_id: str | None = None,
):
    update = await asyncio.to_thread(
        read_latest_pending_preview_update,
        project_path,
        workspace_path=workspace_path,
        agent_deck_session_id=agent_deck_session_id,
    )
    return {"update": update}


@app.post("/api/preview-updates")
async def stage_pending_preview_update(payload: PendingPreviewUpdateRequest):
    try:
        update = await asyncio.to_thread(
            write_pending_preview_update,
            {
                "projectPath": payload.project_path,
                "workspacePath": payload.workspace_path,
                "previewUrl": payload.preview_url,
                "activeMode": payload.active_mode,
                "summary": payload.summary,
                "source": payload.source,
                "requestId": payload.request_id,
                "agentDeckSessionId": payload.agent_deck_session_id,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"update": update}


@app.delete("/api/preview-updates/latest")
async def delete_pending_preview_update(update_id: str):
    cleared = await asyncio.to_thread(clear_pending_preview_update, update_id)
    return {"ok": cleared}


@app.post("/browse/directory")
async def browse_directory(request: BrowseDirectoryRequest):
    """Open a native folder picker and return the selected directory."""
    try:
        selected_path = browse_for_directory(request.initial_path)
    except DirectoryBrowseError as exc:
        return {
            "success": False,
            "cancelled": False,
            "message": str(exc),
        }

    if not selected_path:
        return {
            "success": True,
            "cancelled": True,
            "path": None,
        }

    return {
        "success": True,
        "cancelled": False,
        "path": selected_path,
    }


@app.post("/save-code")
async def save_code(request: SaveCodeRequest):
    """Save generated code to a project file."""
    # Validate project path exists
    normalized_project_path = normalize_project_path(request.project_path)
    if not os.path.isdir(normalized_project_path):
        return {
            "success": False,
            "message": f"Project path does not exist: {request.project_path}",
        }

    # Determine file path
    if request.file_path:
        rel_path = request.file_path
    else:
        # Generate default path based on stack
        _, default_name = STACK_EXTENSIONS.get(
            request.stack, (".html", "index.html")
        )
        rel_path = f".pixel-forge/generated/{default_name}"

    try:
        rel_path, full_path = resolve_project_file_path(
            normalized_project_path, rel_path
        )
    except ValueError as exc:
        return {
            "success": False,
            "message": str(exc),
        }

    # Create parent directory if needed
    parent_dir = os.path.dirname(full_path)
    os.makedirs(parent_dir, exist_ok=True)

    # Write the file
    try:
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(request.code)
    except Exception as e:
        return {
            "success": False,
            "message": f"Failed to write file: {e}",
        }

    url_path = f"/preview-file?{urlencode({'project_path': normalized_project_path, 'rel_path': rel_path})}"

    return {
        "success": True,
        "file_path": full_path,
        "rel_path": rel_path,
        "url_path": url_path,
        "message": f"Saved to {rel_path}",
    }


@app.get("/preview-file")
async def preview_saved_file(project_path: str, rel_path: str):
    """Serve a saved workspace file through the Pixel Forge backend."""
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Workspace not found")

    try:
        _, full_path = resolve_project_file_path(normalized_project_path, rel_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="Saved file not found")

    media_type = mimetypes.guess_type(full_path)[0] or "text/plain"
    return FileResponse(full_path, media_type=media_type)


@app.post("/config/app-proxy")
async def configure_app_proxy(
    config: AppProxyConfig,
    request: Request,
    response: Response,
):
    """Configure the target URL for the app proxy."""
    target_url = (config.target_url or config.url or "").strip()
    if not target_url:
        raise HTTPException(status_code=422, detail="target_url is required")

    session = await configure_proxy_target(
        target_url,
        config.session_id or request.cookies.get(PROXY_SESSION_COOKIE),
    )
    response.set_cookie(
        key=PROXY_SESSION_COOKIE,
        value=session.session_id,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        max_age=PROXY_SESSION_TTL_SECONDS,
        path="/",
    )
    return {
        "status": "ok",
        "target_url": session.target_url,
        "proxy_session_id": session.session_id,
    }


@app.get("/config/app-proxy")
async def get_app_proxy_config(request: Request):
    """Get the current app proxy configuration."""
    target_url = await get_proxy_target_url(request.cookies.get(PROXY_SESSION_COOKIE))
    return {"target_url": target_url}


@app.delete("/config/app-proxy")
async def clear_app_proxy_config(
    request: Request,
    response: Response,
    session_id: str | None = None,
):
    """Clear the current browser-scoped app proxy session."""
    resolved_session_id = session_id or request.cookies.get(PROXY_SESSION_COOKIE)
    await clear_proxy_session(resolved_session_id)
    if resolved_session_id == request.cookies.get(PROXY_SESSION_COOKIE):
        response.delete_cookie(key=PROXY_SESSION_COOKIE, path="/")
    return {"status": "cleared"}


def _build_proxy_frame_src(proxy_session_id: str) -> str:
    return f"/app/s/{proxy_session_id}/?_pf_t={int(asyncio.get_running_loop().time() * 1000)}"


@app.post("/api/live-preview/load")
async def load_live_preview(
    payload: LivePreviewLoadRequest,
    request: Request,
    response: Response,
):
    target_url = payload.target_url.strip()
    if not target_url:
        raise HTTPException(status_code=422, detail="target_url is required")

    preview_mode = resolve_preview_mode(target_url, payload.preferred_mode)

    if preview_mode == "proxy":
        session = await configure_proxy_target(
            target_url,
            payload.proxy_session_id or request.cookies.get(PROXY_SESSION_COOKIE),
        )
        response.set_cookie(
            key=PROXY_SESSION_COOKIE,
            value=session.session_id,
            httponly=True,
            secure=request.url.scheme == "https",
            samesite="lax",
            max_age=PROXY_SESSION_TTL_SECONDS,
            path="/",
        )
        return {
            "mode": "proxy",
            "target_url": session.target_url,
            "proxy_session_id": session.session_id,
            "frame_src": _build_proxy_frame_src(session.session_id),
        }

    try:
        tab = await MANAGED_BROWSER_PREVIEW.load_tab(
            target_url,
            browser_tab_id=payload.browser_tab_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return await MANAGED_BROWSER_PREVIEW.tab_payload(tab.id)


@app.post("/api/live-preview/browser/command")
async def browser_preview_command(payload: BrowserPreviewCommandRequest):
    try:
        if payload.action == "focus":
            tab = await MANAGED_BROWSER_PREVIEW.focus_tab(payload.browser_tab_id)
        elif payload.action == "set_select_mode":
            tab = await MANAGED_BROWSER_PREVIEW.set_select_mode(
                payload.browser_tab_id,
                bool(payload.enabled),
            )
        elif payload.action == "clear":
            tab = await MANAGED_BROWSER_PREVIEW.clear_selections(payload.browser_tab_id)
        elif payload.action == "deselect":
            if not payload.selectionId and not payload.xpath:
                raise HTTPException(status_code=422, detail="selectionId or xpath is required")
            tab = await MANAGED_BROWSER_PREVIEW.deselect_xpath(
                payload.browser_tab_id,
                payload.selectionId or payload.xpath or "",
            )
        elif payload.action == "apply":
            tab = await MANAGED_BROWSER_PREVIEW.apply_selections(
                payload.browser_tab_id,
                [
                    {
                        "id": selection.id,
                        "selectorKind": selection.selectorKind,
                        "surfaceKind": selection.surfaceKind,
                        "pageKey": selection.pageKey,
                        "xpath": selection.xpath,
                        "globalIndex": selection.globalIndex,
                        "tagName": selection.tagName,
                        "elementId": selection.elementId,
                        "classList": selection.classList,
                        "textSample": selection.textSample,
                        "rootXPath": selection.rootXPath,
                        "rootTagName": selection.rootTagName,
                        "rootElementId": selection.rootElementId,
                        "rootClassList": selection.rootClassList,
                        "region": selection.region,
                    }
                    for selection in (payload.selections or [])
                ]
                or payload.xpaths
                or [],
            )
        elif payload.action == "refresh":
            tab = await MANAGED_BROWSER_PREVIEW.refresh_tab(payload.browser_tab_id)
        else:
            raise HTTPException(status_code=400, detail="Unsupported browser command")
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return await MANAGED_BROWSER_PREVIEW.tab_payload(tab.id)


@app.delete("/api/live-preview/browser/{browser_tab_id}")
async def close_browser_preview_tab(browser_tab_id: str):
    await MANAGED_BROWSER_PREVIEW.close_tab(browser_tab_id)
    return {"status": "closed"}


@app.get("/api/live-editor/selection-tunnel")
async def read_selection_tunnel(
    project_path: str,
    request_id: str,
    selection_id: str | None = None,
):
    tunnel_path = _selection_tunnel_file(project_path, request_id)
    payload = json.loads(tunnel_path.read_text(encoding="utf-8"))

    if selection_id:
        selections = payload.get("selections")
        if not isinstance(selections, list):
            raise HTTPException(status_code=404, detail="Selection tunnel is empty")
        selection = next(
            (
                entry
                for entry in selections
                if isinstance(entry, dict) and entry.get("id") == selection_id
            ),
            None,
        )
        if selection is None:
            raise HTTPException(status_code=404, detail="Selection not found")
        return selection

    return payload


@app.websocket("/ws/live-preview")
async def live_preview_websocket(websocket: WebSocket):
    await websocket.accept()
    queue = MANAGED_BROWSER_PREVIEW.subscribe()
    try:
        while True:
            event = await queue.get()
            await websocket.send_text(json.dumps(event))
    except Exception:
        pass
    finally:
        MANAGED_BROWSER_PREVIEW.unsubscribe(queue)


@app.on_event("startup")
async def initialize_shared_state_store():
    ensure_state_store_initialized()


@app.on_event("shutdown")
async def shutdown_managed_browser_preview():
    await MANAGED_BROWSER_PREVIEW.shutdown()


# Screenshot bootstrap prompts
SYSTEM_PROMPTS = {
    "html_tailwind": """You are an expert Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Tailwind, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "html_css": """You are an expert CSS developer
You take screenshots of a reference web page from the user, and then build single page apps
using CSS, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "react_tailwind": """You are an expert React/Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using React and Tailwind CSS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use these script to include React so that it can run on a standalone page:
    <script src="https://cdn.jsdelivr.net/npm/react@18.0.0/umd/react.development.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/react-dom@18.0.0/umd/react-dom.development.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.js"></script>
- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "bootstrap": """You are an expert Bootstrap developer
You take screenshots of a reference web page from the user, and then build single page apps
using Bootstrap, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use this script to include Bootstrap: <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "vue_tailwind": """You are an expert Vue/Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Vue and Tailwind CSS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use these script to include Vue so that it can run on a standalone page:
  <script src="https://registry.npmmirror.com/vue/3.3.11/files/dist/vue.global.js"></script>
- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "ionic_tailwind": """You are an expert Ionic/Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Ionic and Tailwind CSS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use these script to include Ionic so that it can run on a standalone page:
    <script type="module" src="https://cdn.jsdelivr.net/npm/@ionic/core/dist/ionic/ionic.esm.js"></script>
    <script nomodule src="https://cdn.jsdelivr.net/npm/@ionic/core/dist/ionic/ionic.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@ionic/core/css/ionic.bundle.css" />
- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "svg": """You are an expert at building SVGs.
You take screenshots of a reference web page from the user, and then build a SVG that looks exactly like the screenshot.

- Make sure the SVG looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.
- You can use Google Fonts

Return only the full code in <svg></svg> tags.
Do not include markdown "```" or "```svg" at the start or end.""",
}

USER_PROMPT = "Generate code for a web page that looks exactly like this."
SVG_USER_PROMPT = "Generate code for a SVG that looks exactly like this."


def extract_html_content(code: str) -> str:
    """Extract HTML content, removing markdown fences if present."""
    code = code.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        lines = lines[1:]  # Remove first line
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)
    return code.strip()


def save_base64_file(
    data_url: str,
    filename: str | None = None,
    mime_type: str | None = None,
) -> str:
    """Save a base64 data URL to a temp file, preserving a useful extension when possible."""
    if data_url.startswith("data:"):
        header, data = data_url.split(",", 1)
        # Extract mime type
        mime = header.split(":")[1].split(";")[0]
        suffix = mimetypes.guess_extension(mime) or ""
        if mime == "image/jpeg":
            suffix = ".jpg"
    else:
        # Fallback for raw base64 without a data URL header
        data = data_url
        mime = mime_type or "application/octet-stream"
        suffix = mimetypes.guess_extension(mime) or ".bin"

    if filename:
        filename_ext = os.path.splitext(filename)[1]
        if filename_ext:
            suffix = filename_ext

    if not suffix:
        suffix = mimetypes.guess_extension(mime_type or mime) or ".bin"

    # Decode and save
    file_data = base64.b64decode(data)
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(file_data)
    return path


def save_base64_image(data_url: str) -> str:
    """Backward-compatible helper for image-only paths."""
    return save_base64_file(data_url)


def _is_remote_preview(url: str | None) -> bool:
    """Return True if the preview URL points to a non-localhost target."""
    if not url:
        return False
    from urllib.parse import urlparse
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    return hostname not in {"localhost", "127.0.0.1", "::1", ""} and not hostname.endswith(".localhost")


def _is_pixel_forge_workspace(project_path: str | None) -> bool:
    if not project_path:
        return False

    project_root = Path(normalize_project_path(project_path))
    required_paths = (
        "start-dev.sh",
        "apps/api/main.py",
        "apps/web/package.json",
        "apps/desktop/package.json",
    )
    return all((project_root / relative_path).exists() for relative_path in required_paths)


def _selection_tunnel_file(project_path: str, request_id: str) -> Path:
    project_root = Path(normalize_project_path(project_path)).resolve()
    request_root = (project_root / ".pixel-forge" / "requests").resolve()
    tunnel_path = (request_root / request_id / "selection-tunnel.json").resolve()

    if os.path.commonpath([str(request_root), str(tunnel_path)]) != str(request_root):
        raise HTTPException(status_code=400, detail="Invalid request_id")

    if not tunnel_path.exists():
        raise HTTPException(status_code=404, detail="Selection tunnel not found")

    return tunnel_path


def _selection_source_summary(
    selection_tunnel: dict[str, object] | None,
) -> list[tuple[str | None, str, int]]:
    if not isinstance(selection_tunnel, dict):
        return []

    raw_selections = selection_tunnel.get("selections")
    if not isinstance(raw_selections, list):
        return []

    grouped: list[tuple[str | None, str, int]] = []
    counts: dict[tuple[str | None, str], int] = {}
    order: list[tuple[str | None, str]] = []

    for entry in raw_selections:
        if not isinstance(entry, dict):
            continue

        source_url = str(entry.get("sourceUrl") or "").strip()
        if not source_url:
            continue

        source_label_raw = entry.get("sourceTabLabel")
        source_label = (
            str(source_label_raw).strip()
            if isinstance(source_label_raw, str) and str(source_label_raw).strip()
            else None
        )
        key = (source_label, source_url)
        if key not in counts:
            counts[key] = 0
            order.append(key)
        counts[key] += 1

    for key in order:
        grouped.append((key[0], key[1], counts[key]))

    return grouped


def _is_informational_live_editor_request(message: str) -> bool:
    normalized = re.sub(r"\s+", " ", (message or "").strip().lower())
    if not normalized:
        return False

    if any(hint in normalized for hint in MUTATING_REQUEST_HINTS):
        return False

    if "screenshot" in normalized:
        return True

    return any(hint in normalized for hint in INFORMATIONAL_REQUEST_HINTS)


def _resolve_self_edit_scope(
    project_path: str | None,
    workspace_path: str | None,
) -> Literal["controller", "preview"] | None:
    normalized_project_path = normalize_project_path(project_path) if project_path else None
    normalized_workspace_path = normalize_project_path(workspace_path) if workspace_path else None
    if not normalized_project_path or not normalized_workspace_path:
        return None
    if normalized_workspace_path != normalized_project_path:
        return "preview"
    return "controller"


def _assert_agent_deck_lane_available(
    project_path: str,
    thread_id: str,
    agent_deck_session_id: str | None,
) -> None:
    normalized_agent_deck_session_id = (
        agent_deck_session_id.strip()
        if isinstance(agent_deck_session_id, str) and agent_deck_session_id.strip()
        else None
    )
    if not normalized_agent_deck_session_id:
        return

    for session in list_project_sessions(project_path):
        if session.thread_id == thread_id:
            continue
        if session.agent_deck_session_id != normalized_agent_deck_session_id:
            continue
        raise ValueError(
            "Agent Deck session "
            f"{normalized_agent_deck_session_id} is already bound to Live Editor thread "
            f"{session.thread_id}. Switch to that thread or choose a different session."
        )


def build_live_editor_dispatch_prompt(
    request_file_path: str,
    *,
    preview_url: str | None = None,
    selection_tunnel: dict[str, object] | None = None,
    selection_tunnel_url: str | None = None,
    requested_skills: list[str] | None = None,
    self_edit_safe_mode: bool = False,
    self_edit_scope: Literal["controller", "preview"] | None = None,
    continuation_mode: Literal["bootstrap", "attached-session", "delta"] = "bootstrap",
    informational_only: bool = False,
) -> str:
    normalized_requested_skills = normalize_requested_skills(requested_skills)

    if informational_only:
        if continuation_mode == "bootstrap":
            base = f"""Read `{request_file_path}` and answer that Pixel Forge request.

Start by reading the request file itself, then the referenced selected-surface artifacts.
This is an informational inspection request. Do not edit code, rebuild, restart, deploy, or reload unless the user explicitly asks.
Prefer answering directly from the captured Pixel Forge artifacts and attachments. Only inspect source if those artifacts are insufficient.
Keep the reply concise and directly answer the user's question."""
        elif continuation_mode == "attached-session":
            base = f"""Pixel Forge continuation into an already-running Agent Deck session.

Read `{request_file_path}` and the referenced artifacts for this turn.
This is the first Pixel Forge turn for an existing Agent Deck session, not a new bootstrap.
Keep the current Agent Deck session continuity and use the new Pixel Forge context for this turn.
Keep the reply concise and directly answer the user's question."""
        else:
            base = f"""New Pixel Forge turn for this existing session.

Read `{request_file_path}` and the referenced artifacts for this turn.
This is an informational delta, not a full session reboot and not a code-change request.
Prefer answering directly from the new Pixel Forge artifacts and attachments. Only inspect source if those artifacts are insufficient.
Keep the reply concise and directly answer the user's question."""
    else:
        if continuation_mode == "bootstrap":
            base = f"""Read `{request_file_path}` and complete that Pixel Forge live edit request.

Start by reading the request file itself, then read every referenced context file before changing code.
Make the smallest correct change, avoid AskUserQuestion for this request, and finish with a brief confirmation of what changed."""
        elif continuation_mode == "attached-session":
            base = f"""Pixel Forge continuation into an already-running Agent Deck session.

Read `{request_file_path}` and any context files it references.
This is the first Pixel Forge turn for an existing Agent Deck session, not a full session bootstrap.
Keep the current Agent Deck session continuity and use the new Pixel Forge context for this turn.
Make the smallest correct change, avoid AskUserQuestion for this request, and finish with a brief confirmation of what changed."""
        else:
            base = f"""New Pixel Forge turn for this existing session.

Read `{request_file_path}` and any context files it references.
Treat this request pack as the new delta for this turn, not as a full session reboot.
Assume the earlier Pixel Forge session setup and workflow constraints for this same session still apply unless this request pack overrides them.
Make the smallest correct change, avoid AskUserQuestion for this request, and finish with a brief confirmation of what changed."""

    if normalized_requested_skills:
        requested_skill_list = ", ".join(
            f"`{skill}`" for skill in normalized_requested_skills
        )
        base += f"""

This request explicitly asks for these skills: {requested_skill_list}.
Immediately after reading `{request_file_path}`, invoke each listed skill via the Skill tool before reading source code, using repo-specific tools, or making changes. Do not treat these skill requests as optional flavor text."""

    if not informational_only:
        if continuation_mode == "bootstrap":
            base += """

If you need Pixel Forge-specific CLI or tunnel workflow help beyond what the request pack already gives you, the `using-pixel-forge` skill can help."""
        else:
            base += """

If you need extra Pixel Forge-specific CLI or tunnel workflow help beyond this request pack and the existing session context, the `using-pixel-forge` skill can help."""

    if selection_tunnel_url:
        if informational_only:
            base += f"""

Use `{selection_tunnel_url}` or the `selection-tunnel.json` file referenced by the request pack if you need the frozen structured selection state for this turn.
Treat the request pack, selected-elements artifact, selection tunnel, and attachments as the primary truth for the selected live surface."""
        elif continuation_mode == "bootstrap":
            base += f"""

If you need the exact frozen selection state Pixel Forge captured, call `{selection_tunnel_url}` from the workspace, run `pixel-forge tunnel --project . --request <request-id>` if available, or read the `selection-tunnel.json` file referenced by the request pack. Do not recreate the browser path from scratch when the tunnel already gives you the selected state."""
            base += """

Treat the request pack, selected-elements artifact, and selection tunnel as authoritative evidence for the selected live surface. Do not invent runtime behavior from repo code alone when Pixel Forge already captured the relevant state. If the frozen tunnel is still insufficient to verify a claim, say that explicitly instead of guessing."""
        else:
            base += f"""

If you need the frozen selection state for this turn, use `{selection_tunnel_url}` or the `selection-tunnel.json` file referenced by the request pack."""

    selection_sources = _selection_source_summary(selection_tunnel)
    if continuation_mode != "delta" and len(selection_sources) > 1:
        source_lines = "\n".join(
            f"- {label or 'Preview'} ({count} selection{'s' if count != 1 else ''}) at {url}"
            for label, url, count in selection_sources
        )
        base += f"""

Selections span multiple preview sources. Use the grouped sources in the request pack as the source of truth for target-vs-reference context, and do not collapse them into one preview URL:
{source_lines}"""

    if continuation_mode != "delta" and self_edit_safe_mode:
        base += """

This workspace is Pixel Forge itself. Do not run `./install.sh`, `pixel-forge restart`, or any command that replaces or restarts the active Pixel Forge controller while this request is still streaming.
Make repo changes and safe verification-only checks inside the workspace."""
        if self_edit_scope == "preview":
            base += """

This is an isolated clone-backed self-edit session. Finish by stating whether the clone preview update is ready to load inside Pixel Forge preview. Do not claim that a controller update is staged or ready from this clone workspace."""
        elif self_edit_scope == "controller":
            base += """

This is the canonical Pixel Forge root. Finish by stating whether the controller update is ready to stage/load after this request completes."""

    if preview_url and continuation_mode != "delta":
        if informational_only:
            base += f"""

The active preview target for this request is {preview_url}. This request is informational only, so do not rebuild, restart, deploy, or reload unless the user explicitly asks."""
        else:
            base += f"""

The active preview target for this request is {preview_url}. If this workspace controls that target, do not stop at code changes: apply the update to that preview target and verify this exact URL/path reflects the change before you finish."""
            if self_edit_safe_mode:
                if self_edit_scope == "preview":
                    base += """

For Pixel Forge self-edit requests running in an isolated clone workspace, do not replace the active controller mid-stream. Keep the result in the preview-update lane only, and finish by stating whether the clone preview update is ready to load."""
                else:
                    base += """

For Pixel Forge self-edit requests in the canonical root, do not replace the active controller mid-stream. Use the staged controller-update flow instead, and finish by stating whether the updated controller build is ready to load."""
            elif _is_remote_preview(preview_url):
                base += """

For repo-controlled remote previews, deploy using whatever deployment process this project uses (deploy script, docker compose, CI trigger, etc.). Look in the workspace for deploy.sh, Makefile, docker-compose.yml, fly.toml, or similar."""
            else:
                base += """

For local/dev previews, rebuild, restart, or reload the service serving this URL so the preview updates in place."""

            base += """

If the preview target is external or not controlled by this workspace, state that explicitly and skip deployment or reload."""

    return base


async def _deliver_live_editor_prompt_to_agent_deck_session(
    *,
    session_info,
    websocket: WebSocket,
    dispatch_prompt: str,
) -> tuple[str, asyncio.Task[object], asyncio.Task[object] | None]:
    baseline_output = ""
    normalized_session_status = (session_info.status or "").strip().lower()
    queue_onto_busy_session = normalized_session_status not in {
        "",
        "waiting",
        "idle",
    }

    if session_info.tool == "codex":
        baseline_output = await get_last_output(session_info.agent_deck_session_id)

    await send_agent_deck_prompt_reliably(
        session_info,
        project_path=session_info.workspace_path,
        prompt=dispatch_prompt,
        no_wait=queue_onto_busy_session and session_info.tool != "claude",
    )

    tool_label = (session_info.tool or "agent").strip().capitalize() or "Agent"
    if session_info.tool == "codex":
        status_message = (
            f"Queued request to busy {tool_label} session. Waiting for completion..."
            if queue_onto_busy_session
            else f"Request delivered to {tool_label}. Waiting for completion..."
        )
    else:
        status_message = f"Request delivered to {tool_label}. Waiting for completion..."

    await websocket.send_json(
        {
            "type": "status",
            "message": status_message,
        }
    )

    turn_wait_task = asyncio.create_task(
        wait_for_agent_deck_turn_completion(
            session_info,
            completion_timeout_seconds=LIVE_EDITOR_AGENT_COMPLETION_TIMEOUT_SECONDS,
        )
    )
    status_heartbeat_task: asyncio.Task[object] | None = None
    if session_info.tool != "claude":
        status_heartbeat_task = asyncio.create_task(
            _emit_live_editor_wait_heartbeat(
                websocket,
                tool=session_info.tool,
                wait_task=turn_wait_task,
            )
        )

    return baseline_output, turn_wait_task, status_heartbeat_task


async def generate_with_claude_cli(
    image_path: str | None,
    system_prompt: str,
    user_prompt: str,
    session_id: str | None = None,
    project_path: str | None = None,
) -> tuple[str, str]:
    """
    Call Claude CLI to generate code from image.
    Returns (result, session_id).
    """
    if image_path:
        prompt = f"Read the image at {image_path} and {user_prompt}"
    else:
        prompt = user_prompt

    cmd = [
        "claude",
        "-p", prompt,
        "--system-prompt", system_prompt,
        "--dangerously-skip-permissions",
        "--tools", "Read",
        "--output-format", "json",
    ]

    # Handle session persistence
    if session_id:
        if is_session_active(session_id):
            cmd.extend(["--resume", session_id])
        else:
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path or "")
    else:
        # Generate new session if project_path provided
        if project_path:
            session_id = generate_session_id(project_path)
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path if project_path else None,
    )

    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode())
    return result.get("result", ""), session_id or ""


async def generate_update_with_claude_cli(
    system_prompt: str,
    current_code: str,
    update_instruction: str,
    session_id: str | None = None,
    project_path: str | None = None,
) -> tuple[str, str]:
    """
    Call Claude CLI to update existing code based on instruction.
    Returns (result, session_id).
    """
    prompt = f"""Here is the current HTML code:

```html
{current_code}
```

User request: {update_instruction}

Update the code according to the user's request. Return ONLY the complete updated HTML code, nothing else. Do not include markdown fences. Start with <!DOCTYPE html> or <html> and end with </html>."""

    cmd = [
        "claude",
        "-p", prompt,
        "--system-prompt", system_prompt,
        "--dangerously-skip-permissions",
        "--output-format", "json",
    ]

    # Handle session persistence
    if session_id:
        if is_session_active(session_id):
            cmd.extend(["--resume", session_id])
        else:
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path or "")
    else:
        if project_path:
            session_id = generate_session_id(project_path)
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path if project_path else None,
    )

    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode())
    return result.get("result", ""), session_id or ""


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "Pixel Forge API - screenshot bootstrap and live editing via Claude Code",
    }


@app.websocket("/generate-code")
async def generate_code(websocket: WebSocket):
    """WebSocket endpoint for screenshot bootstrap in the Pixel Forge web app."""
    await websocket.accept()
    print("Incoming websocket connection...", flush=True)

    try:
        # Receive parameters from frontend
        print("Waiting for params...", flush=True)
        params = await websocket.receive_json()
        print(f"Received params: keys={list(params.keys())}", flush=True)

        # Extract key parameters
        stack = params.get("generatedCodeConfig", "html_tailwind")
        input_mode = params.get("inputMode", "image")
        generation_type = params.get("generationType", "create")
        history = params.get("history", [])

        # Session parameters (new)
        session_id = params.get("session_id")
        project_path = params.get("project_path")

        print(f"Stack: {stack}, InputMode: {input_mode}, GenerationType: {generation_type}", flush=True)
        print(f"Session: {session_id}, Project: {project_path}", flush=True)

        # Map stack names to our keys
        stack_map = {
            "html_tailwind": "html_tailwind",
            "html_css": "html_css",
            "react_tailwind": "react_tailwind",
            "bootstrap": "bootstrap",
            "vue_tailwind": "vue_tailwind",
            "ionic_tailwind": "ionic_tailwind",
            "svg": "svg",
        }
        stack_key = stack_map.get(stack, "html_tailwind")
        system_prompt = SYSTEM_PROMPTS.get(stack_key, SYSTEM_PROMPTS["html_tailwind"])
        user_prompt = SVG_USER_PROMPT if stack == "svg" else USER_PROMPT

        # Tell frontend we're using 1 variant (Claude CLI mode)
        await websocket.send_json({"type": "variantCount", "value": "1", "variantIndex": 0})

        # Handle UPDATE requests (Select and update feature)
        if generation_type == "update" and history:
            print(f"Processing UPDATE request with {len(history)} history items", flush=True)
            await websocket.send_json({"type": "status", "value": "Updating code via Claude Code...", "variantIndex": 0})

            # History format:
            # - Even indices (0, 2, 4...): assistant messages (generated code)
            # - Odd indices (1, 3, 5...): user messages (update instructions)
            # The last item is the user's update instruction

            # Get the most recent code (second to last item, which is assistant's code)
            if len(history) >= 2:
                current_code = history[-2].get("text", "")
            else:
                # Fallback: shouldn't happen but handle gracefully
                current_code = history[0].get("text", "") if history else ""

            # Get the update instruction (last item)
            update_instruction = history[-1].get("text", "")

            print(f"Current code length: {len(current_code)}", flush=True)
            print(f"Update instruction: {update_instruction[:200]}...", flush=True)

            try:
                # Generate updated code via Claude CLI
                result, returned_session_id = await generate_update_with_claude_cli(
                    system_prompt=system_prompt,
                    current_code=current_code,
                    update_instruction=update_instruction,
                    session_id=session_id,
                    project_path=project_path,
                )

                # Extract and clean HTML
                html_code = extract_html_content(result)

                # Send result back to frontend
                await websocket.send_json({"type": "setCode", "value": html_code, "variantIndex": 0})
                await websocket.send_json({
                    "type": "variantComplete",
                    "value": "Update complete",
                    "variantIndex": 0,
                    "session_id": returned_session_id,
                })

            except Exception as e:
                print(f"Update error: {e}", flush=True)
                raise

        # Handle CREATE requests (initial generation)
        else:
            # Extract image/video from prompt
            prompt_data = params.get("prompt", {})
            images = prompt_data.get("images", [])

            if not images:
                await websocket.send_json({"type": "error", "value": "No image provided"})
                await websocket.close()
                return

            data_url = images[0]

            # Handle video vs image input
            if input_mode == "video":
                await websocket.send_json({"type": "status", "value": "Extracting video frames...", "variantIndex": 0})
                image_path = process_video_to_image(data_url)
                # Update user prompt for video context - BE VERY STRICT about output format
                user_prompt = """These are frames extracted from a video recording of a web page. Generate HTML/Tailwind code that recreates the UI shown.

CRITICAL: Return ONLY the HTML code. Do NOT include any explanation, description, or commentary. Do NOT describe what you see. Start directly with <!DOCTYPE html> or <html> and end with </html>. Nothing else."""
                await websocket.send_json({"type": "status", "value": "Generating code via Claude Code...", "variantIndex": 0})
            else:
                await websocket.send_json({"type": "status", "value": "Generating code via Claude Code...", "variantIndex": 0})
                # Save image to temp file
                image_path = save_base64_image(data_url)

            print(f"Saved {'video frames' if input_mode == 'video' else 'image'} to: {image_path}", flush=True)

            try:
                # Generate code via Claude CLI
                result, returned_session_id = await generate_with_claude_cli(
                    image_path=image_path,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    session_id=session_id,
                    project_path=project_path,
                )

                # Extract and clean HTML
                html_code = extract_html_content(result)

                # Send result back to frontend
                await websocket.send_json({"type": "setCode", "value": html_code, "variantIndex": 0})
                await websocket.send_json({
                    "type": "variantComplete",
                    "value": "Generation complete",
                    "variantIndex": 0,
                    "session_id": returned_session_id,
                })

            finally:
                # Cleanup temp file
                if os.path.exists(image_path):
                    os.unlink(image_path)

    except Exception as e:
        import traceback
        print(f"Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({"type": "error", "value": str(e)})
        except Exception:
            pass

    finally:
        print("Closing websocket connection", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


async def edit_element_with_claude_cli(
    element_html: str,
    instruction: str,
    project_path: str,
    element_xpath: str | None = None,
    element_classes: list[str] | None = None,
    session_id: str | None = None,
) -> tuple[str, str]:
    """
    Call Claude CLI to edit an element in a real project.
    Returns (result, session_id).
    """
    # Build context about the element
    element_context = f"Element HTML:\n```html\n{element_html}\n```"
    if element_xpath:
        element_context += f"\n\nXPath: {element_xpath}"
    if element_classes:
        element_context += f"\n\nCSS Classes: {', '.join(element_classes)}"

    prompt = f"""The user is pointing at this element in their running web app:

{element_context}

Their request: {instruction}

Find the source file that renders this element and make the requested change.
Use Glob and Grep to search the codebase, Read to examine files, and Edit to make changes.
After making changes, briefly confirm what you changed."""

    system_prompt = """You are a code editor assistant. The user has selected an element in their running web application and wants you to modify it.

Your task:
1. Find the source file that contains or renders this element
2. Make the requested modification
3. Confirm what you changed

Tips for finding the element:
- Search for unique text content, class names, or IDs
- Look in common locations: src/, components/, pages/, app/
- The element might be in a React component, Vue component, or plain HTML file

Be precise and minimal - only change what's necessary."""

    cmd = [
        "claude",
        "-p", prompt,
        "--system-prompt", system_prompt,
        "--dangerously-skip-permissions",
        "--output-format", "json",
    ]

    # Handle session persistence
    # If session_id provided explicitly, try to resume it
    # Otherwise start fresh (no session persistence by default)
    if session_id:
        if is_session_active(session_id):
            cmd.extend(["--resume", session_id])
        else:
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path)
    # else: No session flags = fresh conversation each time

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path,
    )

    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode())
    return result.get("result", ""), session_id or ""


@app.websocket("/edit-element")
async def edit_element(websocket: WebSocket):
    """WebSocket endpoint for element-based editing with Claude."""
    await websocket.accept()
    print("[edit-element] Connection opened", flush=True)

    try:
        # Receive edit request
        data = await websocket.receive_json()
        print(f"[edit-element] Received request: {list(data.keys())}", flush=True)

        element = data.get("element", {})
        instruction = data.get("instruction", "")
        project_path = data.get("projectPath", "")
        session_id = data.get("session_id")

        print(f"[edit-element] Session: {session_id}, Project: {project_path}", flush=True)

        # Validate required fields
        if not element.get("outerHTML"):
            await websocket.send_json({
                "type": "error",
                "message": "No element HTML provided"
            })
            return

        if not instruction:
            await websocket.send_json({
                "type": "error",
                "message": "No instruction provided"
            })
            return

        if not project_path:
            await websocket.send_json({
                "type": "error",
                "message": "No project path provided"
            })
            return

        # Verify project path exists
        if not os.path.isdir(project_path):
            await websocket.send_json({
                "type": "error",
                "message": f"Project path does not exist: {project_path}"
            })
            return

        # Send status update
        await websocket.send_json({
            "type": "status",
            "message": "Finding and editing element..."
        })

        # Call Claude to edit the element
        try:
            result, returned_session_id = await edit_element_with_claude_cli(
                element_html=element.get("outerHTML", ""),
                instruction=instruction,
                project_path=project_path,
                element_xpath=element.get("xpath"),
                element_classes=element.get("classList", []),
                session_id=session_id,
            )

            await websocket.send_json({
                "type": "result",
                "message": result,
                "session_id": returned_session_id,
            })

        except Exception as e:
            print(f"[edit-element] Claude error: {e}", flush=True)
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })

    except Exception as e:
        import traceback
        print(f"[edit-element] Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except Exception:
            pass

    finally:
        print("[edit-element] Connection closing", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/chat")
async def unified_chat(websocket: WebSocket):
    """
    Unified chat WebSocket endpoint for all modes.
    Provides streaming responses with session persistence.
    """
    await websocket.accept()
    print("[ws/chat] Connection opened", flush=True)

    try:
        while True:
            # Receive chat message
            data = await websocket.receive_json()
            print(f"[ws/chat] Received: {list(data.keys())}", flush=True)

            message = data.get("message", "")
            context = data.get("context", "")
            session_id = data.get("session_id")
            project_path = data.get("project_path", "")

            if not message:
                await websocket.send_json({
                    "type": "error",
                    "message": "No message provided"
                })
                continue

            # Build prompt with context if provided
            if context:
                prompt = f"Context:\n{context}\n\nRequest: {message}"
            else:
                prompt = message

            # Build command
            cmd = [
                "claude",
                "-p", prompt,
                "--dangerously-skip-permissions",
                "--output-format", "stream-json",
                "--verbose",
            ]

            # Handle session persistence
            if session_id:
                if is_session_active(session_id):
                    cmd.extend(["--resume", session_id])
                else:
                    cmd.extend(["--session-id", session_id])
                    mark_session_active(session_id, project_path)
            elif project_path:
                session_id = generate_session_id(project_path)
                cmd.extend(["--session-id", session_id])
                mark_session_active(session_id, project_path)

            print(f"[ws/chat] Session: {session_id}", flush=True)

            # Send session info
            await websocket.send_json({
                "type": "session",
                "session_id": session_id or "",
            })

            # Start streaming process
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=project_path if project_path else None,
            )

            # Stream output line by line
            try:
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break

                    line_str = line.decode().strip()
                    if not line_str:
                        continue

                    try:
                        event = json.loads(line_str)
                        event_type = event.get("type", "")

                        if event_type == "assistant":
                            # Text content from Claude
                            content = event.get("message", {}).get("content", [])
                            for block in content:
                                if block.get("type") == "text":
                                    await websocket.send_json({
                                        "type": "text",
                                        "content": block.get("text", ""),
                                    })

                        elif event_type == "tool_use":
                            # Tool being used
                            await websocket.send_json({
                                "type": "tool_use",
                                "tool": event.get("tool", ""),
                                "input": event.get("input", {}),
                            })

                        elif event_type == "tool_result":
                            # Tool result
                            await websocket.send_json({
                                "type": "tool_result",
                                "result": event.get("result", ""),
                            })

                        elif event_type == "result":
                            # Final result
                            await websocket.send_json({
                                "type": "complete",
                                "content": event.get("result", ""),
                                "session_id": session_id or "",
                            })

                    except json.JSONDecodeError:
                        # Non-JSON output, send as raw text
                        await websocket.send_json({
                            "type": "raw",
                            "content": line_str,
                        })

                # Wait for process to complete
                await proc.wait()

                if proc.returncode != 0:
                    stderr = await proc.stderr.read()
                    error_msg = stderr.decode() if stderr else "Unknown error"
                    await websocket.send_json({
                        "type": "error",
                        "message": error_msg,
                    })

            except Exception as e:
                proc.kill()
                await websocket.send_json({
                    "type": "error",
                    "message": str(e),
                })

    except Exception as e:
        import traceback
        print(f"[ws/chat] Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except Exception:
            pass

    finally:
        print("[ws/chat] Connection closing", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/live-editor")
async def live_editor_chat(websocket: WebSocket):
    """
    Live Editor WebSocket endpoint backed by Agent Deck sessions.
    Stores each request as a disk request pack and dispatches a short prompt
    into a persistent Agent Deck Claude session for the target project.
    """
    await websocket.accept()
    print("[live-editor] Connection opened", flush=True)

    try:
        while True:
            # Receive chat message
            data = await websocket.receive_json()
            print(f"[live-editor] Received: {list(data.keys())}", flush=True)

            message = data.get("message", "")
            element_context = data.get("element_context", "")
            selection_tunnel = data.get("selection_tunnel")
            attachments = data.get("attachments") or []
            legacy_images = data.get("images") or []
            thread_id = data.get("thread_id") or data.get("session_id")
            project_path = data.get("project_path", "")
            preview_url = data.get("preview_url", "")
            agent_type = data.get("agent_type", "claude")
            target_agent_deck_session_id = data.get("target_agent_deck_session_id")

            if not attachments and legacy_images:
                attachments = [
                    {
                        "name": f"reference-image-{index + 1}.png",
                        "mime_type": "image/png",
                        "data_url": image_data,
                        "kind": "image",
                    }
                    for index, image_data in enumerate(legacy_images)
                ]

            if not message and not attachments:
                await websocket.send_json({
                    "type": "error",
                    "message": "No message or attachments provided"
                })
                continue

            if not project_path:
                await websocket.send_json({
                    "type": "error",
                    "message": "No project path configured"
                })
                continue

            # Verify project path exists
            normalized_project_path = normalize_project_path(project_path)
            if not os.path.isdir(normalized_project_path):
                await websocket.send_json({
                    "type": "error",
                    "message": f"Project path does not exist: {project_path}"
                })
                continue

            turn_wait_task: asyncio.Task[None] | None = None
            status_heartbeat_task: asyncio.Task[None] | None = None

            try:
                request_message = message.strip() or "Use the attached reference files as context for this live edit."
                requested_skills = extract_requested_skills(request_message)
                informational_only = _is_informational_live_editor_request(request_message)
                self_edit_safe_mode = _is_pixel_forge_workspace(normalized_project_path)
                selection_count = 0
                if isinstance(selection_tunnel, dict):
                    raw_selections = selection_tunnel.get("selections")
                    if isinstance(raw_selections, list):
                        selection_count = len(raw_selections)

                upsert_project(
                    normalized_project_path,
                    name=project_name_for_path(normalized_project_path),
                )
                if preview_url:
                    touch_project_url(normalized_project_path, preview_url)
                thread = get_or_create_live_editor_thread(
                    normalized_project_path,
                    thread_id=thread_id if isinstance(thread_id, str) and thread_id else None,
                )
                previous_request_id = thread.last_request_id
                previous_agent_deck_session_id = thread.agent_deck_session_id

                await websocket.send_json(
                    {
                        "type": "status",
                        "message": "Resolving Agent Deck session...",
                    }
                )

                session_info = await ensure_agent_deck_session(
                    normalized_project_path,
                    thread,
                    agent_type=agent_type,
                    target_agent_deck_session_id=(
                        target_agent_deck_session_id
                        if isinstance(target_agent_deck_session_id, str)
                        else None
                    ),
                )
                _assert_agent_deck_lane_available(
                    normalized_project_path,
                    thread.thread_id,
                    session_info.agent_deck_session_id,
                )
                thread = update_live_editor_thread(
                    thread.thread_id,
                    workspace_path=session_info.workspace_path,
                    agent_deck_session_id=session_info.agent_deck_session_id,
                    agent_deck_session_title=session_info.agent_deck_session_title,
                    acpx_agent=session_info.acpx_agent or "",
                    acpx_session_name=session_info.acpx_session_name or "",
                    acpx_record_id=session_info.acpx_record_id or "",
                    acp_session_id=session_info.acp_session_id or "",
                    claude_session_id=session_info.claude_session_id or "",
                )
                upsert_session(
                    normalized_project_path,
                    thread_id=thread.thread_id,
                    backend=thread.backend,
                    workspace_path=session_info.workspace_path,
                    agent_deck_session_id=session_info.agent_deck_session_id,
                    agent_deck_session_title=session_info.agent_deck_session_title,
                    agent_deck_tool=session_info.tool,
                )
                self_edit_scope = (
                    _resolve_self_edit_scope(
                        normalized_project_path,
                        session_info.workspace_path,
                    )
                    if self_edit_safe_mode
                    else None
                )
                if previous_request_id:
                    continuation_mode: Literal["bootstrap", "attached-session", "delta"] = "delta"
                elif (
                    previous_agent_deck_session_id
                    and previous_agent_deck_session_id == session_info.agent_deck_session_id
                ):
                    continuation_mode = "attached-session"
                else:
                    continuation_mode = "bootstrap"

                request_pack = create_request_pack(
                    session_info.workspace_path,
                    thread.thread_id,
                    request_message,
                    element_context,
                    attachments,
                    agent_deck_session_id=session_info.agent_deck_session_id,
                    agent_deck_session_title=session_info.agent_deck_session_title,
                    acpx_agent=session_info.acpx_agent,
                    acpx_session_name=session_info.acpx_session_name,
                    acpx_record_id=session_info.acpx_record_id,
                    acp_session_id=session_info.acp_session_id,
                    preview_url=preview_url or None,
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    continuation_mode=continuation_mode,
                    informational_only=informational_only,
                    requested_skills=requested_skills,
                    session_working_rules=(
                        [
                            "- This is a Pixel Forge self-edit request. Do not run `./install.sh`, `pixel-forge restart`, or otherwise restart/replace the active Pixel Forge controller during this request.",
                            "- Leave install/restart activation for after the request completes. Use verification commands that do not replace the running controller.",
                            (
                                "- This session is an isolated clone-backed self-edit preview. Keep the result in the preview-update lane only and finish by stating whether the clone preview update is ready to load."
                                if self_edit_scope == "preview"
                                else "- This session is the canonical Pixel Forge root. If the change is good, finish by stating whether the controller update is ready to stage/load after the request completes."
                            ),
                        ]
                        if self_edit_safe_mode
                        else None
                    ),
                )
                thread = update_live_editor_thread(
                    thread.thread_id,
                    last_request_id=request_pack.request_id,
                )

                await websocket.send_json(
                    {
                        "type": "session",
                        "session_id": thread.thread_id,
                        "backend": thread.backend,
                        "workspace_path": session_info.workspace_path,
                        "agent_deck_session_id": session_info.agent_deck_session_id,
                        "agent_deck_session_title": session_info.agent_deck_session_title,
                        "agent_deck_tool": session_info.tool,
                        "acpx_agent": session_info.acpx_agent,
                        "acpx_session_name": session_info.acpx_session_name,
                        "acpx_record_id": session_info.acpx_record_id,
                        "acp_session_id": session_info.acp_session_id,
                        "request_id": request_pack.request_id,
                        "selection_count": selection_count,
                        "self_edit_safe_mode": self_edit_safe_mode,
                        "self_edit_scope": self_edit_scope,
                    }
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "message": (
                            f"Sending Pixel Forge continuation {request_pack.relative_directory} into existing Agent Deck session..."
                            if continuation_mode == "attached-session"
                            else f"Dispatching request pack {request_pack.relative_directory} to Agent Deck..."
                        ),
                    }
                )

                dispatch_prompt = build_live_editor_dispatch_prompt(
                    request_pack.relative_request_file,
                    preview_url=preview_url or None,
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    selection_tunnel_url=(
                        f"http://pixel-forge.localhost:{runtime_api_port()}/api/live-editor/selection-tunnel?"
                        + urlencode(
                            {
                                "project_path": session_info.workspace_path,
                                "request_id": request_pack.request_id,
                            }
                        )
                        if request_pack.relative_selection_tunnel_file
                        else None
                    ),
                    self_edit_safe_mode=self_edit_safe_mode,
                    self_edit_scope=self_edit_scope,
                    continuation_mode=continuation_mode,
                    informational_only=informational_only,
                    requested_skills=requested_skills,
                )
                if session_info.acpx_agent and session_info.acpx_session_name:
                    refreshed_acpx_session, fallback_output, streamed_text = await prompt_acpx_session(
                        session_info.acpx_agent,
                        session_info.workspace_path,
                        session_info.acpx_session_name,
                        dispatch_prompt,
                        websocket=websocket,
                    )
                    thread = update_live_editor_thread(
                        thread.thread_id,
                        acpx_agent=refreshed_acpx_session.agent or "",
                        acpx_session_name=refreshed_acpx_session.session_name or "",
                        acpx_record_id=refreshed_acpx_session.acpx_record_id or "",
                        acp_session_id=refreshed_acpx_session.acp_session_id or "",
                    )
                    if fallback_output and not streamed_text:
                        await websocket.send_json(
                            {
                                "type": "chunk",
                                "content": fallback_output,
                            }
                        )
                else:
                    jsonl_path = session_info.jsonl_path
                    start_offset = (
                        jsonl_path.stat().st_size
                        if jsonl_path and jsonl_path.exists()
                        else 0
                    )
                    (
                        baseline_output,
                        turn_wait_task,
                        status_heartbeat_task,
                    ) = await _deliver_live_editor_prompt_to_agent_deck_session(
                        session_info=session_info,
                        websocket=websocket,
                        dispatch_prompt=dispatch_prompt,
                    )
                    send_task = turn_wait_task

                    stream_stats = None
                    if jsonl_path:
                        stream_stats = await stream_claude_jsonl(
                            websocket,
                            jsonl_path,
                            start_offset,
                            send_task,
                        )
                    elif session_info.tool == "codex":
                        stream_stats = await stream_codex_session_output(
                            websocket,
                            agent_deck_session_id=session_info.agent_deck_session_id,
                            baseline_output=baseline_output,
                            prompt=dispatch_prompt,
                            wait_task=send_task,
                        )

                    await turn_wait_task

                    if not stream_stats or not stream_stats.streamed_text:
                        fallback_output = getattr(stream_stats, "last_output", "")
                        if not fallback_output:
                            fallback_output = await get_last_output(
                                session_info.agent_deck_session_id
                            )
                        if fallback_output:
                            await websocket.send_json(
                                {
                                    "type": "chunk",
                                    "content": fallback_output,
                                }
                            )

                refreshed_session = await ensure_agent_deck_session(
                    normalized_project_path,
                    thread,
                    agent_type=agent_type,
                )
                _assert_agent_deck_lane_available(
                    normalized_project_path,
                    thread.thread_id,
                    refreshed_session.agent_deck_session_id,
                )
                update_live_editor_thread(
                    thread.thread_id,
                    workspace_path=refreshed_session.workspace_path,
                    acpx_agent=refreshed_session.acpx_agent or "",
                    acpx_session_name=refreshed_session.acpx_session_name or "",
                    acpx_record_id=refreshed_session.acpx_record_id or "",
                    acp_session_id=refreshed_session.acp_session_id or "",
                    claude_session_id=refreshed_session.claude_session_id or "",
                )
                upsert_session(
                    normalized_project_path,
                    thread_id=thread.thread_id,
                    backend=thread.backend,
                    workspace_path=refreshed_session.workspace_path,
                    agent_deck_session_id=refreshed_session.agent_deck_session_id,
                    agent_deck_session_title=refreshed_session.agent_deck_session_title,
                    agent_deck_tool=refreshed_session.tool,
                )
                refreshed_self_edit_scope = (
                    _resolve_self_edit_scope(
                        normalized_project_path,
                        refreshed_session.workspace_path,
                    )
                    if self_edit_safe_mode
                    else None
                )

                await websocket.send_json(
                    {
                        "type": "complete",
                        "session_id": thread.thread_id,
                        "backend": thread.backend,
                        "workspace_path": refreshed_session.workspace_path,
                        "agent_deck_session_id": refreshed_session.agent_deck_session_id,
                        "agent_deck_session_title": refreshed_session.agent_deck_session_title,
                        "agent_deck_tool": refreshed_session.tool,
                        "acpx_agent": refreshed_session.acpx_agent,
                        "acpx_session_name": refreshed_session.acpx_session_name,
                        "acpx_record_id": refreshed_session.acpx_record_id,
                        "acp_session_id": refreshed_session.acp_session_id,
                        "request_id": request_pack.request_id,
                        "selection_count": selection_count,
                        "self_edit_safe_mode": self_edit_safe_mode,
                        "self_edit_scope": refreshed_self_edit_scope,
                        "is_remote_target": _is_remote_preview(preview_url or None),
                    }
                )

            except (AgentDeckBridgeError, AcpxBridgeError, ValueError) as e:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": str(e),
                    }
                )
            except Exception as e:
                if turn_wait_task and not turn_wait_task.done():
                    turn_wait_task.cancel()
                if status_heartbeat_task and not status_heartbeat_task.done():
                    status_heartbeat_task.cancel()
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": str(e),
                    }
                )

            finally:
                if turn_wait_task and not turn_wait_task.done():
                    turn_wait_task.cancel()
                if status_heartbeat_task and not status_heartbeat_task.done():
                    status_heartbeat_task.cancel()
                if status_heartbeat_task:
                    with suppress(asyncio.CancelledError):
                        await status_heartbeat_task

    except WebSocketDisconnect:
        pass
    except Exception as e:
        import traceback
        print(f"[live-editor] Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except Exception:
            pass

    finally:
        print("[live-editor] Connection closing", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


# =============================================================================
# APP PROXY ROUTER - Must be LAST because it has a catch-all route!
# =============================================================================
app.include_router(app_proxy_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=runtime_api_port())
