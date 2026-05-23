from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from uuid import UUID

from agent_providers.models import (
    AgentProviderSessionActivity,
    AgentProviderSessionTarget,
    AgentProviderStatus,
    AgentProviderTurnDispatch,
    AgentTransportDescriptor,
    AgentTurnRequest,
    ProviderCapabilitySet,
)

DEFAULT_CURSOR_MODEL = "composer-2.5-fast"
_CHAT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class CursorCliProviderError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _resolve_cursor_executable() -> str:
    env_cmd = os.environ.get("PIXEL_FORGE_CURSOR_AGENT_CMD", "").strip()
    if env_cmd:
        return env_cmd

    direct_match = shutil.which("cursor-agent")
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
        home / ".npm-global" / "bin",
        home / ".local" / "share" / "pnpm",
        home / "bin",
        home / ".bun" / "bin",
        home / ".cargo" / "bin",
    ):
        append_path(extra_path)

    if search_paths:
        resolved = shutil.which("cursor-agent", path=os.pathsep.join(search_paths))
        if resolved:
            return resolved

    raise CursorCliProviderError(
        "cursor-agent command not found in the Pixel Forge service environment. "
        "Install Cursor CLI with `curl https://cursor.com/install -fsS | bash`."
    )


def _cursor_config_home() -> str:
    return str(
        Path(os.environ.get("CURSOR_CONFIG_DIR") or Path.home() / ".cursor").expanduser()
    )


def _normalize_chat_id(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or not _CHAT_ID_RE.match(normalized):
        return None
    try:
        return str(UUID(normalized))
    except ValueError:
        return None


def _parse_create_chat_output(raw_output: str) -> str:
    for line in raw_output.splitlines():
        normalized = _normalize_chat_id(line)
        if normalized:
            return normalized
    raise CursorCliProviderError(
        "cursor-agent create-chat did not return a chat id"
    )


def _extract_assistant_text(event: dict[str, object]) -> str:
    message = event.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
    return "".join(parts)


def _parse_stream_json_output(
    stdout: str,
    *,
    stderr: str,
    returncode: int,
) -> tuple[str, str | None, str | None]:
    assistant_parts: list[str] = []
    terminal_result: str | None = None
    session_id: str | None = None
    last_event_type: str | None = None
    terminal_error: str | None = None

    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue

        event_type = str(event.get("type") or "")
        last_event_type = event_type or last_event_type

        if event_type == "system":
            parsed_session_id = _normalize_chat_id(event.get("session_id"))
            if parsed_session_id:
                session_id = parsed_session_id
            continue

        if event_type == "assistant":
            assistant_text = _extract_assistant_text(event)
            if assistant_text:
                assistant_parts.append(assistant_text)
            parsed_session_id = _normalize_chat_id(event.get("session_id"))
            if parsed_session_id:
                session_id = parsed_session_id
            continue

        if event_type == "result":
            parsed_session_id = _normalize_chat_id(event.get("session_id"))
            if parsed_session_id:
                session_id = parsed_session_id
            result = event.get("result")
            if isinstance(result, str) and result.strip():
                terminal_result = result.strip()
            if event.get("is_error") is True:
                error_message = event.get("error")
                if isinstance(error_message, str) and error_message.strip():
                    terminal_error = error_message.strip()
                elif isinstance(result, str) and result.strip():
                    terminal_error = result.strip()
            continue

    output = terminal_result or "".join(assistant_parts).strip()
    if returncode != 0 or terminal_error:
        detail = stderr.strip() or terminal_error or f"Cursor CLI failed after {last_event_type or 'unknown event'}"
        raise CursorCliProviderError(detail)
    if not output and not terminal_result:
        detail = stderr.strip() or "Cursor CLI returned no assistant output"
        raise CursorCliProviderError(detail)
    return output, session_id, terminal_error


def _build_cursor_dispatch_argv(
    executable: str,
    *,
    workspace_path: str,
    prompt: str,
    provider_session_id: str | None,
    model: str | None,
    resume: bool,
) -> list[str]:
    cmd = [
        executable,
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
        "--force",
        "--approve-mcps",
        "--workspace",
        workspace_path,
    ]
    normalized_model = model.strip() if isinstance(model, str) and model.strip() else DEFAULT_CURSOR_MODEL
    cmd.extend(["--model", normalized_model])
    if resume and provider_session_id:
        cmd.extend(["--resume", provider_session_id])
    cmd.append(prompt)
    return cmd


@dataclass(slots=True)
class CursorCliSessionInfo:
    provider_session_id: str
    title: str
    workspace_path: str
    status: str | None
    cursor_session_id: str | None
    has_started: bool = False
    agent_deck_session_id: str | None = None
    agent_deck_session_title: str | None = None
    tmux_session: str | None = None
    tool: str = "cursor"
    acpx_agent: str | None = None
    acpx_session_name: str | None = None
    acpx_record_id: str | None = None
    acp_session_id: str | None = None
    claude_session_id: str | None = None
    codex_session_id: str | None = None
    gemini_session_id: str | None = None
    jsonl_path: object | None = None


async def _create_cursor_chat() -> str:
    executable = _resolve_cursor_executable()
    proc = await asyncio.create_subprocess_exec(
        executable,
        "create-chat",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise CursorCliProviderError(
            stderr.decode("utf-8", errors="replace").strip()
            or "cursor-agent create-chat failed"
        )
    return _parse_create_chat_output(stdout.decode("utf-8", errors="replace"))


async def _run_cursor_turn(
    session_info: CursorCliSessionInfo,
    *,
    prompt: str,
    image_paths: list[str] | None,
    model: str | None,
    timeout_seconds: float,
) -> str:
    executable = _resolve_cursor_executable()
    dispatch_prompt = prompt
    referenced_images = [path.strip() for path in image_paths or [] if path.strip()]
    if referenced_images:
        dispatch_prompt = "\n\n".join(
            [
                "Reference image paths:",
                "\n".join(f"- {path}" for path in referenced_images),
                prompt,
            ]
        )

    resume = bool(
        (session_info.cursor_session_id or session_info.provider_session_id or "").strip()
    )
    cmd = _build_cursor_dispatch_argv(
        executable,
        workspace_path=session_info.workspace_path,
        prompt=dispatch_prompt,
        provider_session_id=session_info.cursor_session_id or session_info.provider_session_id,
        model=model,
        resume=resume,
    )
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=session_info.workspace_path,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise CursorCliProviderError("Timed out waiting for Cursor CLI completion") from exc

    output, parsed_session_id, _ = _parse_stream_json_output(
        stdout.decode("utf-8", errors="replace"),
        stderr=stderr.decode("utf-8", errors="replace"),
        returncode=proc.returncode or 0,
    )
    if parsed_session_id:
        session_info.provider_session_id = parsed_session_id
        session_info.cursor_session_id = parsed_session_id
    session_info.has_started = True
    return output


class CursorCliProvider:
    provider_id = "cursor-cli"
    display_name = "Cursor CLI"

    capabilities = ProviderCapabilitySet(
        list_sessions=False,
        launch=True,
        send=True,
        observe=True,
        open_tui=True,
        rename=False,
        delete=False,
    )
    transports = (
        AgentTransportDescriptor(
            agent_id="cursor",
            display_name="Cursor",
            current_transport="cursor-agent --print stream-json direct CLI request",
            preferred_transport="cursor-agent stream-json with resumed chat sessions",
            architecture_note=(
                "This direct provider launches and resumes Cursor CLI chats through "
                "headless stream-json turns while Pixel Forge owns session metadata."
            ),
        ),
    )

    def status(self) -> AgentProviderStatus:
        unavailable_reason: str | None = None
        command: str | None
        try:
            command = _resolve_cursor_executable()
        except CursorCliProviderError as exc:
            command = None
            unavailable_reason = str(exc)
        diagnostics: dict[str, object] = {
            "config_home": _cursor_config_home(),
        }
        if os.environ.get("CURSOR_API_KEY"):
            diagnostics["api_key_configured"] = True
        return AgentProviderStatus(
            id=self.provider_id,
            display_name=self.display_name,
            enabled=True,
            available=bool(command),
            reason=None if command else unavailable_reason,
            command=[command] if command else [],
            capabilities=self.capabilities,
            transports=self.transports,
            diagnostics=diagnostics,
        )

    def is_missing_session_error(self, error: BaseException) -> bool:
        message = str(error).lower()
        if not any(token in message for token in ("session", "chat", "conversation")):
            return False
        return any(
            token in message
            for token in (
                "not_found",
                "not found",
                "could not find",
                "does not exist",
                "no conversation",
                "unknown session",
                "invalid session",
                "unknown chat",
            )
        )

    async def list_sessions(
        self,
        project_path: str,
        *,
        include_live_editor: bool = False,
    ) -> list[AgentProviderSessionTarget]:
        del project_path, include_live_editor
        return []

    async def create_session(
        self,
        project_path: str,
        *,
        agent_type: str = "cursor",
        title: str | None = None,
        workspace_mode: str = "root",
        agent_model: str | None = None,
        agent_thinking: str | None = None,
    ) -> AgentProviderSessionTarget:
        del agent_type, title, workspace_mode, agent_thinking
        session_id = await _create_cursor_chat()
        return AgentProviderSessionTarget(
            provider_id=self.provider_id,
            id=session_id,
            title=f"cursor:{session_id[:8]}",
            workspace_path=project_path,
            group=None,
            agent_id="cursor",
            command="cursor-agent --print",
            status="idle",
            created_at=None,
        )

    async def rename_session(
        self,
        project_path: str,
        provider_session_id: str,
        new_title: str,
    ) -> None:
        del project_path, provider_session_id, new_title
        raise CursorCliProviderError("Cursor CLI provider rename is not implemented yet")

    async def delete_session(
        self,
        project_path: str,
        provider_session_id: str,
        *,
        force_clone_remove: bool = False,
    ) -> None:
        del project_path, provider_session_id, force_clone_remove
        raise CursorCliProviderError("Cursor CLI provider delete is not implemented yet")

    async def get_activity(
        self,
        project_path: str,
        provider_session_id: str,
    ) -> AgentProviderSessionActivity:
        return AgentProviderSessionActivity(
            provider_id=self.provider_id,
            provider_session_id=provider_session_id,
            title=f"cursor:{provider_session_id[:8]}",
            workspace_path=project_path,
            agent_id="cursor",
            status=None,
            output="",
        )

    async def ensure_live_session(
        self,
        project_path: str,
        thread,
        *,
        agent_type: str = "cursor",
        workspace_mode: str = "root",
        target_provider_session_id: str | None = None,
        agent_model: str | None = None,
        agent_thinking: str | None = None,
        request: AgentTurnRequest | None = None,
    ) -> CursorCliSessionInfo:
        del request, agent_type, workspace_mode, agent_model, agent_thinking
        persisted_id = (
            thread.provider_session_id
            if getattr(thread, "provider_id", None) == self.provider_id
            else None
        )
        session_id = (
            target_provider_session_id
            if isinstance(target_provider_session_id, str) and target_provider_session_id.strip()
            else persisted_id
        )
        if isinstance(session_id, str) and session_id.strip():
            normalized_id = session_id.strip()
            return CursorCliSessionInfo(
                provider_session_id=normalized_id,
                title=(
                    getattr(thread, "provider_session_title", None)
                    or f"cursor:{normalized_id[:8]}"
                ),
                workspace_path=project_path,
                status="idle",
                cursor_session_id=normalized_id,
                has_started=bool(persisted_id),
            )

        created_id = await _create_cursor_chat()
        return CursorCliSessionInfo(
            provider_session_id=created_id,
            title=f"cursor:{created_id[:8]}",
            workspace_path=project_path,
            status="idle",
            cursor_session_id=created_id,
        )

    async def dispatch_turn(
        self,
        session_info: CursorCliSessionInfo,
        *,
        project_path: str,
        prompt: str,
        image_paths: list[str] | None = None,
        startup_timeout_seconds: float,
        completion_timeout_seconds: float,
        request: AgentTurnRequest | None = None,
    ) -> AgentProviderTurnDispatch:
        del project_path, startup_timeout_seconds
        model = None
        if request is not None:
            prompt = request.prompt or prompt
            image_paths = list(request.image_paths) or image_paths
            model = request.agent_model
        wait_task = asyncio.create_task(
            _run_cursor_turn(
                session_info,
                prompt=prompt,
                image_paths=image_paths,
                model=model,
                timeout_seconds=completion_timeout_seconds,
            )
        )
        return AgentProviderTurnDispatch(
            provider_id=self.provider_id,
            provider_session_id=session_info.provider_session_id,
            agent_id="cursor",
            baseline_output="",
            status_message="Request delivered to Cursor CLI. Waiting for completion...",
            wait_task=wait_task,
            status_heartbeat=False,
        )
