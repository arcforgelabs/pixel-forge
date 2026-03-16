from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from live_editor_threads import LiveEditorThreadRecord


CLAUDE_DIR_NAME_RE = re.compile(r"[^a-zA-Z0-9-]")
STREAM_IDLE_AFTER_COMPLETION_SECONDS = 1.0
STREAM_POLL_INTERVAL_SECONDS = 0.2


@dataclass(slots=True)
class AgentDeckSessionInfo:
    agent_deck_session_id: str
    agent_deck_session_title: str
    claude_session_id: str | None
    jsonl_path: Path | None


@dataclass(slots=True)
class ClaudeStreamStats:
    streamed_text: bool = False


class AgentDeckBridgeError(RuntimeError):
    pass


def _project_slug(project_path: str) -> str:
    project_name = Path(project_path).resolve().name or "project"
    slug = re.sub(r"[^a-z0-9-]+", "-", project_name.lower()).strip("-")
    return slug or "project"


def _session_title(project_path: str, thread_id: str) -> str:
    return f"pixel-forge-{_project_slug(project_path)}-{thread_id[:8]}"


def _group_path(project_path: str) -> str:
    return f"pixel-forge/{_project_slug(project_path)}"


async def _run_command(args: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


async def _run_json_command(args: list[str], cwd: str | None = None) -> dict[str, object]:
    code, stdout, stderr = await _run_command(args, cwd=cwd)
    if code != 0:
        error_output = stderr.strip() or stdout.strip() or "Unknown error"
        raise AgentDeckBridgeError(error_output)

    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AgentDeckBridgeError(
            f"Agent Deck returned non-JSON output for {' '.join(args)}"
        ) from exc


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
    return await _run_json_command(
        ["agent-deck", "session", "show", agent_deck_session_id, "-json"]
    )


async def _start_existing_session(agent_deck_session_id: str) -> None:
    code, _, stderr = await _run_command(
        ["agent-deck", "session", "start", agent_deck_session_id]
    )
    if code != 0:
        raise AgentDeckBridgeError(stderr.strip() or "Failed to start Agent Deck session")


async def _launch_new_session(project_path: str, thread: LiveEditorThreadRecord) -> dict[str, object]:
    return await _run_json_command(
        [
            "agent-deck",
            "launch",
            "-json",
            "-no-wait",
            f"-t={_session_title(project_path, thread.thread_id)}",
            f"-g={_group_path(project_path)}",
            "-c=claude",
            project_path,
        ]
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
) -> AgentDeckSessionInfo:
    payload: dict[str, object]
    agent_deck_session_id = thread.agent_deck_session_id

    if agent_deck_session_id:
        try:
            payload = await session_show(agent_deck_session_id)
        except AgentDeckBridgeError:
            payload = await _launch_new_session(project_path, thread)
            agent_deck_session_id = str(payload["id"])
        else:
            status = str(payload.get("status") or "")
            if status not in {"running", "waiting", "idle", "starting"}:
                await _start_existing_session(agent_deck_session_id)
                payload = await session_show(agent_deck_session_id)
    else:
        payload = await _launch_new_session(project_path, thread)
        agent_deck_session_id = str(payload["id"])

    if not agent_deck_session_id:
        raise AgentDeckBridgeError("Agent Deck did not return a session ID")

    agent_deck_title = str(payload.get("title") or _session_title(project_path, thread.thread_id))
    claude_session_id, jsonl_path, payload = await _wait_for_claude_session_id(
        agent_deck_session_id,
        project_path,
    )

    if not claude_session_id:
        fallback_claude_id = payload.get("claude_session_id")
        if isinstance(fallback_claude_id, str) and fallback_claude_id:
            claude_session_id = fallback_claude_id
            jsonl_path = claude_jsonl_path(project_path, claude_session_id)

    return AgentDeckSessionInfo(
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_title,
        claude_session_id=claude_session_id,
        jsonl_path=jsonl_path,
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
