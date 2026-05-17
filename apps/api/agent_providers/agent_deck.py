from __future__ import annotations

from agent_deck_runtime import (
    agent_deck_available,
    agent_deck_command,
)
import agent_deck_bridge
from runtime_config import agent_deck_provider_enabled

from .models import (
    AgentProviderSessionActivity,
    AgentProviderSessionTarget,
    AgentProviderStatus,
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
        return AgentProviderStatus(
            id=self.provider_id,
            display_name=self.display_name,
            enabled=enabled,
            available=available,
            reason=reason,
            command=agent_deck_command() if enabled else [],
            capabilities=self.capabilities,
            transports=self.transports,
        )

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
        session = await agent_deck_bridge.create_agent_deck_session_target(
            project_path,
            agent_type=agent_type,
            title=title,
            workspace_mode=workspace_mode,
            agent_model=agent_model,
            agent_thinking=agent_thinking,
        )
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
