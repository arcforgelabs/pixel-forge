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
    async def test_create_project_chat_uses_project_path_when_generating_thread_id(self) -> None:
        created_chat = ProjectChatRecord(
            id="thread-a",
            project_path="/tmp/project",
            title="Chat thread-a",
            thread_id="thread-a",
            workspace_path="/tmp/project",
            backend="agent-deck",
            agent_deck_session_id=None,
            agent_deck_session_title="Chat thread-a",
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
            patch.object(main, "generate_session_id", Mock(return_value="thread-a")) as generate_id,
            patch.object(main, "upsert_session", Mock()) as upsert_session,
            patch.object(
                main,
                "_load_reconciled_project_chats",
                AsyncMock(return_value=([], [created_chat])),
            ),
        ):
            payload = await main.create_project_chat(
                "/tmp/project",
                main.AgentDeckSessionRequest(agent_type="claude", title=None, workspace_mode="root"),
            )

        generate_id.assert_called_once_with("/tmp/project")
        upsert_session.assert_called_once()
        self.assertEqual(payload["thread_id"], "thread-a")
        self.assertEqual(payload["title"], "Chat thread-a")


class LiveEditorPromptDispatchTest(unittest.IsolatedAsyncioTestCase):
    def test_build_dispatch_prompt_warns_clone_workspaces_off_shared_remote_deploys(self) -> None:
        prompt = main.build_live_editor_dispatch_prompt(
            request_file_path=".pixel-forge/requests/req/request.md",
            preview_url="https://staging.example.com/jobs/123",
            self_edit_safe_mode=False,
            self_edit_scope=None,
            informational_only=False,
            continuation_mode="bootstrap",
            requested_skills=[],
        )

        self.assertIn(
            "If this workspace is an isolated clone, do not deploy to shared remote staging or production targets.",
            prompt,
        )
        self.assertIn(
            "Only use a shared remote deploy path from the canonical workspace when the user explicitly asked for deployment",
            prompt,
        )
        self.assertNotIn(
            "deploy using whatever deployment process this project uses",
            prompt,
        )

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
