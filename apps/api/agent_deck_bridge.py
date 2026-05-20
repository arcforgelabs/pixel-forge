from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import shutil
import tempfile
import urllib.error
import urllib.request
from contextlib import suppress
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4

from acpx_bridge import AcpxSessionInfo, ensure_acpx_session, parse_agent_deck_acpx_command
from agent_deck_launch import (
    PI_LOCAL_MODEL_RE,
    PI_OLLAMA_BASE_URL,
    PI_OLLAMA_TAGS_URL,
    build_agent_deck_launch_args,
    resolve_agent_model_effort_args as _resolve_agent_model_effort_args,
)
from agent_deck_runtime import agent_deck_available, agent_deck_command, agent_deck_env
from live_editor_threads import LiveEditorThreadRecord
from memory_governance import plan_agent_deck_launch_admission


CLAUDE_DIR_NAME_RE = re.compile(r"[^a-zA-Z0-9-]")
STREAM_IDLE_AFTER_COMPLETION_SECONDS = 1.0
STREAM_POLL_INTERVAL_SECONDS = 0.2
CODEX_POLL_INTERVAL_SECONDS = 1.0
CODEX_READY_PROMPT_PREFIX = "› "
EMPTY_SESSION_LIST_RE = re.compile(r"^No sessions found in profile '.*'\.$")
AGENT_DECK_LAUNCH_RECOVERY_TIMEOUT_SECONDS = 45.0
AGENT_DECK_COMMAND_TIMEOUT_SECONDS = 3.0
AGENT_DECK_SEND_COMMAND_TIMEOUT_SECONDS = 45.0
AGENT_DECK_LAUNCH_COMMAND_TIMEOUT_SECONDS = 25.0
AGENT_DECK_CLEANUP_COMMAND_TIMEOUT_SECONDS = 90.0
StreamPayloadCallback = Callable[[dict[str, object]], Awaitable[None]]
AgentDeckLaunchSession = Callable[..., Awaitable[dict[str, object]]]
def _pi_agent_dir() -> Path:
    configured = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".pi" / "agent"


def _read_ollama_model_ids() -> list[str]:
    request = urllib.request.Request(
        PI_OLLAMA_TAGS_URL,
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=0.8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return []

    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        return []

    ids: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        model_id = item.get("model") or item.get("name")
        if isinstance(model_id, str) and model_id.strip():
            ids.append(model_id.strip())
    return sorted(set(ids))


def _load_pi_models_config(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AgentDeckBridgeError(
            f"Pi models config is invalid JSON: {path}"
        ) from exc
    if not isinstance(payload, dict):
        raise AgentDeckBridgeError(f"Pi models config must be a JSON object: {path}")
    return payload


def _write_pi_models_config(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    fd, tmp_name = tempfile.mkstemp(
        prefix=".models.",
        suffix=".json.tmp",
        dir=str(path.parent),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def _sync_pi_ollama_models_for_launch(agent_model: str | None) -> None:
    model = (agent_model or "").strip()
    if not model.startswith("ollama/"):
        return

    selected_model_id = model.split("/", 1)[1].strip()
    if not selected_model_id:
        return

    path = _pi_agent_dir() / "models.json"
    payload = _load_pi_models_config(path)
    providers = payload.get("providers")
    if not isinstance(providers, dict):
        providers = {}
        payload["providers"] = providers

    existing_provider = providers.get("ollama")
    ollama_provider: dict[str, object] = (
        dict(existing_provider) if isinstance(existing_provider, dict) else {}
    )
    existing_models = ollama_provider.get("models")
    models_by_id: dict[str, dict[str, object]] = {}
    if isinstance(existing_models, list):
        for item in existing_models:
            if not isinstance(item, dict):
                continue
            model_id = item.get("id")
            if isinstance(model_id, str) and model_id.strip():
                models_by_id[model_id.strip()] = dict(item)

    for model_id in [*_read_ollama_model_ids(), selected_model_id]:
        models_by_id.setdefault(model_id, {"id": model_id})

    existing_compat = ollama_provider.get("compat")
    compat = {
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": False,
    }
    if isinstance(existing_compat, dict):
        compat.update(existing_compat)

    ollama_provider.update(
        {
            "baseUrl": str(ollama_provider.get("baseUrl") or PI_OLLAMA_BASE_URL),
            "api": str(ollama_provider.get("api") or "openai-completions"),
            "apiKey": str(ollama_provider.get("apiKey") or "ollama"),
            "compat": compat,
            "models": [models_by_id[model_id] for model_id in sorted(models_by_id)],
        }
    )
    providers["ollama"] = ollama_provider
    _write_pi_models_config(path, payload)


@dataclass(slots=True)
class AgentDeckSessionInfo:
    agent_deck_session_id: str
    agent_deck_session_title: str
    workspace_path: str
    tmux_session: str | None
    tool: str
    status: str | None
    acpx_agent: str | None
    acpx_session_name: str | None
    acpx_record_id: str | None
    acp_session_id: str | None
    claude_session_id: str | None
    codex_session_id: str | None
    gemini_session_id: str | None = None
    jsonl_path: Path | None = None


@dataclass(slots=True)
class AgentDeckSessionTarget:
    id: str
    title: str
    path: str
    group: str | None
    tool: str | None
    command: str | None
    status: str | None
    created_at: str | None
    memory_rss_bytes: int | None = None
    memory_swap_bytes: int | None = None
    process_count: int | None = None


@dataclass(slots=True)
class AgentDeckSessionActionContext:
    session_id: str
    session_title: str
    group_path: str | None
    workspace_path: str
    repo_root: str
    target_branch: str | None
    is_clone: bool
    is_worktree: bool
    clone_dirty: bool | None
    clone_branch_state: str | None


@dataclass(slots=True)
class AgentDeckDeleteAssessment:
    session_id: str
    session_title: str
    workspace_path: str
    repo_root: str
    target_branch: str | None
    is_clone: bool
    is_worktree: bool
    has_activity: bool
    requires_closeout: bool
    can_force_delete: bool
    detail: str


@dataclass(slots=True)
class ClaudeStreamStats:
    streamed_text: bool = False
    last_output: str = ""


@dataclass(slots=True)
class SessionOutputStreamStats:
    streamed_text: bool = False
    last_output: str = ""


@dataclass(slots=True)
class AgentDeckSessionActivity:
    session_id: str
    session_title: str
    workspace_path: str
    tool: str | None
    status: str | None
    output: str


class AgentDeckBridgeError(RuntimeError):
    pass


def _is_missing_session_error(error: BaseException | str) -> bool:
    message = str(error).lower()
    return (
        "not_found" in message
        or "not found" in message
        or "session missing" in message
    )


def _is_already_exists_session_error(error: BaseException | str) -> bool:
    message = str(error).lower()
    return "already_exists" in message or "session already exists" in message


def _is_agent_deck_timeout_error(error: BaseException | str) -> bool:
    return "timed out after" in str(error).lower()


def _existing_session_id_from_already_exists_error(error: BaseException | str) -> str | None:
    message = str(error)
    match = re.search(r"session already exists:\s+.*\(([^()]+)\)", message, re.IGNORECASE)
    if not match:
        return None
    candidate = match.group(1).strip()
    return candidate or None


def _project_slug(project_path: str) -> str:
    project_name = Path(project_path).resolve().name or "project"
    slug = re.sub(r"[^a-z0-9-]+", "-", project_name.lower()).strip("-")
    return slug or "project"


def _session_title(project_path: str, thread_id: str) -> str:
    normalized = thread_id.strip() if isinstance(thread_id, str) else ""
    return normalized or "chat"


def _is_legacy_pixel_forge_session_title(project_path: str, title: str | None) -> bool:
    if not isinstance(title, str):
        return False
    stripped = title.strip()
    if not stripped:
        return False
    legacy_prefix = f"pixel-forge-{_project_slug(project_path)}-"
    return stripped.startswith(legacy_prefix)


def _preferred_thread_session_title(
    project_path: str,
    thread: LiveEditorThreadRecord,
) -> str:
    persisted = _normalized_text(thread.agent_deck_session_title)
    if persisted and not _is_legacy_pixel_forge_session_title(project_path, persisted):
        return persisted
    return _session_title(project_path, thread.thread_id)


def _group_path(project_path: str) -> str:
    return f"pixel-forge/{_project_slug(project_path)}"


def _normalize_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def _clone_root(project_path: str) -> str:
    return str(Path(_normalize_path(project_path)) / ".agents")


def _is_descendant_path(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _session_belongs_to_project(project_path: str, session_path: str) -> bool:
    normalized_project_path = _normalize_path(project_path)
    normalized_session_path = _normalize_path(session_path)
    if normalized_session_path == normalized_project_path:
        return True
    return _is_descendant_path(
        normalized_session_path,
        _clone_root(normalized_project_path),
    )


def _session_matches_project_context(
    project_path: str,
    *,
    session_path: str,
    group_path: str | None = None,
) -> bool:
    if _session_belongs_to_project(project_path, session_path):
        return True
    if _normalized_text(group_path) != _group_path(project_path):
        return False

    normalized_project_path = _normalize_path(project_path)
    normalized_session_path = _normalize_path(session_path)
    return _is_descendant_path(normalized_project_path, normalized_session_path)


def _clone_name(session_title: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", session_title.lower()).strip("-")
    return normalized or uuid4().hex[:8]


def _openclaw_session_key(session_title: str) -> str:
    return f"agent:main:{_clone_name(session_title)}"


def _thread_rebind_workspace_path(
    project_path: str,
    thread: LiveEditorThreadRecord,
) -> str | None:
    normalized_project_path = _normalize_path(project_path)
    normalized_workspace_path = _normalize_path(thread.workspace_path)
    if normalized_workspace_path == normalized_project_path:
        return None
    if not os.path.isdir(normalized_workspace_path):
        return None
    if not _session_belongs_to_project(normalized_project_path, normalized_workspace_path):
        return None
    return normalized_workspace_path


@lru_cache(maxsize=16)
def _resolve_runtime_executable(binary_name: str) -> str:
    normalized_binary_name = binary_name.strip()
    if not normalized_binary_name:
        raise AgentDeckBridgeError("Executable name is required")

    direct_match = shutil.which(normalized_binary_name)
    if direct_match:
        return direct_match

    search_paths: list[str] = []
    seen_paths: set[str] = set()

    def append_path(path_value: str | Path | None) -> None:
        if path_value is None:
            return
        normalized_path = str(path_value).strip()
        if not normalized_path or normalized_path in seen_paths:
            return
        seen_paths.add(normalized_path)
        search_paths.append(normalized_path)

    for path_value in os.environ.get("PATH", "").split(os.pathsep):
        append_path(path_value)

    home = Path.home()
    for extra_path in (
        home / ".npm-global" / "bin",
        home / ".local" / "bin",
        home / ".local" / "share" / "pnpm",
        home / "bin",
        home / ".bun" / "bin",
        home / ".cargo" / "bin",
    ):
        append_path(extra_path)

    nvm_versions_root = home / ".nvm" / "versions" / "node"
    if nvm_versions_root.is_dir():
        for version_dir in sorted(
            (entry for entry in nvm_versions_root.iterdir() if entry.is_dir()),
            key=lambda entry: entry.name,
            reverse=True,
        ):
            append_path(version_dir / "bin")

    if search_paths:
        resolved = shutil.which(normalized_binary_name, path=os.pathsep.join(search_paths))
        if resolved:
            return resolved

    raise AgentDeckBridgeError(
        f"Executable `{normalized_binary_name}` is not available in the Pixel Forge service environment"
    )


def _command_timeout_message(args: list[str], timeout_seconds: float) -> str:
    command = " ".join(args[:3]) if args else "command"
    return f"{command} timed out after {timeout_seconds:.1f}s"


async def _communicate_with_timeout(
    proc: asyncio.subprocess.Process,
    args: list[str],
    timeout_seconds: float | None,
) -> tuple[int, str, str]:
    try:
        if timeout_seconds and timeout_seconds > 0:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout_seconds,
            )
        else:
            stdout, stderr = await proc.communicate()
    except TimeoutError:
        with suppress(ProcessLookupError):
            if os.name == "nt":
                proc.kill()
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        stdout, stderr = await proc.communicate()
        timeout_message = _command_timeout_message(args, timeout_seconds or 0)
        decoded_stderr = stderr.decode("utf-8", errors="replace")
        if decoded_stderr.strip():
            decoded_stderr = f"{decoded_stderr.rstrip()}\n{timeout_message}"
        else:
            decoded_stderr = timeout_message
        return (
            124,
            stdout.decode("utf-8", errors="replace"),
            decoded_stderr,
        )

    return (
        proc.returncode,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


async def _run_command(
    args: list[str],
    cwd: str | None = None,
    *,
    timeout_seconds: float | None = None,
) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        start_new_session=(os.name != "nt"),
    )
    return await _communicate_with_timeout(proc, args, timeout_seconds)


async def _run_command_with_env(
    args: list[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: float | None = None,
) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
        start_new_session=(os.name != "nt"),
    )
    return await _communicate_with_timeout(proc, args, timeout_seconds)


def _agent_deck_args(*args: str) -> list[str]:
    require_launch_yolo = bool(args and args[0] == "launch" and "--yolo" in args)
    command = (
        agent_deck_command(require_launch_yolo=True)
        or agent_deck_command(require_launch_yolo=require_launch_yolo)
    )
    if not command:
        _, reason = agent_deck_available(require_launch_yolo=require_launch_yolo)
        raise AgentDeckBridgeError(
            reason or "Agent Deck provider is disabled or no Agent Deck command is configured"
        )
    return [*command, *args]


def _env_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if not isinstance(raw, str) or not raw.strip():
        return fallback
    try:
        value = float(raw.strip())
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _agent_deck_command_timeout_seconds(args: list[str]) -> float:
    if args and args[0] == "launch":
        return _env_float(
            "PIXEL_FORGE_AGENT_DECK_LAUNCH_TIMEOUT_SECONDS",
            AGENT_DECK_LAUNCH_COMMAND_TIMEOUT_SECONDS,
        )
    if len(args) >= 2 and args[0] == "session" and args[1] == "send":
        return _env_float(
            "PIXEL_FORGE_AGENT_DECK_SEND_TIMEOUT_SECONDS",
            AGENT_DECK_SEND_COMMAND_TIMEOUT_SECONDS,
        )
    if args and args[0] in {"clone", "rm"}:
        return _env_float(
            "PIXEL_FORGE_AGENT_DECK_CLEANUP_TIMEOUT_SECONDS",
            AGENT_DECK_CLEANUP_COMMAND_TIMEOUT_SECONDS,
        )
    return _env_float(
        "PIXEL_FORGE_AGENT_DECK_COMMAND_TIMEOUT_SECONDS",
        AGENT_DECK_COMMAND_TIMEOUT_SECONDS,
    )


async def _run_agent_deck_command(
    args: list[str],
    *,
    cwd: str | None = None,
) -> tuple[int, str, str]:
    return await _run_command_with_env(
        _agent_deck_args(*args),
        cwd=cwd,
        env=agent_deck_env(),
        timeout_seconds=_agent_deck_command_timeout_seconds(args),
    )


def _decode_json_output(stdout: str, args: list[str]) -> object:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AgentDeckBridgeError(
            f"Agent Deck returned non-JSON output for {' '.join(args)}"
        ) from exc


def _decode_agent_deck_json_output(stdout: str, args: list[str]) -> object:
    trimmed = stdout.strip()
    if (
        args
        and args[0] in {"ls", "list"}
        and "-json" in args
        and EMPTY_SESSION_LIST_RE.fullmatch(trimmed)
    ):
        return []
    return _decode_json_output(stdout, _agent_deck_args(*args))


async def _run_json_command(args: list[str], cwd: str | None = None) -> object:
    code, stdout, stderr = await _run_command(args, cwd=cwd)
    if code != 0:
        error_output = stderr.strip() or stdout.strip() or "Unknown error"
        raise AgentDeckBridgeError(error_output)

    return _decode_json_output(stdout, args)


async def _run_json_object_command(args: list[str], cwd: str | None = None) -> dict[str, object]:
    payload = await _run_json_command(args, cwd=cwd)
    if not isinstance(payload, dict):
        raise AgentDeckBridgeError(
            f"Agent Deck returned an unexpected JSON shape for {' '.join(args)}"
        )
    return payload


async def _run_json_array_command(args: list[str], cwd: str | None = None) -> list[object]:
    payload = await _run_json_command(args, cwd=cwd)
    if not isinstance(payload, list):
        raise AgentDeckBridgeError(
            f"Agent Deck returned an unexpected JSON shape for {' '.join(args)}"
        )
    return payload


async def _run_agent_deck_json_command(args: list[str], cwd: str | None = None) -> object:
    code, stdout, stderr = await _run_agent_deck_command(args, cwd=cwd)
    if code != 0:
        error_output = stderr.strip() or stdout.strip() or "Unknown error"
        raise AgentDeckBridgeError(error_output)
    return _decode_agent_deck_json_output(stdout, args)


async def _run_agent_deck_json_object_command(
    args: list[str],
    cwd: str | None = None,
) -> dict[str, object]:
    payload = await _run_agent_deck_json_command(args, cwd=cwd)
    if not isinstance(payload, dict):
        raise AgentDeckBridgeError(
            f"Agent Deck returned an unexpected JSON shape for {' '.join(_agent_deck_args(*args))}"
        )
    return payload


async def _run_agent_deck_json_array_command(
    args: list[str],
    cwd: str | None = None,
) -> list[object]:
    payload = await _run_agent_deck_json_command(args, cwd=cwd)
    if not isinstance(payload, list):
        raise AgentDeckBridgeError(
            f"Agent Deck returned an unexpected JSON shape for {' '.join(_agent_deck_args(*args))}"
        )
    return payload


def _payload_int(payload: dict[str, object], key: str) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


async def _enforce_agent_deck_launch_admission() -> None:
    try:
        payload = await _run_agent_deck_json_array_command(["ls", "-json"])
    except AgentDeckBridgeError as exc:
        if _is_agent_deck_timeout_error(exc):
            return
        raise
    sessions = [entry for entry in payload if isinstance(entry, dict)]
    decision = plan_agent_deck_launch_admission(sessions)

    for session_id in decision.stop_idle_session_ids:
        code, stdout, stderr = await _run_agent_deck_command(["session", "stop", session_id, "-q"])
        if code != 0 and not _is_missing_session_error(stderr.strip() or stdout.strip()):
            raise AgentDeckBridgeError(
                stderr.strip()
                or stdout.strip()
                or f"Failed to park idle Agent Deck session `{session_id}` before launch"
            )

    if not decision.allowed:
        raise AgentDeckBridgeError(decision.reason or "Agent Deck launch blocked by memory governance")


def _convert_to_claude_dir_name(path: str) -> str:
    return CLAUDE_DIR_NAME_RE.sub("-", path)


def _claude_config_dir() -> Path:
    claude_config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if claude_config_dir:
        return Path(claude_config_dir)
    return Path.home() / ".claude"


def _codex_home_dir() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return Path(codex_home)
    return Path.home() / ".codex"


def claude_jsonl_path(project_path: str, claude_session_id: str | None) -> Path | None:
    if not claude_session_id:
        return None

    resolved_project_path = str(Path(project_path).resolve())
    project_dir = _convert_to_claude_dir_name(resolved_project_path)
    if not project_dir:
        project_dir = "-"

    session_path = (
        _claude_config_dir()
        / "projects"
        / project_dir
        / f"{claude_session_id}.jsonl"
    )
    if session_path.exists():
        return session_path
    return session_path


def codex_jsonl_path(codex_session_id: str | None) -> Path | None:
    if not codex_session_id:
        return None

    sessions_root = _codex_home_dir() / "sessions"
    if not sessions_root.exists():
        return None

    suffix = f"{codex_session_id}.jsonl"
    latest_match: Path | None = None
    latest_mtime = -1
    for path in sessions_root.rglob("*.jsonl"):
        if not path.name.endswith(suffix):
            continue
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            continue
        if latest_match is None or mtime > latest_mtime:
            latest_match = path
            latest_mtime = mtime
    return latest_match


async def session_show(agent_deck_session_id: str) -> dict[str, object]:
    return await _run_agent_deck_json_object_command(
        ["session", "show", agent_deck_session_id, "-json"]
    )


async def _start_existing_session(agent_deck_session_id: str) -> None:
    code, _, stderr = await _run_agent_deck_command(
        ["session", "start", agent_deck_session_id]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to start Agent Deck session")


async def _rename_session(agent_deck_session_id: str, new_title: str) -> None:
    code, _, stderr = await _run_agent_deck_command(
        ["rename", agent_deck_session_id, new_title]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to rename Agent Deck session")


async def _launch_new_session(
    project_path: str,
    *,
    session_title: str,
    agent_type: str = "claude",
    workspace_mode: str = "root",
    workspace_path: str | None = None,
    agent_model: str | None = None,
    agent_thinking: str | None = None,
    turn_request: object | None = None,
) -> dict[str, object]:
    await _enforce_agent_deck_launch_admission()
    del workspace_mode
    normalized_agent_type = agent_type.strip().lower() or "claude"
    if normalized_agent_type == "pi":
        await asyncio.to_thread(_sync_pi_ollama_models_for_launch, agent_model)
    args = build_agent_deck_launch_args(
        project_path,
        session_title=session_title,
        agent_type=normalized_agent_type,
        workspace_path=workspace_path,
        agent_model=agent_model,
        agent_thinking=agent_thinking,
        policy=getattr(turn_request, "policy", None),
    )
    return await _run_agent_deck_json_object_command(args)


def _payload_session_metadata(
    payload: dict[str, object],
    *,
    fallback_title: str,
    default_path: str,
) -> tuple[str, str, str | None, str | None]:
    agent_deck_title = str(payload.get("title") or fallback_title)
    workspace_path = str(payload.get("path") or "").strip() or _normalize_path(default_path)
    tmux_session = (
        str(payload.get("tmux_session")).strip()
        if isinstance(payload.get("tmux_session"), str) and str(payload.get("tmux_session")).strip()
        else None
    )
    status = (
        str(payload.get("status")).strip()
        if isinstance(payload.get("status"), str) and str(payload.get("status")).strip()
        else None
    )
    return agent_deck_title, workspace_path, tmux_session, status


def _session_tool(payload: dict[str, object], default: str = "claude") -> str:
    tool = payload.get("tool")
    if isinstance(tool, str) and tool.strip():
        return tool.strip().lower()
    return default


def _tmux_target(tmux_session: str | None) -> str | None:
    if not isinstance(tmux_session, str):
        return None
    normalized = tmux_session.strip()
    if not normalized:
        return None
    return f"{normalized}:0.0"


def _parsed_acpx_payload(payload: dict[str, object]) -> tuple[str, str] | None:
    command = payload.get("command")
    return parse_agent_deck_acpx_command(
        command if isinstance(command, str) else None
    )


def _is_acpx_backed_payload(payload: dict[str, object]) -> bool:
    return _parsed_acpx_payload(payload) is not None


def _session_title_for_target(project_path: str, suffix: str | None = None) -> str:
    raw_suffix = suffix.strip() if isinstance(suffix, str) else ""
    normalized_suffix = re.sub(r"[^a-z0-9-]+", "-", raw_suffix.lower()).strip("-")
    if not normalized_suffix:
        normalized_suffix = uuid4().hex[:8]
    return f"chat-{normalized_suffix}"


def _payload_to_session_target(payload: dict[str, object]) -> AgentDeckSessionTarget:
    session_id = str(payload.get("id") or "").strip()
    if not session_id:
        raise AgentDeckBridgeError("Agent Deck session payload is missing an id")

    path = str(payload.get("path") or "").strip()
    command = str(payload.get("command")).strip() if isinstance(payload.get("command"), str) and str(payload.get("command")).strip() else None
    parsed_acpx_command = parse_agent_deck_acpx_command(command)
    tool_value: str | None
    if parsed_acpx_command is not None:
        tool_value = parsed_acpx_command[0]
    else:
        tool_value = str(payload.get("tool")).strip() if isinstance(payload.get("tool"), str) and str(payload.get("tool")).strip() else None
    return AgentDeckSessionTarget(
        id=session_id,
        title=str(payload.get("title") or session_id),
        path=path,
        group=str(payload.get("group")).strip() if isinstance(payload.get("group"), str) and str(payload.get("group")).strip() else None,
        tool=tool_value,
        command=command,
        status=str(payload.get("status")).strip() if isinstance(payload.get("status"), str) and str(payload.get("status")).strip() else None,
        created_at=str(payload.get("created_at")).strip() if isinstance(payload.get("created_at"), str) and str(payload.get("created_at")).strip() else None,
        memory_rss_bytes=_payload_int(payload, "memory_rss_bytes"),
        memory_swap_bytes=_payload_int(payload, "memory_swap_bytes"),
        process_count=_payload_int(payload, "process_count"),
    )


def _normalized_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _require_matching_project_path(project_path: str, payload: dict[str, object]) -> None:
    payload_path = payload.get("path")
    if not isinstance(payload_path, str) or not payload_path.strip():
        raise AgentDeckBridgeError("Agent Deck session is missing a workspace path")

    if not _session_belongs_to_project(project_path, payload_path):
        raise AgentDeckBridgeError(
            "Chosen Agent Deck session is bound to a different workspace path"
        )


async def _list_project_session_targets(
    project_path: str,
    *,
    include_acpx_backed: bool,
) -> list[AgentDeckSessionTarget]:
    payload = await _run_agent_deck_json_array_command(["ls", "-json"])
    sessions: list[AgentDeckSessionTarget] = []
    normalized_project_path = _normalize_path(project_path)

    for entry in payload:
        if not isinstance(entry, dict):
            continue

        session_path = entry.get("path")
        if not isinstance(session_path, str) or not session_path.strip():
            continue

        if not _session_matches_project_context(
            project_path,
            session_path=session_path,
            group_path=_normalized_text(entry.get("group")),
        ):
            continue

        if not include_acpx_backed and _is_acpx_backed_payload(entry):
            continue

        session_id = _normalized_text(entry.get("id"))
        normalized_session_path = _normalize_path(session_path)
        is_root_session = normalized_session_path == normalized_project_path
        if (
            session_id
            and not is_root_session
            and not os.path.isdir(normalized_session_path)
        ):
            code, stdout, stderr = await _run_agent_deck_command(["rm", session_id, "-q"])
            error_output = stderr.strip() or stdout.strip()
            if code == 0 or _is_missing_session_error(error_output):
                continue

        sessions.append(_payload_to_session_target(entry))

    return sessions


async def _find_live_editor_session_id_by_title(
    project_path: str,
    *,
    session_title: str,
    requested_agent_type: str,
) -> str | None:
    normalized_title = _normalized_text(session_title)
    if not normalized_title:
        return None
    normalized_agent_type = requested_agent_type.strip().lower()
    try:
        sessions = await _list_project_session_targets(
            project_path,
            include_acpx_backed=True,
        )
    except AgentDeckBridgeError as exc:
        if _is_agent_deck_timeout_error(exc):
            return None
        raise

    for session in sessions:
        if session.title != normalized_title:
            continue
        if normalized_agent_type and session.tool and session.tool != normalized_agent_type:
            continue
        return session.id
    return None


async def list_project_agent_deck_sessions(project_path: str) -> list[AgentDeckSessionTarget]:
    return await _list_project_session_targets(
        project_path,
        include_acpx_backed=False,
    )


async def list_live_editor_agent_deck_sessions(project_path: str) -> list[AgentDeckSessionTarget]:
    return await _list_project_session_targets(
        project_path,
        include_acpx_backed=True,
    )


async def create_agent_deck_session_target(
    project_path: str,
    *,
    agent_type: str = "claude",
    title: str | None = None,
    workspace_mode: str = "root",
    agent_model: str | None = None,
    agent_thinking: str | None = None,
) -> AgentDeckSessionTarget:
    del workspace_mode
    session_title = title.strip() if isinstance(title, str) and title.strip() else _session_title_for_target(project_path)
    payload = await _launch_new_session(
        project_path,
        session_title=session_title,
        agent_type=agent_type.strip() or "claude",
        workspace_mode="root",
        agent_model=agent_model,
        agent_thinking=agent_thinking,
    )
    return _payload_to_session_target(payload)


async def rename_agent_deck_session_target(
    project_path: str,
    agent_deck_session_id: str,
    new_title: str,
) -> None:
    normalized_title = new_title.strip()
    if not normalized_title:
        raise AgentDeckBridgeError("Chat title cannot be empty")

    payload = await session_show(agent_deck_session_id)
    _require_matching_project_path(project_path, payload)
    await _rename_session(agent_deck_session_id, normalized_title)


def _session_output_has_meaningful_activity(output: str) -> bool:
    if not output.strip():
        return False

    ignored_substrings = (
        "Do you trust the contents of this directory?",
        "Press enter to continue",
        "Use /skills to list available skills",
        "OpenAI Codex",
        "Working with untrusted contents comes with higher risk",
    )
    ignored_prefixes = (
        "samuelrodda@",
        "model:",
        "directory:",
        "Tip:",
        "1. Yes, continue",
        "2. No, quit",
        "1) Yes, continue",
        "2) No, quit",
        "› 1. Yes, continue",
        "› Use /skills",
    )

    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("╭", "╰", "│")):
            continue
        if any(line.startswith(prefix) for prefix in ignored_prefixes):
            continue
        if any(fragment in line for fragment in ignored_substrings):
            continue
        return True

    return False


async def _default_local_branch(repo_root: str) -> str:
    for args in (
        ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    ):
        code, stdout, _ = await _run_command(args, cwd=repo_root)
        if code != 0:
            continue
        branch = stdout.strip()
        if branch.startswith("origin/"):
            branch = branch[len("origin/") :]
        if branch and branch != "HEAD":
            return branch

    for fallback in ("master", "main"):
        code, _, _ = await _run_command(
            ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{fallback}"],
            cwd=repo_root,
        )
        if code == 0:
            return fallback

    return "main"


async def _unique_group_session_title(group_path: str | None, preferred_title: str) -> str:
    payload = await _run_agent_deck_json_array_command(["ls", "-json"])
    normalized_group_path = _normalized_text(group_path)
    existing_titles = {
        str(entry.get("title")).strip()
        for entry in payload
        if isinstance(entry, dict)
        and _normalized_text(entry.get("group")) == normalized_group_path
        and isinstance(entry.get("title"), str)
        and str(entry.get("title")).strip()
    }
    return _unique_session_title(existing_titles, preferred_title)


async def _load_session_action_context(
    project_path: str,
    agent_deck_session_id: str,
) -> AgentDeckSessionActionContext:
    payload = await session_show(agent_deck_session_id)
    _require_matching_project_path(project_path, payload)

    normalized_project_path = _normalize_path(project_path)
    workspace_path = _normalized_text(payload.get("path")) or normalized_project_path
    normalized_workspace_path = _normalize_path(workspace_path)
    is_clone = _is_descendant_path(normalized_workspace_path, _clone_root(normalized_project_path))
    is_worktree = normalized_workspace_path != normalized_project_path and not is_clone
    session_title = _normalized_text(payload.get("title")) or agent_deck_session_id
    group_path = _normalized_text(payload.get("group"))
    repo_root = normalized_project_path
    target_branch: str | None = None
    clone_dirty: bool | None = None
    clone_branch_state: str | None = None

    if is_clone:
        clone_payload = await _run_agent_deck_json_object_command(
            ["clone", "info", agent_deck_session_id, "-json"]
        )
        repo_root = _normalize_path(
            _normalized_text(clone_payload.get("main_repo")) or normalized_project_path
        )
        target_branch = _normalized_text(clone_payload.get("target_branch"))
        clone_dirty = bool(clone_payload.get("dirty"))
        clone_branch_state = _normalized_text(clone_payload.get("branch_state"))
    elif is_worktree:
        target_branch = await _default_local_branch(repo_root)

    return AgentDeckSessionActionContext(
        session_id=agent_deck_session_id,
        session_title=session_title,
        group_path=group_path,
        workspace_path=normalized_workspace_path,
        repo_root=repo_root,
        target_branch=target_branch,
        is_clone=is_clone,
        is_worktree=is_worktree,
        clone_dirty=clone_dirty,
        clone_branch_state=clone_branch_state,
    )


async def assess_agent_deck_delete_state(
    project_path: str,
    agent_deck_session_id: str,
    *,
    thread_has_activity: bool = False,
) -> AgentDeckDeleteAssessment:
    context = await _load_session_action_context(project_path, agent_deck_session_id)
    session_output_activity = False
    if not thread_has_activity:
        session_output_activity = _session_output_has_meaningful_activity(
            await get_last_output(agent_deck_session_id)
        )

    has_activity = (
        thread_has_activity
        or session_output_activity
        or bool(context.clone_dirty)
        or (
            isinstance(context.clone_branch_state, str)
            and context.clone_branch_state not in {"", "in_sync"}
        )
    )
    requires_closeout = (context.is_clone or context.is_worktree) and has_activity

    if requires_closeout:
        detail = (
            f"`{context.session_title}` has Agent Deck activity. Run closeout before deleting, "
            "or use delete anyway for local no-merge cleanup."
        )
    elif context.is_clone and (context.clone_dirty or context.clone_branch_state not in {None, "", "in_sync"}):
        detail = (
            f"`{context.session_title}` has clone state that may need cleanup. "
            "Delete anyway will use local no-merge cleanup."
        )
    else:
        detail = f"`{context.session_title}` can be deleted immediately."

    return AgentDeckDeleteAssessment(
        session_id=context.session_id,
        session_title=context.session_title,
        workspace_path=context.workspace_path,
        repo_root=context.repo_root,
        target_branch=context.target_branch,
        is_clone=context.is_clone,
        is_worktree=context.is_worktree,
        has_activity=has_activity,
        requires_closeout=requires_closeout,
        can_force_delete=context.is_clone,
        detail=detail,
    )


async def delete_agent_deck_session_target(
    project_path: str,
    agent_deck_session_id: str,
    *,
    force_clone_remove: bool = False,
) -> None:
    try:
        context = await _load_session_action_context(project_path, agent_deck_session_id)
    except AgentDeckBridgeError as exc:
        if force_clone_remove and _is_missing_session_error(exc):
            return
        raise

    if force_clone_remove and context.is_clone:
        args = [
            "clone",
            "finish",
            agent_deck_session_id,
            "--no-merge",
            "--force",
            "-json",
        ]
        code, stdout, stderr = await _run_agent_deck_command(args)
        if code == 0:
            return
        error_output = stderr.strip() or stdout.strip() or ""
        if _is_missing_session_error(error_output):
            return
        raise AgentDeckBridgeError(
            error_output or f"agent-deck clone finish failed (exit {code})"
        )

    code, stdout, stderr = await _run_agent_deck_command(
        ["rm", agent_deck_session_id, "-q"],
        cwd=context.repo_root,
    )
    if code != 0:
        error_output = stderr.strip() or stdout.strip() or "Failed to remove Agent Deck session"
        raise AgentDeckBridgeError(error_output)


def _build_closeout_prompt(
    context: AgentDeckSessionActionContext,
    *,
    user_prompt: str | None = None,
) -> str:
    source_type = "clone" if context.is_clone else "worktree"
    target_branch = context.target_branch or "master"
    lines = [
        "You are the AI closeout agent for one isolated Agent Deck session.",
        "",
        "Context:",
        f"- source session: {context.session_title} ({context.session_id})",
        f"- source isolation type: {source_type}",
        f"- source workspace: {context.workspace_path}",
        f"- canonical repo root: {context.repo_root}",
        f"- target local branch: {target_branch}",
        "",
        "Intent:",
        "Close out this isolated session in the way that best serves the canonical repo's current intent.",
        "Extract the highest-value truthful outcome with the least unnecessary process.",
        "",
        "Requirements:",
        "1. Stay within the named source session and the canonical repo root.",
        "2. Inspect both the source workspace and canonical repo root before deciding what to do.",
        "3. Preserve unrelated local work in the canonical root.",
        "4. Keep Agent Deck state truthful and prefer Agent Deck-native cleanup over ad hoc tmux or filesystem cleanup.",
        "5. If the source workspace is gone but Agent Deck still lists the source session, treat it as a zombie and remove that Agent Deck session row in the same pass.",
        "6. Do not ask for permission to remove a zombie source session or stale Agent Deck row when the source workspace is already gone and no unique work remains. Remove it and verify.",
        "7. Do not claim the source session is removed unless Agent Deck itself no longer lists that source session. Deleting only the clone/worktree directory is not enough.",
        "8. Keep the final report concise: what changed, what was checked, what remains uncertain, and whether the source session is safe to remove.",
        "",
        "Useful starting points:",
        f"- git -C {context.repo_root!r} status --short",
        f"- git -C {context.workspace_path!r} status --short",
        f"- git -C {context.repo_root!r} diff --stat",
        f"- git -C {context.workspace_path!r} diff --stat",
        f"- agent-deck session output {context.session_id!r} -q",
        "- agent-deck ls --json",
    ]

    if context.is_clone:
        lines.append(
            f"- Relevant closeout tools likely include `agent-deck clone finish {context.session_title!r} --into {target_branch}` "
            f"and `agent-deck clone finish {context.session_title!r} --no-merge`."
        )
        lines.append(
            "- Verify the source session row disappears from `agent-deck ls --json` before you report it removed."
        )
        lines.append(
            f"- If clone cleanup removes the workspace but the source row survives, follow with `agent-deck rm {context.session_id!r} -q` and re-check `agent-deck ls --json`."
        )
    else:
        lines.append(f"- Relevant cleanup tools likely include `agent-deck rm {context.session_title!r}`.")
        lines.append(
            "- Verify the source session row disappears from `agent-deck ls --json` before you report it removed."
        )

    if user_prompt and user_prompt.strip():
        lines.extend(["", "Additional operator instructions:", user_prompt.strip()])

    return "\n".join(lines)


async def launch_agent_deck_closeout_session(
    project_path: str,
    agent_deck_session_id: str,
    *,
    tool: str = "codex",
    user_prompt: str | None = None,
) -> AgentDeckSessionTarget:
    context = await _load_session_action_context(project_path, agent_deck_session_id)
    if not context.is_clone and not context.is_worktree:
        raise AgentDeckBridgeError(
            f"Session `{context.session_title}` is not an isolated clone/worktree session."
        )

    preferred_title = f"closeout: {context.session_title}".strip()
    session_title = await _unique_group_session_title(context.group_path, preferred_title)
    prompt = _build_closeout_prompt(context, user_prompt=user_prompt)
    normalized_tool = tool.strip().lower() if isinstance(tool, str) and tool.strip() else "codex"
    args = [
        "launch",
        "-json",
        f"-t={session_title}",
        f"-g={context.group_path or _group_path(project_path)}",
        f"-c={normalized_tool}",
        f"-m={prompt}",
        context.repo_root,
    ]
    await _enforce_agent_deck_launch_admission()
    payload = await _run_agent_deck_json_object_command(args)
    return _payload_to_session_target(payload)


async def _load_existing_session(
    project_path: str,
    agent_deck_session_id: str,
) -> dict[str, object]:
    payload = await session_show(agent_deck_session_id)
    _require_matching_project_path(project_path, payload)

    status = str(payload.get("status") or "")
    if status not in {"running", "waiting", "idle", "starting"}:
        await _start_existing_session(agent_deck_session_id)
        payload = await session_show(agent_deck_session_id)
        _require_matching_project_path(project_path, payload)

    return payload


def _migration_session_title(
    payload: dict[str, object],
    *,
    project_path: str,
    thread_id: str,
) -> str:
    base_title = str(payload.get("title") or _session_title(project_path, thread_id)).strip()
    if not base_title:
        base_title = _session_title(project_path, thread_id)
    if base_title.endswith("-acpx"):
        base_title = base_title[: -len("-acpx")].rstrip("-")
    return base_title or _session_title(project_path, thread_id)


def _archived_migration_session_title(
    payload: dict[str, object],
    *,
    project_path: str,
    thread_id: str,
) -> str:
    base_title = str(payload.get("title") or "").strip()
    if not base_title:
        base_title = _session_title(project_path, thread_id)
    if base_title.endswith("-acpx"):
        return base_title
    return f"{base_title}-acpx"


def _unique_session_title(existing_titles: set[str], preferred_title: str) -> str:
    candidate = preferred_title
    counter = 2
    while candidate in existing_titles:
        candidate = f"{preferred_title}-{counter}"
        counter += 1
    return candidate


def _migration_agent_type(
    payload: dict[str, object],
    requested_agent_type: str,
) -> str:
    session_tool = _session_tool(payload, default=requested_agent_type or "claude")
    if session_tool in {"claude", "codex"}:
        return session_tool
    normalized_requested_type = requested_agent_type.strip().lower()
    if normalized_requested_type in {"claude", "codex"}:
        return normalized_requested_type
    return "claude"


async def _migrate_legacy_session_payload(
    project_path: str,
    thread: LiveEditorThreadRecord,
    payload: dict[str, object],
    *,
    requested_agent_type: str,
) -> dict[str, object]:
    if not _is_acpx_backed_payload(payload):
        return payload

    parsed_payload = _parsed_acpx_payload(payload)
    session_tool = (
        parsed_payload[0]
        if parsed_payload is not None
        else _session_tool(payload, default=requested_agent_type or "claude")
    )
    normalized_requested_type = requested_agent_type.strip().lower()
    if session_tool not in {"claude", "codex"} and normalized_requested_type not in {"claude", "codex"}:
        return payload

    migration_title = _migration_session_title(
        payload,
        project_path=project_path,
        thread_id=thread.thread_id,
    )
    expected_agent = _migration_agent_type(payload, requested_agent_type)

    project_sessions = await _list_project_session_targets(
        project_path,
        include_acpx_backed=True,
    )
    existing_titles = {session.title for session in project_sessions if session.title}
    existing_session_id = str(payload.get("id") or "").strip()
    archived_title = _unique_session_title(
        existing_titles,
        _archived_migration_session_title(
            payload,
            project_path=project_path,
            thread_id=thread.thread_id,
        ),
    )
    current_title = str(payload.get("title") or "").strip()

    for session_target in project_sessions:
        if session_target.id == payload.get("id"):
            continue
        if session_target.title != migration_title:
            continue
        if _is_acpx_backed_payload(
            {
                "command": session_target.command,
                "tool": session_target.tool,
            }
        ):
            continue
        if session_target.tool != expected_agent:
            continue
        if existing_session_id and current_title != archived_title:
            await _rename_session(existing_session_id, archived_title)
        return await _load_existing_session(project_path, session_target.id)

    if existing_session_id and current_title != archived_title:
        await _rename_session(existing_session_id, archived_title)
        payload = await session_show(existing_session_id)

    return await _launch_new_session(
        project_path,
        session_title=migration_title,
        agent_type=expected_agent,
    )


async def _build_session_info(
    project_path: str,
    payload: dict[str, object],
    *,
    fallback_title: str,
) -> AgentDeckSessionInfo:
    agent_deck_session_id = str(payload.get("id") or "").strip()
    if not agent_deck_session_id:
        raise AgentDeckBridgeError("Agent Deck did not return a session ID")

    agent_deck_title, workspace_path, tmux_session, status = _payload_session_metadata(
        payload,
        fallback_title=fallback_title,
        default_path=project_path,
    )
    session_tool = _session_tool(payload)
    acpx_agent: str | None = None
    acpx_session_name: str | None = None
    acpx_record_id: str | None = None
    acp_session_id: str | None = None
    claude_session_id: str | None = None
    codex_session_id: str | None = None
    gemini_session_id: str | None = None
    jsonl_path: Path | None = None

    parsed_acpx_command = _parsed_acpx_payload(payload)
    if parsed_acpx_command is not None:
        acpx_agent, acpx_session_name = parsed_acpx_command
        acpx_session = await ensure_acpx_session(
            acpx_agent,
            workspace_path,
            acpx_session_name,
        )
        acpx_record_id = acpx_session.acpx_record_id
        acp_session_id = acpx_session.acp_session_id
    elif session_tool == "claude":
        fallback_claude_id = payload.get("claude_session_id")
        if isinstance(fallback_claude_id, str) and fallback_claude_id:
            claude_session_id = fallback_claude_id
            jsonl_path = claude_jsonl_path(workspace_path, claude_session_id)
        else:
            claude_session_id, jsonl_path, payload = await _wait_for_claude_session_id(
                agent_deck_session_id,
                workspace_path,
            )
            agent_deck_title, workspace_path, tmux_session, status = _payload_session_metadata(
                payload,
                fallback_title=agent_deck_title,
                default_path=workspace_path,
            )
            if claude_session_id:
                jsonl_path = claude_jsonl_path(workspace_path, claude_session_id)
            if not claude_session_id:
                fallback_claude_id = payload.get("claude_session_id")
                if isinstance(fallback_claude_id, str) and fallback_claude_id:
                    claude_session_id = fallback_claude_id
                    jsonl_path = claude_jsonl_path(workspace_path, claude_session_id)
    elif session_tool == "codex":
        fallback_codex_id = payload.get("codex_session_id")
        if isinstance(fallback_codex_id, str) and fallback_codex_id:
            codex_session_id = fallback_codex_id
            jsonl_path = codex_jsonl_path(codex_session_id)
        else:
            codex_session_id, jsonl_path, payload = await _wait_for_codex_session_id(
                agent_deck_session_id,
            )
            agent_deck_title, workspace_path, tmux_session, status = _payload_session_metadata(
                payload,
                fallback_title=agent_deck_title,
                default_path=workspace_path,
            )
            if codex_session_id:
                jsonl_path = codex_jsonl_path(codex_session_id)
            if not codex_session_id:
                fallback_codex_id = payload.get("codex_session_id")
                if isinstance(fallback_codex_id, str) and fallback_codex_id:
                    codex_session_id = fallback_codex_id
                    jsonl_path = codex_jsonl_path(codex_session_id)
    elif session_tool == "gemini":
        fallback_gemini_id = payload.get("gemini_session_id")
        if isinstance(fallback_gemini_id, str) and fallback_gemini_id:
            gemini_session_id = fallback_gemini_id
        else:
            gemini_session_id, payload = await _wait_for_gemini_session_id(
                agent_deck_session_id,
            )
            agent_deck_title, workspace_path, tmux_session, status = _payload_session_metadata(
                payload,
                fallback_title=agent_deck_title,
                default_path=workspace_path,
            )
            if not gemini_session_id:
                fallback_gemini_id = payload.get("gemini_session_id")
                if isinstance(fallback_gemini_id, str) and fallback_gemini_id:
                    gemini_session_id = fallback_gemini_id

    return AgentDeckSessionInfo(
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_title,
        workspace_path=workspace_path,
        tmux_session=tmux_session,
        tool=session_tool,
        status=status,
        acpx_agent=acpx_agent,
        acpx_session_name=acpx_session_name,
        acpx_record_id=acpx_record_id,
        acp_session_id=acp_session_id,
        claude_session_id=claude_session_id,
        codex_session_id=codex_session_id,
        gemini_session_id=gemini_session_id,
        jsonl_path=jsonl_path,
    )


async def _wait_for_claude_session_id(
    agent_deck_session_id: str,
    project_path: str,
    *,
    timeout_seconds: float = 20.0,
) -> tuple[str | None, Path | None, dict[str, object]]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_payload: dict[str, object] = {}

    while asyncio.get_running_loop().time() < deadline:
        payload = await session_show(agent_deck_session_id)
        last_payload = payload
        claude_session_id = payload.get("claude_session_id")
        if isinstance(claude_session_id, str) and claude_session_id:
            jsonl_path = claude_jsonl_path(project_path, claude_session_id)
            return claude_session_id, jsonl_path, payload
        await asyncio.sleep(0.5)

    return None, None, last_payload


async def _wait_for_codex_session_id(
    agent_deck_session_id: str,
    *,
    timeout_seconds: float = 3.0,
) -> tuple[str | None, Path | None, dict[str, object]]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_payload: dict[str, object] = {}

    while asyncio.get_running_loop().time() < deadline:
        payload = await session_show(agent_deck_session_id)
        last_payload = payload
        codex_session_id = payload.get("codex_session_id")
        if isinstance(codex_session_id, str) and codex_session_id:
            jsonl_path = codex_jsonl_path(codex_session_id)
            return codex_session_id, jsonl_path, payload
        await asyncio.sleep(0.5)

    return None, None, last_payload


async def _wait_for_gemini_session_id(
    agent_deck_session_id: str,
    *,
    timeout_seconds: float = 20.0,
) -> tuple[str | None, dict[str, object]]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_payload: dict[str, object] = {}

    while asyncio.get_running_loop().time() < deadline:
        payload = await session_show(agent_deck_session_id)
        last_payload = payload
        gemini_session_id = payload.get("gemini_session_id")
        if isinstance(gemini_session_id, str) and gemini_session_id:
            return gemini_session_id, payload
        await asyncio.sleep(0.5)

    return None, last_payload


async def ensure_agent_deck_session(
    project_path: str,
    thread: LiveEditorThreadRecord,
    agent_type: str = "claude",
    workspace_mode: str = "root",
    *,
    target_agent_deck_session_id: str | None = None,
    agent_model: str | None = None,
    agent_thinking: str | None = None,
    launch_session: AgentDeckLaunchSession | None = None,
    turn_request: object | None = None,
) -> AgentDeckSessionInfo:
    del workspace_mode
    payload: dict[str, object]
    rebind_workspace_path = _thread_rebind_workspace_path(project_path, thread)
    launch_workspace_mode = "existing" if rebind_workspace_path else "root"
    preferred_session_title = _preferred_thread_session_title(project_path, thread)
    persisted_thread_title = _normalized_text(thread.agent_deck_session_title)
    bound_session_id = (
        thread.agent_deck_session_id.strip()
        if isinstance(thread.agent_deck_session_id, str) and thread.agent_deck_session_id.strip()
        else None
    )
    explicit_target_id = (
        target_agent_deck_session_id.strip()
        if isinstance(target_agent_deck_session_id, str) and target_agent_deck_session_id.strip()
        else None
    )

    if explicit_target_id and bound_session_id and explicit_target_id != bound_session_id:
        raise AgentDeckBridgeError(
            "This Live Editor thread is already bound to a different Agent Deck session. Start a fresh live thread to retarget it."
        )

    async def launch_agent_deck_session(**kwargs: object) -> dict[str, object]:
        launcher = launch_session or _launch_new_session
        if turn_request is not None:
            kwargs["turn_request"] = turn_request
        session_title = str(kwargs.get("session_title") or "").strip()
        requested_agent_type = str(kwargs.get("agent_type") or agent_type or "").strip()
        try:
            return await asyncio.wait_for(
                launcher(project_path, **kwargs),
                timeout=AGENT_DECK_LAUNCH_RECOVERY_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            existing_session_id = await _find_live_editor_session_id_by_title(
                project_path,
                session_title=session_title,
                requested_agent_type=requested_agent_type,
            )
            if existing_session_id:
                return await _load_existing_session(project_path, existing_session_id)
            raise AgentDeckBridgeError(
                f"Timed out launching Agent Deck session `{session_title or requested_agent_type}`. "
                "The provider did not return a session id; retry or choose a direct provider."
            ) from exc
        except AgentDeckBridgeError as exc:
            if not _is_already_exists_session_error(exc):
                raise
            existing_session_id = (
                _existing_session_id_from_already_exists_error(exc)
                or await _find_live_editor_session_id_by_title(
                    project_path,
                    session_title=session_title,
                    requested_agent_type=requested_agent_type,
                )
            )
            if not existing_session_id:
                raise
            return await _load_existing_session(project_path, existing_session_id)

    if explicit_target_id:
        try:
            payload = await _load_existing_session(project_path, explicit_target_id)
            payload = await _migrate_legacy_session_payload(
                project_path,
                thread,
                payload,
                requested_agent_type=agent_type,
            )
        except AgentDeckBridgeError as exc:
            if (
                explicit_target_id == bound_session_id
                and _is_missing_session_error(exc)
            ):
                payload = await launch_agent_deck_session(
                    session_title=preferred_session_title,
                    agent_type=agent_type,
                    workspace_mode=launch_workspace_mode,
                    workspace_path=rebind_workspace_path,
                    agent_model=agent_model,
                    agent_thinking=agent_thinking,
                )
            else:
                raise
    elif bound_session_id:
        try:
            payload = await _load_existing_session(project_path, bound_session_id)
            payload = await _migrate_legacy_session_payload(
                project_path,
                thread,
                payload,
                requested_agent_type=agent_type,
            )
        except AgentDeckBridgeError:
            payload = await launch_agent_deck_session(
                session_title=preferred_session_title,
                agent_type=agent_type,
                workspace_mode=launch_workspace_mode,
                workspace_path=rebind_workspace_path,
                agent_model=agent_model,
                agent_thinking=agent_thinking,
            )
    else:
        existing_session_id = await _find_live_editor_session_id_by_title(
            project_path,
            session_title=preferred_session_title,
            requested_agent_type=agent_type,
        )
        if existing_session_id:
            payload = await _load_existing_session(project_path, existing_session_id)
            payload = await _migrate_legacy_session_payload(
                project_path,
                thread,
                payload,
                requested_agent_type=agent_type,
            )
        else:
            payload = await launch_agent_deck_session(
                session_title=preferred_session_title,
                agent_type=agent_type,
                workspace_mode=launch_workspace_mode,
                workspace_path=rebind_workspace_path,
                agent_model=agent_model,
                agent_thinking=agent_thinking,
            )

    rename_target: str | None = None
    if persisted_thread_title:
        if _is_legacy_pixel_forge_session_title(project_path, persisted_thread_title):
            rename_target = preferred_session_title
        else:
            rename_target = persisted_thread_title

    if rename_target:
        current_title = _normalized_text(payload.get("title"))
        session_id = _normalized_text(payload.get("id"))
        if session_id and current_title != rename_target:
            await _rename_session(session_id, rename_target)
            payload = {
                **payload,
                "title": rename_target,
            }

    return await _build_session_info(
        project_path,
        payload,
        fallback_title=preferred_session_title,
    )


def _flatten_tool_content(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [_flatten_tool_content(item) for item in value]
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        if value.get("type") == "tool_reference" and value.get("tool_name"):
            return f"Reference: {value['tool_name']}"
        return json.dumps(value, ensure_ascii=True)
    return str(value)


def _claude_user_text_for_record(record: dict[str, object]) -> str | None:
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    if message.get("role") != "user":
        return None

    content_value = message.get("content")
    if isinstance(content_value, str):
        normalized = content_value.strip()
        return normalized or None
    if not isinstance(content_value, list):
        return None

    parts: list[str] = []
    for block in content_value:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "text":
            continue
        text = block.get("text")
        if isinstance(text, str):
            normalized = text.strip()
            if normalized:
                parts.append(normalized)

    if not parts:
        return None
    return "\n\n".join(parts)


def claude_jsonl_payloads_for_record(record: dict[str, object]) -> list[dict[str, object]]:
    payloads: list[dict[str, object]] = []
    record_type = record.get("type")

    if record_type == "assistant":
        message = record.get("message")
        if not isinstance(message, dict):
            return payloads
        if message.get("role") != "assistant":
            return payloads

        content_blocks = message.get("content")
        if not isinstance(content_blocks, list):
            return payloads

        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    payloads.append({"type": "chunk", "content": text})
            elif block_type == "tool_use":
                payloads.append(
                    {
                        "type": "tool_use",
                        "tool_call_id": block.get("id", ""),
                        "tool": block.get("name", ""),
                        "input": block.get("input", {}),
                    }
                )
        return payloads

    if record_type == "system":
        if record.get("subtype") == "stop_hook_summary":
            payloads.append({"type": "turn_stop"})
        return payloads

    if record_type != "user":
        return payloads

    prompt_text = _claude_user_text_for_record(record)
    if prompt_text:
        payloads.append(
            {
                "type": "user_prompt",
                "content": prompt_text,
                "entrypoint": record.get("entrypoint"),
            }
        )

    message = record.get("message")
    content_blocks = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content_blocks, list):
        return payloads

    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "tool_result":
            continue

        payloads.append(
            {
                "type": "tool_result",
                "tool_call_id": block.get("tool_use_id", ""),
                "content": _flatten_tool_content(block.get("content")),
                "is_error": bool(block.get("is_error")),
            }
        )

    return payloads


def read_claude_jsonl_payloads(
    jsonl_path: Path,
    start_offset: int,
    *,
    seen_uuids: set[str] | None = None,
) -> tuple[int, list[dict[str, object]]]:
    offset = start_offset
    payloads: list[dict[str, object]] = []
    normalized_seen_uuids = seen_uuids if seen_uuids is not None else set()

    if not jsonl_path.exists():
        return offset, payloads

    with jsonl_path.open("r", encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        while True:
            line = handle.readline()
            if not line:
                break
            offset = handle.tell()

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            if not isinstance(record, dict):
                continue

            record_uuid = record.get("uuid")
            if isinstance(record_uuid, str) and record_uuid:
                if record_uuid in normalized_seen_uuids:
                    continue
                normalized_seen_uuids.add(record_uuid)

            payloads.extend(claude_jsonl_payloads_for_record(record))

    return offset, payloads


def _summarize_codex_function_call(name: str, arguments: object) -> str:
    parsed: dict[str, object] = {}
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, dict):
            parsed = decoded
    elif isinstance(arguments, dict):
        parsed = arguments

    if name == "exec_command":
        cmd = parsed.get("cmd")
        if isinstance(cmd, str) and cmd:
            compact = cmd if len(cmd) <= 200 else f"{cmd[:197]}..."
            return f"\n\n```\n$ {compact}\n```\n"

    summary_args = json.dumps(parsed, ensure_ascii=False) if parsed else ""
    if len(summary_args) > 200:
        summary_args = f"{summary_args[:197]}..."
    return f"\n\n```\n{name}({summary_args})\n```\n"


def codex_jsonl_text_chunks_for_record(record: dict[str, object]) -> list[str]:
    record_type = record.get("type")
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return []

    chunks: list[str] = []

    if record_type == "event_msg":
        if payload.get("type") == "agent_message":
            message = payload.get("message")
            if isinstance(message, str) and message:
                chunks.append(f"{message}\n\n")
        return chunks

    if record_type != "response_item":
        return chunks

    payload_type = payload.get("type")

    if payload_type == "function_call":
        name = payload.get("name")
        if isinstance(name, str) and name:
            summary = _summarize_codex_function_call(name, payload.get("arguments"))
            if summary:
                chunks.append(summary)
        return chunks

    if payload_type != "message" or payload.get("role") != "assistant":
        return chunks

    content_blocks = payload.get("content")
    if not isinstance(content_blocks, list):
        return chunks

    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "output_text":
            continue
        text = block.get("text")
        if isinstance(text, str) and text:
            chunks.append(text)
    return chunks


def codex_jsonl_payloads_for_record(record: dict[str, object]) -> list[dict[str, object]]:
    record_type = record.get("type")
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return []

    events: list[dict[str, object]] = []

    if record_type == "event_msg":
        event_type = payload.get("type")
        if event_type == "agent_message":
            message = payload.get("message")
            if isinstance(message, str) and message:
                events.append({"type": "chunk", "content": f"{message}\n\n"})
        elif event_type == "exec_command_begin":
            call_id = payload.get("call_id")
            command = payload.get("command")
            cmd_text = ""
            if isinstance(command, list):
                cmd_text = " ".join(part for part in command if isinstance(part, str))
            elif isinstance(command, str):
                cmd_text = command
            events.append(
                {
                    "type": "tool_use",
                    "tool_call_id": call_id if isinstance(call_id, str) else "",
                    "tool": "Bash",
                    "input": {"command": cmd_text} if cmd_text else {},
                }
            )
        elif event_type == "exec_command_end":
            call_id = payload.get("call_id")
            stdout = payload.get("stdout")
            stderr = payload.get("stderr")
            exit_code = payload.get("exit_code")
            parts: list[str] = []
            if isinstance(stdout, str) and stdout:
                parts.append(stdout)
            if isinstance(stderr, str) and stderr:
                parts.append(stderr)
            events.append(
                {
                    "type": "tool_result",
                    "tool_call_id": call_id if isinstance(call_id, str) else "",
                    "content": "\n".join(parts),
                    "is_error": isinstance(exit_code, int) and exit_code != 0,
                }
            )
        return events

    if record_type != "response_item":
        return events

    payload_type = payload.get("type")

    if payload_type == "function_call":
        name = payload.get("name")
        if isinstance(name, str) and name:
            call_id = payload.get("call_id")
            raw_args = payload.get("arguments")
            parsed_args: dict[str, object] = {}
            if isinstance(raw_args, str):
                try:
                    decoded = json.loads(raw_args)
                except json.JSONDecodeError:
                    decoded = None
                if isinstance(decoded, dict):
                    parsed_args = decoded
            elif isinstance(raw_args, dict):
                parsed_args = raw_args
            events.append(
                {
                    "type": "tool_use",
                    "tool_call_id": call_id if isinstance(call_id, str) else "",
                    "tool": name,
                    "input": parsed_args,
                }
            )
        return events

    if payload_type == "function_call_output":
        call_id = payload.get("call_id")
        output = payload.get("output")
        output_text = ""
        is_error = False
        if isinstance(output, dict):
            content_value = output.get("content")
            if isinstance(content_value, str):
                output_text = content_value
            success = output.get("success")
            if isinstance(success, bool):
                is_error = not success
        elif isinstance(output, str):
            output_text = output
        events.append(
            {
                "type": "tool_result",
                "tool_call_id": call_id if isinstance(call_id, str) else "",
                "content": output_text,
                "is_error": is_error,
            }
        )
        return events

    if payload_type != "message" or payload.get("role") != "assistant":
        return events

    content_blocks = payload.get("content")
    if not isinstance(content_blocks, list):
        return events

    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "output_text":
            continue
        text = block.get("text")
        if isinstance(text, str) and text:
            events.append({"type": "chunk", "content": text})
    return events


def read_codex_jsonl_payloads(
    jsonl_path: Path,
    start_offset: int,
) -> tuple[int, list[dict[str, object]]]:
    offset = start_offset
    payloads: list[dict[str, object]] = []

    if not jsonl_path.exists():
        return offset, payloads

    try:
        file_size = jsonl_path.stat().st_size
    except OSError:
        return offset, payloads
    if offset > file_size:
        offset = 0

    with jsonl_path.open("r", encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        while True:
            line = handle.readline()
            if not line:
                break
            offset = handle.tell()

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            if not isinstance(record, dict):
                continue

            payloads.extend(codex_jsonl_payloads_for_record(record))

    return offset, payloads


def read_codex_jsonl_text_chunks(
    jsonl_path: Path,
    start_offset: int,
) -> tuple[int, list[str]]:
    offset = start_offset
    chunks: list[str] = []

    if not jsonl_path.exists():
        return offset, chunks

    try:
        file_size = jsonl_path.stat().st_size
    except OSError:
        return offset, chunks
    if offset > file_size:
        offset = 0

    with jsonl_path.open("r", encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        while True:
            line = handle.readline()
            if not line:
                break
            offset = handle.tell()

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            if not isinstance(record, dict):
                continue

            chunks.extend(codex_jsonl_text_chunks_for_record(record))

    return offset, chunks


async def _emit_claude_jsonl_record(
    websocket,
    record: dict[str, object],
    stats: ClaudeStreamStats,
    *,
    on_emit: StreamPayloadCallback | None = None,
) -> None:
    for payload in claude_jsonl_payloads_for_record(record):
        if payload.get("type") == "chunk":
            content = payload.get("content")
            if isinstance(content, str) and content:
                stats.streamed_text = True
                stats.last_output += content
        await _emit_stream_payload(
            websocket,
            payload,
            on_emit=on_emit,
        )


async def _emit_stream_payload(
    websocket,
    payload: dict[str, object],
    *,
    on_emit: StreamPayloadCallback | None = None,
) -> None:
    await websocket.send_json(payload)
    if on_emit is not None:
        await on_emit(payload)


async def stream_claude_jsonl(
    websocket,
    jsonl_path: Path,
    start_offset: int,
    wait_task: asyncio.Task[object],
    *,
    on_emit: StreamPayloadCallback | None = None,
) -> ClaudeStreamStats:
    stats = ClaudeStreamStats()
    offset = start_offset
    seen_uuids: set[str] = set()
    last_activity = asyncio.get_running_loop().time()

    while True:
        if jsonl_path.exists():
            with jsonl_path.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(offset)
                while True:
                    line = handle.readline()
                    if not line:
                        break
                    offset = handle.tell()
                    last_activity = asyncio.get_running_loop().time()

                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    record_uuid = record.get("uuid")
                    if isinstance(record_uuid, str) and record_uuid:
                        if record_uuid in seen_uuids:
                            continue
                        seen_uuids.add(record_uuid)

                    await _emit_claude_jsonl_record(
                        websocket,
                        record,
                        stats,
                        on_emit=on_emit,
                    )

        if wait_task.done():
            idle_for = asyncio.get_running_loop().time() - last_activity
            if idle_for >= STREAM_IDLE_AFTER_COMPLETION_SECONDS:
                break

        await asyncio.sleep(STREAM_POLL_INTERVAL_SECONDS)

    return stats


async def stream_codex_jsonl(
    websocket,
    jsonl_path: Path,
    start_offset: int,
    wait_task: asyncio.Task[object],
    *,
    on_emit: StreamPayloadCallback | None = None,
) -> SessionOutputStreamStats:
    stats = SessionOutputStreamStats()
    offset = start_offset
    last_activity = asyncio.get_running_loop().time()

    while True:
        offset, chunks = read_codex_jsonl_text_chunks(jsonl_path, offset)
        if chunks:
            last_activity = asyncio.get_running_loop().time()
            for chunk in chunks:
                if not chunk:
                    continue
                stats.streamed_text = True
                stats.last_output += chunk
                await _emit_stream_payload(
                    websocket,
                    {"type": "chunk", "content": chunk},
                    on_emit=on_emit,
                )

        if wait_task.done():
            idle_for = asyncio.get_running_loop().time() - last_activity
            if idle_for >= STREAM_IDLE_AFTER_COMPLETION_SECONDS:
                break

        await asyncio.sleep(STREAM_POLL_INTERVAL_SECONDS)

    return stats


async def send_agent_deck_prompt_reliably(
    session_info: AgentDeckSessionInfo,
    *,
    project_path: str,
    prompt: str,
    no_wait: bool = False,
) -> None:
    args = [
        "session",
        "send",
        session_info.agent_deck_session_id,
        prompt,
        "-q",
    ]
    if no_wait:
        args.append("--no-wait")
    code, stdout, stderr = await _run_agent_deck_command(
        args,
        cwd=project_path,
    )
    if code != 0:
        raise AgentDeckBridgeError(
            stderr.strip() or stdout.strip() or "Agent Deck live-edit request failed"
        )


def _native_agent_env(session_info: AgentDeckSessionInfo) -> dict[str, str]:
    env = os.environ.copy()
    env["AGENTDECK_INSTANCE_ID"] = session_info.agent_deck_session_id
    env["AGENTDECK_TITLE"] = session_info.agent_deck_session_title
    env["AGENTDECK_TOOL"] = session_info.tool
    if session_info.claude_session_id:
        env["CLAUDE_SESSION_ID"] = session_info.claude_session_id
    if session_info.codex_session_id:
        env["CODEX_SESSION_ID"] = session_info.codex_session_id
    if session_info.gemini_session_id:
        env["GEMINI_SESSION_ID"] = session_info.gemini_session_id
    return env


def _claude_resume_identifier_args(session_info: AgentDeckSessionInfo) -> list[str]:
    if not session_info.claude_session_id:
        raise AgentDeckBridgeError(
            f"Claude session `{session_info.agent_deck_session_title}` is missing a native session ID"
        )

    use_resume = True
    jsonl_path = session_info.jsonl_path
    if jsonl_path is not None:
        try:
            use_resume = jsonl_path.exists() and jsonl_path.stat().st_size > 0
        except OSError:
            use_resume = True

    if use_resume:
        return ["-r", session_info.claude_session_id]
    return ["--session-id", session_info.claude_session_id]


async def send_native_claude_prompt_reliably(
    session_info: AgentDeckSessionInfo,
    *,
    project_path: str,
    prompt: str,
) -> None:
    claude_executable = _resolve_runtime_executable("claude")
    cmd = [
        claude_executable,
        *_claude_resume_identifier_args(session_info),
        "-p",
        prompt,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path,
        env=_native_agent_env(session_info),
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise AgentDeckBridgeError(
            stderr.decode("utf-8", errors="replace").strip()
            or "Claude native live-edit request failed"
        )


async def send_native_codex_prompt_reliably(
    session_info: AgentDeckSessionInfo,
    *,
    project_path: str,
    prompt: str,
    image_paths: list[str] | None = None,
) -> None:
    if not session_info.codex_session_id:
        raise AgentDeckBridgeError(
            f"Codex session `{session_info.agent_deck_session_title}` is missing a native session ID"
        )

    codex_executable = _resolve_runtime_executable("codex")
    cmd = [
        codex_executable,
        "exec",
        "resume",
        session_info.codex_session_id,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
    ]
    for image_path in image_paths or []:
        normalized_path = image_path.strip()
        if not normalized_path:
            continue
        cmd.extend(["--image", normalized_path])
    cmd.append(prompt)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path,
        env=_native_agent_env(session_info),
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise AgentDeckBridgeError(
            stderr.decode("utf-8", errors="replace").strip()
            or "Codex native live-edit request failed"
        )


async def submit_agent_deck_prompt(
    session_info: AgentDeckSessionInfo,
) -> None:
    target = _tmux_target(session_info.tmux_session)
    if not target:
        raise AgentDeckBridgeError(
            f"Agent Deck session `{session_info.agent_deck_session_title}` is missing a tmux target"
        )

    code, stdout, stderr = await _run_command(
        ["tmux", "send-keys", "-t", target, "Enter"],
        cwd=session_info.workspace_path,
    )
    if code != 0:
        raise AgentDeckBridgeError(
            stderr.strip() or stdout.strip() or "Failed to submit Agent Deck prompt"
        )


async def type_agent_deck_prompt(
    session_info: AgentDeckSessionInfo,
    *,
    prompt: str,
    chunk_size: int = 256,
) -> None:
    target = _tmux_target(session_info.tmux_session)
    if not target:
        raise AgentDeckBridgeError(
            f"Agent Deck session `{session_info.agent_deck_session_title}` is missing a tmux target"
        )

    normalized_prompt = " ".join(prompt.split())
    if not normalized_prompt:
        raise AgentDeckBridgeError("Refusing to send an empty Agent Deck prompt")

    for start in range(0, len(normalized_prompt), chunk_size):
        chunk = normalized_prompt[start : start + chunk_size]
        code, stdout, stderr = await _run_command(
            ["tmux", "send-keys", "-t", target, "-l", chunk],
            cwd=session_info.workspace_path,
        )
        if code != 0:
            raise AgentDeckBridgeError(
                stderr.strip() or stdout.strip() or "Failed to type Agent Deck prompt"
            )


JSONL_IDLE_COMPLETION_SECONDS = 60.0


async def wait_for_agent_deck_turn_completion(
    session_info: AgentDeckSessionInfo,
    *,
    startup_timeout_seconds: float = 60.0,
    completion_timeout_seconds: float = 600.0,
    poll_interval_seconds: float = 1.5,
) -> None:
    loop = asyncio.get_running_loop()
    startup_deadline = loop.time() + startup_timeout_seconds
    completion_deadline = loop.time() + completion_timeout_seconds
    status_saw_running = False
    settled_polls = 0

    # Tmux-hosted native sessions (the default since b4bd714 routed prompts
    # through Agent Deck CLI when a tmux target exists) don't always update
    # Agent Deck's session `status` field when the embedded agent starts
    # processing. The JSONL file the agent writes is a more reliable signal:
    # any growth past its baseline size means the agent received and began
    # handling the prompt. We use JSONL growth as an alternate startup signal
    # and JSONL idleness as a fallback completion signal when the status
    # field never transitions.
    jsonl_path = session_info.jsonl_path
    jsonl_last_size: int | None = None
    if jsonl_path is not None:
        try:
            jsonl_last_size = (
                jsonl_path.stat().st_size if jsonl_path.exists() else 0
            )
        except OSError:
            jsonl_last_size = None
    jsonl_saw_growth = False
    jsonl_last_change_time: float | None = None

    while loop.time() < completion_deadline:
        payload = await session_show(session_info.agent_deck_session_id)
        status = str(payload.get("status") or "").strip().lower()

        if jsonl_path is not None and jsonl_last_size is not None:
            try:
                current_jsonl_size = (
                    jsonl_path.stat().st_size if jsonl_path.exists() else 0
                )
            except OSError:
                current_jsonl_size = None
            if (
                current_jsonl_size is not None
                and current_jsonl_size > jsonl_last_size
            ):
                jsonl_saw_growth = True
                jsonl_last_change_time = loop.time()
                jsonl_last_size = current_jsonl_size

        if status in {"running", "busy", "active", "connected"}:
            status_saw_running = True
            settled_polls = 0
        elif status in {"waiting", "idle", ""}:
            if status_saw_running:
                settled_polls += 1
                if settled_polls >= 2:
                    return
            elif not jsonl_saw_growth and loop.time() >= startup_deadline:
                raise AgentDeckBridgeError(
                    f"Agent Deck session `{session_info.agent_deck_session_title}` never started processing the live-edit request."
                )
        else:
            settled_polls = 0
            if (
                not status_saw_running
                and not jsonl_saw_growth
                and loop.time() >= startup_deadline
            ):
                raise AgentDeckBridgeError(
                    f"Agent Deck session `{session_info.agent_deck_session_title}` did not enter a running state (status: {status or 'unknown'})."
                )

        if (
            jsonl_saw_growth
            and not status_saw_running
            and jsonl_last_change_time is not None
            and (loop.time() - jsonl_last_change_time) >= JSONL_IDLE_COMPLETION_SECONDS
        ):
            return

        await asyncio.sleep(poll_interval_seconds)

    raise AgentDeckBridgeError(
        f"Timed out waiting for Agent Deck session `{session_info.agent_deck_session_title}` to finish the live-edit request."
    )


def _codex_output_looks_ready(output: str) -> bool:
    nonempty_lines = [line.rstrip() for line in output.splitlines() if line.strip()]
    if len(nonempty_lines) < 2:
        return False

    return (
        nonempty_lines[-2].lstrip().startswith(CODEX_READY_PROMPT_PREFIX)
        and nonempty_lines[-1].lstrip().startswith("gpt-")
    )


async def wait_for_codex_ready_output(
    agent_deck_session_id: str,
    *,
    timeout_seconds: float,
    changed_from: str | None = None,
) -> str | None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds

    while asyncio.get_running_loop().time() < deadline:
        output = await get_last_output(agent_deck_session_id)
        if changed_from is not None and output == changed_from:
            await asyncio.sleep(CODEX_POLL_INTERVAL_SECONDS)
            continue
        if _codex_output_looks_ready(output):
            return output
        await asyncio.sleep(CODEX_POLL_INTERVAL_SECONDS)

    return None


def _extract_session_output_delta(previous_output: str, next_output: str) -> str:
    if not previous_output:
        return next_output
    prefix_length = len(os.path.commonprefix([previous_output, next_output]))
    previous_remainder = previous_output[prefix_length:]
    next_remainder = next_output[prefix_length:]

    suffix_length = 0
    max_suffix = min(len(previous_remainder), len(next_remainder))
    while suffix_length < max_suffix:
        if previous_remainder[-(suffix_length + 1)] != next_remainder[-(suffix_length + 1)]:
            break
        suffix_length += 1

    if suffix_length == 0:
        return next_remainder
    return next_remainder[:-suffix_length]


def _strip_codex_prompt_echo(output: str) -> str:
    lines = output.splitlines()

    while lines and not lines[0].strip():
        lines.pop(0)

    if lines and lines[0].lstrip().startswith(CODEX_READY_PROMPT_PREFIX):
        lines.pop(0)
        while lines and lines[0].strip():
            lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)

    while lines and not lines[-1].strip():
        lines.pop()

    if len(lines) >= 2:
        last_line = lines[-1].lstrip()
        previous_line = lines[-2].lstrip()
        if last_line.startswith("gpt-") and previous_line.startswith(CODEX_READY_PROMPT_PREFIX):
            lines.pop()
            lines.pop()
            while lines and not lines[-1].strip():
                lines.pop()

    return "\n".join(lines).strip()


def _codex_output_is_still_running(output: str) -> bool:
    normalized = output.strip()
    if not normalized:
        return False
    return "esc to interrupt" in normalized or normalized.startswith("• Working")


def _strip_codex_progress_lines(output: str) -> str:
    lines: list[str] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if "esc to interrupt" in line:
            continue
        if line.startswith("• Working"):
            continue
        lines.append(raw_line)
    return "\n".join(lines).strip()


def _trim_codex_turn_artifacts(output: str, prompt: str) -> str:
    trimmed_output = output.strip()
    trimmed_prompt = prompt.strip()

    if trimmed_prompt and trimmed_output.startswith(trimmed_prompt):
        trimmed_output = trimmed_output[len(trimmed_prompt):].lstrip()

    lines = trimmed_output.splitlines()
    while lines and lines[-1].strip() in {CODEX_READY_PROMPT_PREFIX.strip(), CODEX_READY_PROMPT_PREFIX}:
        lines.pop()
    while lines and not lines[-1].strip():
        lines.pop()

    return "\n".join(lines).strip()


def _codex_progress_status(output: str) -> str | None:
    for raw_line in reversed(output.splitlines()):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("╭", "╰", "│", CODEX_READY_PROMPT_PREFIX, "gpt-", "model:", "directory:", "Tip:")):
            continue
        if "esc to interrupt" in line:
            line = line.replace(" · esc to interrupt", "").strip()
            return f"Codex: {line}"
        if line.startswith("• "):
            return f"Codex: {line}"
    return None


async def stream_codex_session_output(
    websocket,
    *,
    agent_deck_session_id: str,
    baseline_output: str,
    prompt: str,
    wait_task: asyncio.Task[object],
    on_emit: StreamPayloadCallback | None = None,
) -> SessionOutputStreamStats:
    stats = SessionOutputStreamStats()
    last_output = baseline_output
    last_status_message: str | None = None
    last_activity = asyncio.get_running_loop().time()

    while True:
        current_output = await get_last_output(agent_deck_session_id)
        if current_output != last_output:
            delta = _extract_session_output_delta(last_output, current_output)
            sanitized_delta = _strip_codex_prompt_echo(delta)
            streamable_delta = _strip_codex_progress_lines(sanitized_delta)
            if streamable_delta:
                stats.streamed_text = True
                stats.last_output = _trim_codex_turn_artifacts(
                    _strip_codex_progress_lines(
                        _strip_codex_prompt_echo(
                            _extract_session_output_delta(baseline_output, current_output)
                        )
                    ),
                    prompt,
                )
                last_activity = asyncio.get_running_loop().time()
                await _emit_stream_payload(
                    websocket,
                    {"type": "chunk", "content": streamable_delta},
                    on_emit=on_emit,
                )
            else:
                status_message = _codex_progress_status(current_output)
                if status_message and status_message != last_status_message:
                    last_status_message = status_message
                    await _emit_stream_payload(
                        websocket,
                        {"type": "status", "message": status_message},
                        on_emit=on_emit,
                    )
            last_output = current_output

        if wait_task.done():
            idle_for = asyncio.get_running_loop().time() - last_activity
            if idle_for >= STREAM_IDLE_AFTER_COMPLETION_SECONDS:
                break

        await asyncio.sleep(CODEX_POLL_INTERVAL_SECONDS)

    stats.last_output = _trim_codex_turn_artifacts(
        _strip_codex_progress_lines(
            _strip_codex_prompt_echo(
                _extract_session_output_delta(baseline_output, last_output)
            )
        ),
        prompt,
    )
    return stats


async def wait_for_codex_turn_output(
    agent_deck_session_id: str,
    *,
    baseline_output: str,
    timeout_seconds: float,
) -> str | None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_delta = ""
    stable_polls = 0

    while asyncio.get_running_loop().time() < deadline:
        current_output = await get_last_output(agent_deck_session_id)
        delta = _extract_session_output_delta(baseline_output, current_output)
        sanitized_delta = _strip_codex_prompt_echo(delta)

        if sanitized_delta == last_delta:
            stable_polls += 1
        else:
            last_delta = sanitized_delta
            stable_polls = 0

        if (
            sanitized_delta
            and not _codex_output_is_still_running(sanitized_delta)
            and stable_polls >= 1
        ):
            return sanitized_delta

        await asyncio.sleep(CODEX_POLL_INTERVAL_SECONDS)

    return None


async def send_codex_prompt_and_capture_output(
    session_info: AgentDeckSessionInfo,
    *,
    project_path: str,
    prompt: str,
    preflight_timeout_seconds: float = 20.0,
    completion_timeout_seconds: float = 600.0,
) -> str:
    status = (session_info.status or "").strip().lower()
    if status not in {"", "waiting", "idle"}:
        raise AgentDeckBridgeError(
            f"Codex session `{session_info.agent_deck_session_title}` is busy ({status}). "
            "Wait for it to finish in Agent Deck or start a fresh Live Editor thread."
        )

    ready_output = await wait_for_codex_ready_output(
        session_info.agent_deck_session_id,
        timeout_seconds=preflight_timeout_seconds,
    )
    if ready_output is None:
        raise AgentDeckBridgeError(
            f"Codex session `{session_info.agent_deck_session_title}` is not ready yet. "
            "Open it in Agent Deck, clear any trust or startup prompt, then retry."
        )

    await send_agent_deck_prompt_reliably(
        session_info,
        project_path=project_path,
        prompt=prompt,
    )

    completed_output = await wait_for_codex_turn_output(
        session_info.agent_deck_session_id,
        baseline_output=ready_output,
        timeout_seconds=completion_timeout_seconds,
    )
    if completed_output is None:
        raise AgentDeckBridgeError(
            f"Timed out waiting for Codex session `{session_info.agent_deck_session_title}` to finish the live-edit request."
        )

    return _trim_codex_turn_artifacts(completed_output, prompt)


async def get_last_output(agent_deck_session_id: str) -> str:
    code, stdout, stderr = await _run_agent_deck_command(
        ["session", "output", agent_deck_session_id, "-q"]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to read Agent Deck output")
    return stdout.strip()


async def get_agent_deck_session_activity(
    project_path: str,
    agent_deck_session_id: str,
) -> AgentDeckSessionActivity:
    payload = await session_show(agent_deck_session_id)
    _require_matching_project_path(project_path, payload)

    title, workspace_path, _, status = _payload_session_metadata(
        payload,
        fallback_title=agent_deck_session_id,
        default_path=project_path,
    )
    tool = _session_tool(payload, default="")
    output = await get_last_output(agent_deck_session_id)
    if not _session_output_has_meaningful_activity(output):
        output = ""

    return AgentDeckSessionActivity(
        session_id=agent_deck_session_id,
        session_title=title,
        workspace_path=workspace_path,
        tool=tool or None,
        status=status,
        output=output,
    )
