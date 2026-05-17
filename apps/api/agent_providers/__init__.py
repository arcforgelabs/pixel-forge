def get_agent_provider(provider_id: str):
    from .registry import get_agent_provider as _get_agent_provider

    return _get_agent_provider(provider_id)


def list_agent_providers():
    from .registry import list_agent_providers as _list_agent_providers

    return _list_agent_providers()


def __getattr__(name: str):
    if name == "AgentProviderRegistry":
        from .registry import AgentProviderRegistry

        return AgentProviderRegistry
    raise AttributeError(name)


__all__ = [
    "AgentProviderRegistry",
    "get_agent_provider",
    "list_agent_providers",
]
