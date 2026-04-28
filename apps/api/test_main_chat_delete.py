import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main
import live_editor_threads
import project_store
import workstation_events
from agent_deck_bridge import (
    AgentDeckBridgeError,
    AgentDeckDeleteAssessment,
    AgentDeckSessionInfo,
)


class ChatItemDeleteRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_delete_chat_allows_local_cleanup_when_agent_deck_session_is_already_missing(self) -> None:
        with (
            patch.object(
                main,
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-a",
                    object(),
                    object(),
                    "deck-a",
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
            patch.object(
                main,
                "assess_agent_deck_delete_state",
                AsyncMock(side_effect=AgentDeckBridgeError("session 'deck-a' not found")),
            ),
            patch.object(main, "delete_agent_deck_session_target", AsyncMock()) as delete_target,
            patch.object(main, "delete_session", Mock(return_value=True)) as delete_session,
            patch.object(main, "delete_live_editor_thread", Mock(return_value=True)) as delete_thread,
        ):
            payload = await main.delete_project_chat_item(
                "/tmp/project",
                main.ChatItemDeleteRequest(thread_id="thread-a", agent_deck_session_id="deck-a"),
            )

        self.assertEqual(payload["status"], "deleted")
        delete_target.assert_not_awaited()
        delete_session.assert_called_once_with("/tmp/project", "thread-a")
        delete_thread.assert_called_once_with("thread-a")

    async def test_delete_chat_allows_local_cleanup_when_agent_deck_session_disappears_after_assessment(self) -> None:
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
                "_resolve_chat_item_context",
                return_value=(
                    "/tmp/project",
                    "thread-a",
                    object(),
                    object(),
                    "deck-a",
                ),
            ),
            patch.object(main.os.path, "isdir", return_value=True),
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
            patch.object(main, "delete_session", Mock(return_value=True)) as delete_session,
            patch.object(main, "delete_live_editor_thread", Mock(return_value=True)) as delete_thread,
        ):
            payload = await main.delete_project_chat_item(
                "/tmp/project",
                main.ChatItemDeleteRequest(thread_id="thread-a", agent_deck_session_id="deck-a"),
            )

        self.assertEqual(payload["status"], "deleted")
        delete_target.assert_awaited_once()
        delete_session.assert_called_once_with("/tmp/project", "thread-a")
        delete_thread.assert_called_once_with("thread-a")


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
                "draftWorkspaceMode": "root",
            },
        )
        self.assertEqual(payload["thread_id"], expected_thread_id)
        self.assertEqual(payload["title"], f"Chat {expected_thread_id[:8]}")
        self.assertEqual(payload["binding_state"], "detached")


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
                agent_type="codex",
                workspace_mode="root",
                target_agent_deck_session_id=None,
                agent_model="gpt-5.5",
                agent_thinking="xhigh",
                selection_count=1,
            )

            payload = json.loads(snapshot_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["kind"], "live-editor-pre-agent-deck-snapshot")
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
            patch.object(main, "get_last_output", AsyncMock()) as get_last_output,
            patch.object(
                main,
                "send_native_claude_prompt_reliably",
                AsyncMock(),
            ) as native_send,
            patch.object(
                main,
                "wait_for_agent_deck_turn_completion",
                AsyncMock(return_value=None),
            ) as wait_for_completion,
            patch.object(main.asyncio, "create_task", side_effect=fake_create_task),
        ):
            baseline_output, turn_wait_task, status_heartbeat_task = (
                await main._deliver_live_editor_prompt_to_agent_deck_session(
                    session_info=session_info,
                    websocket=websocket,
                    dispatch_prompt="Read request.md",
                )
            )

        get_last_output.assert_not_awaited()
        native_send.assert_not_awaited()
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
        wait_for_completion.assert_not_awaited()

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
            patch.object(main, "get_last_output", AsyncMock(return_value="baseline")) as get_last_output,
            patch.object(
                main,
                "send_native_codex_prompt_reliably",
                AsyncMock(),
            ) as native_send,
            patch.object(
                main,
                "send_agent_deck_prompt_reliably",
                AsyncMock(),
            ) as send_prompt,
            patch.object(
                main,
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
                await main._deliver_live_editor_prompt_to_agent_deck_session(
                    session_info=session_info,
                    websocket=websocket,
                    dispatch_prompt="Review the request",
                    native_image_paths=[".pixel-forge/requests/abcd/attachments/reference.png"],
                )
            )

        native_send.assert_not_awaited()
        get_last_output.assert_not_awaited()
        send_prompt.assert_awaited_once_with(
            session_info,
            project_path="/tmp/project/.agents/thread-a",
            prompt="Review the request",
            no_wait=True,
        )
        wait_for_completion.assert_not_awaited()
        self.assertEqual(baseline_output, "")
        self.assertIs(turn_wait_task, fake_wait_task)
        self.assertIs(status_heartbeat_task, fake_heartbeat_task)
        self.assertEqual(len(create_task_calls), 2)


if __name__ == "__main__":
    unittest.main()
