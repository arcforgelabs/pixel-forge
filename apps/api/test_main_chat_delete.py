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
        self.assertEqual(payload["thread_id"], expected_thread_id)
        self.assertEqual(payload["title"], f"Chat {expected_thread_id[:8]}")

class LiveEditorPromptDispatchTest(unittest.IsolatedAsyncioTestCase):
    def test_build_dispatch_prompt_mentions_live_preview_context(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            turn_input_payload={
                "prompt_text": "Inspect the active preview",
                "selection": {"count": 0, "items": []},
            },
            selection_tunnel_url="http://pixel-forge.test/api/live-editor/selection-tunnel?request_id=abcd",
            live_preview_context_url="http://pixel-forge.test/api/live-editor/live-preview-context?request_id=abcd",
        )

        self.assertIn("Current typed Pixel Forge turn payload", prompt)
        self.assertIn('"prompt_text": "Inspect the active preview"', prompt)
        self.assertIn("Start with that typed payload before falling back to the disk artifacts.", prompt)
        self.assertIn("live-preview-context", prompt)
        self.assertIn("pixel-forge preview-context --project . --request <request-id>", prompt)
        self.assertIn("already-running Pixel Forge preview tab", prompt)

    def test_build_dispatch_prompt_mentions_context_patch_and_attach_hints(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            request_id="abcd",
            continuation_mode="delta",
            context_patch={
                "source": "pixel-forge",
                "thread_id": "thread-a",
                "continuation_mode": "delta",
                "live_preview": {
                    "current_url": "https://example.com/app",
                    "attach_hints": {
                        "browser_url": "http://127.0.0.1:9222",
                        "target_id": "target-1",
                    },
                },
            },
        )

        self.assertIn("Session context patch for this already-running Agent Deck session", prompt)
        self.assertIn('"thread_id": "thread-a"', prompt)
        self.assertIn('"browser_url": "http://127.0.0.1:9222"', prompt)
        self.assertIn("using-chrome-devtools-mcp", prompt)
        self.assertIn("instead of replaying login or navigation", prompt)
        self.assertIn("pixel-forge attach-proof --project . --request abcd --status attempted --via chrome-devtools-mcp", prompt)
        self.assertIn("pixel-forge attach-proof --project . --request abcd --status succeeded --via chrome-devtools-mcp", prompt)
        self.assertIn("replace the `--via` value with the actual mechanism you used", prompt)
        self.assertIn("Do not claim a successful live attach unless", prompt)

    def test_build_dispatch_prompt_requires_real_attach_for_explicit_attach_proof(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            request_id="abcd",
            continuation_mode="delta",
            explicit_live_attach_required=True,
            live_preview_context_url="http://pixel-forge.test/api/live-editor/live-preview-context?request_id=abcd",
            context_patch={
                "source": "pixel-forge",
                "thread_id": "thread-a",
                "continuation_mode": "delta",
                "live_preview": {
                    "current_url": "https://example.com/app",
                    "attach_hints": {
                        "browser_url": "http://127.0.0.1:9222",
                        "target_id": "target-1",
                    },
                },
            },
        )

        self.assertIn("explicitly requests real live-attach proof", prompt)
        self.assertIn("it is not sufficient to satisfy this request on its own", prompt)
        self.assertIn("explicitly requires real warm-session attach proof", prompt)
        self.assertIn("keep the proof read-only", prompt)
        self.assertNotIn("--via controller-browserview --status succeeded", prompt)

    def test_build_dispatch_prompt_mentions_controller_browserview_live_context(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            request_id="abcd",
            continuation_mode="delta",
            context_patch={
                "source": "pixel-forge",
                "thread_id": "thread-a",
                "continuation_mode": "delta",
                "live_preview": {
                    "live_inspection_mode": "controller-browserview",
                    "current_url": "https://field.example.com/app",
                },
            },
        )

        self.assertIn("controller-captured live DOM state", prompt)
        self.assertIn("--via controller-browserview --status succeeded", prompt)
        self.assertIn("Do not claim that a deeper live attach happened", prompt)

    def test_build_dispatch_prompt_requires_failed_proof_when_explicit_attach_has_no_hints(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            request_id="abcd",
            continuation_mode="delta",
            explicit_live_attach_required=True,
            context_patch={
                "source": "pixel-forge",
                "thread_id": "thread-a",
                "continuation_mode": "delta",
                "live_preview": {
                    "live_inspection_mode": "controller-browserview",
                    "current_url": "https://field.example.com/app",
                },
            },
        )

        self.assertIn("explicitly requires real live-attach proof", prompt)
        self.assertIn("Record failure instead of a controller-browserview success", prompt)
        self.assertIn("--via no-live-attach-hints", prompt)
        self.assertNotIn("--via controller-browserview --status succeeded", prompt)

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
