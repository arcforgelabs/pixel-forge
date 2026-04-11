from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4

from acpx_bridge import AcpxSessionInfo, ensure_acpx_session, parse_agent_deck_acpx_command
from agent_deck_runtime import agent_deck_command, agent_deck_env
from live_editor_threads import LiveEditorThreadRecord


CLAUDE_DIR_NAME_RE = re.compile(r"[^a-zA-Z0-9-]")
STREAM_IDLE_AFTER_COMPLETION_SECONDS = 1.0
STREAM_POLL_INTERVAL_SECONDS = 0.2
CODEX_POLL_INTERVAL_SECONDS = 1.0
CODEX_READY_PROMPT_PREFIX = "› "
EMPTY_SESSION_LIST_RE = re.compile(r"^No sessions found in profile '.*'\.$")
StreamPayloadCallback = Callable[[dict[str, object]], Awaitable[None]]

# Allowlists for agent model + thinking-effort overrides plumbed from the
# Pixel Forge chat composer through to agent-deck launch. These values end
# up as argv elements on `agent-deck launch`, not inside a shell string —
# the agent-deck CLI then stores them on the session's ToolOptions. We
# still validate them here so an unexpected value gets silently dropped
# (treated as "use tool defaults") rather than forwarded to the tool and
# causing a surprising failure.
CLAUDE_MODEL_ALLOWLIST = frozenset({
    "opus",
    "sonnet",
    "haiku",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
})
CLAUDE_EFFORT_ALLOWLIST = frozenset({"low", "medium", "high", "max"})
CODEX_MODEL_ALLOWLIST = frozenset({"gpt-5.4", "gpt-5.3", "gpt-5.2"})
CODEX_EFFORT_ALLOWLIST = frozenset({"minimal", "low", "medium", "high", "xhigh"})


def _resolve_agent_model_effort_args(
    agent_type: str,
    agent_model: str | None,
    agent_thinking: str | None,
) -> list[str]:
    """Return the `--model`/`--effort` argv fragment for `agent-deck launch`.

    These flags get set on the session's ToolOptions (ClaudeOptions.Model /
    ClaudeOptions.Effort / CodexOptions.Model / CodexOptions.ReasoningEffort)
    rather than smuggled through a `{command}` wrapper. The wrapper path is
    broken for Claude specifically because Pixel Forge wraps the claude
    command inside `python3 dev_channel_wrapper.py -- /bin/bash -lc "…"` —
    any wrapper-appended flags land OUTSIDE that quoted envelope and bash
    swallows them as positional parameters instead of passing them to
    claude.
    """
    tool = (agent_type or "claude").strip().lower()
    model = (agent_model or "").strip()
    thinking = (agent_thinking or "").strip()

    if tool == "claude":
        model_allowed = CLAUDE_MODEL_ALLOWLIST
        effort_allowed = CLAUDE_EFFORT_ALLOWLIST
    elif tool == "codex":
        model_allowed = CODEX_MODEL_ALLOWLIST
        effort_allowed = CODEX_EFFORT_ALLOWLIST
    else:
        return []

    args: list[str] = []
    if model and model in model_allowed:
        args.extend(["--model", model])
    if thinking and thinking in effort_allowed:
        args.extend(["--effort", thinking])
    return args


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
    jsonl_path: Path | None


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


def _project_slug(project_path: str) -> str:
    project_name = Path(project_path).resolve().name or "project"
    slug = re.sub(r"[^a-z0-9-]+", "-", project_name.lower()).strip("-")
    return slug or "project"


def _session_title(project_path: str, thread_id: str) -> str:
    return f"pixel-forge-{_project_slug(project_path)}-{thread_id[:8]}"


def _preferred_thread_session_title(
    project_path: str,
    thread: LiveEditorThreadRecord,
) -> str:
    return _normalized_text(thread.agent_deck_session_title) or _session_title(
        project_path,
        thread.thread_id,
    )


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


async def _run_command(args: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


async def _run_command_with_env(
    args: list[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


def _agent_deck_args(*args: str) -> list[str]:
    return [*agent_deck_command(), *args]


async def _run_agent_deck_command(
    args: list[str],
    *,
    cwd: str | None = None,
) -> tuple[int, str, str]:
    return await _run_command_with_env(
        _agent_deck_args(*args),
        cwd=cwd,
        env=agent_deck_env(),
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
    workspace_mode: str = "clone",
    workspace_path: str | None = None,
    agent_model: str | None = None,
    agent_thinking: str | None = None,
) -> dict[str, object]:
    normalized_agent_type = agent_type.strip().lower() or "claude"
    launch_path = (
        _normalize_path(workspace_path)
        if isinstance(workspace_path, str) and workspace_path.strip()
        else _normalize_path(project_path)
    )
    args = [
        "launch",
        "-json",
        "-no-wait",
        f"-t={session_title}",
        f"-g={_group_path(project_path)}",
        f"-c={normalized_agent_type}",
    ]
    # Route model/effort through agent-deck's ToolOptions rather than a
    # `-cmd` wrapper string. The wrapper approach is broken for Claude
    # because the dev-channel wrap envelopes the claude command inside
    # `bash -lc "…"` and any wrapper-appended flags land outside the
    # quoted envelope where bash swallows them as positional parameters.
    args.extend(
        _resolve_agent_model_effort_args(
            normalized_agent_type, agent_model, agent_thinking
        )
    )
    if workspace_mode == "clone":
        args.append(f"-clone={_clone_name(session_title)}")
    args.append(launch_path)
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
    return f"pixel-forge-{_project_slug(project_path)}-{normalized_suffix}"


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
    workspace_mode: str = "clone",
) -> AgentDeckSessionTarget:
    session_title = title.strip() if isinstance(title, str) and title.strip() else _session_title_for_target(project_path)
    payload = await _launch_new_session(
        project_path,
        session_title=session_title,
        agent_type=agent_type.strip() or "claude",
        workspace_mode=workspace_mode.strip().lower() if isinstance(workspace_mode, str) else "clone",
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
    timeout_seconds: float = 20.0,
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


async def ensure_agent_deck_session(
    project_path: str,
    thread: LiveEditorThreadRecord,
    agent_type: str = "claude",
    workspace_mode: str = "clone",
    *,
    target_agent_deck_session_id: str | None = None,
    agent_model: str | None = None,
    agent_thinking: str | None = None,
) -> AgentDeckSessionInfo:
    payload: dict[str, object]
    rebind_workspace_path = _thread_rebind_workspace_path(project_path, thread)
    requested_workspace_mode = (
        workspace_mode.strip().lower()
        if isinstance(workspace_mode, str) and workspace_mode.strip()
        else "clone"
    )
    launch_workspace_mode = (
        "existing"
        if rebind_workspace_path
        else ("root" if requested_workspace_mode == "root" else "clone")
    )
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
                payload = await _launch_new_session(
                    project_path,
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
            payload = await _launch_new_session(
                project_path,
                session_title=preferred_session_title,
                agent_type=agent_type,
                workspace_mode=launch_workspace_mode,
                workspace_path=rebind_workspace_path,
                agent_model=agent_model,
                agent_thinking=agent_thinking,
            )
    else:
        payload = await _launch_new_session(
            project_path,
            session_title=preferred_session_title,
            agent_type=agent_type,
            workspace_mode=launch_workspace_mode,
            workspace_path=rebind_workspace_path,
            agent_model=agent_model,
            agent_thinking=agent_thinking,
        )

    if persisted_thread_title:
        current_title = _normalized_text(payload.get("title"))
        session_id = _normalized_text(payload.get("id"))
        if session_id and current_title != persisted_thread_title:
            await _rename_session(session_id, persisted_thread_title)
            payload = {
                **payload,
                "title": persisted_thread_title,
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

    with jsonl_path.open("r", encoding="utf-8") as handle:
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


def codex_jsonl_text_chunks_for_record(record: dict[str, object]) -> list[str]:
    if record.get("type") != "response_item":
        return []

    payload = record.get("payload")
    if not isinstance(payload, dict):
        return []
    if payload.get("type") != "message" or payload.get("role") != "assistant":
        return []

    content_blocks = payload.get("content")
    if not isinstance(content_blocks, list):
        return []

    chunks: list[str] = []
    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "output_text":
            continue
        text = block.get("text")
        if isinstance(text, str) and text:
            chunks.append(text)
    return chunks


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

    with jsonl_path.open("r", encoding="utf-8") as handle:
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
            with jsonl_path.open("r", encoding="utf-8") as handle:
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
            stderr.decode().strip()
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
            stderr.decode().strip()
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


async def wait_for_agent_deck_turn_completion(
    session_info: AgentDeckSessionInfo,
    *,
    startup_timeout_seconds: float = 20.0,
    completion_timeout_seconds: float = 600.0,
    poll_interval_seconds: float = 0.5,
) -> None:
    loop = asyncio.get_running_loop()
    startup_deadline = loop.time() + startup_timeout_seconds
    completion_deadline = loop.time() + completion_timeout_seconds
    saw_running = False
    settled_polls = 0

    while loop.time() < completion_deadline:
        payload = await session_show(session_info.agent_deck_session_id)
        status = str(payload.get("status") or "").strip().lower()

        if status in {"running", "busy", "active", "connected"}:
            saw_running = True
            settled_polls = 0
        elif status in {"waiting", "idle", ""}:
            if saw_running:
                settled_polls += 1
                if settled_polls >= 2:
                    return
            elif loop.time() >= startup_deadline:
                raise AgentDeckBridgeError(
                    f"Agent Deck session `{session_info.agent_deck_session_title}` never started processing the live-edit request."
                )
        else:
            settled_polls = 0
            if not saw_running and loop.time() >= startup_deadline:
                raise AgentDeckBridgeError(
                    f"Agent Deck session `{session_info.agent_deck_session_title}` did not enter a running state (status: {status or 'unknown'})."
                )

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
