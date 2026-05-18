from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from agent_deck_bridge import AgentDeckBridgeError, _resolve_runtime_executable
from agent_providers.models import (
    AgentProviderSessionActivity,
    AgentProviderSessionTarget,
    AgentProviderStatus,
    AgentProviderTurnDispatch,
    AgentTransportDescriptor,
    AgentTurnRequest,
    ProviderCapabilitySet,
)


class ClaudeCliProviderError(RuntimeError):
    pass


@dataclass(slots=True)
class ClaudeCliSessionInfo:
    provider_session_id: str
    title: str
    workspace_path: str
    status: str | None
    claude_session_id: str | None
    has_started: bool = False
    agent_deck_session_id: str | None = None
    agent_deck_session_title: str | None = None
    tmux_session: str | None = None
    tool: str = "claude"
    acpx_agent: str | None = None
    acpx_session_name: str | None = None
    acpx_record_id: str | None = None
    acp_session_id: str | None = None
    codex_session_id: str | None = None
    gemini_session_id: str | None = None
    jsonl_path: object | None = None


def _resolve_claude_executable() -> str:
    try:
        return _resolve_runtime_executable("claude")
    except AgentDeckBridgeError as exc:
        raise ClaudeCliProviderError(str(exc)) from exc


def _claude_config_home() -> str:
    return str(Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser())


async def _run_claude_turn(
    session_info: ClaudeCliSessionInfo,
    *,
    prompt: str,
    image_paths: list[str] | None,
    timeout_seconds: float,
) -> str:
    claude_executable = _resolve_claude_executable()
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

    session_id = session_info.claude_session_id or session_info.provider_session_id
    session_args = ["--resume", session_id] if session_info.has_started else ["--session-id", session_id]
    cmd = [
        claude_executable,
        *session_args,
        "-p",
        dispatch_prompt,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
    ]
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
        raise ClaudeCliProviderError("Timed out waiting for Claude CLI completion") from exc
    if proc.returncode != 0:
        raise ClaudeCliProviderError(
            stderr.decode("utf-8", errors="replace").strip()
            or "Claude CLI request failed"
        )
    session_info.has_started = True
    raw_output = stdout.decode("utf-8", errors="replace").strip()
    if not raw_output:
        return ""
    try:
        payload = json.loads(raw_output)
    except json.JSONDecodeError:
        return raw_output
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, str):
            return result
    return raw_output


class ClaudeCliProvider:
    provider_id = "claude-cli"
    display_name = "Claude Code CLI"

    capabilities = ProviderCapabilitySet(
        list_sessions=False,
        launch=True,
        send=True,
        observe=True,
        rename=False,
        delete=False,
    )
    transports = (
        AgentTransportDescriptor(
            agent_id="claude",
            display_name="Claude Code",
            current_transport="claude -p --session-id/--resume direct CLI request",
            preferred_transport="first-party Claude Code service protocol when available",
            architecture_note=(
                "This provider is the explicit direct-CLI replay lane when Agent Deck is selected "
                "but cannot launch or dispatch the requested Claude Code turn."
            ),
        ),
    )

    def status(self) -> AgentProviderStatus:
        unavailable_reason: str | None = None
        try:
            command = _resolve_claude_executable()
        except ClaudeCliProviderError as exc:
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
                "config_home": _claude_config_home(),
            },
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
        agent_type: str = "claude",
        title: str | None = None,
        workspace_mode: str = "root",
        agent_model: str | None = None,
        agent_thinking: str | None = None,
    ) -> AgentProviderSessionTarget:
        del agent_type, title, workspace_mode, agent_model, agent_thinking
        session_id = str(uuid4())
        return AgentProviderSessionTarget(
            provider_id=self.provider_id,
            id=session_id,
            title=f"claude:{session_id[:8]}",
            workspace_path=project_path,
            group=None,
            agent_id="claude",
            command="claude -p",
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
        raise ClaudeCliProviderError("Claude CLI provider rename is not implemented yet")

    async def delete_session(
        self,
        project_path: str,
        provider_session_id: str,
        *,
        force_clone_remove: bool = False,
    ) -> None:
        del project_path, provider_session_id, force_clone_remove
        raise ClaudeCliProviderError("Claude CLI provider delete is not implemented yet")

    async def get_activity(
        self,
        project_path: str,
        provider_session_id: str,
    ) -> AgentProviderSessionActivity:
        return AgentProviderSessionActivity(
            provider_id=self.provider_id,
            provider_session_id=provider_session_id,
            title=f"claude:{provider_session_id[:8]}",
            workspace_path=project_path,
            agent_id="claude",
            status=None,
            output="",
        )

    async def ensure_live_session(
        self,
        project_path: str,
        thread,
        *,
        agent_type: str = "claude",
        workspace_mode: str = "root",
        target_provider_session_id: str | None = None,
        agent_model: str | None = None,
        agent_thinking: str | None = None,
        request: AgentTurnRequest | None = None,
    ) -> ClaudeCliSessionInfo:
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
            return ClaudeCliSessionInfo(
                provider_session_id=normalized_id,
                title=(
                    getattr(thread, "provider_session_title", None)
                    or f"claude:{normalized_id[:8]}"
                ),
                workspace_path=project_path,
                status="idle",
                claude_session_id=normalized_id,
                has_started=bool(persisted_id),
            )
        pending_id = str(uuid4())
        return ClaudeCliSessionInfo(
            provider_session_id=pending_id,
            title=f"claude:{pending_id[:8]}",
            workspace_path=project_path,
            status="idle",
            claude_session_id=pending_id,
        )

    async def dispatch_turn(
        self,
        session_info: ClaudeCliSessionInfo,
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
            _run_claude_turn(
                session_info,
                prompt=prompt,
                image_paths=image_paths,
                timeout_seconds=completion_timeout_seconds,
            )
        )
        return AgentProviderTurnDispatch(
            provider_id=self.provider_id,
            provider_session_id=session_info.provider_session_id,
            agent_id="claude",
            baseline_output="",
            status_message="Request delivered to Claude Code CLI. Waiting for completion...",
            wait_task=wait_task,
            status_heartbeat=False,
        )
