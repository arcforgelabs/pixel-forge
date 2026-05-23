from __future__ import annotations

from agent_provider_plugins.agent_deck import AgentDeckProvider
from agent_provider_plugins.claude_cli import ClaudeCliProvider
from agent_provider_plugins.codex_cli import CodexCliProvider
from agent_provider_plugins.cursor_cli import CursorCliProvider

from .base import AgentProvider
from .models import AgentProviderStatus


class AgentProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, AgentProvider] = {
            AgentDeckProvider.provider_id: AgentDeckProvider(),
            ClaudeCliProvider.provider_id: ClaudeCliProvider(),
            CodexCliProvider.provider_id: CodexCliProvider(),
            CursorCliProvider.provider_id: CursorCliProvider(),
        }

    def get(self, provider_id: str) -> AgentProvider | None:
        return self._providers.get(provider_id)

    def list(self) -> list[AgentProviderStatus]:
        return [provider.status() for provider in self._providers.values()]


_REGISTRY = AgentProviderRegistry()


def get_agent_provider(provider_id: str) -> AgentProvider | None:
    return _REGISTRY.get(provider_id)


def list_agent_providers() -> list[AgentProviderStatus]:
    return _REGISTRY.list()
