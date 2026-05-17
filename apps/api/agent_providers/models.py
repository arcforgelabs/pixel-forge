from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class ProviderCapabilitySet:
    list_sessions: bool = False
    launch: bool = False
    send: bool = False
    observe: bool = False
    open_tui: bool = False
    open_surface: bool = False
    rename: bool = False
    delete: bool = False
    closeout: bool = False
    skills: bool = False

    def to_dict(self) -> dict[str, bool]:
        return {
            "list": self.list_sessions,
            "launch": self.launch,
            "send": self.send,
            "observe": self.observe,
            "open_tui": self.open_tui,
            "open_surface": self.open_surface,
            "rename": self.rename,
            "delete": self.delete,
            "closeout": self.closeout,
            "skills": self.skills,
        }


@dataclass(slots=True, frozen=True)
class AgentTransportDescriptor:
    agent_id: str
    display_name: str
    current_transport: str
    preferred_transport: str
    architecture_note: str

    def to_dict(self) -> dict[str, str]:
        return {
            "agent_id": self.agent_id,
            "display_name": self.display_name,
            "current_transport": self.current_transport,
            "preferred_transport": self.preferred_transport,
            "architecture_note": self.architecture_note,
        }


@dataclass(slots=True, frozen=True)
class AgentProviderStatus:
    id: str
    display_name: str
    enabled: bool
    available: bool
    reason: str | None
    command: list[str]
    capabilities: ProviderCapabilitySet
    transports: tuple[AgentTransportDescriptor, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "enabled": self.enabled,
            "available": self.available,
            "reason": self.reason,
            "command": self.command,
            "capabilities": self.capabilities.to_dict(),
            "transports": [transport.to_dict() for transport in self.transports],
        }


@dataclass(slots=True, frozen=True)
class AgentProviderSessionTarget:
    provider_id: str
    id: str
    title: str
    workspace_path: str
    group: str | None
    agent_id: str | None
    command: str | None
    status: str | None
    created_at: str | None
    memory_rss_bytes: int | None = None
    memory_swap_bytes: int | None = None
    process_count: int | None = None

    @property
    def path(self) -> str:
        return self.workspace_path

    @property
    def tool(self) -> str | None:
        return self.agent_id

    def to_dict(self) -> dict[str, object]:
        return {
            "provider_id": self.provider_id,
            "id": self.id,
            "provider_session_id": self.id,
            "title": self.title,
            "workspace_path": self.workspace_path,
            "path": self.workspace_path,
            "group": self.group,
            "agent_id": self.agent_id,
            "tool": self.agent_id,
            "command": self.command,
            "status": self.status,
            "created_at": self.created_at,
            "memory_rss_bytes": self.memory_rss_bytes,
            "memory_swap_bytes": self.memory_swap_bytes,
            "process_count": self.process_count,
        }


@dataclass(slots=True, frozen=True)
class AgentProviderSessionActivity:
    provider_id: str
    provider_session_id: str
    title: str
    workspace_path: str
    agent_id: str | None
    status: str | None
    output: str

    def to_dict(self) -> dict[str, object]:
        return {
            "provider_id": self.provider_id,
            "provider_session_id": self.provider_session_id,
            "id": self.provider_session_id,
            "title": self.title,
            "workspace_path": self.workspace_path,
            "agent_id": self.agent_id,
            "tool": self.agent_id,
            "status": self.status,
            "output": self.output,
        }


@dataclass(slots=True, frozen=True)
class AgentProviderTurnDispatch:
    provider_id: str
    provider_session_id: str
    agent_id: str | None
    baseline_output: str
    status_message: str
    wait_task: asyncio.Task[object]
    status_heartbeat: bool = False
