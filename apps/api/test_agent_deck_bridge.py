import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_deck_bridge
from live_editor_threads import LiveEditorThreadRecord


class AgentDeckBridgeSessionReuseTest(unittest.IsolatedAsyncioTestCase):
    async def test_detached_clone_lane_reuses_existing_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            workspace_path = project_path / ".agents" / "thread-a"
            workspace_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                project_path=str(project_path.resolve()),
                workspace_path=str(workspace_path.resolve()),
                backend="agent-deck",
                agent_deck_session_id=None,
                agent_deck_session_title=None,
                acpx_agent=None,
                acpx_session_name=None,
                acpx_record_id=None,
                acp_session_id=None,
                claude_session_id=None,
                last_request_id="request-a",
                created_at="2026-03-20T00:00:00Z",
                updated_at="2026-03-20T00:00:00Z",
            )

            launch_mock = AsyncMock(
                return_value={
                    "id": "deck-a",
                    "title": "pixel-forge-project-thread-a",
                    "path": str(workspace_path.resolve()),
                    "tool": "claude",
                }
            )
            build_mock = AsyncMock(
                return_value=agent_deck_bridge.AgentDeckSessionInfo(
                    agent_deck_session_id="deck-a",
                    agent_deck_session_title="pixel-forge-project-thread-a",
                    workspace_path=str(workspace_path.resolve()),
                    tmux_session="tmux-a",
                    tool="claude",
                    status="starting",
                    acpx_agent=None,
                    acpx_session_name=None,
                    acpx_record_id=None,
                    acp_session_id=None,
                    claude_session_id=None,
                    jsonl_path=None,
                )
            )

            with (
                patch.object(agent_deck_bridge, "_launch_new_session", launch_mock),
                patch.object(agent_deck_bridge, "_build_session_info", build_mock),
            ):
                await agent_deck_bridge.ensure_agent_deck_session(
                    str(project_path.resolve()),
                    thread,
                    agent_type="claude",
                )

            launch_mock.assert_awaited_once_with(
                str(project_path.resolve()),
                session_title=agent_deck_bridge._session_title(
                    str(project_path.resolve()),
                    thread.thread_id,
                ),
                agent_type="claude",
                workspace_mode="existing",
                workspace_path=str(workspace_path.resolve()),
            )

    async def test_fresh_lane_still_creates_clone_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            project_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                project_path=str(project_path.resolve()),
                workspace_path=str(project_path.resolve()),
                backend="agent-deck",
                agent_deck_session_id=None,
                agent_deck_session_title=None,
                acpx_agent=None,
                acpx_session_name=None,
                acpx_record_id=None,
                acp_session_id=None,
                claude_session_id=None,
                last_request_id=None,
                created_at="2026-03-20T00:00:00Z",
                updated_at="2026-03-20T00:00:00Z",
            )

            launch_mock = AsyncMock(
                return_value={
                    "id": "deck-a",
                    "title": "pixel-forge-project-thread-a",
                    "path": str((project_path / ".agents" / "thread-a").resolve()),
                    "tool": "claude",
                }
            )
            build_mock = AsyncMock(
                return_value=agent_deck_bridge.AgentDeckSessionInfo(
                    agent_deck_session_id="deck-a",
                    agent_deck_session_title="pixel-forge-project-thread-a",
                    workspace_path=str((project_path / ".agents" / "thread-a").resolve()),
                    tmux_session="tmux-a",
                    tool="claude",
                    status="starting",
                    acpx_agent=None,
                    acpx_session_name=None,
                    acpx_record_id=None,
                    acp_session_id=None,
                    claude_session_id=None,
                    jsonl_path=None,
                )
            )

            with (
                patch.object(agent_deck_bridge, "_launch_new_session", launch_mock),
                patch.object(agent_deck_bridge, "_build_session_info", build_mock),
            ):
                await agent_deck_bridge.ensure_agent_deck_session(
                    str(project_path.resolve()),
                    thread,
                    agent_type="claude",
                )

            launch_mock.assert_awaited_once_with(
                str(project_path.resolve()),
                session_title=agent_deck_bridge._session_title(
                    str(project_path.resolve()),
                    thread.thread_id,
                ),
                agent_type="claude",
                workspace_mode="clone",
                workspace_path=None,
            )


if __name__ == "__main__":
    unittest.main()
