import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main
import agent_deck_bridge
import live_editor_threads
import project_store
import workstation_events
from agent_deck_bridge import (
    AgentDeckBridgeError,
    AgentDeckDeleteAssessment,
    AgentDeckSessionInfo,
)
from agent_providers.agent_deck import AgentDeckProvider
from agent_providers.models import AgentProviderStatus, ProviderCapabilitySet


class _FakeProvider:
    def __init__(
        self,
        provider_id: str,
        *,
        enabled: bool = True,
        available: bool = True,
        reason: str | None = None,
    ) -> None:
        self.provider_id = provider_id
        self.display_name = provider_id
        self._status = AgentProviderStatus(
            id=provider_id,
            display_name=provider_id,
            enabled=enabled,
            available=available,
            reason=reason,
            command=[provider_id] if available else [],
            capabilities=ProviderCapabilitySet(launch=True, send=True),
        )

    def status(self) -> AgentProviderStatus:
        return self._status


class LiveEditorProviderSelectionTest(unittest.TestCase):
    def test_agent_deck_selected_codex_handoff_leaves_launch_policy_to_provider(self) -> None:
        agent_deck = _FakeProvider("agent-deck")
        codex_cli = _FakeProvider("codex-cli")
        thread = SimpleNamespace(provider_id=None, provider_session_id=None)

        def fake_get_provider(provider_id: str):
            return {
                "agent-deck": agent_deck,
                "codex-cli": codex_cli,
            }.get(provider_id)

        with patch.object(main, "get_agent_provider", side_effect=fake_get_provider):
            provider = main._live_editor_agent_provider_or_error(
                "agent-deck",
                agent_type="codex",
                target_provider_session_id=None,
                thread=thread,
            )

        self.assertIs(provider, agent_deck)

    def test_codex_cli_selected_handoff_uses_direct_codex_provider(self) -> None:
        agent_deck = _FakeProvider("agent-deck")
        codex_cli = _FakeProvider("codex-cli")
        thread = SimpleNamespace(provider_id=None, provider_session_id=None)

        def fake_get_provider(provider_id: str):
            return {
                "agent-deck": agent_deck,
                "codex-cli": codex_cli,
            }.get(provider_id)

        with patch.object(main, "get_agent_provider", side_effect=fake_get_provider):
            provider = main._live_editor_agent_provider_or_error(
                "codex-cli",
                agent_type="codex",
                target_provider_session_id=None,
                thread=thread,
            )

        self.assertIs(provider, codex_cli)

    def test_agent_deck_failure_retry_options_offer_matching_direct_cli_provider(self) -> None:
        codex_cli = _FakeProvider("codex-cli")
        claude_cli = _FakeProvider("claude-cli")

        def fake_get_provider(provider_id: str):
            return {
                "codex-cli": codex_cli,
                "claude-cli": claude_cli,
            }.get(provider_id)

        with patch.object(main, "get_agent_provider", side_effect=fake_get_provider):
            codex_options = main._direct_cli_retry_options_for_agent("codex")
            claude_options = main._direct_cli_retry_options_for_agent("claude")

        self.assertEqual(codex_options[0]["provider_id"], "codex-cli")
        self.assertEqual(codex_options[0]["agent_type"], "codex")
        self.assertTrue(codex_options[0]["available"])
        self.assertEqual(claude_options[0]["provider_id"], "claude-cli")
        self.assertEqual(claude_options[0]["agent_type"], "claude")
        self.assertTrue(claude_options[0]["available"])

    def test_existing_agent_deck_binding_does_not_silently_fallback_to_codex_provider(self) -> None:
        agent_deck = _FakeProvider("agent-deck")
        codex_cli = _FakeProvider("codex-cli")
        thread = SimpleNamespace(provider_id="agent-deck", provider_session_id="deck-a")

        def fake_get_provider(provider_id: str):
            return {
                "agent-deck": agent_deck,
                "codex-cli": codex_cli,
            }.get(provider_id)

        with patch.object(main, "get_agent_provider", side_effect=fake_get_provider):
            provider = main._live_editor_agent_provider_or_error(
                "agent-deck",
                agent_type="codex",
                target_provider_session_id=None,
                thread=thread,
            )

        self.assertIs(provider, agent_deck)


class LiveEditorTargetIntentContractTest(unittest.TestCase):
    def test_new_target_intent_ignores_legacy_provider_session_fields(self) -> None:
        data = {
            "target_intent": {
                "mode": "new",
                "provider_id": "agent-deck",
                "agent_id": "codex",
                "workspace_mode": "root",
            },
            "target_provider_session_id": "stale-session",
            "target_agent_deck_session_id": "stale-agent-deck-session",
        }
        target_intent = main._live_editor_target_intent(data)

        self.assertIsNone(
            main._live_editor_target_session_id(
                target_intent=target_intent,
                target_intent_mode=main._target_intent_mode(target_intent),
                data=data,
            )
        )

    def test_attach_existing_target_intent_owns_provider_session_field(self) -> None:
        data = {
            "target_intent": {
                "mode": "attach_existing",
                "provider_id": "codex-cli",
                "provider_session_id": "codex-thread-a",
            },
            "target_provider_session_id": "legacy-thread",
        }
        target_intent = main._live_editor_target_intent(data)

        self.assertEqual(
            main._live_editor_target_session_id(
                target_intent=target_intent,
                target_intent_mode=main._target_intent_mode(target_intent),
                data=data,
            ),
            "codex-thread-a",
        )


class ChatItemDeleteRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_delete_direct_provider_chat_does_not_call_agent_deck(self) -> None:
        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-direct",
                    object(),
                    object(),
                    "codex-cli",
                    "codex-thread-a",
                    None,
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "assess_agent_deck_delete_state", AsyncMock()) as assess_delete,
            patch.object(main, "delete_agent_deck_session_target", AsyncMock()) as delete_target,
            patch.object(main, "delete_session", Mock(return_value=True)) as delete_session,
            patch.object(main, "delete_live_editor_thread", Mock(return_value=True)) as delete_thread,
        ):
            payload = await main.delete_project_chat_item(
                "/tmp/project",
                main.ChatItemDeleteRequest(
                    thread_id="thread-direct",
                    provider_id="codex-cli",
                    provider_session_id="codex-thread-a",
                ),
                background_tasks=main.BackgroundTasks(),
            )

        self.assertEqual(payload["status"], "deleted")
        self.assertEqual(payload["provider_id"], "codex-cli")
        self.assertEqual(payload["provider_session_id"], "codex-thread-a")
        self.assertIsNone(payload["agent_deck_session_id"])
        assess_delete.assert_not_awaited()
        delete_target.assert_not_awaited()
        delete_session.assert_called_once_with("/tmp/project", "thread-direct")
        delete_thread.assert_called_once_with("thread-direct")

    async def test_delete_agent_deck_chat_hides_locally_and_queues_provider_cleanup(self) -> None:
        background_tasks = main.BackgroundTasks()

        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-a",
                    object(),
                    object(),
                    "agent-deck",
                    "deck-a",
                    "deck-a",
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "assess_agent_deck_delete_state", AsyncMock()) as assess_delete,
            patch.object(main, "delete_agent_deck_session_target", AsyncMock()) as delete_target,
            patch.object(main, "delete_session", Mock(return_value=True)) as delete_session,
            patch.object(main, "delete_live_editor_thread", Mock(return_value=True)) as delete_thread,
        ):
            payload = await main.delete_project_chat_item(
                "/tmp/project",
                main.ChatItemDeleteRequest(thread_id="thread-a", agent_deck_session_id="deck-a"),
                background_tasks=background_tasks,
            )

        self.assertEqual(payload["status"], "deleted")
        self.assertEqual(payload["cleanup_status"], "queued")
        assess_delete.assert_not_awaited()
        delete_target.assert_not_awaited()
        delete_session.assert_called_once_with("/tmp/project", "thread-a")
        delete_thread.assert_called_once_with("thread-a")
        self.assertEqual(len(background_tasks.tasks), 1)

    async def test_deleted_agent_deck_cleanup_treats_missing_session_as_complete(self) -> None:
        assessment = AgentDeckDeleteAssessment(
            session_id="deck-a",
            session_title="error-clean-up",
            workspace_path="/tmp/project/.agents/error-clean-up",
            repo_root="/tmp/project",
            target_branch="master",
            is_clone=True,
            is_worktree=False,
            has_activity=False,
            requires_closeout=False,
            can_force_delete=True,
            detail="ok to delete",
        )

        with (
            patch.object(
                main,
                "assess_agent_deck_delete_state",
                AsyncMock(return_value=assessment),
            ),
            patch.object(
                main,
                "delete_agent_deck_session_target",
                AsyncMock(side_effect=AgentDeckBridgeError("session 'deck-a' not found")),
            ) as delete_target,
            patch.object(main, "append_workstation_event", Mock()) as append_event,
        ):
            await main._cleanup_deleted_agent_deck_chat(
                "/tmp/project",
                "thread-a",
                "deck-a",
                thread_has_activity=False,
                force_clone_remove=False,
            )

        delete_target.assert_awaited_once()
        append_event.assert_called_once()
        _, args, kwargs = append_event.mock_calls[0]
        self.assertEqual(args[:2], ("/tmp/project", "thread-a"))
        self.assertEqual(kwargs["event_type"], "provider_cleanup_completed")
        self.assertTrue(kwargs["payload"]["already_missing"])

    async def test_deleted_agent_deck_cleanup_records_closeout_required(self) -> None:
        assessment = AgentDeckDeleteAssessment(
            session_id="deck-a",
            session_title="needs-closeout",
            workspace_path="/tmp/project/.agents/needs-closeout",
            repo_root="/tmp/project",
            target_branch="master",
            is_clone=True,
            is_worktree=False,
            has_activity=True,
            requires_closeout=True,
            can_force_delete=True,
            detail="needs closeout first",
        )

        with (
            patch.object(
                main,
                "assess_agent_deck_delete_state",
                AsyncMock(return_value=assessment),
            ),
            patch.object(main, "delete_agent_deck_session_target", AsyncMock()) as delete_target,
            patch.object(main, "append_workstation_event", Mock()) as append_event,
        ):
            await main._cleanup_deleted_agent_deck_chat(
                "/tmp/project",
                "thread-a",
                "deck-a",
                thread_has_activity=True,
                force_clone_remove=False,
            )

        delete_target.assert_not_awaited()
        append_event.assert_called_once()
        _, args, kwargs = append_event.mock_calls[0]
        self.assertEqual(args[:2], ("/tmp/project", "thread-a"))
        self.assertEqual(kwargs["event_type"], "provider_cleanup_requires_closeout")


class ChatItemOpenTuiRouteTest(unittest.IsolatedAsyncioTestCase):
    def test_open_agent_deck_tui_terminal_selects_bound_session(self) -> None:
        with (
            patch.object(main._pf_cli, "agent_deck_command", Mock(return_value=["agent-deck"])),
            patch.object(main._pf_cli, "agent_deck_tui_wm_class", Mock(return_value="pixel-forge-agent-deck")),
            patch.object(
                main._pf_cli,
                "_agent_deck_tui_exec_env",
                Mock(return_value={"PIXEL_FORGE_AGENT_DECK_HOME": "/tmp/deck"}),
            ),
            patch.object(
                main._pf_cli,
                "_agent_deck_tui_terminal_command",
                Mock(return_value=["ghostty", "-e", "agent-deck", "--select", "deck-a"]),
            ) as terminal_command,
            patch("subprocess.Popen", Mock()) as popen,
        ):
            payload = main._open_agent_deck_tui_terminal(
                title="Agent Deck · Chat chat-a",
                session_id="deck-a",
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["provider_session_id"], "deck-a")
        terminal_command.assert_called_once_with(
            ["agent-deck", "--select", "deck-a"],
            "Agent Deck · Chat chat-a",
            "pixel-forge-agent-deck",
        )
        popen.assert_called_once()

    async def test_open_agent_deck_chat_tui_uses_agent_deck_terminal(self) -> None:
        session_record = SimpleNamespace(
            provider_session_title="Agent Deck Chat",
            agent_deck_session_title="Agent Deck Chat",
        )

        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-a",
                    session_record,
                    None,
                    "agent-deck",
                    "deck-a",
                    "deck-a",
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "_agent_provider_or_error", Mock()) as provider_or_error,
            patch.object(
                main,
                "_open_agent_deck_tui_terminal",
                Mock(return_value={"ok": True, "provider_id": "agent-deck"}),
            ) as open_tui,
        ):
            payload = await main.open_project_chat_item_tui(
                "/tmp/project",
                main.ChatItemOpenTuiRequest(thread_id="thread-a", agent_deck_session_id="deck-a"),
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["provider_id"], "agent-deck")
        provider_or_error.assert_called_once_with("agent-deck")
        open_tui.assert_called_once()
        _, kwargs = open_tui.call_args
        self.assertEqual(kwargs["session_id"], "deck-a")
        self.assertIn("Agent Deck Chat", kwargs["title"])

    async def test_open_direct_codex_chat_tui_reports_future_harness(self) -> None:
        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-direct",
                    object(),
                    object(),
                    "codex-cli",
                    "codex-thread-a",
                    None,
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "_open_agent_deck_tui_terminal", Mock()) as open_tui,
        ):
            with self.assertRaises(main.HTTPException) as context:
                await main.open_project_chat_item_tui(
                    "/tmp/project",
                    main.ChatItemOpenTuiRequest(
                        thread_id="thread-direct",
                        provider_id="codex-cli",
                        provider_session_id="codex-thread-a",
                    ),
                )

        self.assertEqual(context.exception.status_code, 501)
        self.assertIn("Codex bound-chat TUI launch is not wired yet", context.exception.detail)
        open_tui.assert_not_called()

    async def test_open_detached_agent_deck_chat_tui_reports_not_bound(self) -> None:
        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-a",
                    object(),
                    object(),
                    "agent-deck",
                    None,
                    None,
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "_agent_provider_or_error", Mock()) as provider_or_error,
            patch.object(main, "_open_agent_deck_tui_terminal", Mock()) as open_tui,
        ):
            with self.assertRaises(main.HTTPException) as context:
                await main.open_project_chat_item_tui(
                    "/tmp/project",
                    main.ChatItemOpenTuiRequest(thread_id="thread-a", provider_id="agent-deck"),
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(context.exception.detail, "This chat is not bound to a provider TUI yet.")
        provider_or_error.assert_not_called()
        open_tui.assert_not_called()

    async def test_open_unbound_direct_codex_chat_tui_reports_not_bound(self) -> None:
        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-direct",
                    object(),
                    object(),
                    "codex-cli",
                    None,
                    None,
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "_open_agent_deck_tui_terminal", Mock()) as open_tui,
        ):
            with self.assertRaises(main.HTTPException) as context:
                await main.open_project_chat_item_tui(
                    "/tmp/project",
                    main.ChatItemOpenTuiRequest(thread_id="thread-direct", provider_id="codex-cli"),
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(context.exception.detail, "This chat is not bound to a provider TUI yet.")
        open_tui.assert_not_called()


class ChatCreateRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_create_project_chat_reuses_empty_draft_by_default(self) -> None:
        existing_session = SimpleNamespace(
            id=1,
            profile_id="default",
            project_path="/tmp/project",
            thread_id="chat-existing123",
            workspace_path="/tmp/project",
            backend="agent-deck",
            origin_kind="managed",
            agent_deck_session_id=None,
            agent_deck_session_title="Chat chat-exi",
            agent_deck_tool=None,
            editor_state={
                "draftAgentType": "claude",
                "draftWorkspaceMode": "root",
            },
            created_at="2026-03-21T00:00:00Z",
            last_active="2026-03-21T00:00:00Z",
        )

        with (
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "upsert_project", Mock()),
            patch.object(main, "project_name_for_path", Mock(return_value="project")),
            patch.object(main, "list_project_sessions", Mock(return_value=[existing_session])),
            patch.object(main, "chat_has_primary_workstation_events", Mock(return_value=False)),
            patch.object(main, "upsert_session", Mock()) as upsert_session,
        ):
            payload = await main.create_project_chat(
                "/tmp/project",
                main.AgentDeckSessionRequest(
                    agent_type="claude",
                    title=None,
                    workspace_mode="root",
                ),
            )

        upsert_session.assert_not_called()
        self.assertEqual(payload["thread_id"], "chat-existing123")
        self.assertEqual(payload["title"], "Chat chat-exi")

    async def test_create_project_chat_can_force_fresh_draft_for_replay(self) -> None:
        existing_session = SimpleNamespace(
            id=1,
            profile_id="default",
            project_path="/tmp/project",
            thread_id="chat-existing123",
            workspace_path="/tmp/project",
            backend="agent-deck",
            origin_kind="managed",
            agent_deck_session_id=None,
            agent_deck_session_title="Chat chat-exi",
            agent_deck_tool=None,
            editor_state={
                "draftAgentType": "claude",
                "draftWorkspaceMode": "root",
            },
            created_at="2026-03-21T00:00:00Z",
            last_active="2026-03-21T00:00:00Z",
        )
        expected_thread_id = "chat-fedcba098765"
        created_session = SimpleNamespace(
            **{
                **existing_session.__dict__,
                "id": 2,
                "thread_id": expected_thread_id,
                "agent_deck_session_title": f"Chat {expected_thread_id[:8]}",
            }
        )

        with (
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "upsert_project", Mock()),
            patch.object(main, "project_name_for_path", Mock(return_value="project")),
            patch.object(
                main,
                "uuid4",
                Mock(return_value=SimpleNamespace(hex="fedcba0987654321fedcba0987654321")),
            ),
            patch.object(main, "list_project_sessions", Mock(return_value=[existing_session])),
            patch.object(main, "chat_has_primary_workstation_events", Mock(return_value=False)),
            patch.object(main, "upsert_session", Mock(return_value=created_session)) as upsert_session,
        ):
            payload = await main.create_project_chat(
                "/tmp/project",
                main.AgentDeckSessionRequest(
                    agent_type="claude",
                    title=None,
                    workspace_mode="root",
                    reuse_empty_draft=False,
                ),
            )

        upsert_session.assert_called_once()
        self.assertEqual(upsert_session.call_args.kwargs["thread_id"], expected_thread_id)
        self.assertEqual(payload["thread_id"], expected_thread_id)

    async def test_create_project_chat_generates_unique_chat_thread_id(self) -> None:
        expected_thread_id = "chat-1234567890ab"
        created_session = SimpleNamespace(
            id=1,
            profile_id="default",
            project_path="/tmp/project",
            thread_id=expected_thread_id,
            workspace_path="/tmp/project",
            backend="agent-deck",
            origin_kind="managed",
            agent_deck_session_id=None,
            agent_deck_session_title=f"Chat {expected_thread_id[:8]}",
            agent_deck_tool=None,
            editor_state={
                "draftAgentType": "claude",
                "draftWorkspaceMode": "root",
            },
            created_at="2026-03-21T00:00:00Z",
            last_active="2026-03-21T00:00:00Z",
        )

        with (
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(main, "upsert_project", Mock()),
            patch.object(main, "project_name_for_path", Mock(return_value="project")),
            patch.object(
                main,
                "uuid4",
                Mock(return_value=SimpleNamespace(hex="1234567890abcdef1234567890abcdef")),
            ),
            patch.object(main, "list_project_sessions", Mock(return_value=[])),
            patch.object(
                main,
                "upsert_session",
                Mock(return_value=created_session),
            ) as upsert_session,
            patch.object(
                main,
                "_load_reconciled_project_chats",
                AsyncMock(),
            ) as load_chats,
        ):
            payload = await main.create_project_chat(
                "/tmp/project",
                main.AgentDeckSessionRequest(
                    agent_type="claude",
                    title=None,
                    workspace_mode="root",
                ),
            )

        upsert_session.assert_called_once()
        load_chats.assert_not_awaited()
        self.assertEqual(upsert_session.call_args.kwargs["thread_id"], expected_thread_id)
        self.assertEqual(
            upsert_session.call_args.kwargs["editor_state"],
            {
                "draftAgentType": "claude",
                "draftProviderId": "agent-deck",
                "draftWorkspaceMode": "root",
            },
        )
        self.assertEqual(payload["thread_id"], expected_thread_id)
        self.assertEqual(payload["title"], f"Chat {expected_thread_id[:8]}")
        self.assertEqual(payload["binding_state"], "detached")


class ProviderNeutralSessionTitleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = main.os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        self.original_xdg_state_home = main.os.environ.get("XDG_STATE_HOME")
        self.original_db_path = main.os.environ.get("PIXEL_FORGE_DB_PATH")
        main.os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        main.os.environ["XDG_STATE_HOME"] = self.tempdir.name
        main.os.environ["PIXEL_FORGE_DB_PATH"] = str(Path(self.tempdir.name) / "pixel-forge.db")
        project_store._DB_INITIALIZED = False

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            main.os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            main.os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        if self.original_xdg_state_home is None:
            main.os.environ.pop("XDG_STATE_HOME", None)
        else:
            main.os.environ["XDG_STATE_HOME"] = self.original_xdg_state_home
        if self.original_db_path is None:
            main.os.environ.pop("PIXEL_FORGE_DB_PATH", None)
        else:
            main.os.environ["PIXEL_FORGE_DB_PATH"] = self.original_db_path
        project_store._DB_INITIALIZED = False

    def test_direct_provider_rename_does_not_populate_agent_deck_title(self) -> None:
        project_path = str(Path(self.tempdir.name) / "project")
        Path(project_path).mkdir()
        project_store.upsert_project(project_path)
        project_store.upsert_session(
            project_path,
            thread_id="thread-direct",
            backend="codex-cli",
            workspace_path=project_path,
            provider_id="codex-cli",
            provider_session_id="codex-thread-a",
            provider_session_title="Old Codex",
            provider_agent_id="codex",
            agent_deck_session_id=None,
            agent_deck_session_title=None,
            agent_deck_tool=None,
        )

        updated = project_store.update_session_title(
            project_path,
            "thread-direct",
            "New Codex",
        )

        self.assertIsNotNone(updated)
        self.assertEqual(updated.provider_session_title, "New Codex")
        self.assertIsNone(updated.agent_deck_session_title)

    def test_direct_provider_chat_draft_does_not_populate_agent_deck_fields(self) -> None:
        project_path = str(Path(self.tempdir.name) / "project")
        Path(project_path).mkdir()

        payload = asyncio.run(
            main.create_project_chat(
                project_path,
                main.AgentDeckSessionRequest(
                    provider_id="codex-cli",
                    agent_type="codex",
                    title="Codex draft",
                    reuse_empty_draft=False,
                ),
            )
        )
        stored = project_store.list_project_sessions(project_path)

        self.assertEqual(payload["provider_id"], "codex-cli")
        self.assertIsNone(payload["provider_session_id"])
        self.assertEqual(payload["provider_session_title"], "Codex draft")
        self.assertEqual(payload["provider_agent_id"], "codex")
        self.assertIsNone(payload["agent_deck_session_id"])
        self.assertIsNone(payload["agent_deck_session_title"])
        self.assertIsNone(payload["agent_deck_tool"])
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0].provider_id, "codex-cli")
        self.assertEqual(stored[0].provider_session_title, "Codex draft")
        self.assertIsNone(stored[0].agent_deck_session_title)


class LiveEditorPreflightSnapshotTest(unittest.TestCase):
    def test_preflight_snapshot_persists_prompt_and_selection_before_agent_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            snapshot_path = main._write_live_editor_preflight_snapshot(
                project_path=tempdir,
                thread_id="chat-b91d262c1ccc",
                request_message="Fix the selected elements",
                element_context="<selected-elements />",
                selection_tunnel={"selections": [{"label": "1", "xpath": "/html"}]},
                attachments=[
                    {
                        "name": "selection-01.jpg",
                        "mime_type": "image/jpeg",
                        "data_url": "data:image/jpeg;base64,abc",
                        "kind": "image",
                    }
                ],
                preview_url="https://example.test/capture",
                live_preview={"preview_tab_id": "tab-one"},
                target_provider_id="codex-cli",
                target_provider_session_id="codex-thread-a",
                agent_type="codex",
                workspace_mode="root",
                target_agent_deck_session_id=None,
                target_intent={
                    "mode": "attach_existing",
                    "provider_id": "codex-cli",
                    "provider_session_id": "codex-thread-a",
                },
                agent_model="gpt-5.5",
                agent_thinking="xhigh",
                selection_count=1,
            )

            payload = json.loads(snapshot_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["kind"], "live-editor-pre-provider-snapshot")
        self.assertEqual(payload["target_provider_id"], "codex-cli")
        self.assertEqual(payload["target_provider_session_id"], "codex-thread-a")
        self.assertEqual(payload["target_intent"]["mode"], "attach_existing")
        self.assertEqual(payload["thread_id"], "chat-b91d262c1ccc")
        self.assertEqual(payload["prompt_text"], "Fix the selected elements")
        self.assertEqual(payload["selection"]["count"], 1)
        self.assertEqual(payload["selection"]["tunnel"]["selections"][0]["xpath"], "/html")
        self.assertEqual(payload["attachments"][0]["name"], "selection-01.jpg")


class BackfillChatHistoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = main.os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        self.original_xdg_state_home = main.os.environ.get("XDG_STATE_HOME")
        self.original_db_path = main.os.environ.get("PIXEL_FORGE_DB_PATH")
        main.os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        main.os.environ["XDG_STATE_HOME"] = self.tempdir.name
        main.os.environ["PIXEL_FORGE_DB_PATH"] = str(Path(self.tempdir.name) / "pixel-forge.db")
        project_store._DB_INITIALIZED = False
        workstation_events._DB_INITIALIZED = False
        live_editor_threads._DB_INITIALIZED = False

        self.project_path = Path(self.tempdir.name) / "project"
        self.workspace_path = self.project_path / ".agents" / "thread-a"
        self.workspace_path.mkdir(parents=True)

        project_store.upsert_project(str(self.project_path))
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-a",
            backend="agent-deck",
            workspace_path=str(self.workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="Chat thread-a",
            agent_deck_tool="claude",
        )
        live_editor_threads.get_or_create_live_editor_thread(
            str(self.project_path),
            thread_id="thread-a",
        )
        live_editor_threads.update_live_editor_thread(
            "thread-a",
            workspace_path=str(self.workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="Chat thread-a",
            claude_session_id="claude-session-a",
        )

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            main.os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            main.os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        if self.original_xdg_state_home is None:
            main.os.environ.pop("XDG_STATE_HOME", None)
        else:
            main.os.environ["XDG_STATE_HOME"] = self.original_xdg_state_home
        if self.original_db_path is None:
            main.os.environ.pop("PIXEL_FORGE_DB_PATH", None)
        else:
            main.os.environ["PIXEL_FORGE_DB_PATH"] = self.original_db_path

    def test_backfill_skips_when_primary_typed_turn_history_already_exists(self) -> None:
        workstation_events.append_workstation_event(
            str(self.project_path),
            "thread-a",
            agent_deck_session_id="deck-a",
            event_type="turn_input",
            payload={
                "request_id": "request-1",
                "prompt": "Inspect the current preview",
            },
        )

        with patch.object(
            main,
            "claude_jsonl_path",
            side_effect=AssertionError("backfill should not read JSONL when typed history exists"),
        ):
            main._backfill_chat_history_from_jsonl(
                str(self.project_path),
                "thread-a",
            )

        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_input", "backfill_completed"],
        )
        self.assertEqual(events[-1].payload["skipped"], True)
        self.assertEqual(events[-1].payload["reason"], "existing turn events found")

class LiveEditorPromptDispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_wait_heartbeat_names_selected_provider(self) -> None:
        websocket = Mock()
        websocket.send_json = AsyncMock()
        statuses: list[str] = []

        async def record_status(message: str) -> None:
            statuses.append(message)

        async def finish_soon() -> None:
            await main.asyncio.sleep(0.01)

        wait_task = main.asyncio.create_task(finish_soon())

        await main._emit_live_editor_wait_heartbeat(
            websocket,
            tool="codex",
            provider_label="Codex CLI",
            wait_task=wait_task,
            interval_seconds=0.001,
            on_status=record_status,
        )

        self.assertTrue(statuses)
        self.assertIn("Codex is still working in Codex CLI", statuses[0])
        websocket.send_json.assert_awaited()

    def test_build_dispatch_prompt_uses_prompt_first_transport_with_native_file_refs(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Inspect the active preview",
                "artifacts": {
                    "session_brief_file": ".pixel-forge/threads/thread-a/session-brief.md",
                    "selection_tunnel_file": ".pixel-forge/requests/abcd/selection-tunnel.json",
                    "live_preview_context_file": ".pixel-forge/requests/abcd/live-preview-context.json",
                },
                "attachments": [
                    {
                        "path": ".pixel-forge/requests/abcd/attachments/reference.png",
                    }
                ],
                "selection": {"count": 0, "items": []},
            },
        )

        self.assertTrue(prompt.startswith("Inspect the active preview"))
        self.assertIn("@.pixel-forge/requests/abcd/turn-input.json", prompt)
        self.assertIn("@.pixel-forge/threads/thread-a/session-brief.md", prompt)
        self.assertIn("@.pixel-forge/requests/abcd/selection-tunnel.json", prompt)
        self.assertIn("@.pixel-forge/requests/abcd/live-preview-context.json", prompt)
        self.assertIn("@.pixel-forge/requests/abcd/attachments/reference.png", prompt)
        self.assertNotIn("Pixel Forge refs:", prompt)
        self.assertNotIn("request.md", prompt)

    def test_build_dispatch_prompt_uses_plain_context_paths_for_codex(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Inspect the active preview",
                "artifacts": {
                    "selection_tunnel_file": ".pixel-forge/requests/abcd/selection-tunnel.json",
                },
            },
            tool="codex",
        )

        self.assertTrue(prompt.startswith("Inspect the active preview"))
        self.assertIn("Context files:", prompt)
        self.assertIn(".pixel-forge/requests/abcd/turn-input.json", prompt)
        self.assertIn(".pixel-forge/requests/abcd/selection-tunnel.json", prompt)
        self.assertNotIn("@.pixel-forge/requests/abcd/turn-input.json", prompt)

    def test_build_dispatch_prompt_includes_context_patch_as_native_file_ref(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Check the warm preview",
                "artifacts": {
                    "context_patch_file": ".pixel-forge/requests/abcd/context-patch.json",
                },
            },
        )

        self.assertTrue(prompt.startswith("Check the warm preview"))
        self.assertIn("@.pixel-forge/requests/abcd/turn-input.json", prompt)
        self.assertIn("@.pixel-forge/requests/abcd/context-patch.json", prompt)
        self.assertNotIn("Pixel Forge refs:", prompt)

    def test_build_dispatch_prompt_uses_turn_input_file_for_attach_requirements(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Prove the live attach path if it exists.",
                "artifacts": {
                    "live_preview_context_file": ".pixel-forge/requests/abcd/live-preview-context.json",
                },
            },
        )

        self.assertTrue(prompt.startswith("Prove the live attach path if it exists."))
        self.assertIn("@.pixel-forge/requests/abcd/turn-input.json", prompt)
        self.assertIn("@.pixel-forge/requests/abcd/live-preview-context.json", prompt)
        self.assertNotIn("live_attach_proof_required", prompt)

    def test_build_dispatch_prompt_includes_live_preview_attach_hints_inline(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Inspect the active preview state.",
                "artifacts": {
                    "live_preview_context_file": ".pixel-forge/requests/abcd/live-preview-context.json",
                },
                "live_preview": {
                    "attach_hints": {
                        "browser_url": "http://127.0.0.1:9222",
                        "target_id": "target-1",
                        "target_url": "https://example.com/app",
                        "page_websocket_url": "ws://127.0.0.1:9222/devtools/page/target-1",
                        "recommended_command": "npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --slim --no-usage-statistics",
                    }
                },
            },
            tool="codex",
        )

        self.assertIn("Live preview attach hints:", prompt)
        self.assertIn(
            "Use the controller browser endpoint below for live inspection; do not target a local Chrome profile.",
            prompt,
        )
        self.assertIn("Attach browser URL: `http://127.0.0.1:9222`", prompt)
        self.assertIn("Attach target ID: `target-1`", prompt)
        self.assertIn("Page websocket URL: `ws://127.0.0.1:9222/devtools/page/target-1`", prompt)
        self.assertIn(
            "Recommended command: `npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --slim --no-usage-statistics`",
            prompt,
        )
        self.assertIn("Context files:", prompt)

    def test_build_dispatch_prompt_does_not_inline_controller_browserview_context(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Inspect the active preview state.",
                "artifacts": {
                    "live_preview_context_file": ".pixel-forge/requests/abcd/live-preview-context.json",
                },
            },
        )

        self.assertIn("@.pixel-forge/requests/abcd/live-preview-context.json", prompt)
        self.assertNotIn("controller-browserview", prompt)

    def test_build_dispatch_prompt_deduplicates_native_refs(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Inspect the active preview state.",
                "artifacts": {
                    "selection_tunnel_file": ".pixel-forge/requests/abcd/selection-tunnel.json",
                },
                "attachments": [
                    {"path": ".pixel-forge/requests/abcd/selection-tunnel.json"},
                    {"path": ".pixel-forge/requests/abcd/selection-tunnel.json"},
                ],
            },
        )

        self.assertEqual(
            prompt.count("@.pixel-forge/requests/abcd/selection-tunnel.json"),
            1,
        )

    def test_build_dispatch_prompt_can_exclude_paths_promoted_to_native_items(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Inspect the active preview state.",
                "attachments": [
                    {"path": ".pixel-forge/requests/abcd/attachments/reference.png"},
                    {"path": ".pixel-forge/requests/abcd/attachments/notes.txt"},
                ],
            },
            tool="codex",
            exclude_attachment_paths={
                ".pixel-forge/requests/abcd/attachments/reference.png",
            },
        )

        self.assertNotIn(".pixel-forge/requests/abcd/attachments/reference.png", prompt)
        self.assertIn(".pixel-forge/requests/abcd/attachments/notes.txt", prompt)

    def test_native_image_attachment_paths_extracts_only_images(self) -> None:
        image_paths = main._native_image_attachment_paths(
            {
                "attachments": [
                    {
                        "path": ".pixel-forge/requests/abcd/attachments/reference.png",
                        "mime_type": "image/png",
                    },
                    {
                        "path": ".pixel-forge/requests/abcd/attachments/mockup.webp",
                        "kind": "image",
                        "mime_type": "image/webp",
                    },
                    {
                        "path": ".pixel-forge/requests/abcd/attachments/notes.txt",
                        "mime_type": "text/plain",
                    },
                ]
            }
        )

        self.assertEqual(
            image_paths,
            [
                ".pixel-forge/requests/abcd/attachments/reference.png",
                ".pixel-forge/requests/abcd/attachments/mockup.webp",
            ],
        )

    def test_build_dispatch_prompt_omits_session_brief_on_delta_turn(self) -> None:
        artifacts = {
            "session_brief_file": ".pixel-forge/threads/thread-a/session-brief.md",
            "selection_tunnel_file": ".pixel-forge/requests/abcd/selection-tunnel.json",
            "live_preview_context_file": ".pixel-forge/requests/abcd/live-preview-context.json",
        }
        payload = {
            "prompt_text": "Keep going",
            "artifacts": artifacts,
        }

        claude_prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload=payload,
            continuation_mode="delta",
        )
        self.assertNotIn("session-brief.md", claude_prompt)
        self.assertIn("@.pixel-forge/requests/abcd/selection-tunnel.json", claude_prompt)

        codex_prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload=payload,
            continuation_mode="delta",
            tool="codex",
        )
        self.assertNotIn("session-brief.md", codex_prompt)
        self.assertIn(".pixel-forge/requests/abcd/selection-tunnel.json", codex_prompt)

    def test_build_dispatch_prompt_omits_session_brief_on_attached_session(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Resume",
                "artifacts": {
                    "session_brief_file": ".pixel-forge/threads/thread-a/session-brief.md",
                },
            },
            continuation_mode="attached-session",
        )
        self.assertNotIn("session-brief.md", prompt)

    def test_build_dispatch_prompt_keeps_session_brief_on_bootstrap(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload={
                "prompt_text": "Kick off",
                "artifacts": {
                    "session_brief_file": ".pixel-forge/threads/thread-a/session-brief.md",
                },
            },
            continuation_mode="bootstrap",
        )
        self.assertIn("@.pixel-forge/threads/thread-a/session-brief.md", prompt)

    def test_build_dispatch_prompt_skips_live_preview_when_unchanged(self) -> None:
        payload = {
            "prompt_text": "Same preview",
            "artifacts": {
                "live_preview_context_file": ".pixel-forge/requests/abcd/live-preview-context.json",
            },
        }
        claude_prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload=payload,
            continuation_mode="delta",
            include_live_preview_context=False,
        )
        self.assertNotIn("live-preview-context.json", claude_prompt)

        codex_prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_file_path=".pixel-forge/requests/abcd/turn-input.json",
            turn_input_payload=payload,
            continuation_mode="delta",
            include_live_preview_context=False,
            tool="codex",
        )
        self.assertNotIn("live-preview-context.json", codex_prompt)

    def test_hash_live_preview_context_stable_across_timestamps(self) -> None:
        payload_a = {"current_url": "http://a", "captured_at": 100, "refreshed_at": 200}
        payload_b = {"current_url": "http://a", "captured_at": 999, "refreshed_at": 9999}
        self.assertEqual(
            main._hash_live_preview_context(payload_a),
            main._hash_live_preview_context(payload_b),
        )
        payload_c = {"current_url": "http://b", "captured_at": 100}
        self.assertNotEqual(
            main._hash_live_preview_context(payload_a),
            main._hash_live_preview_context(payload_c),
        )
        self.assertIsNone(main._hash_live_preview_context(None))

    def test_build_dispatch_prompt_falls_back_to_request_mirror_when_turn_bundle_is_missing(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_payload={
                "prompt_text": "Inspect the active preview state.",
            },
        )

        self.assertTrue(prompt.startswith("Inspect the active preview state."))
        self.assertIn("@.pixel-forge/requests/abcd/request.md", prompt)

    async def test_deliver_live_editor_prompt_prefers_native_claude_resume(self) -> None:
        session_info = AgentDeckSessionInfo(
            agent_deck_session_id="deck-a",
            agent_deck_session_title="Chat thread-a",
            workspace_path="/tmp/project/.agents/thread-a",
            tmux_session=None,
            tool="claude",
            status="waiting",
            acpx_agent=None,
            acpx_session_name=None,
            acpx_record_id=None,
            acp_session_id=None,
            claude_session_id="claude-session-a",
            codex_session_id=None,
            jsonl_path=Path("/tmp/claude.jsonl"),
        )
        websocket = Mock()
        websocket.send_json = AsyncMock()
        create_task_calls: list[object] = []
        fake_wait_task = object()

        def fake_create_task(coro: object) -> object:
            create_task_calls.append(coro)
            close = getattr(coro, "close", None)
            if callable(close):
                close()
            return fake_wait_task

        with (
            patch.object(
                agent_deck_bridge,
                "send_native_claude_prompt_reliably",
                AsyncMock(),
            ) as native_send,
            patch.object(
                agent_deck_bridge,
                "wait_for_agent_deck_turn_completion",
                AsyncMock(return_value=None),
            ) as wait_for_completion,
            patch.object(main.asyncio, "create_task", side_effect=fake_create_task),
        ):
            baseline_output, turn_wait_task, status_heartbeat_task = (
                await main._dispatch_live_editor_prompt_to_agent_provider(
                    agent_provider=AgentDeckProvider(),
                    session_info=session_info,
                    websocket=websocket,
                    dispatch_prompt="Read request.md",
                )
            )

        native_send.assert_called_once_with(
            session_info,
            project_path="/tmp/project/.agents/thread-a",
            prompt="Read request.md",
        )
        websocket.send_json.assert_awaited_once_with(
            {
                "type": "status",
                "message": "Request delivered to Claude. Waiting for completion...",
            }
        )
        self.assertEqual(baseline_output, "")
        self.assertIs(turn_wait_task, fake_wait_task)
        self.assertIsNone(status_heartbeat_task)
        self.assertEqual(len(create_task_calls), 1)
        wait_for_completion.assert_not_called()

    async def test_deliver_live_editor_prompt_falls_back_to_agent_deck_send_for_busy_codex(self) -> None:
        session_info = AgentDeckSessionInfo(
            agent_deck_session_id="deck-a",
            agent_deck_session_title="Chat thread-a",
            workspace_path="/tmp/project/.agents/thread-a",
            tmux_session=None,
            tool="codex",
            status="running",
            acpx_agent=None,
            acpx_session_name=None,
            acpx_record_id=None,
            acp_session_id=None,
            claude_session_id=None,
            codex_session_id="codex-session-a",
            jsonl_path=Path("/tmp/codex.jsonl"),
        )
        websocket = Mock()
        websocket.send_json = AsyncMock()
        create_task_calls: list[object] = []
        fake_wait_task = object()
        fake_heartbeat_task = object()

        def fake_create_task(coro: object) -> object:
            create_task_calls.append(coro)
            close = getattr(coro, "close", None)
            if callable(close):
                close()
            if len(create_task_calls) == 1:
                return fake_wait_task
            return fake_heartbeat_task

        with (
            patch.object(
                agent_deck_bridge,
                "send_native_codex_prompt_reliably",
                AsyncMock(),
            ) as native_send,
            patch.object(
                agent_deck_bridge,
                "send_agent_deck_prompt_reliably",
                AsyncMock(),
            ) as send_prompt,
            patch.object(
                agent_deck_bridge,
                "wait_for_agent_deck_turn_completion",
                AsyncMock(return_value=None),
            ) as wait_for_completion,
            patch.object(
                main,
                "_emit_live_editor_wait_heartbeat",
                AsyncMock(return_value=None),
            ),
            patch.object(main.asyncio, "create_task", side_effect=fake_create_task),
        ):
            baseline_output, turn_wait_task, status_heartbeat_task = (
                await main._dispatch_live_editor_prompt_to_agent_provider(
                    agent_provider=AgentDeckProvider(),
                    session_info=session_info,
                    websocket=websocket,
                    dispatch_prompt="Review the request",
                    native_image_paths=[".pixel-forge/requests/abcd/attachments/reference.png"],
                )
            )

        native_send.assert_not_called()
        send_prompt.assert_awaited_once_with(
            session_info,
            project_path="/tmp/project/.agents/thread-a",
            prompt="Review the request",
            no_wait=True,
        )
        wait_for_completion.assert_called_once_with(
            session_info,
            startup_timeout_seconds=main.LIVE_EDITOR_AGENT_STARTUP_TIMEOUT_SECONDS,
            completion_timeout_seconds=main.LIVE_EDITOR_AGENT_COMPLETION_TIMEOUT_SECONDS,
        )
        self.assertEqual(baseline_output, "")
        self.assertIs(turn_wait_task, fake_wait_task)
        self.assertIs(status_heartbeat_task, fake_heartbeat_task)
        self.assertEqual(len(create_task_calls), 2)


class LiveEditorThreadHydrationTest(unittest.TestCase):
    def test_detaches_missing_direct_provider_binding(self) -> None:
        thread = SimpleNamespace(thread_id="chat-stale")
        provider = SimpleNamespace(
            provider_id="claude-cli",
            display_name="Claude Code CLI",
            is_missing_session_error=Mock(return_value=True),
        )
        updated = SimpleNamespace(thread_id="chat-stale", provider_session_id=None)

        with (
            patch.object(main, "detach_project_session_binding", Mock()) as detach_binding,
            patch.object(main, "update_live_editor_thread", Mock(return_value=updated)) as update_thread,
        ):
            result, message = main._detach_missing_provider_session_binding(
                project_path="/tmp/project",
                thread=thread,
                agent_provider=provider,
                target_provider_session_id="claude-thread-a",
                error=RuntimeError("No conversation found for session claude-thread-a"),
            )

        self.assertIs(result, updated)
        self.assertIn("Claude Code CLI session `claude-thread-a` was missing", message)
        detach_binding.assert_called_once_with("/tmp/project", "chat-stale")
        update_thread.assert_called_once_with(
            "chat-stale",
            backend="claude-cli",
            provider_id="",
            provider_session_id="",
            provider_session_title="",
            provider_agent_id="",
            agent_deck_session_id="",
            agent_deck_session_title="",
        )

    def test_missing_provider_detach_ignores_non_missing_errors(self) -> None:
        thread = SimpleNamespace(thread_id="chat-active")
        provider = SimpleNamespace(
            provider_id="codex-cli",
            display_name="Codex CLI",
            is_missing_session_error=Mock(return_value=False),
        )

        with (
            patch.object(main, "detach_project_session_binding", Mock()) as detach_binding,
            patch.object(main, "update_live_editor_thread", Mock()) as update_thread,
        ):
            result, message = main._detach_missing_provider_session_binding(
                project_path="/tmp/project",
                thread=thread,
                agent_provider=provider,
                target_provider_session_id="codex-thread-a",
                error=RuntimeError("Codex authentication failed"),
            )

        self.assertIsNone(result)
        self.assertIsNone(message)
        detach_binding.assert_not_called()
        update_thread.assert_not_called()

    def test_hydrates_missing_live_thread_binding_from_project_session(self) -> None:
        thread = SimpleNamespace(
            thread_id="chat-stale",
            provider_session_id=None,
            provider_session_title=None,
            agent_deck_session_id=None,
        )
        session = SimpleNamespace(
            backend="agent-deck",
            workspace_path="/tmp/project",
            provider_id="agent-deck",
            provider_session_id="deck-stale",
            provider_session_title="Chat chat-stale",
            provider_agent_id="codex",
            agent_deck_session_id="deck-stale",
            agent_deck_session_title="Chat chat-stale",
        )
        updated = SimpleNamespace(thread_id="chat-stale", provider_session_id="deck-stale")

        with (
            patch.object(main, "get_project_session", Mock(return_value=session)),
            patch.object(main, "update_live_editor_thread", Mock(return_value=updated)) as update_thread,
        ):
            result = main._hydrate_live_editor_thread_from_project_session(
                "/tmp/project",
                thread,
            )

        self.assertIs(result, updated)
        update_thread.assert_called_once_with(
            "chat-stale",
            backend="agent-deck",
            workspace_path="/tmp/project",
            provider_id="agent-deck",
            provider_session_id="deck-stale",
            provider_session_title="Chat chat-stale",
            provider_agent_id="codex",
            agent_deck_session_id="deck-stale",
            agent_deck_session_title="Chat chat-stale",
        )


if __name__ == "__main__":
    unittest.main()
