import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main
from agent_deck_bridge import AgentDeckBridgeError
from agent_providers.models import AgentProviderStatus, ProviderCapabilitySet
from project_store import SessionRecord


def create_session(project_path: str, **overrides) -> SessionRecord:
    values = {
        "id": 1,
        "profile_id": "default",
        "project_path": project_path,
        "workspace_path": project_path,
        "thread_id": "chat-direct-a",
        "backend": "codex-cli",
        "origin_kind": "managed",
        "provider_id": "codex-cli",
        "provider_session_id": "codex-thread-a",
        "provider_session_title": "Codex direct",
        "provider_agent_id": "codex",
        "agent_deck_session_id": None,
        "agent_deck_session_title": None,
        "agent_deck_tool": None,
        "editor_state": None,
        "created_at": "2026-05-19T00:00:00Z",
        "last_active": "2026-05-19T00:01:00Z",
    }
    values.update(overrides)
    return SessionRecord(**values)


class _ExplodingProvider:
    provider_id = "agent-deck"

    def status(self) -> AgentProviderStatus:
        return AgentProviderStatus(
            id="agent-deck",
            display_name="Agent Deck",
            enabled=True,
            available=True,
            reason=None,
            command=["agent-deck"],
            capabilities=ProviderCapabilitySet(list_sessions=True),
        )

    async def list_sessions(self, *args, **kwargs):
        raise AssertionError("cached project chat projection must not list live provider sessions")


class ProjectChatsRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_project_chats_default_uses_cached_projection_without_agent_deck_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as project_path:
            session = create_session(project_path)
            with (
                patch.object(main, "get_agent_provider", Mock(return_value=_ExplodingProvider())) as get_provider,
                patch.object(main, "list_project_sessions", Mock(return_value=[session])),
            ):
                payload = await main.get_project_chats(project_path)

        get_provider.assert_not_called()
        self.assertEqual(len(payload["chats"]), 1)
        chat = payload["chats"][0]
        self.assertEqual(chat["provider_id"], "codex-cli")
        self.assertEqual(chat["provider_session_id"], "codex-thread-a")
        self.assertEqual(chat["provider_agent_id"], "codex")
        self.assertEqual(chat["binding_state"], "attached")
        self.assertIsNone(chat["agent_deck_session_id"])
        self.assertIsNone(chat["agent_deck_session_title"])
        self.assertIsNone(chat["agent_deck_tool"])

    async def test_project_chats_explicit_reconcile_lists_live_agent_deck_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as project_path:
            provider = _ExplodingProvider()
            provider.list_sessions = AsyncMock(return_value=[])
            with (
                patch.object(main, "get_agent_provider", Mock(return_value=provider)) as get_provider,
                patch.object(main, "list_project_sessions", Mock(return_value=[])),
                patch.object(
                    main,
                    "detach_missing_agent_deck_session_bindings",
                    Mock(return_value=[]),
                ),
                patch.object(main, "detach_missing_agent_deck_thread_bindings", Mock()),
            ):
                payload = await main.get_project_chats(project_path, reconcile=True)

        get_provider.assert_called_once_with("agent-deck")
        self.assertEqual(provider.list_sessions.await_count, 2)
        self.assertEqual(payload["chats"], [])

    async def test_project_chats_reconcile_falls_back_to_cached_projection_when_agent_deck_times_out(self) -> None:
        with tempfile.TemporaryDirectory() as project_path:
            session = create_session(
                project_path,
                backend="agent-deck",
                provider_id="agent-deck",
                provider_session_id=None,
                provider_session_title="Chat chat-cf7",
                provider_agent_id="codex",
                agent_deck_session_id=None,
                agent_deck_session_title="Chat chat-cf7",
                agent_deck_tool="codex",
            )
            provider = _ExplodingProvider()
            provider.list_sessions = AsyncMock(
                side_effect=AgentDeckBridgeError("agent-deck ls -json timed out after 3.0s")
            )
            with (
                patch.object(main, "get_agent_provider", Mock(return_value=provider)),
                patch.object(main, "list_project_sessions", Mock(return_value=[session])),
                patch.object(main, "detach_missing_agent_deck_session_bindings", Mock()) as detach_sessions,
                patch.object(main, "detach_missing_agent_deck_thread_bindings", Mock()) as detach_threads,
            ):
                payload = await main.get_project_chats(project_path, reconcile=True)

        self.assertEqual(provider.list_sessions.await_count, 1)
        detach_sessions.assert_not_called()
        detach_threads.assert_not_called()
        self.assertEqual(len(payload["chats"]), 1)
        self.assertEqual(payload["chats"][0]["thread_id"], "chat-direct-a")
        self.assertEqual(payload["chats"][0]["binding_state"], "detached")
