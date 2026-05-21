from __future__ import annotations

import asyncio
import json
import os
import shutil
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from agent_providers.models import (
    AgentProviderSessionActivity,
    AgentProviderSessionTarget,
    AgentProviderStatus,
    AgentProviderTurnDispatch,
    AgentTransportDescriptor,
    AgentTurnRequest,
    ProviderCapabilitySet,
)
from chat_titles import is_placeholder_chat_title


class CodexCliProviderError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _resolve_codex_executable() -> str:
    direct_match = shutil.which("codex")
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
        resolved = shutil.which("codex", path=os.pathsep.join(search_paths))
        if resolved:
            return resolved

    raise CodexCliProviderError(
        "codex command not found in the Pixel Forge service environment"
    )


def _codex_config_home() -> str:
    return str(Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser())


@dataclass(slots=True)
class CodexCliSessionInfo:
    provider_session_id: str
    title: str
    workspace_path: str
    status: str | None
    codex_session_id: str | None
    jsonl_path: Path | None = None
    agent_deck_session_id: str | None = None
    agent_deck_session_title: str | None = None
    tmux_session: str | None = None
    tool: str = "codex"
    acpx_agent: str | None = None
    acpx_session_name: str | None = None
    acpx_record_id: str | None = None
    acp_session_id: str | None = None
    claude_session_id: str | None = None
    gemini_session_id: str | None = None


class _CodexAppServerClient:
    def __init__(self, cwd: str) -> None:
        self.cwd = cwd
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[dict[str, object]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self.agent_output = ""
        self.thread_idle = asyncio.Event()

    async def __aenter__(self) -> "_CodexAppServerClient":
        self._proc = await asyncio.create_subprocess_exec(
            _resolve_codex_executable(),
            "app-server",
            "--listen",
            "stdio://",
            cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        await self.request(
            "initialize",
            {"clientInfo": {"name": "pixel-forge", "version": "0"}},
        )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._proc is not None and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=1.0)
            except TimeoutError:
                self._proc.kill()
                await self._proc.wait()
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

    async def request(
        self,
        method: str,
        params: dict[str, object],
        *,
        timeout_seconds: float = 30.0,
    ) -> dict[str, object]:
        if self._proc is None or self._proc.stdin is None:
            raise CodexCliProviderError("Codex app-server is not running")
        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, object]] = loop.create_future()
        self._pending[request_id] = future
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()
        return await asyncio.wait_for(future, timeout=timeout_seconds)

    async def _read_stdout(self) -> None:
        assert self._proc is not None
        assert self._proc.stdout is not None
        while True:
            raw_line = await self._proc.stdout.readline()
            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message.get("id"), int):
                request_id = int(message["id"])
                future = self._pending.pop(request_id, None)
                if future is not None and not future.done():
                    if "error" in message:
                        error = message.get("error")
                        detail = (
                            error.get("message")
                            if isinstance(error, dict)
                            else str(error)
                        )
                        future.set_exception(CodexCliProviderError(str(detail)))
                    else:
                        future.set_result(message)
                continue
            self._handle_notification(message)

    def _handle_notification(self, message: dict[str, object]) -> None:
        method = str(message.get("method") or "")
        params = message.get("params")
        if not isinstance(params, dict):
            return
        if method == "item/agentMessage/delta":
            delta = params.get("delta")
            if isinstance(delta, str):
                self.agent_output += delta
        elif method == "item/completed":
            item = params.get("item")
            if isinstance(item, dict) and item.get("type") == "agentMessage":
                text = item.get("text")
                if isinstance(text, str) and text and not self.agent_output:
                    self.agent_output = text
        elif method == "thread/status/changed":
            status = params.get("status")
            if isinstance(status, dict) and status.get("type") == "idle":
                self.thread_idle.set()

    def begin_turn(self) -> None:
        self.agent_output = ""
        self.thread_idle.clear()


async def _start_codex_thread(
    project_path: str,
    *,
    model: str | None = None,
    effort: str | None = None,
) -> CodexCliSessionInfo:
    async with _CodexAppServerClient(project_path) as client:
        config: dict[str, object] = {}
        if effort:
            config["model_reasoning_effort"] = effort
        response = await client.request(
            "thread/start",
            {
                "cwd": project_path,
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "threadSource": "user",
                "sessionStartSource": "clear",
                "ephemeral": False,
                "model": model,
                "config": config or None,
            },
            timeout_seconds=60.0,
        )
    result = response.get("result")
    thread = result.get("thread") if isinstance(result, dict) else None
    if not isinstance(thread, dict):
        raise CodexCliProviderError("Codex app-server did not return a thread")
    thread_id = str(thread.get("id") or "").strip()
    if not thread_id:
        raise CodexCliProviderError("Codex app-server returned a thread without an id")
    title = str(thread.get("name") or "").strip() or f"codex:{thread_id[:8]}"
    return CodexCliSessionInfo(
        provider_session_id=thread_id,
        title=title,
        workspace_path=project_path,
        status="idle",
        codex_session_id=thread_id,
    )


async def _run_codex_turn(
    session_info: CodexCliSessionInfo,
    *,
    prompt: str,
    image_paths: list[str] | None,
    timeout_seconds: float,
) -> str:
    async with _CodexAppServerClient(session_info.workspace_path) as client:
        try:
            await client.request(
                "thread/resume",
                {
                    "threadId": session_info.provider_session_id,
                    "cwd": session_info.workspace_path,
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                },
                timeout_seconds=60.0,
            )
        except CodexCliProviderError as exc:
            if "no rollout found" not in str(exc).lower():
                raise
            response = await client.request(
                "thread/start",
                {
                    "cwd": session_info.workspace_path,
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "threadSource": "user",
                    "sessionStartSource": "clear",
                    "ephemeral": False,
                },
                timeout_seconds=60.0,
            )
            result = response.get("result")
            thread = result.get("thread") if isinstance(result, dict) else None
            if not isinstance(thread, dict) or not str(thread.get("id") or "").strip():
                raise CodexCliProviderError("Codex app-server did not return a restart thread")
            thread_id = str(thread["id"]).strip()
            session_info.provider_session_id = thread_id
            session_info.codex_session_id = thread_id
            native_title = str(thread.get("name") or "").strip()
            if is_placeholder_chat_title(session_info.title):
                session_info.title = native_title or f"codex:{thread_id[:8]}"
        input_items: list[dict[str, object]] = [{"type": "text", "text": prompt}]
        for path in image_paths or []:
            if path.strip():
                input_items.append({"type": "localImage", "path": path.strip()})
        client.begin_turn()
        await client.request(
            "turn/start",
            {
                "threadId": session_info.provider_session_id,
                "cwd": session_info.workspace_path,
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "dangerFullAccess"},
                "input": input_items,
            },
            timeout_seconds=60.0,
        )
        try:
            await asyncio.wait_for(client.thread_idle.wait(), timeout=timeout_seconds)
        except TimeoutError as exc:
            raise CodexCliProviderError("Timed out waiting for Codex turn completion") from exc
        return client.agent_output


class CodexCliProvider:
    provider_id = "codex-cli"
    display_name = "Codex CLI"

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
            agent_id="codex",
            display_name="OpenAI Codex",
            current_transport="codex app-server stdio thread/start + turn/start",
            preferred_transport="long-lived codex app-server with remote TUI subscription",
            architecture_note=(
                "This direct provider speaks Codex's first-party app-server protocol. "
                "The next tightening step is keeping a subscribed app-server process per workspace "
                "so the visible TUI and Pixel Forge dispatch observe the same live thread."
            ),
        ),
    )

    def status(self) -> AgentProviderStatus:
        unavailable_reason: str | None = None
        try:
            command = _resolve_codex_executable()
        except CodexCliProviderError as exc:
            command = None
            unavailable_reason = str(exc)
        return AgentProviderStatus(
            id=self.provider_id,
            display_name=self.display_name,
            enabled=True,
            available=bool(command),
            reason=None if command else unavailable_reason,
            command=[command] if command else [],
            capabilities=self.capabilities,
            transports=self.transports,
            diagnostics={
                "config_home": _codex_config_home(),
            },
        )

    def is_missing_session_error(self, error: BaseException) -> bool:
        message = str(error).lower()
        if "no rollout found" in message:
            return True
        return (
            ("not_found" in message or "not found" in message)
            and any(token in message for token in ("thread", "session", "rollout"))
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
        agent_type: str = "codex",
        title: str | None = None,
        workspace_mode: str = "root",
        agent_model: str | None = None,
        agent_thinking: str | None = None,
    ) -> AgentProviderSessionTarget:
        del agent_type, title, workspace_mode
        session = await _start_codex_thread(
            project_path,
            model=agent_model,
            effort=agent_thinking,
        )
        return AgentProviderSessionTarget(
            provider_id=self.provider_id,
            id=session.provider_session_id,
            title=session.title,
            workspace_path=session.workspace_path,
            group=None,
            agent_id="codex",
            command="codex app-server",
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
        raise CodexCliProviderError("Codex CLI provider rename is not implemented yet")

    async def delete_session(
        self,
        project_path: str,
        provider_session_id: str,
        *,
        force_clone_remove: bool = False,
    ) -> None:
        del project_path, provider_session_id, force_clone_remove
        raise CodexCliProviderError("Codex CLI provider delete is not implemented yet")

    async def get_activity(
        self,
        project_path: str,
        provider_session_id: str,
    ) -> AgentProviderSessionActivity:
        return AgentProviderSessionActivity(
            provider_id=self.provider_id,
            provider_session_id=provider_session_id,
            title=f"codex:{provider_session_id[:8]}",
            workspace_path=project_path,
            agent_id="codex",
            status=None,
            output="",
        )

    async def ensure_live_session(
        self,
        project_path: str,
        thread,
        *,
        agent_type: str = "codex",
        workspace_mode: str = "root",
        target_provider_session_id: str | None = None,
        agent_model: str | None = None,
        agent_thinking: str | None = None,
        request: AgentTurnRequest | None = None,
    ) -> CodexCliSessionInfo:
        del request, agent_type, workspace_mode
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
            return CodexCliSessionInfo(
                provider_session_id=normalized_id,
                title=(
                    getattr(thread, "provider_session_title", None)
                    or f"codex:{normalized_id[:8]}"
                ),
                workspace_path=project_path,
                status="idle",
                codex_session_id=normalized_id,
            )
        pending_id = str(uuid4())
        return CodexCliSessionInfo(
            provider_session_id=pending_id,
            title=f"codex:{pending_id[:8]}",
            workspace_path=project_path,
            status="idle",
            codex_session_id=None,
        )

    async def dispatch_turn(
        self,
        session_info: CodexCliSessionInfo,
        *,
        project_path: str,
        prompt: str,
        image_paths: list[str] | None = None,
        startup_timeout_seconds: float,
        completion_timeout_seconds: float,
        request: AgentTurnRequest | None = None,
    ) -> AgentProviderTurnDispatch:
        del project_path, startup_timeout_seconds
        if request is not None:
            prompt = request.prompt or prompt
            image_paths = list(request.image_paths) or image_paths
        wait_task = asyncio.create_task(
            _run_codex_turn(
                session_info,
                prompt=prompt,
                image_paths=image_paths,
                timeout_seconds=completion_timeout_seconds,
            )
        )
        return AgentProviderTurnDispatch(
            provider_id=self.provider_id,
            provider_session_id=session_info.provider_session_id,
            agent_id="codex",
            baseline_output="",
            status_message="Request delivered to Codex. Waiting for completion...",
            wait_task=wait_task,
            status_heartbeat=False,
        )
