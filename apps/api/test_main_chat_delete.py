import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main
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

class LiveEditorPromptDispatchTest(unittest.IsolatedAsyncioTestCase):
    def test_build_dispatch_prompt_mentions_live_preview_context(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            ".pixel-forge/requests/abcd/request.md",
            selection_tunnel_url="http://pixel-forge.test/api/live-editor/selection-tunnel?request_id=abcd",
            live_preview_context_url="http://pixel-forge.test/api/live-editor/live-preview-context?request_id=abcd",
        )

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
        self.assertIn("pixel-forge attach-proof --project . --request abcd --status attempted", prompt)
        self.assertIn("pixel-forge attach-proof --project . --request abcd --status succeeded", prompt)
        self.assertIn("Do not claim a successful live attach unless", prompt)

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
