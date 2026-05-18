from __future__ import annotations

from typing import Protocol

from .models import (
    AgentProviderSessionActivity,
    AgentProviderSessionTarget,
    AgentProviderStatus,
    AgentProviderTurnDispatch,
    AgentTurnRequest,
)


class AgentProvider(Protocol):
    provider_id: str
    display_name: str

    def status(self) -> AgentProviderStatus:
        ...

    async def list_sessions(
        self,
        project_path: str,
        *,
        include_live_editor: bool = False,
    ) -> list[AgentProviderSessionTarget]:
        ...

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
        ...

    async def rename_session(
        self,
        project_path: str,
        provider_session_id: str,
        new_title: str,
    ) -> None:
        ...

    async def delete_session(
        self,
        project_path: str,
        provider_session_id: str,
        *,
        force_clone_remove: bool = False,
    ) -> None:
        ...

    async def get_activity(
        self,
        project_path: str,
        provider_session_id: str,
    ) -> AgentProviderSessionActivity:
        ...

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
        ...

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
        ...
