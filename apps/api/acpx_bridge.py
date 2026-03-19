from __future__ import annotations

import asyncio
import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path


ACPX_VERSION = "0.3.1"
ACPX_SESSION_NAME_PREFIX = "pixel-forge"
ACPX_SHELL_MARKER = "acpx_agent_shell.py"
DEFAULT_PROMPT_TIMEOUT_SECONDS = 600
ACPX_STREAM_LIMIT_BYTES = 8 * 1024 * 1024
MAX_TOOL_RESULT_TEXT_CHARS = 4000


@dataclass(slots=True)
class AcpxSessionInfo:
    agent: str
    session_name: str
    acpx_record_id: str | None
    acp_session_id: str | None
    event_log_path: Path | None
    status: str | None


class AcpxBridgeError(RuntimeError):
    pass


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _local_acpx_binary() -> Path | None:
    candidate = _repo_root() / "node_modules" / ".bin" / "acpx"
    if candidate.is_file():
        return candidate
    return None


def acpx_base_command() -> list[str]:
    local_binary = _local_acpx_binary()
    if local_binary is not None:
        return [str(local_binary)]
    return ["npx", "-y", f"acpx@{ACPX_VERSION}"]


def acpx_shell_script_path() -> Path:
    return Path(__file__).resolve().with_name("acpx_agent_shell.py")


def build_agent_deck_acpx_command(agent: str, session_name: str, project_path: str) -> str:
    command = [
        "python3",
        "-u",
        str(acpx_shell_script_path()),
        "--agent",
        agent.strip().lower(),
        "--session-name",
        session_name.strip(),
        "--cwd",
        str(Path(project_path).resolve()),
    ]
    return shlex.join(command)


def parse_agent_deck_acpx_command(command: str | None) -> tuple[str, str] | None:
    if not isinstance(command, str) or ACPX_SHELL_MARKER not in command:
        return None

    try:
        parts = shlex.split(command)
    except ValueError:
        return None

    agent: str | None = None
    session_name: str | None = None
    for index, part in enumerate(parts):
        if part == "--agent" and index + 1 < len(parts):
            agent = parts[index + 1].strip().lower()
        elif part == "--session-name" and index + 1 < len(parts):
            session_name = parts[index + 1].strip()

    if not agent or not session_name:
        return None
    return agent, session_name


def default_acpx_session_name(project_path: str, suffix: str) -> str:
    project_slug = Path(project_path).resolve().name or "project"
    normalized_slug = "".join(
        char if char.isalnum() else "-"
        for char in project_slug.lower()
    ).strip("-") or "project"
    normalized_suffix = "".join(
        char if char.isalnum() else "-"
        for char in suffix.lower()
    ).strip("-") or "session"
    return f"{ACPX_SESSION_NAME_PREFIX}-{normalized_slug}-{normalized_suffix}"


async def _run_command(args: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


def _json_error_message(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    message = error.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()
    return None


def _decode_json_payload(stdout: str, args: list[str]) -> object:
    stripped = stdout.strip()
    if not stripped:
        raise AcpxBridgeError(f"ACPX returned empty output for {' '.join(args)}")
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise AcpxBridgeError(
            f"ACPX returned non-JSON output for {' '.join(args)}"
        ) from exc

    error_message = _json_error_message(payload)
    if error_message:
        raise AcpxBridgeError(error_message)

    return payload


async def _run_json_command(args: list[str], cwd: str | None = None) -> object:
    code, stdout, stderr = await _run_command(args, cwd=cwd)
    payload = _decode_json_payload(stdout, args)
    if code != 0:
        error_output = stderr.strip() or _json_error_message(payload) or "ACPX command failed"
        raise AcpxBridgeError(error_output)
    return payload


def _json_command_args(
    agent: str,
    *extra: str,
) -> list[str]:
    return [
        *acpx_base_command(),
        "--format",
        "json",
        "--json-strict",
        agent.strip().lower(),
        *extra,
    ]


def _payload_to_session_info(
    agent: str,
    session_name: str,
    payload: dict[str, object],
    *,
    status: str | None = None,
) -> AcpxSessionInfo:
    event_log = payload.get("eventLog")
    event_log_path: Path | None = None
    if isinstance(event_log, dict):
        active_path = event_log.get("active_path")
        if isinstance(active_path, str) and active_path.strip():
            event_log_path = Path(active_path)

    return AcpxSessionInfo(
        agent=agent,
        session_name=session_name,
        acpx_record_id=(
            str(payload.get("acpxRecordId")).strip()
            if isinstance(payload.get("acpxRecordId"), str)
            and str(payload.get("acpxRecordId")).strip()
            else None
        ),
        acp_session_id=(
            str(payload.get("acpSessionId")).strip()
            if isinstance(payload.get("acpSessionId"), str)
            and str(payload.get("acpSessionId")).strip()
            else None
        ),
        event_log_path=event_log_path,
        status=status,
    )


async def show_acpx_session(
    agent: str,
    project_path: str,
    session_name: str,
) -> AcpxSessionInfo:
    payload = await _run_json_command(
        _json_command_args(agent, "sessions", "show", session_name),
        cwd=project_path,
    )
    if not isinstance(payload, dict):
        raise AcpxBridgeError("ACPX session show returned an unexpected shape")

    status_payload = await _run_json_command(
        _json_command_args(agent, "status", "-s", session_name),
        cwd=project_path,
    )
    status: str | None = None
    if isinstance(status_payload, dict):
        raw_status = status_payload.get("status")
        if isinstance(raw_status, str) and raw_status.strip():
            status = raw_status.strip()

    return _payload_to_session_info(agent, session_name, payload, status=status)


async def ensure_acpx_session(
    agent: str,
    project_path: str,
    session_name: str,
) -> AcpxSessionInfo:
    try:
        payload = await _run_json_command(
            _json_command_args(agent, "sessions", "ensure", "--name", session_name),
            cwd=project_path,
        )
        if not isinstance(payload, dict):
            raise AcpxBridgeError("ACPX session ensure returned an unexpected shape")
        return await show_acpx_session(agent, project_path, session_name)
    except AcpxBridgeError as exc:
        if "returned empty output" not in str(exc):
            raise
        return await _wait_for_acpx_session(agent, project_path, session_name)


async def _wait_for_acpx_session(
    agent: str,
    project_path: str,
    session_name: str,
    *,
    timeout_seconds: float = 10.0,
    poll_interval_seconds: float = 0.5,
) -> AcpxSessionInfo:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_error: AcpxBridgeError | None = None

    while asyncio.get_running_loop().time() < deadline:
        try:
            return await show_acpx_session(agent, project_path, session_name)
        except AcpxBridgeError as exc:
            last_error = exc
            await asyncio.sleep(poll_interval_seconds)

    if last_error is not None:
        raise last_error
    raise AcpxBridgeError(
        f"Timed out waiting for ACPX session {session_name}"
    )


def _extract_text_from_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(_extract_text_from_content(item) for item in content)
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str):
            return text
        if "Text" in content and isinstance(content.get("Text"), str):
            return str(content["Text"])
    return ""


def _extract_last_agent_text(payload: dict[str, object]) -> str:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return ""

    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        agent_message = message.get("Agent")
        if not isinstance(agent_message, dict):
            continue
        content = agent_message.get("content")
        text = _extract_text_from_content(content)
        if text:
            return text
    return ""


def _summarize_tool_input(update: dict[str, object]) -> dict[str, object]:
    summary: dict[str, object] = {}

    title = update.get("title")
    if isinstance(title, str) and title.strip():
        summary["title"] = title.strip()

    kind = update.get("kind")
    if isinstance(kind, str) and kind.strip():
        summary["kind"] = kind.strip()

    locations = update.get("locations")
    if isinstance(locations, list):
        paths = [
            location.get("path")
            for location in locations
            if isinstance(location, dict)
            and isinstance(location.get("path"), str)
            and str(location.get("path")).strip()
        ]
        if paths:
            summary["path"] = str(paths[0]).strip()
            if len(paths) > 1:
                summary["paths"] = paths

    raw_input = update.get("rawInput")
    if isinstance(raw_input, dict):
        command = raw_input.get("command")
        if isinstance(command, list) and command:
            summary["command"] = shlex.join(str(part) for part in command)
        elif isinstance(command, str) and command.strip():
            summary["command"] = command.strip()

        cwd = raw_input.get("cwd")
        if isinstance(cwd, str) and cwd.strip():
            summary["cwd"] = cwd.strip()

        parsed_cmd = raw_input.get("parsed_cmd")
        if isinstance(parsed_cmd, list):
            for entry in parsed_cmd:
                if not isinstance(entry, dict):
                    continue
                path = entry.get("path")
                if isinstance(path, str) and path.strip():
                    summary.setdefault("path", path.strip())
                    break

    return summary


def _summarize_tool_output(update: dict[str, object]) -> tuple[str, bool]:
    def _truncate(value: str) -> str:
        text = value.strip()
        if len(text) <= MAX_TOOL_RESULT_TEXT_CHARS:
            return text
        return (
            text[:MAX_TOOL_RESULT_TEXT_CHARS]
            + "\n...[truncated tool output]"
        )

    status = str(update.get("status") or "").strip().lower()
    raw_output = update.get("rawOutput")
    if not isinstance(raw_output, dict):
        return status or "tool update", status not in {"", "completed"}

    for key in ("formatted_output", "aggregated_output", "stdout"):
        value = raw_output.get(key)
        if isinstance(value, str) and value.strip():
            return _truncate(value), False

    stderr = raw_output.get("stderr")
    if isinstance(stderr, str) and stderr.strip():
        return _truncate(stderr), True

    exit_code = raw_output.get("exit_code")
    if isinstance(exit_code, int) and exit_code != 0:
        return f"exit code {exit_code}", True

    return status or "tool completed", status not in {"", "completed"}


async def prompt_acpx_session(
    agent: str,
    project_path: str,
    session_name: str,
    prompt: str,
    *,
    websocket=None,
    timeout_seconds: int = DEFAULT_PROMPT_TIMEOUT_SECONDS,
) -> tuple[AcpxSessionInfo, str, bool]:
    prompt_args = [
        *acpx_base_command(),
        "--format",
        "json",
        "--json-strict",
        "--approve-all",
        "--timeout",
        str(timeout_seconds),
        agent.strip().lower(),
        "prompt",
        "-s",
        session_name.strip(),
        prompt,
    ]
    proc = await asyncio.create_subprocess_exec(
        *prompt_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path,
        limit=ACPX_STREAM_LIMIT_BYTES,
    )

    if proc.stdout is None or proc.stderr is None:
        raise AcpxBridgeError("Failed to capture ACPX prompt output")

    text_fragments: list[str] = []
    error_message: str | None = None
    streamed_text = False

    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        decoded = line.decode().strip()
        if not decoded:
            continue

        try:
            payload = json.loads(decoded)
        except json.JSONDecodeError as exc:
            raise AcpxBridgeError("ACPX returned invalid JSON during prompt") from exc

        parsed_error = _json_error_message(payload)
        if parsed_error:
            error_message = parsed_error
            continue

        if not isinstance(payload, dict):
            continue

        if payload.get("method") != "session/update":
            continue

        params = payload.get("params")
        if not isinstance(params, dict):
            continue

        update = params.get("update")
        if not isinstance(update, dict):
            continue

        session_update = str(update.get("sessionUpdate") or "").strip()
        if session_update == "tool_call":
            if websocket is not None:
                await websocket.send_json(
                    {
                        "type": "tool_use",
                        "tool_call_id": update.get("toolCallId"),
                        "tool": str(update.get("title") or update.get("kind") or "Tool"),
                        "input": _summarize_tool_input(update),
                    }
                )
            continue
        if session_update == "tool_call_update":
            status = str(update.get("status") or "").strip().lower()
            if status not in {"completed", "failed", "cancelled"}:
                continue
            output_text, is_error = _summarize_tool_output(update)
            if websocket is not None:
                await websocket.send_json(
                    {
                        "type": "tool_result",
                        "tool_call_id": update.get("toolCallId"),
                        "content": output_text,
                        "is_error": is_error,
                    }
                )
            continue
        if session_update != "agent_message_chunk":
            continue

        content = update.get("content")
        text = _extract_text_from_content(content)
        if not text:
            continue

        text_fragments.append(text)
        streamed_text = True
        if websocket is not None:
            await websocket.send_json({"type": "chunk", "content": text})

    stderr_output = (await proc.stderr.read()).decode().strip()
    await proc.wait()

    if proc.returncode != 0:
        raise AcpxBridgeError(
            error_message or stderr_output or "ACPX prompt failed"
        )

    session_info = await show_acpx_session(agent, project_path, session_name)
    text_output = "".join(text_fragments)
    if not text_output:
        payload = await _run_json_command(
            _json_command_args(agent, "sessions", "show", session_name),
            cwd=project_path,
        )
        if isinstance(payload, dict):
            text_output = _extract_last_agent_text(payload)

    return session_info, text_output, streamed_text


async def close_acpx_session(agent: str, project_path: str, session_name: str) -> None:
    await _run_json_command(
        _json_command_args(agent, "sessions", "close", session_name),
        cwd=project_path,
    )
