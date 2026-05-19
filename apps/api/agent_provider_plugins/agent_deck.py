from __future__ import annotations

import asyncio

from agent_deck_launch import (
    agent_deck_no_approval_launch_required,
    agent_deck_runtime_origin,
    build_agent_deck_launch_args,
)
from agent_deck_runtime import (
    agent_deck_available,
    agent_deck_command,
)
import agent_deck_bridge
from runtime_config import agent_deck_home_dir, agent_deck_provider_enabled

from agent_providers.models import (
    AgentTurnPolicy,
    AgentTurnRequest,
    AgentProviderSessionActivity,
    AgentProviderSessionTarget,
    AgentProviderStatus,
    AgentProviderTurnDispatch,
    AgentTransportDescriptor,
    ProviderCapabilitySet,
)


class AgentDeckProvider:
    provider_id = "agent-deck"
    display_name = "Agent Deck"

    capabilities = ProviderCapabilitySet(
        list_sessions=True,
        launch=True,
        send=True,
        observe=True,
        open_tui=True,
        open_surface=True,
        rename=True,
        delete=True,
        closeout=True,
        skills=True,
    )
    transports = (
        AgentTransportDescriptor(
            agent_id="claude",
            display_name="Claude Code",
            current_transport="claude -p --resume for headless warm turns; Agent Deck/tmux for visible TUI fallback",
            preferred_transport="provider-owned Claude native bridge when it preserves the visible TUI contract",
            architecture_note=(
                "The current headless resume path is the best validated warm-turn path; "
                "Remote Control/SSE remains a candidate only behind a UI-contract gate."
            ),
        ),
        AgentTransportDescriptor(
            agent_id="codex",
            display_name="OpenAI Codex",
            current_transport="codex exec resume --json with Codex JSONL observation",
            preferred_transport="dedicated Codex provider using codex app-server / remote TUI protocol",
            architecture_note=(
                "exec resume is better than tmux key stuffing today, but Codex app-server exposes "
                "thread/turn, delta, approval, image, and file-change protocol schemas and is the "
                "right long-term Pixel Forge adapter boundary."
            ),
        ),
        AgentTransportDescriptor(
            agent_id="gemini",
            display_name="Gemini CLI",
            current_transport="Agent Deck/tmux session send and status polling",
            preferred_transport="direct Gemini provider using --prompt/--prompt-interactive or ACP where it can preserve continuity",
            architecture_note="No stronger validated native ingress is wired yet.",
        ),
        AgentTransportDescriptor(
            agent_id="pi",
            display_name="Pi",
            current_transport="Agent Deck/tmux session send and status polling",
            preferred_transport="direct Pi provider using --print/--continue/--session or RPC mode when session semantics are proven",
            architecture_note="Pi exposes non-interactive and session flags; Pixel Forge still needs a direct provider spike.",
        ),
    )

    def is_missing_session_error(self, error: BaseException) -> bool:
        message = str(error).lower()
        return (
            "not_found" in message
            or "not found" in message
        ) and "session" in message

    def _session_target(
        self,
        session: agent_deck_bridge.AgentDeckSessionTarget,
    ) -> AgentProviderSessionTarget:
        return AgentProviderSessionTarget(
            provider_id=self.provider_id,
            id=session.id,
            title=session.title,
            workspace_path=session.path,
            group=session.group,
            agent_id=session.tool,
            command=session.command,
            status=session.status,
            created_at=session.created_at,
            memory_rss_bytes=session.memory_rss_bytes,
            memory_swap_bytes=session.memory_swap_bytes,
            process_count=session.process_count,
        )

    def status(self) -> AgentProviderStatus:
        enabled = agent_deck_provider_enabled()
        available, reason = agent_deck_available()
        surface_command = agent_deck_command() if enabled else []
        launch_command = agent_deck_command(require_launch_yolo=True) if enabled else []
        provider_command = launch_command or surface_command
        launch_available, launch_reason = (
            agent_deck_available(require_launch_yolo=True)
            if enabled
            else (False, "Agent Deck provider is disabled")
        )
        return AgentProviderStatus(
            id=self.provider_id,
            display_name=self.display_name,
            enabled=enabled,
            available=available,
            reason=reason,
            command=provider_command,
            capabilities=self.capabilities,
            transports=self.transports,
            diagnostics={
                "provider_command": provider_command,
                "surface_command": surface_command,
                "launch_command": launch_command,
                "config_home": str(agent_deck_home_dir()),
                "runtime_origin": agent_deck_runtime_origin(provider_command),
                "provider_runtime_origin": agent_deck_runtime_origin(provider_command),
                "surface_runtime_origin": agent_deck_runtime_origin(surface_command),
                "launch_runtime_origin": agent_deck_runtime_origin(launch_command),
                "launch_capabilities": {
                    "no_approval": launch_available,
                    "flag": "--yolo",
                    "reason": launch_reason,
                },
            },
        )

    async def _launch_session(
        self,
        project_path: str,
        *,
        session_title: str,
        agent_type: str = "claude",
        workspace_mode: str = "root",
        workspace_path: str | None = None,
        agent_model: str | None = None,
        agent_thinking: str | None = None,
        turn_request: AgentTurnRequest | None = None,
    ) -> dict[str, object]:
        del workspace_mode
        policy = turn_request.policy if turn_request is not None else AgentTurnPolicy(no_approval=True)
        normalized_agent_type = agent_type.strip().lower() or "claude"
        if agent_deck_no_approval_launch_required(normalized_agent_type, policy):
            available, reason = agent_deck_available(require_launch_yolo=True)
            if not available:
                raise agent_deck_bridge.AgentDeckBridgeError(
                    reason or "Agent Deck provider lacks required no-approval launch capability"
                )
        await agent_deck_bridge._enforce_agent_deck_launch_admission()
        if normalized_agent_type == "pi":
            await asyncio.to_thread(
                agent_deck_bridge._sync_pi_ollama_models_for_launch,
                agent_model,
            )
        args = build_agent_deck_launch_args(
            project_path,
            session_title=session_title,
            agent_type=normalized_agent_type,
            workspace_path=workspace_path,
            agent_model=agent_model,
            agent_thinking=agent_thinking,
            policy=policy,
        )
        return await agent_deck_bridge._run_agent_deck_json_object_command(args)

    async def list_sessions(
        self,
        project_path: str,
        *,
        include_live_editor: bool = False,
    ) -> list[AgentProviderSessionTarget]:
        if include_live_editor:
            sessions = await agent_deck_bridge.list_live_editor_agent_deck_sessions(project_path)
        else:
            sessions = await agent_deck_bridge.list_project_agent_deck_sessions(project_path)
        return [self._session_target(session) for session in sessions]

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
        session_title = (
            title.strip()
            if isinstance(title, str) and title.strip()
            else agent_deck_bridge._session_title_for_target(project_path)
        )
        payload = await self._launch_session(
            project_path,
            session_title=session_title,
            agent_type=agent_type,
            workspace_mode=workspace_mode,
            agent_model=agent_model,
            agent_thinking=agent_thinking,
        )
        session = agent_deck_bridge._payload_to_session_target(payload)
        return self._session_target(session)

    async def rename_session(
        self,
        project_path: str,
        provider_session_id: str,
        new_title: str,
    ) -> None:
        await agent_deck_bridge.rename_agent_deck_session_target(
            project_path,
            provider_session_id,
            new_title,
        )

    async def delete_session(
        self,
        project_path: str,
        provider_session_id: str,
        *,
        force_clone_remove: bool = False,
    ) -> None:
        await agent_deck_bridge.delete_agent_deck_session_target(
            project_path,
            provider_session_id,
            force_clone_remove=force_clone_remove,
        )

    async def get_activity(
        self,
        project_path: str,
        provider_session_id: str,
    ) -> AgentProviderSessionActivity:
        activity = await agent_deck_bridge.get_agent_deck_session_activity(
            project_path,
            provider_session_id,
        )
        return AgentProviderSessionActivity(
            provider_id=self.provider_id,
            provider_session_id=activity.session_id,
            title=activity.session_title,
            workspace_path=activity.workspace_path,
            agent_id=activity.tool,
            status=activity.status,
            output=activity.output,
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
    ):
        turn_request = request or AgentTurnRequest(
            project_path=project_path,
            workspace_path=getattr(thread, "workspace_path", None),
            thread_id=getattr(thread, "thread_id", None),
            prompt="",
            agent_id=agent_type,
            workspace_mode=workspace_mode,
            target_provider_session_id=target_provider_session_id,
            agent_model=agent_model,
            agent_thinking=agent_thinking,
            policy=AgentTurnPolicy(no_approval=True),
        )
        return await agent_deck_bridge.ensure_agent_deck_session(
            project_path,
            thread,
            agent_type=agent_type,
            workspace_mode=workspace_mode,
            target_agent_deck_session_id=target_provider_session_id,
            agent_model=agent_model,
            agent_thinking=agent_thinking,
            launch_session=self._launch_session,
            turn_request=turn_request,
        )

    async def dispatch_turn(
        self,
        session_info,
        *,
        project_path: str,
        prompt: str,
        image_paths: list[str] | None = None,
        startup_timeout_seconds: float,
        completion_timeout_seconds: float,
        request: AgentTurnRequest | None = None,
    ) -> AgentProviderTurnDispatch:
        if request is not None:
            prompt = request.prompt or prompt
            image_paths = list(request.image_paths) or image_paths
        baseline_output = ""
        normalized_session_status = (session_info.status or "").strip().lower()
        queue_onto_busy_session = normalized_session_status not in {
            "",
            "starting",
            "waiting",
            "idle",
        }
        normalized_image_paths = [
            path.strip()
            for path in (image_paths or [])
            if isinstance(path, str) and path.strip()
        ]

        if session_info.tool == "codex" and not (
            session_info.codex_session_id and session_info.jsonl_path
        ):
            baseline_output = await agent_deck_bridge.get_last_output(
                session_info.agent_deck_session_id
            )

        tool_label = (session_info.tool or "agent").strip().capitalize() or "Agent"
        if (
            session_info.tool == "claude"
            and session_info.claude_session_id
            and not queue_onto_busy_session
            and not session_info.tmux_session
        ):
            wait_task = asyncio.create_task(
                agent_deck_bridge.send_native_claude_prompt_reliably(
                    session_info,
                    project_path=project_path,
                    prompt=prompt,
                )
            )
            status_message = f"Request delivered to {tool_label}. Waiting for completion..."
        elif (
            session_info.tool == "codex"
            and session_info.codex_session_id
            and session_info.jsonl_path
            and not queue_onto_busy_session
            and not session_info.tmux_session
        ):
            wait_task = asyncio.create_task(
                agent_deck_bridge.send_native_codex_prompt_reliably(
                    session_info,
                    project_path=project_path,
                    prompt=prompt,
                    image_paths=normalized_image_paths,
                )
            )
            status_message = f"Request delivered to {tool_label}. Waiting for completion..."
        else:
            await agent_deck_bridge.send_agent_deck_prompt_reliably(
                session_info,
                project_path=project_path,
                prompt=prompt,
                no_wait=queue_onto_busy_session and session_info.tool != "claude",
            )
            if session_info.tool == "codex":
                status_message = (
                    f"Queued request to busy {tool_label} session. Waiting for completion..."
                    if queue_onto_busy_session
                    else f"Request delivered to {tool_label}. Waiting for completion..."
                )
            else:
                status_message = f"Request delivered to {tool_label}. Waiting for completion..."

            wait_task = asyncio.create_task(
                agent_deck_bridge.wait_for_agent_deck_turn_completion(
                    session_info,
                    startup_timeout_seconds=startup_timeout_seconds,
                    completion_timeout_seconds=completion_timeout_seconds,
                )
            )

        return AgentProviderTurnDispatch(
            provider_id=self.provider_id,
            provider_session_id=session_info.agent_deck_session_id,
            agent_id=session_info.tool,
            baseline_output=baseline_output,
            status_message=status_message,
            wait_task=wait_task,
            status_heartbeat=session_info.tool != "claude"
            and not (
                session_info.tool == "codex"
                and session_info.codex_session_id
                and session_info.jsonl_path
                and not queue_onto_busy_session
                and not session_info.tmux_session
            ),
        )
