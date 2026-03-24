import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_deck_bridge
from live_editor_threads import LiveEditorThreadRecord


def _session_info(*, tool: str = "codex") -> agent_deck_bridge.AgentDeckSessionInfo:
    return agent_deck_bridge.AgentDeckSessionInfo(
        agent_deck_session_id="deck-a",
        agent_deck_session_title="pixel-forge-project-thread-a",
        workspace_path="/tmp/project/.agents/thread-a",
        tmux_session="tmux-a",
        tool=tool,
        status="waiting",
        acpx_agent=None,
        acpx_session_name=None,
        acpx_record_id=None,
        acp_session_id=None,
        claude_session_id=None,
        codex_session_id=None,
        jsonl_path=None,
    )


class AgentDeckBridgeSessionReuseTest(unittest.IsolatedAsyncioTestCase):
    async def test_detached_lane_launches_with_persisted_pixel_forge_title(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            project_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                project_path=str(project_path.resolve()),
                workspace_path=str(project_path.resolve()),
                backend="agent-deck",
                agent_deck_session_id=None,
                agent_deck_session_title="Test Rename",
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
                    "title": "Test Rename",
                    "path": str((project_path / ".agents" / "thread-a").resolve()),
                    "tool": "claude",
                }
            )
            build_mock = AsyncMock(return_value=_session_info(tool="claude"))

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
                session_title="Test Rename",
                agent_type="claude",
                workspace_mode="clone",
                workspace_path=None,
            )

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
                    codex_session_id=None,
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
                    codex_session_id=None,
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

    async def test_bound_lane_reconciles_existing_agent_deck_title_to_pixel_forge_title(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            project_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                project_path=str(project_path.resolve()),
                workspace_path=str(project_path.resolve()),
                backend="agent-deck",
                agent_deck_session_id="deck-a",
                agent_deck_session_title="Test Rename",
                acpx_agent=None,
                acpx_session_name=None,
                acpx_record_id=None,
                acp_session_id=None,
                claude_session_id=None,
                last_request_id="request-a",
                created_at="2026-03-20T00:00:00Z",
                updated_at="2026-03-20T00:00:00Z",
            )

            load_mock = AsyncMock(
                return_value={
                    "id": "deck-a",
                    "title": "pixel-forge-project-thread-a",
                    "path": str(project_path.resolve()),
                    "tool": "claude",
                }
            )
            migrate_mock = AsyncMock(
                side_effect=lambda _project_path, _thread, payload, requested_agent_type: payload
            )
            rename_mock = AsyncMock(return_value=None)
            build_mock = AsyncMock(return_value=_session_info(tool="claude"))

            with (
                patch.object(agent_deck_bridge, "_load_existing_session", load_mock),
                patch.object(agent_deck_bridge, "_migrate_legacy_session_payload", migrate_mock),
                patch.object(agent_deck_bridge, "_rename_session", rename_mock),
                patch.object(agent_deck_bridge, "_build_session_info", build_mock),
            ):
                await agent_deck_bridge.ensure_agent_deck_session(
                    str(project_path.resolve()),
                    thread,
                    agent_type="claude",
                )

            rename_mock.assert_awaited_once_with("deck-a", "Test Rename")
            build_mock.assert_awaited_once()
            self.assertEqual(
                build_mock.await_args.kwargs["fallback_title"],
                "Test Rename",
            )
            self.assertEqual(
                build_mock.await_args.args[1]["title"],
                "Test Rename",
            )


class AgentDeckBridgePromptSendTest(unittest.IsolatedAsyncioTestCase):
    async def test_send_agent_deck_prompt_reliably_waits_for_ready_without_cli_wait_flag(self) -> None:
        run_command = AsyncMock(return_value=(0, "", ""))

        with patch.object(agent_deck_bridge, "_run_agent_deck_command", run_command):
            await agent_deck_bridge.send_agent_deck_prompt_reliably(
                _session_info(),
                project_path="/tmp/project",
                prompt="Fix the bug",
            )

        run_command.assert_awaited_once_with(
            [
                "session",
                "send",
                "deck-a",
                "Fix the bug",
                "-q",
            ],
            cwd="/tmp/project",
        )

    async def test_send_agent_deck_prompt_reliably_surfaces_agent_deck_errors(self) -> None:
        run_command = AsyncMock(return_value=(1, "", "agent not ready after 30s"))

        with patch.object(agent_deck_bridge, "_run_agent_deck_command", run_command):
            with self.assertRaisesRegex(
                agent_deck_bridge.AgentDeckBridgeError,
                "agent not ready after 30s",
            ):
                await agent_deck_bridge.send_agent_deck_prompt_reliably(
                    _session_info(),
                    project_path="/tmp/project",
                    prompt="Fix the bug",
                )

    async def test_send_agent_deck_prompt_reliably_can_bypass_ready_wait(self) -> None:
        run_command = AsyncMock(return_value=(0, "", ""))

        with patch.object(agent_deck_bridge, "_run_agent_deck_command", run_command):
            await agent_deck_bridge.send_agent_deck_prompt_reliably(
                _session_info(),
                project_path="/tmp/project",
                prompt="Queue the follow-up",
                no_wait=True,
            )

        run_command.assert_awaited_once_with(
            [
                "session",
                "send",
                "deck-a",
                "Queue the follow-up",
                "-q",
                "--no-wait",
            ],
            cwd="/tmp/project",
        )

    async def test_get_agent_deck_session_activity_ignores_startup_noise(self) -> None:
        with (
            patch.object(
                agent_deck_bridge,
                "session_show",
                AsyncMock(
                    return_value={
                        "id": "deck-a",
                        "title": "former multi-chat",
                        "path": "/tmp/project",
                        "tool": "codex",
                        "status": "running",
                    }
                ),
            ),
            patch.object(
                agent_deck_bridge,
                "get_last_output",
                AsyncMock(return_value="OpenAI Codex\nDo you trust the contents of this directory?"),
            ),
        ):
            activity = await agent_deck_bridge.get_agent_deck_session_activity(
                "/tmp/project",
                "deck-a",
            )

        self.assertEqual(activity.session_id, "deck-a")
        self.assertEqual(activity.session_title, "former multi-chat")
        self.assertEqual(activity.tool, "codex")
        self.assertEqual(activity.status, "running")
        self.assertEqual(activity.output, "")


class AgentDeckBridgeSessionListingTest(unittest.IsolatedAsyncioTestCase):
    async def test_list_project_sessions_treats_empty_profile_message_as_empty_json_list(self) -> None:
        with patch.object(
            agent_deck_bridge,
            "_run_agent_deck_command",
            AsyncMock(return_value=(0, "No sessions found in profile 'alpha'.\n", "")),
        ):
            sessions = await agent_deck_bridge.list_project_agent_deck_sessions("/tmp/project")

        self.assertEqual(sessions, [])

    async def test_list_project_sessions_removes_missing_isolated_rows_before_surfacing(self) -> None:
        async def run_command(args, cwd=None):
            if args[:2] == ["ls", "-json"]:
                return (
                    0,
                    json.dumps(
                        [
                            {
                                "id": "deck-orphan",
                                "title": "orphan clone",
                                "path": "/tmp/project/.agents/orphan-clone",
                                "group": "project",
                                "tool": "claude",
                                "command": "claude",
                                "status": "idle",
                                "created_at": "2026-03-24T00:00:00Z",
                            },
                            {
                                "id": "deck-root",
                                "title": "root session",
                                "path": "/tmp/project",
                                "group": "project",
                                "tool": "codex",
                                "command": "codex",
                                "status": "running",
                                "created_at": "2026-03-24T00:01:00Z",
                            },
                        ]
                    ),
                    "",
                )
            if args[:2] == ["rm", "deck-orphan"]:
                return (0, "", "")
            raise AssertionError(f"Unexpected agent-deck command: {args!r} cwd={cwd!r}")

        with (
            patch.object(agent_deck_bridge, "_run_agent_deck_command", side_effect=run_command) as run_mock,
            patch.object(
                agent_deck_bridge.os.path,
                "isdir",
                side_effect=lambda path: path == "/tmp/project",
            ),
        ):
            sessions = await agent_deck_bridge.list_project_agent_deck_sessions("/tmp/project")

        self.assertEqual([session.id for session in sessions], ["deck-root"])
        self.assertEqual(run_mock.await_count, 2)


class AgentDeckBridgeCloseoutPromptTest(unittest.TestCase):
    def test_clone_closeout_prompt_requires_zombie_source_cleanup_without_asking(self) -> None:
        context = agent_deck_bridge.AgentDeckSessionActionContext(
            session_id="deck-zombie",
            session_title="draft-lane",
            group_path="pixel-forge/project",
            workspace_path="/tmp/project/.agents/draft-lane",
            repo_root="/tmp/project",
            target_branch="master",
            is_clone=True,
            is_worktree=False,
            clone_dirty=False,
            clone_branch_state="in_sync",
        )

        prompt = agent_deck_bridge._build_closeout_prompt(context)

        self.assertIn(
            "treat it as a zombie and remove that Agent Deck session row in the same pass",
            prompt,
        )
        self.assertIn(
            "Do not ask for permission to remove a zombie source session",
            prompt,
        )
        self.assertIn("agent-deck rm 'deck-zombie' -q", prompt)


class AgentDeckBridgeCodexStreamTest(unittest.IsolatedAsyncioTestCase):
    async def test_stream_claude_jsonl_mirrors_chunk_payloads_to_callback(self) -> None:
        websocket = AsyncMock()
        on_emit = AsyncMock()
        wait_task = asyncio.get_running_loop().create_future()
        wait_task.set_result(None)

        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as handle:
            handle.write(
                '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello from Claude"}]}}\n'
            )
            jsonl_path = Path(handle.name)

        self.addCleanup(lambda: jsonl_path.unlink(missing_ok=True))

        with (
            patch.object(agent_deck_bridge, "STREAM_POLL_INTERVAL_SECONDS", 0.0),
            patch.object(agent_deck_bridge, "STREAM_IDLE_AFTER_COMPLETION_SECONDS", 0.0),
        ):
            stats = await agent_deck_bridge.stream_claude_jsonl(
                websocket,
                jsonl_path,
                0,
                wait_task,
                on_emit=on_emit,
            )

        websocket.send_json.assert_awaited_once_with(
            {"type": "chunk", "content": "Hello from Claude"}
        )
        on_emit.assert_awaited_once_with(
            {"type": "chunk", "content": "Hello from Claude"}
        )
        self.assertTrue(stats.streamed_text)
        self.assertEqual(stats.last_output, "Hello from Claude")

    async def test_stream_codex_session_output_emits_incremental_text_chunks(self) -> None:
        websocket = AsyncMock()
        on_emit = AsyncMock()
        wait_task = asyncio.get_running_loop().create_future()
        wait_task.set_result(None)
        baseline_output = "model: gpt-5\n› "

        with (
            patch.object(
                agent_deck_bridge,
                "get_last_output",
                AsyncMock(side_effect=[f"{baseline_output}\nHello from Codex"]),
            ),
            patch.object(agent_deck_bridge, "CODEX_POLL_INTERVAL_SECONDS", 0.0),
            patch.object(agent_deck_bridge, "STREAM_IDLE_AFTER_COMPLETION_SECONDS", 0.0),
        ):
            stats = await agent_deck_bridge.stream_codex_session_output(
                websocket,
                agent_deck_session_id="deck-a",
                baseline_output=baseline_output,
                prompt="Fix the bug",
                wait_task=wait_task,
                on_emit=on_emit,
            )

        websocket.send_json.assert_awaited_once_with(
            {"type": "chunk", "content": "Hello from Codex"}
        )
        on_emit.assert_awaited_once_with(
            {"type": "chunk", "content": "Hello from Codex"}
        )
        self.assertTrue(stats.streamed_text)
        self.assertEqual(stats.last_output, "Hello from Codex")

    async def test_stream_codex_session_output_routes_progress_only_updates_to_status(self) -> None:
        websocket = AsyncMock()
        on_emit = AsyncMock()
        wait_task = asyncio.get_running_loop().create_future()
        wait_task.set_result(None)
        baseline_output = "model: gpt-5\n› "

        with (
            patch.object(
                agent_deck_bridge,
                "get_last_output",
                AsyncMock(side_effect=[f"{baseline_output}\n• Working · esc to interrupt"]),
            ),
            patch.object(agent_deck_bridge, "CODEX_POLL_INTERVAL_SECONDS", 0.0),
            patch.object(agent_deck_bridge, "STREAM_IDLE_AFTER_COMPLETION_SECONDS", 0.0),
        ):
            stats = await agent_deck_bridge.stream_codex_session_output(
                websocket,
                agent_deck_session_id="deck-a",
                baseline_output=baseline_output,
                prompt="Fix the bug",
                wait_task=wait_task,
                on_emit=on_emit,
            )

        websocket.send_json.assert_awaited_once_with(
            {"type": "status", "message": "Codex: • Working"}
        )
        on_emit.assert_awaited_once_with(
            {"type": "status", "message": "Codex: • Working"}
        )
        self.assertFalse(stats.streamed_text)
        self.assertEqual(stats.last_output, "")


if __name__ == "__main__":
    unittest.main()
