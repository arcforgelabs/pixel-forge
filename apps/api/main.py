"""
Pixel Forge API Backend

Routes screenshot bootstrap and live-edit requests through Claude Code CLI
to use subscription billing instead of raw API credits.
"""

import asyncio
import base64
import hashlib
import io
import json
import math
import mimetypes
import os
import re
import tempfile
from datetime import datetime, timezone
from contextlib import suppress
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import parse_qs, urlencode, urlparse
from uuid import uuid4

from agent_deck_bridge import (
    AgentDeckBridgeError,
    AgentDeckDeleteAssessment,
    AgentDeckSessionTarget,
    assess_agent_deck_delete_state,
    claude_jsonl_path,
    claude_jsonl_payloads_for_record,
    delete_agent_deck_session_target,
    get_agent_deck_session_activity,
    get_last_output,
    launch_agent_deck_closeout_session,
    rename_agent_deck_session_target,
    stream_claude_jsonl,
    stream_codex_jsonl,
    stream_codex_session_output,
)
from agent_deck_event_ingest import AgentDeckNativeEventIngestor
from agent_deck_surface import (
    ensure_agent_deck_surface_started,
    read_agent_deck_surface_status,
    stop_agent_deck_surface,
)
from agent_providers import get_agent_provider, list_agent_providers
from agent_providers.models import (
    AgentProviderSessionTarget,
    AgentTurnPolicy,
    AgentTurnRequest,
)
import pixel_forge_cli as _pf_cli
from acpx_bridge import AcpxBridgeError, prompt_acpx_session
from agent_deck_config import get_claude_1m_settings, set_claude_1m_settings
from desktop_dialogs import DirectoryBrowseError, browse_for_directory
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect
from live_editor_threads import (
    detach_missing_agent_deck_thread_bindings,
    delete_live_editor_thread,
    get_live_editor_thread,
    get_or_create_live_editor_thread,
    purge_hidden_live_editor_threads,
    update_live_editor_thread,
)
from project_store import (
    create_adopted_project_session,
    detach_missing_agent_deck_session_bindings,
    detach_project_session_binding,
    delete_project,
    ensure_state_store_initialized,
    get_profile_state,
    delete_session,
    get_project_session,
    get_project_session_by_agent_deck_session_id,
    get_project_session_by_provider_session_id,
    list_project_sessions,
    list_project_urls,
    get_project_logo_forge_state,
    list_projects,
    project_name_for_path,
    touch_project_url,
    update_session_title,
    upsert_project,
    upsert_profile_state,
    upsert_project_logo_forge_state,
    purge_hidden_profile_history,
    upsert_session,
)
from project_chats import (
    find_project_chat_by_thread_id,
    ProjectChatRecord,
    reconcile_project_chats,
)
from pydantic import BaseModel
from PIL import Image
from moviepy import VideoFileClip
from request_packs import (
    create_request_pack,
    extract_requested_skills,
    live_preview_attach_lines,
    normalize_requested_skills,
)
from live_preview_context import (
    capture_live_preview_context,
    read_live_preview_context_artifact,
    refresh_live_preview_context,
)
from skill_registry import load_skill_registry_snapshot
from browser_preview import MANAGED_BROWSER_PREVIEW, resolve_preview_mode
from local_target_proxy import LocalTargetAliasMiddleware
from runtime_config import runtime_kind as current_runtime_kind
from controller_update_state import (
    clear_pending_controller_update,
    read_pending_controller_update,
    write_pending_controller_update,
)
from controller_release_update import (
    check_controller_release_update,
    read_controller_release_update,
    skip_controller_release_update,
    stage_controller_release_update,
)
from published_update_state import (
    clear_pending_preview_update,
    read_latest_pending_preview_update,
    write_pending_preview_update,
)
from runtime_version import read_runtime_info
from workstation_events import (
    append_workstation_event,
    chat_has_typed_turn_events,
    chat_has_primary_workstation_events,
    get_chat_activity_snapshot,
    latest_status_bus_event_id,
    latest_workstation_event,
    latest_workstation_event_id,
    list_status_bus_events,
    list_recent_workstation_events,
    list_workstation_events,
    sync_chat_activity_event,
)
from local_targets import (
    list_pixel_forge_targets,
    serialize_local_target,
    start_pixel_forge_target,
)
from workspace_previews import (
    discover_workspace_preview_candidates,
    serialize_workspace_preview,
    serialize_workspace_preview_candidate,
    start_workspace_preview,
)
from runtime_config import api_port as runtime_api_port
from runtime_config import url_host as runtime_url_host

from session_manager import (
    generate_session_id,
    is_session_active,
    mark_session_active,
)

# Video processing settings
TARGET_NUM_FRAMES = 16  # Extract up to 16 frames from video
GRID_COLS = 4  # 4 columns in the frame grid
FRAME_WIDTH = 480  # Width of each frame in the grid (larger = better quality)
LIVE_EDITOR_AGENT_STARTUP_TIMEOUT_SECONDS = 8.0
LIVE_EDITOR_AGENT_RESOLUTION_TIMEOUT_SECONDS = 45.0
LIVE_EDITOR_AGENT_COMPLETION_TIMEOUT_SECONDS = 60 * 60
LIVE_EDITOR_AGENT_STATUS_HEARTBEAT_INTERVAL_SECONDS = 20.0
AGENT_DECK_NATIVE_EVENT_INGESTOR = AgentDeckNativeEventIngestor()
AGENT_DECK_NATIVE_EVENT_TASK: asyncio.Task[None] | None = None
LiveEditorStatusCallback = Callable[[str], Awaitable[None]]
LiveEditorStreamPayloadCallback = Callable[[dict[str, object]], Awaitable[None]]
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


def _safe_live_editor_file_segment(value: str | None, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", (value or "").strip()).strip(".-")
    return cleaned or fallback


def _project_relative_path(project_path: str, path: Path) -> str:
    project_root = Path(project_path).resolve()
    resolved_path = path.resolve()
    try:
        return str(resolved_path.relative_to(project_root))
    except ValueError:
        return str(resolved_path)


def _write_live_editor_preflight_snapshot(
    *,
    project_path: str,
    thread_id: str,
    request_message: str,
    element_context: str,
    selection_tunnel: dict[str, object] | None,
    attachments: list[dict[str, object]],
    preview_url: str,
    live_preview: object,
    target_provider_id: object,
    target_provider_session_id: object,
    agent_type: object,
    workspace_mode: object,
    target_agent_deck_session_id: object,
    target_intent: object,
    agent_model: object,
    agent_thinking: object,
    selection_count: int,
) -> Path:
    project_root = Path(project_path).resolve()
    safe_thread_id = _safe_live_editor_file_segment(thread_id, "thread")
    recovery_root = project_root / ".pixel-forge" / "recovery" / safe_thread_id
    recovery_root.mkdir(parents=True, exist_ok=True)
    snapshot_id = (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        + f"-{uuid4().hex[:8]}"
    )
    snapshot_path = recovery_root / f"{snapshot_id}.json"
    payload = {
        "source": "pixel-forge",
        "kind": "live-editor-pre-provider-snapshot",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "thread_id": thread_id,
        "project_path": str(project_root),
        "prompt_text": request_message,
        "preview_url": preview_url or None,
        "target_provider_id": (
            target_provider_id
            if isinstance(target_provider_id, str)
            else None
        ),
        "target_provider_session_id": (
            target_provider_session_id
            if isinstance(target_provider_session_id, str)
            else None
        ),
        "agent_type": agent_type if isinstance(agent_type, str) else None,
        "workspace_mode": workspace_mode if isinstance(workspace_mode, str) else None,
        "target_agent_deck_session_id": (
            target_agent_deck_session_id
            if isinstance(target_agent_deck_session_id, str)
            else None
        ),
        "target_intent": target_intent if isinstance(target_intent, dict) else None,
        "agent_model": agent_model if isinstance(agent_model, str) else None,
        "agent_thinking": agent_thinking if isinstance(agent_thinking, str) else None,
        "selection": {
            "count": selection_count,
            "tunnel": selection_tunnel if isinstance(selection_tunnel, dict) else None,
            "selected_elements_xml": element_context if element_context.strip() else None,
        },
        "live_preview": live_preview if isinstance(live_preview, dict) else None,
        "attachments": attachments,
    }
    snapshot_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return snapshot_path


def _live_editor_turn_input(data: dict[str, object]) -> dict[str, object]:
    turn_input = data.get("turn_input")
    return turn_input if isinstance(turn_input, dict) else {}


def _live_editor_target_intent(data: dict[str, object]) -> dict[str, object]:
    target_intent = data.get("target_intent")
    return target_intent if isinstance(target_intent, dict) else {}


def _turn_input_value(
    turn_input: dict[str, object],
    data: dict[str, object],
    key: str,
    fallback: object = None,
) -> object:
    return turn_input.get(key, data.get(key, fallback))


def _target_intent_mode(target_intent: dict[str, object]) -> str | None:
    mode = target_intent.get("mode")
    if mode in {"new", "bound", "attach_existing", "direct_replay"}:
        return str(mode)
    return None


def _live_editor_target_session_id(
    *,
    target_intent: dict[str, object],
    target_intent_mode: str | None,
    data: dict[str, object],
) -> str | None:
    if target_intent_mode in {"new", "direct_replay"}:
        return None
    if target_intent_mode in {"bound", "attach_existing"}:
        target_session_id = target_intent.get("provider_session_id")
    else:
        target_session_id = data.get("target_provider_session_id")
    if not isinstance(target_session_id, str) or not target_session_id.strip():
        target_session_id = data.get("target_agent_deck_session_id")
    return target_session_id.strip() if isinstance(target_session_id, str) and target_session_id.strip() else None


def _is_missing_provider_session_error(error: BaseException) -> bool:
    message = str(error).lower()
    return (
        "not_found" in message
        or "not found" in message
    ) and "session" in message


async def _emit_live_editor_wait_heartbeat(
    websocket: WebSocket,
    *,
    tool: str,
    provider_label: str,
    wait_task: asyncio.Task[None],
    interval_seconds: float = LIVE_EDITOR_AGENT_STATUS_HEARTBEAT_INTERVAL_SECONDS,
    on_status: LiveEditorStatusCallback | None = None,
) -> None:
    loop = asyncio.get_running_loop()
    started_at = loop.time()
    tool_label = (tool or "agent").strip().capitalize() or "Agent"
    normalized_provider_label = provider_label.strip() if provider_label.strip() else "provider"

    while not wait_task.done():
        await asyncio.sleep(interval_seconds)
        if wait_task.done():
            return
        try:
            status_message = (
                f"{tool_label} is still working in {normalized_provider_label}... "
                f"{_format_elapsed_duration(loop.time() - started_at)} elapsed."
            )
            await websocket.send_json(
                {
                    "type": "status",
                    "message": status_message,
                }
            )
            if on_status is not None:
                await on_status(status_message)
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

app.add_middleware(LocalTargetAliasMiddleware)


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
_FRONTEND_INDEX_PATH: Path | None = None
_FRONTEND_DIST_CANDIDATES: list[Path] = []

if _FRONTEND_DIST_OVERRIDE:
    _FRONTEND_DIST_CANDIDATES.append(Path(_FRONTEND_DIST_OVERRIDE).expanduser().resolve())
_FRONTEND_DIST_CANDIDATES.extend((_INSTALLED_DIST, _FRONTEND_DIST))

for _dist_candidate in _FRONTEND_DIST_CANDIDATES:
    if (_dist_candidate / "index.html").is_file():
        _FRONTEND_INDEX_PATH = _dist_candidate / "index.html"

        def _serve_frontend_entry() -> FileResponse:
            response = FileResponse(
                str(_FRONTEND_INDEX_PATH),
                media_type="text/html",
            )
            response.headers["Cache-Control"] = "no-store"
            return response

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
                app.mount(
                    f"/internal/{_subdir}",
                    StaticFiles(directory=str(_subdir_path)),
                    name=f"frontend-internal-{_subdir}",
                )

        @app.get("/")
        async def serve_frontend_index():
            return _serve_frontend_entry()

        @app.get("/internal/{internal_path:path}")
        async def serve_frontend_internal_route(internal_path: str):
            del internal_path
            return _serve_frontend_entry()

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
app.mount(
    "/test-app",
    StaticFiles(directory=Path(__file__).resolve().parent / "test-app", html=True),
    name="test-app",
)


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


class WorkspaceDirectoryEntry(BaseModel):
    name: str
    path: str


class WorkspaceDirectoryListing(BaseModel):
    path: str
    parent_path: str | None = None
    home_path: str
    entries: list[WorkspaceDirectoryEntry]


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
    provider_id: str | None = None
    provider_session_id: str | None = None
    provider_session_title: str | None = None
    provider_agent_id: str | None = None
    agent_deck_session_id: str | None = None
    agent_deck_session_title: str | None = None
    agent_deck_tool: str | None = None
    editor_state: dict[str, object] | None = None


class ProfileStateRequest(BaseModel):
    profile_id: str | None = None
    active_project_path: str | None = None
    last_workspace_browse_directory: str | None = None
    active_mode: Literal["screenshot", "live-editor", "logo-forge"] = "screenshot"
    active_live_editor_thread_id: str | None = None
    default_agent_provider_id: Literal["agent-deck", "claude-cli", "codex-cli"] = "agent-deck"
    default_agent_type: Literal["claude", "codex", "gemini", "pi", "openclaw"] = "claude"
    default_workspace_mode: Literal["root"] = "root"
    claude_default_model: str | None = None
    claude_default_thinking: str | None = None
    codex_default_model: str | None = None
    codex_default_thinking: str | None = None
    gemini_default_model: str | None = None
    pi_default_model: str | None = None
    pi_default_thinking: str | None = None


class ClaudeGlobalSettingsRequest(BaseModel):
    use_1m_context_opus: bool | None = None
    use_1m_context_sonnet: bool | None = None


class AgentDeckSessionRequest(BaseModel):
    provider_id: str | None = None
    agent_type: str = "claude"
    title: str | None = None
    workspace_mode: Literal["root"] = "root"
    agent_model: str | None = None
    agent_thinking: str | None = None
    reuse_empty_draft: bool = True


class ChatItemRenameRequest(BaseModel):
    thread_id: str | None = None
    provider_id: str | None = None
    provider_session_id: str | None = None
    agent_deck_session_id: str | None = None
    title: str


class ChatItemDeleteRequest(BaseModel):
    thread_id: str | None = None
    provider_id: str | None = None
    provider_session_id: str | None = None
    agent_deck_session_id: str | None = None
    force_clone_remove: bool = False


class ChatItemCloseoutRequest(BaseModel):
    thread_id: str | None = None
    provider_id: str | None = None
    provider_session_id: str | None = None
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
    pdfSelectionKind: Literal["text", "text-range", "region"] | None = None
    pdfTextRange: dict[str, int] | None = None
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
        "click",
    ]
    enabled: bool | None = None
    selectionId: str | None = None
    xpath: str | None = None
    xpaths: list[str] | None = None
    selections: list[AppliedSelectionRequest] | None = None
    reveal: bool | None = None
    x: float | None = None
    y: float | None = None


class LocalTargetStartRequest(BaseModel):
    project_path: str
    runtime_kind: Literal["mirror", "dev"] = "mirror"
    force_restart: bool = True
    source_root: str | None = None


class WorkspacePreviewStartRequest(BaseModel):
    workspace_path: str
    relative_app_path: str | None = None
    script_name: str | None = None
    package_manager: str | None = None
    force_restart: bool = False


class PendingControllerUpdateRequest(BaseModel):
    project_path: str
    preview_url: str | None = None
    active_mode: Literal["live-editor", "screenshot", "logo-forge"] | None = None
    summary: str | None = None
    source: str | None = None
    request_id: str | None = None
    commit_hash: str | None = None
    git_ref: str | None = None
    allow_noncanonical_project: bool = False


class ControllerReleaseCheckRequest(BaseModel):
    force: bool = False


class ControllerReleaseSkipRequest(BaseModel):
    version: str | None = None


class PendingPreviewUpdateRequest(BaseModel):
    project_path: str
    workspace_path: str
    preview_url: str | None = None
    active_mode: Literal["live-editor", "screenshot", "logo-forge"] | None = None
    summary: str | None = None
    source: str | None = None
    request_id: str | None = None
    provider_id: str | None = None
    provider_session_id: str | None = None
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


def _normalize_project_preview_url(raw_url: str | None) -> str | None:
    normalized_url = str(raw_url or "").strip()
    if not normalized_url:
        return None

    parsed = urlparse(normalized_url)
    if parsed.path != "/internal/pdf-viewer":
        return normalized_url

    source_url = ""
    for candidate in parse_qs(parsed.query).get("source", []):
        source_url = str(candidate or "").strip()
        if source_url:
            break

    return source_url or None


def _serialize_project_urls(url_records) -> list[dict[str, object]]:
    serialized_urls: list[dict[str, object]] = []
    seen_urls: set[str] = set()

    for url_record in url_records:
        normalized_url = _normalize_project_preview_url(getattr(url_record, "url", None))
        if not normalized_url or normalized_url in seen_urls:
            continue
        seen_urls.add(normalized_url)
        serialized_urls.append({
            "url": normalized_url,
            "last_used": url_record.last_used,
            "use_count": url_record.use_count,
        })

    return serialized_urls


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
        "provider_id": session_record.provider_id,
        "provider_session_id": session_record.provider_session_id,
        "provider_session_title": session_record.provider_session_title,
        "provider_agent_id": session_record.provider_agent_id,
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
        "memory_rss_bytes": session_target.memory_rss_bytes,
        "memory_swap_bytes": session_target.memory_swap_bytes,
        "process_count": session_target.process_count,
    }


def serialize_agent_provider_session_target(session_target) -> dict[str, object]:
    return session_target.to_dict()


def serialize_project_chat(chat_record) -> dict[str, object]:
    return {
        "id": chat_record.id,
        "project_path": chat_record.project_path,
        "title": chat_record.title,
        "thread_id": chat_record.thread_id,
        "workspace_path": chat_record.workspace_path,
        "backend": chat_record.backend,
        "provider_id": chat_record.provider_id,
        "provider_session_id": chat_record.provider_session_id,
        "provider_session_title": chat_record.provider_session_title,
        "provider_agent_id": chat_record.provider_agent_id,
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


def _project_chat_from_session_record(session_record) -> ProjectChatRecord:
    normalized_project_path = normalize_project_path(session_record.project_path)
    normalized_workspace_path = normalize_project_path(session_record.workspace_path)
    thread_id = session_record.thread_id
    title = next(
        (
            candidate.strip()
            for candidate in (
                getattr(session_record, "provider_session_title", None),
                getattr(session_record, "agent_deck_session_title", None),
            )
            if isinstance(candidate, str) and candidate.strip()
        ),
        f"Chat {thread_id[:8]}",
    )
    has_provider_binding = bool(
        getattr(session_record, "provider_session_id", None)
        or getattr(session_record, "agent_deck_session_id", None)
    )
    return ProjectChatRecord(
        id=thread_id,
        project_path=normalized_project_path,
        title=title,
        thread_id=thread_id,
        workspace_path=normalized_workspace_path,
        backend=session_record.backend,
        provider_id=getattr(session_record, "provider_id", None),
        provider_session_id=getattr(session_record, "provider_session_id", None),
        provider_session_title=getattr(session_record, "provider_session_title", None),
        provider_agent_id=getattr(session_record, "provider_agent_id", None),
        agent_deck_session_id=getattr(session_record, "agent_deck_session_id", None),
        agent_deck_session_title=getattr(session_record, "agent_deck_session_title", None),
        agent_deck_tool=getattr(session_record, "agent_deck_tool", None),
        agent_deck_session_status=None,
        binding_state="attached" if has_provider_binding else "detached",
        workspace_kind=(
            "root"
            if normalized_workspace_path == normalized_project_path
            else "clone"
        ),
        origin_kind=session_record.origin_kind,
        created_at=session_record.created_at,
        last_active=session_record.last_active,
    )


def serialize_profile_state(profile_state) -> dict[str, object]:
    return {
        "profile_id": profile_state.profile_id,
        "active_project_path": profile_state.active_project_path,
        "last_workspace_browse_directory": profile_state.last_workspace_browse_directory,
        "active_mode": profile_state.active_mode,
        "active_live_editor_thread_id": profile_state.active_live_editor_thread_id,
        "default_agent_provider_id": profile_state.default_agent_provider_id,
        "default_agent_type": profile_state.default_agent_type,
        "default_workspace_mode": profile_state.default_workspace_mode,
        "claude_default_model": profile_state.claude_default_model,
        "claude_default_thinking": profile_state.claude_default_thinking,
        "codex_default_model": profile_state.codex_default_model,
        "codex_default_thinking": profile_state.codex_default_thinking,
        "gemini_default_model": profile_state.gemini_default_model,
        "pi_default_model": profile_state.pi_default_model,
        "pi_default_thinking": profile_state.pi_default_thinking,
        "updated_at": profile_state.updated_at,
    }


def _resolve_chat_item_context(
    project_path: str,
    *,
    thread_id: str | None,
    provider_id: str | None = None,
    provider_session_id: str | None = None,
    agent_deck_session_id: str | None,
) -> tuple[
    str,
    str | None,
    object | None,
    object | None,
    str | None,
    str | None,
    str | None,
]:
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

    resolved_provider_id = (
        provider_id.strip()
        if isinstance(provider_id, str) and provider_id.strip()
        else None
    )
    resolved_provider_session_id = (
        provider_session_id.strip()
        if isinstance(provider_session_id, str) and provider_session_id.strip()
        else None
    )
    resolved_agent_deck_session_id = (
        agent_deck_session_id.strip()
        if isinstance(agent_deck_session_id, str) and agent_deck_session_id.strip()
        else None
    )
    if resolved_agent_deck_session_id and not resolved_provider_session_id:
        resolved_provider_id = resolved_provider_id or "agent-deck"
        resolved_provider_session_id = resolved_agent_deck_session_id
    if resolved_provider_session_id and not resolved_provider_id:
        resolved_provider_id = "agent-deck" if resolved_agent_deck_session_id else "unknown"

    if (
        session_record is None
        and resolved_provider_id
        and resolved_provider_session_id
    ):
        session_record = get_project_session_by_provider_session_id(
            normalized_project_path,
            resolved_provider_id,
            resolved_provider_session_id,
        )
        if session_record is not None:
            normalized_thread_id = session_record.thread_id
            thread_record = get_live_editor_thread(normalized_thread_id)
    if session_record is None and resolved_agent_deck_session_id is not None:
        session_record = get_project_session_by_agent_deck_session_id(
            normalized_project_path,
            resolved_agent_deck_session_id,
        )
        if session_record is not None:
            normalized_thread_id = session_record.thread_id
            thread_record = get_live_editor_thread(normalized_thread_id)
    if session_record is not None:
        resolved_provider_id = resolved_provider_id or session_record.provider_id
        resolved_provider_session_id = (
            resolved_provider_session_id or session_record.provider_session_id
        )
        if not resolved_agent_deck_session_id:
            resolved_agent_deck_session_id = session_record.agent_deck_session_id
    if thread_record is not None:
        resolved_provider_id = resolved_provider_id or thread_record.provider_id
        resolved_provider_session_id = (
            resolved_provider_session_id or thread_record.provider_session_id
        )
        if not resolved_agent_deck_session_id:
            resolved_agent_deck_session_id = thread_record.agent_deck_session_id
    if resolved_provider_id == "agent-deck" and not resolved_agent_deck_session_id:
        resolved_agent_deck_session_id = resolved_provider_session_id

    return (
        normalized_project_path,
        normalized_thread_id,
        session_record,
        thread_record,
        resolved_provider_id,
        resolved_provider_session_id,
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
    extra_visible_targets: list[AgentProviderSessionTarget] | None = None,
) -> tuple[str, list[object]]:
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    live_sessions: list[AgentProviderSessionTarget] = []
    visible_sessions: list[AgentProviderSessionTarget] = []
    agent_deck_provider = get_agent_provider("agent-deck")
    agent_deck_status = agent_deck_provider.status() if agent_deck_provider else None
    if (
        agent_deck_provider is not None
        and agent_deck_status is not None
        and agent_deck_status.enabled
        and agent_deck_status.available
    ):
        try:
            live_sessions = await agent_deck_provider.list_sessions(
                normalized_project_path,
                include_live_editor=True,
            )
            visible_sessions = await agent_deck_provider.list_sessions(
                normalized_project_path,
                include_live_editor=False,
            )
        except AgentDeckBridgeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    visible_sessions_by_id = {
        (session.provider_id, session.id): session for session in visible_sessions
    }
    for session in extra_visible_targets or []:
        visible_sessions_by_id.setdefault((session.provider_id, session.id), session)

    if agent_deck_status and agent_deck_status.enabled and agent_deck_status.available:
        live_session_ids = {session.id for session in live_sessions}
        sessions = detach_missing_agent_deck_session_bindings(
            normalized_project_path,
            live_session_ids,
        )
        detach_missing_agent_deck_thread_bindings(
            normalized_project_path,
            live_session_ids,
        )
    else:
        sessions = list_project_sessions(normalized_project_path)

    chats = reconcile_project_chats(
        normalized_project_path,
        sessions=sessions,
        visible_targets=list(visible_sessions_by_id.values()),
    )
    adopted_chats = [
        chat
        for chat in chats
        if chat.origin_kind == "adopted"
        and chat.thread_id is None
        and chat.agent_deck_session_id
        and chat.provider_id == "agent-deck"
    ]
    if adopted_chats:
        for chat in adopted_chats:
            create_adopted_project_session(
                normalized_project_path,
                workspace_path=chat.workspace_path,
                agent_deck_session_id=chat.agent_deck_session_id,
                agent_deck_session_title=chat.agent_deck_session_title,
                agent_deck_tool=chat.agent_deck_tool,
            )
        sessions = list_project_sessions(normalized_project_path)
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
            last_workspace_browse_directory=request.last_workspace_browse_directory,
            active_mode=request.active_mode,
            active_live_editor_thread_id=request.active_live_editor_thread_id,
            default_agent_provider_id=request.default_agent_provider_id,
            default_agent_type=request.default_agent_type,
            default_workspace_mode=request.default_workspace_mode,
            claude_default_model=request.claude_default_model,
            claude_default_thinking=request.claude_default_thinking,
            codex_default_model=request.codex_default_model,
            codex_default_thinking=request.codex_default_thinking,
            gemini_default_model=request.gemini_default_model,
            pi_default_model=request.pi_default_model,
            pi_default_thinking=request.pi_default_thinking,
        )
    )


@app.get("/api/claude-global-settings")
async def get_claude_global_settings():
    """Return system-wide Claude 1M context toggles from agent-deck's config."""
    return get_claude_1m_settings()


@app.post("/api/claude-global-settings")
async def save_claude_global_settings(request: ClaudeGlobalSettingsRequest):
    """Persist Claude 1M toggles to ~/.agent-deck/config.toml. Unset fields are left alone."""
    return set_claude_1m_settings(
        use_1m_context_opus=request.use_1m_context_opus,
        use_1m_context_sonnet=request.use_1m_context_sonnet,
    )


@app.post("/api/profile-state/purge-hidden-history")
async def purge_default_profile_hidden_history():
    profile_id = get_profile_state().profile_id
    project_result = purge_hidden_profile_history(profile_id=profile_id)
    live_editor_threads_deleted = purge_hidden_live_editor_threads(profile_id=profile_id)
    return {
        "profile_id": profile_id,
        **project_result,
        "live_editor_threads_deleted": live_editor_threads_deleted,
    }


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
    return {"urls": _serialize_project_urls(list_project_urls(project_path))}


@app.get("/api/projects/{project_path:path}/logo-forge-state")
async def get_project_logo_forge_state_endpoint(project_path: str):
    state = get_project_logo_forge_state(project_path)
    return {"state": state}


class LogoForgeDesignBriefRequest(BaseModel):
    content: str


@app.get("/api/projects/{project_path:path}/logo-forge-design-brief")
async def get_project_logo_forge_design_brief_endpoint(project_path: str):
    root = Path(os.path.abspath(os.path.expanduser(project_path))).resolve(strict=False)
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=404, detail="Project path does not exist")
    candidates = [root / "DESIGN.md", root / "design.md"]
    design_path = next((path for path in candidates if path.is_file()), None)
    if design_path is None:
        return {"found": False, "path": None, "content": None, "signature": None}
    try:
        content = design_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = design_path.read_text(encoding="utf-8", errors="replace")
    if len(content) > 200_000:
        content = content[:200_000]
    return {
        "found": True,
        "path": design_path.name,
        "content": content,
        "signature": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }


@app.post("/api/projects/{project_path:path}/logo-forge-design-brief")
async def upsert_project_logo_forge_design_brief_endpoint(
    project_path: str, request: LogoForgeDesignBriefRequest
):
    root = Path(os.path.abspath(os.path.expanduser(project_path))).resolve(strict=False)
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=404, detail="Project path does not exist")
    content = request.content
    if len(content.encode("utf-8")) > 200_000:
        raise HTTPException(status_code=413, detail="DESIGN.md is larger than 200 KB")
    design_path = root / "DESIGN.md"
    try:
        design_path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "found": True,
        "path": design_path.name,
        "content": content,
        "signature": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }


class LogoForgeStateRequest(BaseModel):
    state: dict[str, object] | None = None


@app.post("/api/projects/{project_path:path}/logo-forge-state")
async def upsert_project_logo_forge_state_endpoint(
    project_path: str, request: LogoForgeStateRequest
):
    try:
        upsert_project_logo_forge_state(project_path, request.state)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"state": get_project_logo_forge_state(project_path)}


@app.post("/api/projects/{project_path:path}/urls")
async def add_project_url(project_path: str, request: ProjectUrlRequest):
    normalized_url = _normalize_project_preview_url(request.url)
    try:
        urls = (
            touch_project_url(project_path, normalized_url)
            if normalized_url
            else list_project_urls(project_path)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"urls": _serialize_project_urls(urls)}


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
                provider_id=request.provider_id,
                provider_session_id=request.provider_session_id,
                provider_session_title=request.provider_session_title,
                provider_agent_id=request.provider_agent_id,
                agent_deck_session_id=request.agent_deck_session_id,
                agent_deck_session_title=request.agent_deck_session_title,
            )

        session = upsert_session(
            normalized_project_path,
            thread_id=request.thread_id,
            backend=request.backend,
            workspace_path=request.workspace_path,
            provider_id=request.provider_id,
            provider_session_id=request.provider_session_id,
            provider_session_title=request.provider_session_title,
            provider_agent_id=request.provider_agent_id,
            agent_deck_session_id=request.agent_deck_session_id,
            agent_deck_session_title=request.agent_deck_session_title,
            agent_deck_tool=request.agent_deck_tool,
            editor_state=request.editor_state,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return serialize_session(session)


def _agent_provider_or_error(provider_id: str):
    normalized_provider_id = provider_id.strip() if isinstance(provider_id, str) else ""
    provider = get_agent_provider(normalized_provider_id or "agent-deck")
    if provider is None:
        raise HTTPException(status_code=404, detail="Agent provider not found")
    status = provider.status()
    if not status.enabled:
        raise HTTPException(status_code=503, detail=status.reason or "Agent provider is disabled")
    if not status.available:
        raise HTTPException(status_code=503, detail=status.reason or "Agent provider is unavailable")
    return provider


DIRECT_CLI_RETRY_PROVIDER_BY_AGENT = {
    "claude": "claude-cli",
    "claude-code": "claude-cli",
    "codex": "codex-cli",
}


def _direct_cli_retry_options_for_agent(agent_type: object) -> list[dict[str, object]]:
    normalized_agent_type = agent_type.strip().lower() if isinstance(agent_type, str) else ""
    retry_provider_id = DIRECT_CLI_RETRY_PROVIDER_BY_AGENT.get(normalized_agent_type)
    if not retry_provider_id:
        return []
    retry_provider = get_agent_provider(retry_provider_id)
    if retry_provider is None:
        return []
    status = retry_provider.status()
    available = bool(status.enabled and status.available)
    return [
        {
            "id": f"retry-{retry_provider_id}",
            "label": f"Retry with {retry_provider.display_name}",
            "provider_id": retry_provider_id,
            "agent_type": "claude" if retry_provider_id == "claude-cli" else normalized_agent_type,
            "available": available,
            "reason": None if available else status.reason or "Direct CLI provider is unavailable",
        }
    ]


def _live_editor_agent_provider_or_error(
    provider_id: str,
    *,
    agent_type: str,
    target_provider_session_id: str | None,
    thread,
):
    normalized_provider_id = provider_id.strip() if isinstance(provider_id, str) else ""
    selected_provider_id = normalized_provider_id or "agent-deck"
    provider = get_agent_provider(selected_provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Agent provider not found")

    status = provider.status()
    del agent_type, target_provider_session_id, thread

    if status.enabled and status.available:
        return provider

    if not status.enabled:
        raise HTTPException(status_code=503, detail=status.reason or "Agent provider is disabled")
    raise HTTPException(status_code=503, detail=status.reason or "Agent provider is unavailable")


def _hydrate_live_editor_thread_from_project_session(
    project_path: str,
    thread,
):
    session = get_project_session(project_path, thread.thread_id)
    if session is None:
        return thread

    provider_session_id = (
        session.provider_session_id.strip()
        if isinstance(session.provider_session_id, str)
        and session.provider_session_id.strip()
        else None
    )
    agent_deck_session_id = (
        session.agent_deck_session_id.strip()
        if isinstance(session.agent_deck_session_id, str)
        and session.agent_deck_session_id.strip()
        else None
    )
    provider_id = (
        session.provider_id.strip()
        if isinstance(session.provider_id, str)
        and session.provider_id.strip()
        else None
    )

    needs_provider_binding = provider_session_id and not (
        isinstance(thread.provider_session_id, str)
        and thread.provider_session_id.strip()
    )
    needs_agent_deck_binding = agent_deck_session_id and not (
        isinstance(thread.agent_deck_session_id, str)
        and thread.agent_deck_session_id.strip()
    )
    needs_title = (
        isinstance(session.provider_session_title, str)
        and session.provider_session_title.strip()
        and not (
            isinstance(thread.provider_session_title, str)
            and thread.provider_session_title.strip()
        )
    )

    if not (needs_provider_binding or needs_agent_deck_binding or needs_title):
        return thread

    return update_live_editor_thread(
        thread.thread_id,
        backend=session.backend,
        workspace_path=session.workspace_path,
        provider_id=provider_id,
        provider_session_id=provider_session_id,
        provider_session_title=session.provider_session_title,
        provider_agent_id=session.provider_agent_id,
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=session.agent_deck_session_title,
    )


@app.get("/api/projects/{project_path:path}/agent-deck-sessions")
async def get_project_agent_deck_sessions(project_path: str):
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    agent_provider = _agent_provider_or_error("agent-deck")

    try:
        live_sessions = await agent_provider.list_sessions(
            normalized_project_path,
            include_live_editor=True,
        )
        sessions = await agent_provider.list_sessions(
            normalized_project_path,
            include_live_editor=False,
        )
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
            serialize_agent_provider_session_target(session)
            for session in sessions
        ]
    }


@app.get("/api/projects/{project_path:path}/agent-sessions")
async def get_project_agent_sessions(project_path: str, provider: str = "agent-deck"):
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    agent_provider = _agent_provider_or_error(provider)

    try:
        live_sessions = await agent_provider.list_sessions(
            normalized_project_path,
            include_live_editor=True,
        )
        sessions = await agent_provider.list_sessions(
            normalized_project_path,
            include_live_editor=False,
        )
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if agent_provider.provider_id == "agent-deck":
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
        "provider_id": agent_provider.provider_id,
        "sessions": [
            serialize_agent_provider_session_target(session)
            for session in sessions
        ],
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

    agent_provider = _agent_provider_or_error("agent-deck")

    try:
        session = await agent_provider.create_session(
            normalized_project_path,
            agent_type=request.agent_type,
            title=request.title,
            workspace_mode=request.workspace_mode,
            agent_model=request.agent_model,
            agent_thinking=request.agent_thinking,
        )
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return serialize_agent_provider_session_target(session)


@app.post("/api/projects/{project_path:path}/agent-sessions")
async def create_project_agent_session(
    project_path: str,
    request: AgentDeckSessionRequest,
    provider: str = "agent-deck",
):
    normalized_project_path = normalize_project_path(project_path)
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    agent_provider = _agent_provider_or_error(provider)

    upsert_project(
        normalized_project_path,
        name=project_name_for_path(normalized_project_path),
    )

    try:
        session = await agent_provider.create_session(
            normalized_project_path,
            agent_type=request.agent_type,
            title=request.title,
            workspace_mode=request.workspace_mode,
            agent_model=request.agent_model,
            agent_thinking=request.agent_thinking,
        )
    except AgentDeckBridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return serialize_agent_provider_session_target(session)


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

    selected_provider_id = (
        request.provider_id.strip()
        if isinstance(request.provider_id, str) and request.provider_id.strip()
        else get_profile_state().default_agent_provider_id
    )
    if selected_provider_id not in {"agent-deck", "claude-cli", "codex-cli"}:
        selected_provider_id = "agent-deck"
    selected_agent_id = request.agent_type.strip() if request.agent_type.strip() else "claude"

    if request.reuse_empty_draft:
        # Reuse an existing empty draft chat without paying for live provider
        # reconciliation. Draft creation is a local persisted-state operation.
        for existing in list_project_sessions(normalized_project_path):
            thread_id = existing.thread_id or ""
            if (
                not getattr(existing, "provider_session_id", None)
                and not getattr(existing, "agent_deck_session_id", None)
                and getattr(existing, "provider_id", selected_provider_id) == selected_provider_id
                and getattr(existing, "provider_agent_id", selected_agent_id) == selected_agent_id
                and thread_id.startswith("chat-")
                and not chat_has_primary_workstation_events(normalized_project_path, thread_id)
            ):
                return serialize_project_chat(_project_chat_from_session_record(existing))

    thread_id = f"chat-{uuid4().hex[:12]}"
    draft_title = (
        request.title.strip()
        if request.title and request.title.strip()
        else f"Chat {thread_id[:8]}"
    )
    agent_deck_title = draft_title if selected_provider_id == "agent-deck" else None
    agent_deck_tool = selected_agent_id if selected_provider_id == "agent-deck" else None

    try:
        created_session = upsert_session(
            normalized_project_path,
            thread_id=thread_id,
            backend=selected_provider_id,
            workspace_path=normalized_project_path,
            provider_id=selected_provider_id,
            provider_session_id=None,
            provider_session_title=draft_title,
            provider_agent_id=selected_agent_id,
            agent_deck_session_id=None,
            agent_deck_session_title=agent_deck_title,
            agent_deck_tool=agent_deck_tool,
            editor_state={
                "draftAgentType": selected_agent_id,
                "draftProviderId": selected_provider_id,
                "draftWorkspaceMode": request.workspace_mode,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return serialize_project_chat(_project_chat_from_session_record(created_session))


@app.post("/api/projects/{project_path:path}/chat-items/rename")
async def rename_project_chat_item(
    project_path: str,
    request: ChatItemRenameRequest,
):
    (
        normalized_project_path,
        normalized_thread_id,
        session_record,
        thread_record,
        resolved_provider_id,
        resolved_provider_session_id,
        resolved_agent_deck_session_id,
    ) = (
        _resolve_chat_item_context(
            project_path,
            thread_id=request.thread_id,
            provider_id=request.provider_id,
            provider_session_id=request.provider_session_id,
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
        and session_record is None
        and thread_record is None
        and (
            resolved_provider_id != "agent-deck"
            or resolved_agent_deck_session_id is None
        )
    ):
        raise HTTPException(status_code=404, detail="Chat item not found")

    if resolved_provider_id == "agent-deck" and resolved_agent_deck_session_id:
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
                provider_id=resolved_provider_id,
                provider_session_id=resolved_provider_session_id,
                provider_session_title=normalized_title,
                agent_deck_session_id=resolved_agent_deck_session_id,
                agent_deck_session_title=(
                    normalized_title if resolved_provider_id == "agent-deck" else None
                ),
            )

    return {
        "status": "renamed",
        "thread_id": normalized_thread_id,
        "provider_id": resolved_provider_id,
        "provider_session_id": resolved_provider_session_id,
        "agent_deck_session_id": resolved_agent_deck_session_id,
        "title": normalized_title,
    }


@app.post("/api/projects/{project_path:path}/chat-items/delete")
async def delete_project_chat_item(
    project_path: str,
    request: ChatItemDeleteRequest,
):
    (
        normalized_project_path,
        normalized_thread_id,
        session_record,
        thread_record,
        resolved_provider_id,
        resolved_provider_session_id,
        resolved_agent_deck_session_id,
    ) = (
        _resolve_chat_item_context(
            project_path,
            thread_id=request.thread_id,
            provider_id=request.provider_id,
            provider_session_id=request.provider_session_id,
            agent_deck_session_id=request.agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    if (
        normalized_thread_id is None
        and session_record is None
        and thread_record is None
        and (
            resolved_provider_id != "agent-deck"
            or resolved_agent_deck_session_id is None
        )
    ):
        raise HTTPException(status_code=404, detail="Chat item not found")

    assessment: AgentDeckDeleteAssessment | None = None
    if resolved_provider_id == "agent-deck" and resolved_agent_deck_session_id:
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

    if resolved_provider_id == "agent-deck" and resolved_agent_deck_session_id:
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
        "provider_id": resolved_provider_id,
        "provider_session_id": resolved_provider_session_id,
        "agent_deck_session_id": resolved_agent_deck_session_id,
    }


@app.post("/api/projects/{project_path:path}/chat-items/closeout")
async def start_project_chat_item_closeout(
    project_path: str,
    request: ChatItemCloseoutRequest,
):
    (
        normalized_project_path,
        normalized_thread_id,
        session_record,
        thread_record,
        resolved_provider_id,
        resolved_provider_session_id,
        resolved_agent_deck_session_id,
    ) = (
        _resolve_chat_item_context(
            project_path,
            thread_id=request.thread_id,
            provider_id=request.provider_id,
            provider_session_id=request.provider_session_id,
            agent_deck_session_id=request.agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")
    if (
        normalized_thread_id is None
        and session_record is None
        and thread_record is None
        and (
            resolved_provider_id != "agent-deck"
            or resolved_agent_deck_session_id is None
        )
    ):
        raise HTTPException(status_code=404, detail="Chat item not found")
    if resolved_provider_id != "agent-deck" or not resolved_agent_deck_session_id:
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
    provider_id: str | None = None,
    provider_session_id: str | None = None,
    agent_deck_session_id: str | None = None,
):
    (
        normalized_project_path,
        normalized_thread_id,
        session_record,
        thread_record,
        resolved_provider_id,
        resolved_provider_session_id,
        resolved_agent_deck_session_id,
    ) = (
        _resolve_chat_item_context(
            project_path,
            thread_id=thread_id,
            provider_id=provider_id,
            provider_session_id=provider_session_id,
            agent_deck_session_id=agent_deck_session_id,
        )
    )
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")

    if normalized_thread_id:
        try:
            return await get_chat_activity_snapshot(
                normalized_project_path,
                normalized_thread_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except AgentDeckBridgeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if resolved_provider_id != "agent-deck" or not resolved_agent_deck_session_id:
        return {
            "thread_id": normalized_thread_id,
            "provider_id": resolved_provider_id,
            "provider_session_id": resolved_provider_session_id,
            "provider_session_title": getattr(session_record, "provider_session_title", None),
            "provider_agent_id": getattr(session_record, "provider_agent_id", None),
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
                "provider_id": resolved_provider_id,
                "provider_session_id": resolved_provider_session_id,
                "provider_session_title": getattr(session_record, "provider_session_title", None),
                "provider_agent_id": getattr(session_record, "provider_agent_id", None),
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
        "provider_id": "agent-deck",
        "provider_session_id": activity.session_id,
        "provider_session_title": activity.session_title,
        "provider_agent_id": activity.tool,
        "agent_deck_session_id": activity.session_id,
        "agent_deck_session_title": activity.session_title,
        "agent_deck_tool": activity.tool,
        "agent_deck_session_status": activity.status,
        "workspace_path": activity.workspace_path,
        "binding_state": "attached",
        "output": activity.output,
    }


def _backfill_chat_history_from_jsonl(
    project_path: str,
    chat_id: str,
) -> None:
    """One-time backfill of Claude JSONL turns into workstation_events.

    On reconnect the SSE replay only contains PF-managed turns.  Turns
    that originated directly in Agent Deck are missing because the hook
    ingestor writes them only while running.  This reads the underlying
    Claude JSONL and fills in the gaps so the full conversation replays.
    """
    marker = latest_workstation_event(
        project_path, chat_id, event_type="backfill_completed",
    )
    if marker is not None:
        return

    # If PF already wrote turn events for this chat during a live send,
    # those are authoritative — skip backfill to avoid duplicates.
    if chat_has_typed_turn_events(project_path, chat_id):
        append_workstation_event(
            project_path,
            chat_id,
            agent_deck_session_id=None,
            event_type="backfill_completed",
            payload={"skipped": True, "reason": "existing turn events found"},
        )
        return

    thread = get_live_editor_thread(chat_id)
    if thread is None or not thread.claude_session_id:
        return

    session = get_project_session(project_path, chat_id)
    if session is None:
        return

    jsonl_path = claude_jsonl_path(session.workspace_path, thread.claude_session_id)
    if jsonl_path is None or not jsonl_path.exists():
        jsonl_path = claude_jsonl_path(session.project_path, thread.claude_session_id)
    if jsonl_path is None or not jsonl_path.exists():
        return

    records: list[dict] = []
    try:
        with jsonl_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                    if isinstance(rec, dict):
                        records.append(rec)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return

    if not records:
        return

    turn_index = 0
    for rec in records:
        rec_type = rec.get("type")

        if rec_type == "user":
            message = rec.get("message")
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            if isinstance(content, str):
                user_text = content
            elif isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, str):
                        parts.append(block)
                    elif isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                user_text = "\n".join(parts)
            else:
                continue

            if not user_text.strip():
                continue

            turn_index += 1
            request_id = f"backfill-{chat_id}-{turn_index}"
            append_workstation_event(
                project_path,
                chat_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_input",
                payload={
                    "request_id": request_id,
                    "prompt": user_text.strip(),
                    "source": "backfill",
                },
            )

        elif rec_type == "assistant":
            payloads = claude_jsonl_payloads_for_record(rec)
            chunks = [
                p["content"]
                for p in payloads
                if p.get("type") == "chunk" and p.get("content")
            ]
            if chunks:
                request_id = f"backfill-{chat_id}-{turn_index}"
                append_workstation_event(
                    project_path,
                    chat_id,
                    agent_deck_session_id=session.agent_deck_session_id,
                    event_type="turn_chunk",
                    payload={
                        "request_id": request_id,
                        "content": "".join(chunks),
                        "source": "backfill",
                    },
                )

    if turn_index > 0:
        append_workstation_event(
            project_path,
            chat_id,
            agent_deck_session_id=session.agent_deck_session_id,
            event_type="backfill_completed",
            payload={
                "turns_backfilled": turn_index,
                "jsonl_path": str(jsonl_path),
            },
        )


@app.get("/api/projects/{project_path:path}/chats/{chat_id}/events")
async def stream_project_chat_events(
    project_path: str,
    chat_id: str,
    request: Request,
    from_now: bool = False,
    recent_limit: int = 0,
):
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        raise HTTPException(status_code=400, detail="chat_id is required")
    if not os.path.isdir(normalized_project_path):
        raise HTTPException(status_code=404, detail="Project path does not exist")
    if get_project_session(normalized_project_path, normalized_chat_id) is None:
        raise HTTPException(status_code=404, detail="Chat not found")

    if not from_now:
        _backfill_chat_history_from_jsonl(normalized_project_path, normalized_chat_id)

    async def event_stream():
        bounded_recent_limit = min(max(recent_limit, 0), 200)
        last_event_id = (
            latest_workstation_event_id(
                normalized_project_path,
                normalized_chat_id,
            )
            if from_now
            else 0
        )
        if from_now and bounded_recent_limit > 0:
            recent_events = list_recent_workstation_events(
                normalized_project_path,
                normalized_chat_id,
                limit=bounded_recent_limit,
            )
            for event in recent_events:
                if await request.is_disconnected():
                    return
                last_event_id = max(last_event_id, event.id)
                payload = json.dumps(
                    {
                        "id": event.id,
                        "event_type": event.event_type,
                        **event.payload,
                    }
                )
                yield f"id: {event.id}\nevent: {event.event_type}\ndata: {payload}\n\n"
        while True:
            if await request.is_disconnected():
                break

            events = list_workstation_events(
                normalized_project_path,
                normalized_chat_id,
                after_id=last_event_id,
            )
            if not events and not chat_has_primary_workstation_events(
                normalized_project_path,
                normalized_chat_id,
            ):
                try:
                    await sync_chat_activity_event(
                        normalized_project_path,
                        normalized_chat_id,
                    )
                except ValueError:
                    yield "event: error\ndata: {\"detail\":\"chat not found\"}\n\n"
                    break
                except AgentDeckBridgeError as exc:
                    payload = json.dumps({"detail": str(exc)})
                    yield f"event: error\ndata: {payload}\n\n"
                    await asyncio.sleep(1.0)
                    continue

                events = list_workstation_events(
                    normalized_project_path,
                    normalized_chat_id,
                    after_id=last_event_id,
                )
            if not events:
                yield ": keepalive\n\n"
                await asyncio.sleep(1.0)
                continue

            for event in events:
                last_event_id = max(last_event_id, event.id)
                payload = json.dumps(
                    {
                        "id": event.id,
                        "event_type": event.event_type,
                        **event.payload,
                    }
                )
                yield f"id: {event.id}\nevent: {event.event_type}\ndata: {payload}\n\n"

            await asyncio.sleep(0.25)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/events/status-bus")
async def stream_status_bus(
    request: Request,
    from_now: bool = False,
):
    async def event_stream():
        last_event_id = latest_status_bus_event_id() if from_now else 0
        while True:
            if await request.is_disconnected():
                break
            events = list_status_bus_events(after_id=last_event_id)
            if not events:
                yield ": keepalive\n\n"
                await asyncio.sleep(1.0)
                continue
            for event in events:
                last_event_id = max(last_event_id, event.id)
                payload = json.dumps(
                    {
                        "id": event.id,
                        "event_type": event.event_type,
                        "chat_id": event.chat_id,
                        **event.payload,
                    }
                )
                yield f"id: {event.id}\nevent: {event.event_type}\ndata: {payload}\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
    if current_runtime_kind() != "controller":
        raise HTTPException(
            status_code=400,
            detail="Nested Pixel Forge target launches are disabled inside target runtimes.",
        )
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


@app.get("/api/workspace-previews/candidates")
async def list_workspace_preview_candidates(workspace_path: str):
    try:
        candidates = await asyncio.to_thread(
            discover_workspace_preview_candidates,
            workspace_path,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "workspace_path": str(Path(workspace_path).expanduser().resolve()),
        "candidates": [
            serialize_workspace_preview_candidate(candidate)
            for candidate in candidates
        ],
    }


@app.get("/api/projects/capabilities")
async def get_project_capabilities(project_path: str):
    normalized_project_path = str(Path(project_path).expanduser().resolve())
    return {
        "project_path": normalized_project_path,
        "is_pixel_forge_workspace": _is_pixel_forge_workspace(normalized_project_path),
    }


@app.post("/api/workspace-previews/start")
async def start_workspace_preview_route(payload: WorkspacePreviewStartRequest):
    try:
        record = await asyncio.to_thread(
            start_workspace_preview,
            payload.workspace_path,
            relative_app_path=payload.relative_app_path,
            script_name=payload.script_name,
            package_manager=payload.package_manager,
            force_restart=payload.force_restart,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return serialize_workspace_preview(record)


@app.get("/api/controller-update")
async def get_pending_controller_update():
    update = await asyncio.to_thread(read_pending_controller_update)
    return {"update": update}


@app.get("/api/controller-release-update")
async def get_controller_release_update():
    return {"state": await asyncio.to_thread(read_controller_release_update)}


@app.post("/api/controller-release-update/check")
async def check_controller_release_update_route(payload: ControllerReleaseCheckRequest):
    if current_runtime_kind() != "controller":
        raise HTTPException(
            status_code=400,
            detail="Release update checks are only available in the controller runtime.",
        )
    return {
        "state": await asyncio.to_thread(
            check_controller_release_update,
            force=payload.force,
        ),
        "update": await asyncio.to_thread(read_pending_controller_update),
    }


@app.post("/api/controller-release-update/stage")
async def stage_controller_release_update_route(payload: ControllerReleaseCheckRequest):
    if current_runtime_kind() != "controller":
        raise HTTPException(
            status_code=400,
            detail="Release update staging is only available in the controller runtime.",
        )
    try:
        return await asyncio.to_thread(
            stage_controller_release_update,
            force_check=payload.force,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/controller-release-update/skip")
async def skip_controller_release_update_route(payload: ControllerReleaseSkipRequest):
    if current_runtime_kind() != "controller":
        raise HTTPException(
            status_code=400,
            detail="Release update skipping is only available in the controller runtime.",
        )
    return {
        "state": await asyncio.to_thread(
            skip_controller_release_update,
            payload.version,
        )
    }


@app.get("/api/runtime-info")
async def get_runtime_info():
    return await asyncio.to_thread(read_runtime_info)


@app.get("/api/agent-providers")
async def get_agent_providers():
    return {
        "providers": [
            provider.to_dict()
            for provider in await asyncio.to_thread(list_agent_providers)
        ]
    }


@app.get("/api/agent-deck-surface")
async def get_agent_deck_surface_status():
    return {"surface": await asyncio.to_thread(read_agent_deck_surface_status)}


@app.post("/api/agent-deck-surface/start")
async def start_agent_deck_surface():
    _agent_provider_or_error("agent-deck")
    try:
        status = await asyncio.to_thread(ensure_agent_deck_surface_started)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"surface": status}


@app.delete("/api/agent-deck-surface")
async def delete_agent_deck_surface():
    return {"surface": await asyncio.to_thread(stop_agent_deck_surface)}


@app.post("/api/agent-deck-tui/open")
async def open_agent_deck_tui():
    _agent_provider_or_error("agent-deck")

    def _spawn() -> dict[str, Any]:
        env = _pf_cli._agent_deck_tui_exec_env(for_external_terminal=True)
        command = _pf_cli._agent_deck_tui_terminal_command(
            _pf_cli.agent_deck_command(),
            env.get("PIXEL_FORGE_AGENT_DECK_TUI_TITLE", _pf_cli.agent_deck_tui_title()),
            _pf_cli.agent_deck_tui_wm_class(),
        )
        if command is None:
            raise RuntimeError(
                "No supported terminal emulator found for Agent Deck TUI. "
                "Install ghostty, gnome-terminal, or x-terminal-emulator."
            )
        import subprocess as _subprocess
        _subprocess.Popen(
            command,
            env=env,
            stdout=_subprocess.DEVNULL,
            stderr=_subprocess.DEVNULL,
            stdin=_subprocess.DEVNULL,
            start_new_session=True,
        )
        return {
            "ok": True,
            "home": env.get("PIXEL_FORGE_AGENT_DECK_HOME"),
            "title": env.get("PIXEL_FORGE_AGENT_DECK_TUI_TITLE"),
        }

    try:
        return await asyncio.to_thread(_spawn)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
    provider_session_id: str | None = None,
    agent_deck_session_id: str | None = None,
):
    update = await asyncio.to_thread(
        read_latest_pending_preview_update,
        project_path,
        workspace_path=workspace_path,
        provider_session_id=provider_session_id,
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
                "providerId": payload.provider_id,
                "providerSessionId": payload.provider_session_id,
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


@app.get("/api/workspace-directories", response_model=WorkspaceDirectoryListing)
async def list_workspace_directories(path: str | None = None):
    """Return a shallow, fast directory listing for the app-native workspace picker."""
    home_path = os.path.abspath(os.path.expanduser("~"))
    requested_path = path.strip() if isinstance(path, str) and path.strip() else home_path
    expanded_path = os.path.abspath(os.path.expanduser(requested_path))
    if not os.path.isdir(expanded_path):
        parent_path = os.path.dirname(expanded_path)
        expanded_path = parent_path if os.path.isdir(parent_path) else home_path

    entries: list[WorkspaceDirectoryEntry] = []
    try:
        with os.scandir(expanded_path) as iterator:
            for entry in iterator:
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    entries.append(
                        WorkspaceDirectoryEntry(
                            name=entry.name,
                            path=os.path.abspath(entry.path),
                        )
                    )
                except OSError:
                    continue
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    entries.sort(key=lambda item: (item.name.startswith("."), item.name.casefold()))
    parent_path = os.path.dirname(expanded_path)
    if parent_path == expanded_path:
        parent_path = None
    return WorkspaceDirectoryListing(
        path=expanded_path,
        parent_path=parent_path,
        home_path=home_path,
        entries=entries,
    )


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
    if current_runtime_kind() != "controller" and preview_mode == "browser":
        preview_mode = "proxy"

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
                        "pdfSelectionKind": selection.pdfSelectionKind,
                        "pdfTextRange": selection.pdfTextRange,
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
                reveal=bool(payload.reveal),
            )
        elif payload.action == "refresh":
            tab = await MANAGED_BROWSER_PREVIEW.refresh_tab(payload.browser_tab_id)
        elif payload.action == "click":
            if payload.x is None or payload.y is None:
                raise HTTPException(status_code=422, detail="x and y are required")
            tab = await MANAGED_BROWSER_PREVIEW.click_tab(
                payload.browser_tab_id,
                payload.x,
                payload.y,
            )
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


@app.get("/api/live-editor/live-preview-context")
async def read_live_preview_context(
    project_path: str,
    request_id: str,
):
    try:
        stored_payload = read_live_preview_context_artifact(project_path, request_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return await refresh_live_preview_context(
        stored_payload,
        preview_manager=MANAGED_BROWSER_PREVIEW,
    )


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
    global AGENT_DECK_NATIVE_EVENT_TASK
    if AGENT_DECK_NATIVE_EVENT_TASK is None or AGENT_DECK_NATIVE_EVENT_TASK.done():
        AGENT_DECK_NATIVE_EVENT_TASK = asyncio.create_task(
            AGENT_DECK_NATIVE_EVENT_INGESTOR.run()
        )


@app.on_event("shutdown")
async def shutdown_managed_browser_preview():
    global AGENT_DECK_NATIVE_EVENT_TASK
    if AGENT_DECK_NATIVE_EVENT_TASK is not None:
        AGENT_DECK_NATIVE_EVENT_TASK.cancel()
        with suppress(asyncio.CancelledError):
            await AGENT_DECK_NATIVE_EVENT_TASK
        AGENT_DECK_NATIVE_EVENT_TASK = None
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


def _requires_explicit_live_attach(message: str) -> bool:
    normalized = re.sub(r"\s+", " ", (message or "").strip().lower())
    if not normalized:
        return False

    attach_hints = (
        "live attach",
        "live-attach",
        "cdp attach",
        "attach proof",
        "attach-proof",
        "chrome-devtools-mcp",
        "browser url",
        "browserurl",
    )
    proof_hints = (
        "proof",
        "exercise",
        "must attach",
        "require attach",
        "real attach",
        "warm session",
    )
    return any(hint in normalized for hint in attach_hints) and any(
        hint in normalized for hint in proof_hints
    )


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


_LIVE_PREVIEW_HASH_VOLATILE_KEYS = frozenset(
    {
        "captured_at",
        "refreshed_at",
        "live_context_fresh",
    }
)


def _hash_live_preview_context(
    live_preview_context: dict[str, object] | None,
) -> str | None:
    """Stable content hash for a live-preview-context payload.

    Excludes volatile wall-clock fields so turns with identical substance do
    not churn the hash and re-trigger re-attachment of the preview artifact.
    """
    if not isinstance(live_preview_context, dict):
        return None
    filtered = {
        key: value
        for key, value in live_preview_context.items()
        if key not in _LIVE_PREVIEW_HASH_VOLATILE_KEYS
    }
    try:
        encoded = json.dumps(filtered, sort_keys=True, default=str).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(encoded).hexdigest()


def _summarize_live_preview_context(
    live_preview_context: dict[str, object] | None,
) -> dict[str, object] | None:
    if not isinstance(live_preview_context, dict):
        return None

    summary: dict[str, object] = {
        "mode": live_preview_context.get("mode"),
        "preview_url": live_preview_context.get("preview_url"),
        "preview_title": live_preview_context.get("preview_title"),
        "browser_tab_id": live_preview_context.get("browser_tab_id"),
        "proxy_session_id": live_preview_context.get("proxy_session_id"),
        "live_inspection_available": bool(live_preview_context.get("live_inspection_available")),
        "live_inspection_mode": live_preview_context.get("live_inspection_mode"),
        "live_attach_available": bool(live_preview_context.get("live_attach_available")),
        "live_attach_mode": live_preview_context.get("live_attach_mode"),
        "current_url": live_preview_context.get("current_url"),
        "current_title": live_preview_context.get("current_title"),
        "surface_kind": live_preview_context.get("surface_kind"),
        "page_count": live_preview_context.get("page_count"),
        "visible_page_numbers": live_preview_context.get("visible_page_numbers"),
        "ready_state": live_preview_context.get("ready_state"),
        "viewport": live_preview_context.get("viewport"),
        "attach_hints": live_preview_context.get("attach_hints"),
    }

    raw_matches = live_preview_context.get("selection_matches")
    if isinstance(raw_matches, list):
        summary["selection_matches"] = [
            {
                "selection_id": entry.get("selection_id"),
                "found": entry.get("found"),
                "visible": entry.get("visible"),
                "surface_kind": entry.get("surface_kind"),
                "pdf_page": entry.get("pdf_page"),
                "xpath": entry.get("xpath"),
                "tag_name": entry.get("tag_name"),
                "text_excerpt": entry.get("text_excerpt"),
            }
            for entry in raw_matches[:4]
            if isinstance(entry, dict)
        ]

    return {key: value for key, value in summary.items() if value not in (None, [], {})}


def build_live_editor_context_patch(
    *,
    thread_id: str,
    provider_id: str | None,
    provider_session_id: str | None,
    provider_session_title: str | None,
    provider_agent_id: str | None,
    agent_deck_session_id: str | None,
    agent_deck_session_title: str | None,
    agent_deck_tool: str | None,
    workspace_path: str | None,
    preview_url: str | None,
    selection_tunnel: dict[str, object] | None,
    selection_count: int,
    continuation_mode: Literal["bootstrap", "attached-session", "delta"],
    informational_only: bool,
    live_preview_context: dict[str, object] | None,
) -> dict[str, object]:
    patch: dict[str, object] = {
        "source": "pixel-forge",
        "thread_id": thread_id,
        "continuation_mode": continuation_mode,
        "informational_only": informational_only,
        "selection_count": selection_count,
        "selection_sources": [
            {
                "label": label,
                "url": url,
                "count": count,
            }
            for label, url, count in _selection_source_summary(selection_tunnel)
        ],
    }

    if workspace_path:
        patch["workspace_path"] = workspace_path
    if preview_url:
        patch["preview_url"] = preview_url
    if provider_id or provider_session_id or provider_session_title or provider_agent_id:
        patch["provider_session"] = {
            key: value
            for key, value in {
                "provider_id": provider_id,
                "id": provider_session_id,
                "title": provider_session_title,
                "agent_id": provider_agent_id,
            }.items()
            if value
        }
    if agent_deck_session_id or agent_deck_session_title or agent_deck_tool:
        patch["agent_session"] = {
            key: value
            for key, value in {
                "id": agent_deck_session_id,
                "title": agent_deck_session_title,
                "tool": agent_deck_tool,
            }.items()
            if value
        }

    live_preview_summary = _summarize_live_preview_context(live_preview_context)
    if live_preview_summary is not None:
        patch["live_preview"] = live_preview_summary

    return patch


def _provider_session_id_from_info(session_info) -> str | None:
    return (
        getattr(session_info, "provider_session_id", None)
        or getattr(session_info, "agent_deck_session_id", None)
    )


def _provider_session_title_from_info(session_info) -> str | None:
    return (
        getattr(session_info, "title", None)
        or getattr(session_info, "provider_session_title", None)
        or getattr(session_info, "agent_deck_session_title", None)
    )


def _provider_agent_id_from_info(session_info) -> str | None:
    return (
        getattr(session_info, "agent_id", None)
        or getattr(session_info, "tool", None)
        or getattr(session_info, "provider_agent_id", None)
    )


def build_live_editor_dispatch_prompt(
    request_file_path: str,
    *,
    request_id: str | None = None,
    turn_input_file_path: str | None = None,
    turn_input_payload: dict[str, object] | None = None,
    preview_url: str | None = None,
    selection_tunnel: dict[str, object] | None = None,
    selection_tunnel_url: str | None = None,
    live_preview_context_url: str | None = None,
    context_patch: dict[str, object] | None = None,
    requested_skills: list[str] | None = None,
    self_edit_safe_mode: bool = False,
    self_edit_scope: Literal["controller", "preview"] | None = None,
    continuation_mode: Literal["bootstrap", "attached-session", "delta"] = "bootstrap",
    informational_only: bool = False,
    explicit_live_attach_required: bool = False,
    tool: str = "claude",
    exclude_attachment_paths: set[str] | list[str] | tuple[str, ...] | None = None,
    include_live_preview_context: bool = True,
) -> str:
    del request_id
    del preview_url
    del selection_tunnel
    del selection_tunnel_url
    del live_preview_context_url
    del context_patch
    del requested_skills
    del self_edit_safe_mode
    del self_edit_scope
    del informational_only
    del explicit_live_attach_required

    normalized_continuation_mode = (
        continuation_mode if continuation_mode in {"bootstrap", "attached-session", "delta"}
        else "bootstrap"
    )
    is_bootstrap_turn = normalized_continuation_mode == "bootstrap"

    prompt_text = ""
    if isinstance(turn_input_payload, dict):
        raw_prompt_text = turn_input_payload.get("prompt_text")
        if isinstance(raw_prompt_text, str):
            prompt_text = raw_prompt_text.strip()
    if not prompt_text:
        prompt_text = "Use the attached Pixel Forge turn context."

    live_preview_attach_block = ""
    if isinstance(turn_input_payload, dict):
        raw_live_preview = turn_input_payload.get("live_preview")
        live_preview_attach_block_lines = live_preview_attach_lines(
            raw_live_preview if isinstance(raw_live_preview, dict) else None
        )
        if live_preview_attach_block_lines:
            live_preview_attach_block = (
                "\n\nLive preview attach hints:\n"
                + "\n".join(live_preview_attach_block_lines)
            )

    reference_paths: list[str] = []
    seen_paths: set[str] = set()
    excluded_paths = {
        path.strip()
        for path in (exclude_attachment_paths or [])
        if isinstance(path, str) and path.strip()
    }

    def append_reference(path_value: object | None) -> None:
        if not isinstance(path_value, str):
            return
        normalized_path = path_value.strip()
        if (
            not normalized_path
            or normalized_path in excluded_paths
            or normalized_path in seen_paths
        ):
            return
        seen_paths.add(normalized_path)
        reference_paths.append(normalized_path)

    append_reference(turn_input_file_path)

    if isinstance(turn_input_payload, dict):
        raw_artifacts = turn_input_payload.get("artifacts")
        if isinstance(raw_artifacts, dict):
            artifact_keys: list[str] = []
            if is_bootstrap_turn:
                artifact_keys.append("session_brief_file")
            artifact_keys.extend(
                [
                    "context_patch_file",
                    "selected_elements_file",
                    "selection_tunnel_file",
                ]
            )
            if include_live_preview_context:
                artifact_keys.append("live_preview_context_file")
            for key in artifact_keys:
                append_reference(raw_artifacts.get(key))

        raw_attachments = turn_input_payload.get("attachments")
        if isinstance(raw_attachments, list):
            for attachment in raw_attachments:
                if isinstance(attachment, dict):
                    append_reference(attachment.get("path"))

    if not reference_paths:
        append_reference(request_file_path)

    prompt_text = f"{prompt_text}{live_preview_attach_block}"

    if not reference_paths:
        return prompt_text

    normalized_tool = tool.strip().lower()
    if normalized_tool == "codex":
        return f"{prompt_text}\n\nContext files:\n" + "\n".join(reference_paths)

    return f"{prompt_text}\n\n" + "\n".join(
        f"@{path}" for path in reference_paths
    )


def _native_image_attachment_paths(
    turn_input_payload: dict[str, object] | None,
) -> list[str]:
    if not isinstance(turn_input_payload, dict):
        return []

    image_paths: list[str] = []
    seen_paths: set[str] = set()
    raw_attachments = turn_input_payload.get("attachments")
    if not isinstance(raw_attachments, list):
        return []

    for attachment in raw_attachments:
        if not isinstance(attachment, dict):
            continue
        path_value = attachment.get("path")
        if not isinstance(path_value, str):
            continue
        normalized_path = path_value.strip()
        if not normalized_path or normalized_path in seen_paths:
            continue
        mime_type = attachment.get("mime_type")
        kind = attachment.get("kind")
        if kind == "image" or (
            isinstance(mime_type, str) and mime_type.startswith("image/")
        ):
            seen_paths.add(normalized_path)
            image_paths.append(normalized_path)

    return image_paths


async def _dispatch_live_editor_prompt_to_agent_provider(
    *,
    agent_provider,
    session_info,
    websocket: WebSocket,
    dispatch_prompt: str,
    native_image_paths: list[str] | None = None,
    turn_request: AgentTurnRequest | None = None,
    on_status: LiveEditorStatusCallback | None = None,
) -> tuple[str, asyncio.Task[object], asyncio.Task[object] | None]:
    status_heartbeat_task: asyncio.Task[object] | None = None
    dispatch = await agent_provider.dispatch_turn(
        session_info,
        project_path=session_info.workspace_path,
        prompt=dispatch_prompt,
        image_paths=native_image_paths,
        startup_timeout_seconds=LIVE_EDITOR_AGENT_STARTUP_TIMEOUT_SECONDS,
        completion_timeout_seconds=LIVE_EDITOR_AGENT_COMPLETION_TIMEOUT_SECONDS,
        request=turn_request,
    )
    turn_wait_task = dispatch.wait_task
    if dispatch.status_heartbeat:
        status_heartbeat_task = asyncio.create_task(
            _emit_live_editor_wait_heartbeat(
                websocket,
                tool=session_info.tool,
                provider_label=agent_provider.display_name,
                wait_task=turn_wait_task,
                on_status=on_status,
            )
        )

    await websocket.send_json(
        {
            "type": "status",
            "message": dispatch.status_message,
        }
    )
    if on_status is not None:
        await on_status(dispatch.status_message)

    return dispatch.baseline_output, turn_wait_task, status_heartbeat_task


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
        error_msg = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode("utf-8", errors="replace"))
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
        error_msg = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode("utf-8", errors="replace"))
    return result.get("result", ""), session_id or ""


@app.get("/api/status")
async def api_status():
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
        error_msg = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode("utf-8", errors="replace"))
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

                    line_str = line.decode("utf-8", errors="replace").strip()
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
                    error_msg = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
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
    Live Editor WebSocket endpoint backed by agent provider sessions.
    Stores each request as a disk request pack and dispatches a short prompt
    into a persistent provider session for the target project.
    """
    await websocket.accept()
    print("[live-editor] Connection opened", flush=True)

    try:
        while True:
            # Receive chat message
            data = await websocket.receive_json()
            print(f"[live-editor] Received: {list(data.keys())}", flush=True)

            turn_input = _live_editor_turn_input(data)
            target_intent = _live_editor_target_intent(data)
            target_intent_mode = _target_intent_mode(target_intent)
            message = _turn_input_value(turn_input, data, "prompt", "")
            if not isinstance(message, str) or not message.strip():
                message = _turn_input_value(turn_input, data, "message", "")
            if not isinstance(message, str):
                message = ""
            element_context = _turn_input_value(turn_input, data, "element_context", "")
            selection_tunnel = _turn_input_value(turn_input, data, "selection_tunnel")
            attachments = _turn_input_value(turn_input, data, "attachments", None) or []
            legacy_images = data.get("images") or []
            thread_id = data.get("chat_id") or data.get("thread_id") or data.get("session_id")
            project_path = data.get("project_path", "")
            preview_url = _turn_input_value(turn_input, data, "preview_url", "")
            live_preview = _turn_input_value(turn_input, data, "live_preview")
            target_intent_agent_id = target_intent.get("agent_id")
            agent_type = target_intent_agent_id or data.get("agent_type", "claude")
            agent_model = data.get("agent_model")
            agent_thinking = data.get("agent_thinking")
            workspace_mode_value = target_intent.get("workspace_mode") or data.get("workspace_mode")
            workspace_mode = (
                workspace_mode_value.strip()
                if isinstance(workspace_mode_value, str) and workspace_mode_value.strip()
                else "root"
            )
            target_provider_id = (
                target_intent.get("provider_id")
                or data.get("target_provider_id")
                or data.get("provider_id")
            )
            provider_id = (
                target_provider_id.strip()
                if isinstance(target_provider_id, str) and target_provider_id.strip()
                else "agent-deck"
            )
            target_agent_deck_session_id = data.get("target_agent_deck_session_id")
            target_provider_session_id = _live_editor_target_session_id(
                target_intent=target_intent,
                target_intent_mode=target_intent_mode,
                data=data,
            )

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
            turn_event_base: dict[str, object] | None = None
            turn_terminal_event_written = False

            try:
                request_message = message.strip() or "Use the attached reference files as context for this live edit."
                requested_skills = extract_requested_skills(request_message)
                informational_only = _is_informational_live_editor_request(request_message)
                explicit_live_attach_required = _requires_explicit_live_attach(request_message)
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
                thread = _hydrate_live_editor_thread_from_project_session(
                    normalized_project_path,
                    thread,
                )
                turn_policy = AgentTurnPolicy(
                    autonomy="no-approval",
                    no_approval=True,
                )
                turn_request = AgentTurnRequest(
                    project_path=normalized_project_path,
                    workspace_path=getattr(thread, "workspace_path", None),
                    thread_id=thread.thread_id,
                    prompt=request_message,
                    agent_id=agent_type if isinstance(agent_type, str) else "claude",
                    workspace_mode=workspace_mode,
                    target_provider_session_id=(
                        target_provider_session_id
                        if isinstance(target_provider_session_id, str)
                        else None
                    ),
                    agent_model=agent_model if isinstance(agent_model, str) else None,
                    agent_thinking=agent_thinking if isinstance(agent_thinking, str) else None,
                    policy=turn_policy,
                )
                try:
                    agent_provider = _live_editor_agent_provider_or_error(
                        provider_id,
                        agent_type=agent_type,
                        target_provider_session_id=(
                            target_provider_session_id
                            if isinstance(target_provider_session_id, str)
                            else None
                        ),
                        thread=thread,
                    )
                except HTTPException as exc:
                    await websocket.send_json({
                        "type": "error",
                        "message": str(exc.detail),
                        "failed_provider_id": provider_id,
                        "failed_agent_type": agent_type,
                        "retry_options": (
                            _direct_cli_retry_options_for_agent(agent_type)
                            if provider_id == "agent-deck"
                            else []
                        ),
                    })
                    continue
                previous_request_id = thread.last_request_id
                previous_provider_session_id = thread.provider_session_id
                previous_live_preview_hash = thread.last_live_preview_hash
                preflight_snapshot_path = _write_live_editor_preflight_snapshot(
                    project_path=normalized_project_path,
                    thread_id=thread.thread_id,
                    request_message=request_message,
                    element_context=element_context if isinstance(element_context, str) else "",
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    attachments=attachments,
                    preview_url=preview_url if isinstance(preview_url, str) else "",
                    live_preview=live_preview,
                    target_provider_id=provider_id,
                    target_provider_session_id=target_provider_session_id,
                    agent_type=agent_type,
                    workspace_mode=workspace_mode,
                    target_agent_deck_session_id=target_agent_deck_session_id,
                    target_intent=target_intent,
                    agent_model=agent_model,
                    agent_thinking=agent_thinking,
                    selection_count=selection_count,
                )
                preflight_snapshot_relative_path = _project_relative_path(
                    normalized_project_path,
                    preflight_snapshot_path,
                )

                await websocket.send_json(
                    {
                        "type": "status",
                        "message": f"Resolving {agent_provider.display_name} session...",
                    }
                )

                try:
                    session_info = await asyncio.wait_for(
                        agent_provider.ensure_live_session(
                            normalized_project_path,
                            thread,
                            agent_type=agent_type,
                            workspace_mode=workspace_mode,
                            target_provider_session_id=(
                                target_provider_session_id
                                if isinstance(target_provider_session_id, str)
                                else None
                            ),
                            agent_model=(
                                agent_model if isinstance(agent_model, str) else None
                            ),
                            agent_thinking=(
                                agent_thinking if isinstance(agent_thinking, str) else None
                            ),
                            request=turn_request,
                        ),
                        timeout=LIVE_EDITOR_AGENT_RESOLUTION_TIMEOUT_SECONDS,
                    )
                except TimeoutError as exc:
                    raise AgentDeckBridgeError(
                        f"Timed out resolving {agent_provider.display_name} session after "
                        f"{int(LIVE_EDITOR_AGENT_RESOLUTION_TIMEOUT_SECONDS)}s. "
                        "The request was not sent, but a recovery snapshot was "
                        f"saved at `{preflight_snapshot_relative_path}`."
                    ) from exc
                except AgentDeckBridgeError as exc:
                    provider_missing_session_error = getattr(
                        agent_provider,
                        "is_missing_session_error",
                        None,
                    )
                    missing_provider_session = (
                        provider_missing_session_error(exc)
                        if callable(provider_missing_session_error)
                        else _is_missing_provider_session_error(exc)
                    )
                    if target_provider_session_id and missing_provider_session:
                        detach_project_session_binding(
                            normalized_project_path,
                            thread.thread_id,
                        )
                        thread = update_live_editor_thread(
                            thread.thread_id,
                            backend=agent_provider.provider_id,
                            provider_id="",
                            provider_session_id="",
                            provider_session_title="",
                            provider_agent_id="",
                            agent_deck_session_id="",
                            agent_deck_session_title="",
                        )
                        raise AgentDeckBridgeError(
                            f"{agent_provider.display_name} session `{target_provider_session_id}` "
                            "was missing. Pixel Forge detached that stale binding from this chat. "
                            "Retry to create a fresh provider lane, or use a direct CLI retry option."
                        ) from exc
                    raise
                if agent_provider.provider_id == "agent-deck":
                    _assert_agent_deck_lane_available(
                        normalized_project_path,
                        thread.thread_id,
                        session_info.agent_deck_session_id,
                    )
                provider_session_id = _provider_session_id_from_info(session_info)
                provider_session_title = _provider_session_title_from_info(session_info)
                provider_agent_id = _provider_agent_id_from_info(session_info)
                agent_deck_session_id = (
                    provider_session_id if agent_provider.provider_id == "agent-deck" else None
                )
                agent_deck_session_title = (
                    provider_session_title if agent_provider.provider_id == "agent-deck" else None
                )
                agent_deck_tool = (
                    provider_agent_id if agent_provider.provider_id == "agent-deck" else None
                )
                thread = update_live_editor_thread(
                    thread.thread_id,
                    backend=agent_provider.provider_id,
                    workspace_path=session_info.workspace_path,
                    provider_id=agent_provider.provider_id,
                    provider_session_id=provider_session_id,
                    provider_session_title=provider_session_title,
                    provider_agent_id=provider_agent_id,
                    agent_deck_session_id=agent_deck_session_id,
                    agent_deck_session_title=agent_deck_session_title,
                    acpx_agent=session_info.acpx_agent or "",
                    acpx_session_name=session_info.acpx_session_name or "",
                    acpx_record_id=session_info.acpx_record_id or "",
                    acp_session_id=session_info.acp_session_id or "",
                    claude_session_id=session_info.claude_session_id or "",
                )
                upsert_session(
                    normalized_project_path,
                    thread_id=thread.thread_id,
                    backend=agent_provider.provider_id,
                    workspace_path=session_info.workspace_path,
                    provider_id=agent_provider.provider_id,
                    provider_session_id=provider_session_id,
                    provider_session_title=provider_session_title,
                    provider_agent_id=provider_agent_id,
                    agent_deck_session_id=agent_deck_session_id,
                    agent_deck_session_title=agent_deck_session_title,
                    agent_deck_tool=agent_deck_tool,
                )
                self_edit_scope = (
                    _resolve_self_edit_scope(
                        normalized_project_path,
                        session_info.workspace_path,
                    )
                    if self_edit_safe_mode
                    else None
                )
                live_preview_context = await capture_live_preview_context(
                    live_preview,
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    preview_manager=MANAGED_BROWSER_PREVIEW,
                )
                current_live_preview_hash = _hash_live_preview_context(live_preview_context)
                if previous_request_id:
                    continuation_mode: Literal["bootstrap", "attached-session", "delta"] = "delta"
                elif (
                    previous_provider_session_id
                    and previous_provider_session_id == provider_session_id
                ):
                    continuation_mode = "attached-session"
                else:
                    continuation_mode = "bootstrap"

                context_patch = build_live_editor_context_patch(
                    thread_id=thread.thread_id,
                    provider_id=agent_provider.provider_id,
                    provider_session_id=provider_session_id,
                    provider_session_title=provider_session_title,
                    provider_agent_id=provider_agent_id,
                    agent_deck_session_id=agent_deck_session_id,
                    agent_deck_session_title=agent_deck_session_title,
                    agent_deck_tool=agent_deck_tool,
                    workspace_path=session_info.workspace_path,
                    preview_url=preview_url or None,
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    selection_count=selection_count,
                    continuation_mode=continuation_mode,
                    informational_only=informational_only,
                    live_preview_context=live_preview_context,
                )

                request_pack = create_request_pack(
                    session_info.workspace_path,
                    thread.thread_id,
                    request_message,
                    element_context,
                    attachments,
                    provider_id=agent_provider.provider_id,
                    provider_session_id=provider_session_id,
                    provider_session_title=provider_session_title,
                    provider_agent_id=provider_agent_id,
                    agent_deck_session_id=agent_deck_session_id,
                    agent_deck_session_title=agent_deck_session_title,
                    acpx_agent=session_info.acpx_agent,
                    acpx_session_name=session_info.acpx_session_name,
                    acpx_record_id=session_info.acpx_record_id,
                    acp_session_id=session_info.acp_session_id,
                    preview_url=preview_url or None,
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    live_preview_context=live_preview_context,
                    turn_context_patch=context_patch if continuation_mode != "bootstrap" else None,
                    continuation_mode=continuation_mode,
                    informational_only=informational_only,
                    explicit_live_attach_required=explicit_live_attach_required,
                    canonical_project_path=normalized_project_path,
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
                with suppress(OSError):
                    preflight_snapshot_path.unlink()
                thread = update_live_editor_thread(
                    thread.thread_id,
                    last_request_id=request_pack.request_id,
                    last_live_preview_hash=(
                        current_live_preview_hash
                        if current_live_preview_hash is not None
                        else None
                    ),
                )
                turn_event_base = {
                    "request_id": request_pack.request_id,
                    "provider_id": agent_provider.provider_id,
                    "provider_session_id": provider_session_id,
                    "provider_session_title": provider_session_title,
                    "provider_agent_id": provider_agent_id,
                    "agent_deck_session_id": agent_deck_session_id,
                    "agent_deck_session_title": agent_deck_session_title,
                    "agent_deck_tool": agent_deck_tool,
                    "workspace_path": session_info.workspace_path,
                    "request_relative_directory": request_pack.relative_directory,
                    "request_relative_file": request_pack.relative_request_file,
                }

                async def append_turn_event(
                    event_type: str,
                    payload: dict[str, object],
                ) -> None:
                    nonlocal turn_terminal_event_written
                    if turn_event_base is None:
                        return
                    append_workstation_event(
                        normalized_project_path,
                        thread.thread_id,
                        agent_deck_session_id=agent_deck_session_id,
                        event_type=event_type,
                        payload={
                            **turn_event_base,
                            **payload,
                        },
                    )
                    if event_type in {"turn_completed", "turn_failed"}:
                        turn_terminal_event_written = True

                async def emit_turn_status(message: str) -> None:
                    if message.strip():
                        await append_turn_event("turn_status", {"message": message})

                async def mirror_stream_payload(payload: dict[str, object]) -> None:
                    payload_type = str(payload.get("type") or "").strip().lower()
                    if payload_type == "chunk":
                        content = payload.get("content")
                        if isinstance(content, str) and content:
                            await append_turn_event("turn_chunk", {"content": content})
                    elif payload_type == "status":
                        message = payload.get("message")
                        if isinstance(message, str) and message:
                            await emit_turn_status(message)

                await append_turn_event(
                    "turn_input",
                    {
                        "turn_input": request_pack.turn_input_payload,
                    },
                )

                await append_turn_event(
                    "turn_started",
                    {
                        "selection_count": selection_count,
                        "continuation_mode": continuation_mode,
                        "informational_only": informational_only,
                        "self_edit_safe_mode": self_edit_safe_mode,
                        "self_edit_scope": self_edit_scope,
                        "preview_url": preview_url or None,
                    },
                )

                await websocket.send_json(
                    {
                        "type": "session",
                        "session_id": thread.thread_id,
                        "backend": agent_provider.provider_id,
                        "workspace_path": session_info.workspace_path,
                        "provider_id": agent_provider.provider_id,
                        "provider_session_id": provider_session_id,
                        "provider_session_title": provider_session_title,
                        "provider_agent_id": provider_agent_id,
                        "agent_deck_session_id": agent_deck_session_id,
                        "agent_deck_session_title": agent_deck_session_title,
                        "agent_deck_tool": agent_deck_tool,
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
                dispatch_status_message = (
                    f"Sending Pixel Forge turn into existing {agent_provider.display_name} session..."
                    if continuation_mode == "attached-session"
                    else f"Sending Pixel Forge turn to {agent_provider.display_name}..."
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "message": dispatch_status_message,
                    }
                )
                await emit_turn_status(dispatch_status_message)

                native_image_paths = (
                    _native_image_attachment_paths(request_pack.turn_input_payload)
                    if session_info.tool == "codex"
                    else []
                )
                dispatch_prompt = build_live_editor_dispatch_prompt(
                    request_pack.relative_request_file,
                    request_id=request_pack.request_id,
                    turn_input_file_path=request_pack.relative_turn_input_file,
                    turn_input_payload=request_pack.turn_input_payload,
                    preview_url=preview_url or None,
                    selection_tunnel=selection_tunnel if isinstance(selection_tunnel, dict) else None,
                    selection_tunnel_url=(
                        f"http://{runtime_url_host()}:{runtime_api_port()}/api/live-editor/selection-tunnel?"
                        + urlencode(
                            {
                                "project_path": session_info.workspace_path,
                                "request_id": request_pack.request_id,
                            }
                        )
                        if request_pack.relative_selection_tunnel_file
                        else None
                    ),
                    live_preview_context_url=(
                        f"http://{runtime_url_host()}:{runtime_api_port()}/api/live-editor/live-preview-context?"
                        + urlencode(
                            {
                                "project_path": session_info.workspace_path,
                                "request_id": request_pack.request_id,
                            }
                        )
                        if request_pack.relative_live_preview_context_file
                        else None
                    ),
                    context_patch=context_patch if continuation_mode != "bootstrap" else None,
                    self_edit_safe_mode=self_edit_safe_mode,
                    self_edit_scope=self_edit_scope,
                    continuation_mode=continuation_mode,
                    informational_only=informational_only,
                    explicit_live_attach_required=explicit_live_attach_required,
                    requested_skills=requested_skills,
                    tool=session_info.tool,
                    exclude_attachment_paths=native_image_paths,
                    include_live_preview_context=(
                        continuation_mode == "bootstrap"
                        or current_live_preview_hash is None
                        or current_live_preview_hash != previous_live_preview_hash
                    ),
                )
                dispatch_turn_request = AgentTurnRequest(
                    project_path=normalized_project_path,
                    workspace_path=session_info.workspace_path,
                    thread_id=thread.thread_id,
                    prompt=dispatch_prompt,
                    agent_id=session_info.tool or (
                        agent_type if isinstance(agent_type, str) else "claude"
                    ),
                    workspace_mode=workspace_mode,
                    target_provider_session_id=provider_session_id,
                    agent_model=agent_model if isinstance(agent_model, str) else None,
                    agent_thinking=agent_thinking if isinstance(agent_thinking, str) else None,
                    image_paths=tuple(native_image_paths),
                    request_pack_path=request_pack.relative_request_file,
                    request_pack_directory=request_pack.relative_directory,
                    policy=turn_policy,
                )
                assistant_output = ""
                if session_info.acpx_agent and session_info.acpx_session_name:
                    refreshed_acpx_session, fallback_output, streamed_text = await prompt_acpx_session(
                        session_info.acpx_agent,
                        session_info.workspace_path,
                        session_info.acpx_session_name,
                        dispatch_prompt,
                        websocket=websocket,
                        on_emit=mirror_stream_payload,
                    )
                    thread = update_live_editor_thread(
                        thread.thread_id,
                        acpx_agent=refreshed_acpx_session.agent or "",
                        acpx_session_name=refreshed_acpx_session.session_name or "",
                        acpx_record_id=refreshed_acpx_session.acpx_record_id or "",
                        acp_session_id=refreshed_acpx_session.acp_session_id or "",
                    )
                    assistant_output = fallback_output
                    if fallback_output and not streamed_text:
                        await websocket.send_json(
                            {
                                "type": "chunk",
                                "content": fallback_output,
                            }
                        )
                        await append_turn_event("turn_chunk", {"content": fallback_output})
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
                    ) = await _dispatch_live_editor_prompt_to_agent_provider(
                        agent_provider=agent_provider,
                        session_info=session_info,
                        websocket=websocket,
                        dispatch_prompt=dispatch_prompt,
                        native_image_paths=native_image_paths,
                        turn_request=dispatch_turn_request,
                        on_status=emit_turn_status,
                    )
                    send_task = turn_wait_task

                    stream_stats = None
                    if agent_provider.provider_id != "agent-deck":
                        direct_output = await turn_wait_task
                        if isinstance(direct_output, str) and direct_output:
                            await websocket.send_json(
                                {
                                    "type": "chunk",
                                    "content": direct_output,
                                }
                            )
                            await append_turn_event("turn_chunk", {"content": direct_output})
                            assistant_output = direct_output
                    elif session_info.tool == "claude" and jsonl_path:
                        stream_stats = await stream_claude_jsonl(
                            websocket,
                            jsonl_path,
                            start_offset,
                            send_task,
                            on_emit=mirror_stream_payload,
                        )
                    elif session_info.tool == "codex" and jsonl_path:
                        stream_stats = await stream_codex_jsonl(
                            websocket,
                            jsonl_path,
                            start_offset,
                            send_task,
                            on_emit=mirror_stream_payload,
                        )
                    elif session_info.tool == "codex":
                        stream_stats = await stream_codex_session_output(
                            websocket,
                            agent_deck_session_id=session_info.agent_deck_session_id,
                            baseline_output=baseline_output,
                            prompt=dispatch_prompt,
                            wait_task=send_task,
                            on_emit=mirror_stream_payload,
                        )

                    if agent_provider.provider_id == "agent-deck":
                        await turn_wait_task
                        assistant_output = getattr(stream_stats, "last_output", "")

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
                                await append_turn_event("turn_chunk", {"content": fallback_output})
                                assistant_output = fallback_output

                if agent_provider.provider_id == "agent-deck":
                    refreshed_session = await agent_provider.ensure_live_session(
                        normalized_project_path,
                        thread,
                        agent_type=agent_type,
                        workspace_mode=workspace_mode,
                    )
                else:
                    refreshed_session = session_info
                if agent_provider.provider_id == "agent-deck":
                    _assert_agent_deck_lane_available(
                        normalized_project_path,
                        thread.thread_id,
                        refreshed_session.agent_deck_session_id,
                    )
                refreshed_provider_session_id = _provider_session_id_from_info(refreshed_session)
                refreshed_provider_session_title = _provider_session_title_from_info(refreshed_session)
                refreshed_provider_agent_id = _provider_agent_id_from_info(refreshed_session)
                refreshed_agent_deck_session_id = (
                    refreshed_provider_session_id
                    if agent_provider.provider_id == "agent-deck"
                    else None
                )
                refreshed_agent_deck_session_title = (
                    refreshed_provider_session_title
                    if agent_provider.provider_id == "agent-deck"
                    else None
                )
                refreshed_agent_deck_tool = (
                    refreshed_provider_agent_id
                    if agent_provider.provider_id == "agent-deck"
                    else None
                )
                update_live_editor_thread(
                    thread.thread_id,
                    backend=agent_provider.provider_id,
                    workspace_path=refreshed_session.workspace_path,
                    provider_id=agent_provider.provider_id,
                    provider_session_id=refreshed_provider_session_id,
                    provider_session_title=refreshed_provider_session_title,
                    provider_agent_id=refreshed_provider_agent_id,
                    agent_deck_session_id=refreshed_agent_deck_session_id,
                    agent_deck_session_title=refreshed_agent_deck_session_title,
                    acpx_agent=refreshed_session.acpx_agent or "",
                    acpx_session_name=refreshed_session.acpx_session_name or "",
                    acpx_record_id=refreshed_session.acpx_record_id or "",
                    acp_session_id=refreshed_session.acp_session_id or "",
                    claude_session_id=refreshed_session.claude_session_id or "",
                )
                upsert_session(
                    normalized_project_path,
                    thread_id=thread.thread_id,
                    backend=agent_provider.provider_id,
                    workspace_path=refreshed_session.workspace_path,
                    provider_id=agent_provider.provider_id,
                    provider_session_id=refreshed_provider_session_id,
                    provider_session_title=refreshed_provider_session_title,
                    provider_agent_id=refreshed_provider_agent_id,
                    agent_deck_session_id=refreshed_agent_deck_session_id,
                    agent_deck_session_title=refreshed_agent_deck_session_title,
                    agent_deck_tool=refreshed_agent_deck_tool,
                )
                refreshed_self_edit_scope = (
                    _resolve_self_edit_scope(
                        normalized_project_path,
                        refreshed_session.workspace_path,
                    )
                    if self_edit_safe_mode
                    else None
                )
                is_remote_target = _is_remote_preview(preview_url or None)

                await append_turn_event(
                    "turn_completed",
                    {
                        "provider_id": agent_provider.provider_id,
                        "provider_session_id": refreshed_provider_session_id,
                        "provider_session_title": refreshed_provider_session_title,
                        "provider_agent_id": refreshed_provider_agent_id,
                        "agent_deck_session_id": refreshed_agent_deck_session_id,
                        "agent_deck_session_title": refreshed_agent_deck_session_title,
                        "agent_deck_tool": refreshed_agent_deck_tool,
                        "workspace_path": refreshed_session.workspace_path,
                        "selection_count": selection_count,
                        "self_edit_safe_mode": self_edit_safe_mode,
                        "self_edit_scope": refreshed_self_edit_scope,
                        "is_remote_target": is_remote_target,
                        "assistant_output": assistant_output,
                    },
                )

                await websocket.send_json(
                    {
                        "type": "complete",
                        "session_id": thread.thread_id,
                        "backend": agent_provider.provider_id,
                        "workspace_path": refreshed_session.workspace_path,
                        "provider_id": agent_provider.provider_id,
                        "provider_session_id": refreshed_provider_session_id,
                        "provider_session_title": refreshed_provider_session_title,
                        "provider_agent_id": refreshed_provider_agent_id,
                        "agent_deck_session_id": refreshed_agent_deck_session_id,
                        "agent_deck_session_title": refreshed_agent_deck_session_title,
                        "agent_deck_tool": refreshed_agent_deck_tool,
                        "acpx_agent": refreshed_session.acpx_agent,
                        "acpx_session_name": refreshed_session.acpx_session_name,
                        "acpx_record_id": refreshed_session.acpx_record_id,
                        "acp_session_id": refreshed_session.acp_session_id,
                        "request_id": request_pack.request_id,
                        "selection_count": selection_count,
                        "self_edit_safe_mode": self_edit_safe_mode,
                        "self_edit_scope": refreshed_self_edit_scope,
                        "is_remote_target": is_remote_target,
                    }
                )

            except (AgentDeckBridgeError, AcpxBridgeError, ValueError) as e:
                if turn_event_base is not None and not turn_terminal_event_written:
                    await append_turn_event(
                        "turn_failed",
                        {
                            "message": str(e),
                        },
                    )
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": str(e),
                        "failed_provider_id": provider_id,
                        "failed_agent_type": agent_type,
                        "retry_options": (
                            _direct_cli_retry_options_for_agent(agent_type)
                            if provider_id == "agent-deck"
                            else []
                        ),
                    }
                )
            except Exception as e:
                if turn_wait_task and not turn_wait_task.done():
                    turn_wait_task.cancel()
                if status_heartbeat_task and not status_heartbeat_task.done():
                    status_heartbeat_task.cancel()
                if turn_event_base is not None and not turn_terminal_event_written:
                    await append_turn_event(
                        "turn_failed",
                        {
                            "message": str(e),
                        },
                    )
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
