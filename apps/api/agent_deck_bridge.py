from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from acpx_bridge import AcpxSessionInfo, ensure_acpx_session, parse_agent_deck_acpx_command
from live_editor_threads import LiveEditorThreadRecord


CLAUDE_DIR_NAME_RE = re.compile(r"[^a-zA-Z0-9-]")
STREAM_IDLE_AFTER_COMPLETION_SECONDS = 1.0
STREAM_POLL_INTERVAL_SECONDS = 0.2


@dataclass(slots=True)
class AgentDeckSessionInfo:
    agent_deck_session_id: str
    agent_deck_session_title: str
    workspace_path: str
    acpx_agent: str | None
    acpx_session_name: str | None
    acpx_record_id: str | None
    acp_session_id: str | None
    claude_session_id: str | None
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
class ClaudeStreamStats:
    streamed_text: bool = False


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


def _clone_name(session_title: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", session_title.lower()).strip("-")
    return normalized or uuid4().hex[:8]


async def _run_command(args: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


def _decode_json_output(stdout: str, args: list[str]) -> object:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AgentDeckBridgeError(
            f"Agent Deck returned non-JSON output for {' '.join(args)}"
        ) from exc


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


def _convert_to_claude_dir_name(path: str) -> str:
    return CLAUDE_DIR_NAME_RE.sub("-", path)


def _claude_config_dir() -> Path:
    claude_config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if claude_config_dir:
        return Path(claude_config_dir)
    return Path.home() / ".claude"


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


async def session_show(agent_deck_session_id: str) -> dict[str, object]:
    return await _run_json_object_command(
        ["agent-deck", "session", "show", agent_deck_session_id, "-json"]
    )


async def _start_existing_session(agent_deck_session_id: str) -> None:
    code, _, stderr = await _run_command(
        ["agent-deck", "session", "start", agent_deck_session_id]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to start Agent Deck session")


async def _rename_session(agent_deck_session_id: str, new_title: str) -> None:
    code, _, stderr = await _run_command(
        ["agent-deck", "rename", agent_deck_session_id, new_title]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to rename Agent Deck session")


async def _launch_new_session(
    project_path: str,
    *,
    session_title: str,
    agent_type: str = "claude",
    workspace_mode: str = "clone",
) -> dict[str, object]:
    normalized_agent_type = agent_type.strip().lower() or "claude"
    tool_arg = f"-c={normalized_agent_type}"
    args = [
        "agent-deck",
        "launch",
        "-json",
        "-no-wait",
        f"-t={session_title}",
        f"-g={_group_path(project_path)}",
        tool_arg,
    ]
    if workspace_mode == "clone":
        args.append(f"-clone={_clone_name(session_title)}")
    args.append(project_path)
    return await _run_json_object_command(args)


def _session_tool(payload: dict[str, object], default: str = "claude") -> str:
    tool = payload.get("tool")
    if isinstance(tool, str) and tool.strip():
        return tool.strip().lower()
    return default


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
    payload = await _run_json_array_command(["agent-deck", "ls", "-json"])
    sessions: list[AgentDeckSessionTarget] = []

    for entry in payload:
        if not isinstance(entry, dict):
            continue

        session_path = entry.get("path")
        if not isinstance(session_path, str) or not session_path.strip():
            continue

        if not _session_belongs_to_project(project_path, session_path):
            continue

        if not include_acpx_backed and _is_acpx_backed_payload(entry):
            continue

        sessions.append(_payload_to_session_target(entry))

    return sessions


async def list_project_agent_deck_sessions(project_path: str) -> list[AgentDeckSessionTarget]:
    return await _list_project_session_targets(
        project_path,
        include_acpx_backed=False,
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

    agent_deck_title = str(payload.get("title") or fallback_title)
    workspace_path = str(payload.get("path") or "").strip() or _normalize_path(project_path)
    session_tool = _session_tool(payload)
    acpx_agent: str | None = None
    acpx_session_name: str | None = None
    acpx_record_id: str | None = None
    acp_session_id: str | None = None
    claude_session_id: str | None = None
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
            if not claude_session_id:
                fallback_claude_id = payload.get("claude_session_id")
                if isinstance(fallback_claude_id, str) and fallback_claude_id:
                    claude_session_id = fallback_claude_id
                    jsonl_path = claude_jsonl_path(workspace_path, claude_session_id)

    return AgentDeckSessionInfo(
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_title,
        workspace_path=workspace_path,
        acpx_agent=acpx_agent,
        acpx_session_name=acpx_session_name,
        acpx_record_id=acpx_record_id,
        acp_session_id=acp_session_id,
        claude_session_id=claude_session_id,
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


async def ensure_agent_deck_session(
    project_path: str,
    thread: LiveEditorThreadRecord,
    agent_type: str = "claude",
    *,
    target_agent_deck_session_id: str | None = None,
) -> AgentDeckSessionInfo:
    payload: dict[str, object]
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
                    session_title=_session_title(project_path, thread.thread_id),
                    agent_type=agent_type,
                    workspace_mode="clone",
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
                session_title=_session_title(project_path, thread.thread_id),
                agent_type=agent_type,
                workspace_mode="clone",
            )
    else:
        payload = await _launch_new_session(
            project_path,
            session_title=_session_title(project_path, thread.thread_id),
            agent_type=agent_type,
            workspace_mode="clone",
        )

    return await _build_session_info(
        project_path,
        payload,
        fallback_title=_session_title(project_path, thread.thread_id),
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


async def _emit_claude_jsonl_record(
    websocket,
    record: dict[str, object],
    stats: ClaudeStreamStats,
) -> None:
    record_type = record.get("type")

    if record_type == "assistant":
        message = record.get("message")
        if not isinstance(message, dict):
            return
        if message.get("role") != "assistant":
            return

        content_blocks = message.get("content")
        if not isinstance(content_blocks, list):
            return

        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    stats.streamed_text = True
                    await websocket.send_json({"type": "chunk", "content": text})
            elif block_type == "tool_use":
                await websocket.send_json(
                    {
                        "type": "tool_use",
                        "tool": block.get("name", ""),
                        "input": block.get("input", {}),
                    }
                )
        return

    if record_type != "user":
        return

    message = record.get("message")
    if not isinstance(message, dict):
        return

    content_blocks = message.get("content")
    if not isinstance(content_blocks, list):
        return

    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "tool_result":
            continue

        await websocket.send_json(
            {
                "type": "tool_result",
                "content": _flatten_tool_content(block.get("content")),
                "is_error": bool(block.get("is_error")),
            }
        )


async def stream_claude_jsonl(
    websocket,
    jsonl_path: Path,
    start_offset: int,
    wait_task: asyncio.Task[object],
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

                    await _emit_claude_jsonl_record(websocket, record, stats)

        if wait_task.done():
            idle_for = asyncio.get_running_loop().time() - last_activity
            if idle_for >= STREAM_IDLE_AFTER_COMPLETION_SECONDS:
                break

        await asyncio.sleep(STREAM_POLL_INTERVAL_SECONDS)

    return stats


async def start_agent_deck_send(
    session_info: AgentDeckSessionInfo,
    *,
    project_path: str,
    prompt: str,
    timeout: str = "10m",
) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        "agent-deck",
        "session",
        "send",
        session_info.agent_deck_session_id,
        prompt,
        "-wait",
        "-q",
        f"-timeout={timeout}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path,
    )


async def get_last_output(agent_deck_session_id: str) -> str:
    code, stdout, stderr = await _run_command(
        ["agent-deck", "session", "output", agent_deck_session_id, "-q"]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to read Agent Deck output")
    return stdout.strip()
