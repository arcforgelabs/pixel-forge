import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main
from agent_deck_bridge import (
    AgentDeckBridgeError,
    AgentDeckDeleteAssessment,
    AgentDeckSessionInfo,
)
from project_chats import ProjectChatRecord


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
    async def test_create_project_chat_generates_unique_chat_thread_id(self) -> None:
        expected_thread_id = "chat-1234567890ab"
        created_chat = ProjectChatRecord(
            id=expected_thread_id,
            project_path="/tmp/project",
            title=f"Chat {expected_thread_id[:8]}",
            thread_id=expected_thread_id,
            workspace_path="/tmp/project",
            backend="agent-deck",
            agent_deck_session_id=None,
            agent_deck_session_title=f"Chat {expected_thread_id[:8]}",
            agent_deck_tool=None,
            agent_deck_session_status=None,
            binding_state="detached",
            workspace_kind="root",
            origin_kind="managed",
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
            patch.object(main, "upsert_session", Mock()) as upsert_session,
            patch.object(
                main,
                "_load_reconciled_project_chats",
                AsyncMock(return_value=("/tmp/project", [created_chat])),
            ),
        ):
            payload = await main.create_project_chat(
                "/tmp/project",
                main.AgentDeckSessionRequest(agent_type="claude", title=None, workspace_mode="root"),
            )

        upsert_session.assert_called_once()
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

    def test_build_dispatch_prompt_falls_back_to_request_mirror_when_turn_bundle_is_missing(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_payload={
                "prompt_text": "Inspect the active preview state.",
            },
        )

        self.assertTrue(prompt.startswith("Inspect the active preview state."))
        self.assertIn("@.pixel-forge/requests/abcd/request.md", prompt)

    async def test_deliver_live_editor_prompt_uses_reliable_send_for_claude(self) -> None:
        session_info = AgentDeckSessionInfo(
            agent_deck_session_id="deck-a",
            agent_deck_session_title="Chat thread-a",
            workspace_path="/tmp/project/.agents/thread-a",
            tmux_session="tmux-a",
            tool="claude",
            status="waiting",
            acpx_agent=None,
            acpx_session_name=None,
            acpx_record_id=None,
            acp_session_id=None,
            claude_session_id="claude-session-a",
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
                "send_agent_deck_prompt_reliably",
                AsyncMock(),
            ) as send_prompt,
            patch.object(
                main,
                "wait_for_agent_deck_turn_completion",
                AsyncMock(return_value=None),
            ),
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
        send_prompt.assert_awaited_once_with(
            session_info,
            project_path="/tmp/project/.agents/thread-a",
            prompt="Read request.md",
            no_wait=False,
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


if __name__ == "__main__":
    unittest.main()
