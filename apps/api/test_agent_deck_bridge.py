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


class AgentDeckBridgeModelEffortArgsTest(unittest.TestCase):
    def test_codex_allows_current_gpt_55_family_models(self) -> None:
        args = agent_deck_bridge._resolve_agent_model_effort_args(
            "codex",
            "gpt-5.5",
            "xhigh",
        )

        self.assertEqual(
            args,
            ["--model", "gpt-5.5", "--effort", "xhigh"],
        )

    def test_codex_drops_retired_model_ids(self) -> None:
        args = agent_deck_bridge._resolve_agent_model_effort_args(
            "codex",
            "gpt-5.3",
            "high",
        )

        self.assertEqual(args, ["--effort", "high"])

    def test_claude_alias_normalizes_to_explicit_opus_47_and_keeps_xhigh(self) -> None:
        args = agent_deck_bridge._resolve_agent_model_effort_args(
            "claude",
            "opus",
            "xhigh",
        )

        self.assertEqual(
            args,
            ["--model", "claude-opus-4-7", "--effort", "xhigh"],
        )

    def test_claude_xhigh_is_dropped_for_non_opus_47_models(self) -> None:
        args = agent_deck_bridge._resolve_agent_model_effort_args(
            "claude",
            "claude-opus-4-6",
            "xhigh",
        )

        self.assertEqual(args, ["--model", "claude-opus-4-6"])


class AgentDeckBridgeSessionReuseTest(unittest.IsolatedAsyncioTestCase):
    async def test_detached_lane_launches_with_persisted_pixel_forge_title(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            project_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                profile_id="default",
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
                last_live_preview_hash=None,
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
                agent_model=None,
                agent_thinking=None,
            )

    async def test_detached_clone_lane_reuses_existing_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            workspace_path = project_path / ".agents" / "thread-a"
            workspace_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                profile_id="default",
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
                last_live_preview_hash=None,
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
                agent_model=None,
                agent_thinking=None,
            )

    async def test_fresh_lane_still_creates_clone_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            project_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                profile_id="default",
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
                last_live_preview_hash=None,
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
                agent_model=None,
                agent_thinking=None,
            )

    async def test_bound_lane_reconciles_existing_agent_deck_title_to_pixel_forge_title(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            project_path = Path(tempdir) / "project"
            project_path.mkdir(parents=True)

            thread = LiveEditorThreadRecord(
                thread_id="thread-a",
                profile_id="default",
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
                last_live_preview_hash=None,
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


class AgentDeckBridgeExecutableResolutionTest(unittest.TestCase):
    def tearDown(self) -> None:
        agent_deck_bridge._resolve_runtime_executable.cache_clear()

    def test_resolve_runtime_executable_falls_back_to_nvm_bin(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            home = Path(tempdir)
            version_bin = home / ".nvm" / "versions" / "node" / "v24.11.1" / "bin"
            version_bin.mkdir(parents=True)
            codex_path = version_bin / "codex"
            codex_path.write_text("#!/bin/sh\n", encoding="utf-8")
            codex_path.chmod(0o755)

            with (
                patch.dict(agent_deck_bridge.os.environ, {"PATH": "/usr/bin:/bin"}, clear=False),
                patch.object(agent_deck_bridge.Path, "home", return_value=home),
                patch.object(agent_deck_bridge.shutil, "which", side_effect=lambda name, path=None: str(codex_path) if name == "codex" and path and str(version_bin) in path else None),
            ):
                resolved = agent_deck_bridge._resolve_runtime_executable("codex")

        self.assertEqual(resolved, str(codex_path))


class AgentDeckBridgePromptSendTest(unittest.IsolatedAsyncioTestCase):

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
            AsyncMock(return_value=(0, "No sessions found in profile 'pixel-forge'.\n", "")),
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

    async def test_list_project_sessions_includes_group_owned_root_outside_path(self) -> None:
        async def run_command(args, cwd=None):
            if args[:2] == ["ls", "-json"]:
                return (
                    0,
                    json.dumps(
                        [
                            {
                                "id": "deck-group-owned",
                                "title": "test",
                                "path": "/tmp",
                                "group": "pixel-forge/project",
                                "tool": "claude",
                                "command": "claude",
                                "status": "waiting",
                                "created_at": "2026-03-27T00:00:00Z",
                            }
                        ]
                    ),
                    "",
                )
            raise AssertionError(f"Unexpected agent-deck command: {args!r} cwd={cwd!r}")

        with patch.object(
            agent_deck_bridge,
            "_run_agent_deck_command",
            side_effect=run_command,
        ):
            sessions = await agent_deck_bridge.list_project_agent_deck_sessions("/tmp/project")

        self.assertEqual([session.id for session in sessions], ["deck-group-owned"])
        self.assertEqual(sessions[0].path, "/tmp")

    async def test_list_project_sessions_excludes_group_owned_unrelated_path(self) -> None:
        async def run_command(args, cwd=None):
            if args[:2] == ["ls", "-json"]:
                return (
                    0,
                    json.dumps(
                        [
                            {
                                "id": "deck-group-stale",
                                "title": "stale",
                                "path": "/elsewhere/unrelated",
                                "group": "pixel-forge/project",
                                "tool": "claude",
                                "command": "claude",
                                "status": "waiting",
                                "created_at": "2026-03-27T00:00:00Z",
                            }
                        ]
                    ),
                    "",
                )
            raise AssertionError(f"Unexpected agent-deck command: {args!r} cwd={cwd!r}")

        with patch.object(
            agent_deck_bridge,
            "_run_agent_deck_command",
            side_effect=run_command,
        ):
            sessions = await agent_deck_bridge.list_project_agent_deck_sessions("/tmp/project")

        self.assertEqual(sessions, [])


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
    def test_codex_jsonl_payloads_cover_tool_cards_and_text_blocks(self) -> None:
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "call_id": "tool-1",
                        "name": "open_file",
                        "arguments": {"path": "a.txt"},
                    },
                }
            ),
            [
                {
                    "type": "tool_use",
                    "tool_call_id": "tool-1",
                    "tool": "open_file",
                    "input": {"path": "a.txt"},
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "call_id": "tool-2",
                        "name": "search",
                        "arguments": '{"q":"needle"}',
                    },
                }
            ),
            [
                {
                    "type": "tool_use",
                    "tool_call_id": "tool-2",
                    "tool": "search",
                    "input": {"q": "needle"},
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "call_id": "tool-3",
                        "output": {"content": "done", "success": True},
                    },
                }
            ),
            [
                {
                    "type": "tool_result",
                    "tool_call_id": "tool-3",
                    "content": "done",
                    "is_error": False,
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "call_id": "tool-4",
                        "output": {"content": "failed", "success": False},
                    },
                }
            ),
            [
                {
                    "type": "tool_result",
                    "tool_call_id": "tool-4",
                    "content": "failed",
                    "is_error": True,
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "call_id": "tool-5",
                        "output": "plain output",
                    },
                }
            ),
            [
                {
                    "type": "tool_result",
                    "tool_call_id": "tool-5",
                    "content": "plain output",
                    "is_error": False,
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "exec_command_begin",
                        "call_id": "bash-1",
                        "command": ["git", "status"],
                    },
                }
            ),
            [
                {
                    "type": "tool_use",
                    "tool_call_id": "bash-1",
                    "tool": "Bash",
                    "input": {"command": "git status"},
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "exec_command_end",
                        "call_id": "bash-2",
                        "stdout": "ok",
                        "stderr": "",
                        "exit_code": 0,
                    },
                }
            ),
            [
                {
                    "type": "tool_result",
                    "tool_call_id": "bash-2",
                    "content": "ok",
                    "is_error": False,
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "exec_command_end",
                        "call_id": "bash-3",
                        "stdout": "",
                        "stderr": "bad",
                        "exit_code": 2,
                    },
                }
            ),
            [
                {
                    "type": "tool_result",
                    "tool_call_id": "bash-3",
                    "content": "bad",
                    "is_error": True,
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "agent_message",
                        "message": "Thinking",
                    },
                }
            ),
            [{"type": "chunk", "content": "Thinking\n\n"}],
        )
        self.assertEqual(
            agent_deck_bridge.codex_jsonl_payloads_for_record(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": "Line one"},
                            {"type": "output_text", "text": "Line two"},
                        ],
                    },
                }
            ),
            [
                {"type": "chunk", "content": "Line one"},
                {"type": "chunk", "content": "Line two"},
            ],
        )

    def test_read_codex_jsonl_payloads_rewinds_when_file_shrinks(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "first payload is deliberately longer than the replacement",
                                }
                            ],
                        },
                    }
                )
            )
            handle.write("\n")
            jsonl_path = Path(handle.name)

        self.addCleanup(lambda: jsonl_path.unlink(missing_ok=True))

        first_offset, first_payloads = agent_deck_bridge.read_codex_jsonl_payloads(
            jsonl_path,
            0,
        )
        self.assertGreater(first_offset, 0)
        self.assertEqual(
            first_payloads,
            [
                {
                    "type": "chunk",
                    "content": "first payload is deliberately longer than the replacement",
                }
            ],
        )

        jsonl_path.write_text(
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "rewound"}],
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )

        second_offset, second_payloads = agent_deck_bridge.read_codex_jsonl_payloads(
            jsonl_path,
            first_offset,
        )
        self.assertGreater(second_offset, 0)
        self.assertEqual(second_payloads, [{"type": "chunk", "content": "rewound"}])

    def test_claude_jsonl_payloads_preserve_tool_call_ids(self) -> None:
        self.assertEqual(
            agent_deck_bridge.claude_jsonl_payloads_for_record(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "tool-claude-1",
                                "name": "Read",
                                "input": {"file": "a.txt"},
                            }
                        ],
                    },
                }
            ),
            [
                {
                    "type": "tool_use",
                    "tool_call_id": "tool-claude-1",
                    "tool": "Read",
                    "input": {"file": "a.txt"},
                }
            ],
        )
        self.assertEqual(
            agent_deck_bridge.claude_jsonl_payloads_for_record(
                {
                    "type": "user",
                    "message": {
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "tool-claude-1",
                                "content": [{"type": "text", "text": "ok"}],
                                "is_error": False,
                            }
                        ]
                    },
                }
            ),
            [
                {
                    "type": "tool_result",
                    "tool_call_id": "tool-claude-1",
                    "content": "ok",
                    "is_error": False,
                }
            ],
        )

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


class AgentDeckBridgeTurnCompletionTest(unittest.IsolatedAsyncioTestCase):
    def _session_info_with_jsonl(
        self, jsonl_path: Path
    ) -> agent_deck_bridge.AgentDeckSessionInfo:
        return agent_deck_bridge.AgentDeckSessionInfo(
            agent_deck_session_id="deck-a",
            agent_deck_session_title="pixel-forge-project-thread-a",
            workspace_path="/tmp/project/.agents/thread-a",
            tmux_session="tmux-a",
            tool="claude",
            status="waiting",
            acpx_agent=None,
            acpx_session_name=None,
            acpx_record_id=None,
            acp_session_id=None,
            claude_session_id=None,
            codex_session_id=None,
            jsonl_path=jsonl_path,
        )

    async def test_turn_completion_detects_jsonl_growth_when_status_stays_waiting(
        self,
    ) -> None:
        with tempfile.NamedTemporaryFile(
            "w", delete=False, encoding="utf-8"
        ) as handle:
            handle.write("")
            jsonl_path = Path(handle.name)
        self.addCleanup(lambda: jsonl_path.unlink(missing_ok=True))

        session_info = self._session_info_with_jsonl(jsonl_path)

        call_count = {"n": 0}

        async def fake_session_show(_session_id: str) -> dict:
            call_count["n"] += 1
            if call_count["n"] == 2:
                with jsonl_path.open("a", encoding="utf-8") as handle:
                    handle.write(
                        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n'
                    )
            return {"id": "deck-a", "status": "waiting"}

        with (
            patch.object(
                agent_deck_bridge,
                "session_show",
                side_effect=fake_session_show,
            ),
            patch.object(
                agent_deck_bridge,
                "JSONL_IDLE_COMPLETION_SECONDS",
                0.0,
            ),
        ):
            await agent_deck_bridge.wait_for_agent_deck_turn_completion(
                session_info,
                startup_timeout_seconds=5.0,
                completion_timeout_seconds=5.0,
                poll_interval_seconds=0.01,
            )

        self.assertGreaterEqual(call_count["n"], 2)

    async def test_turn_completion_raises_without_jsonl_growth_or_status_transition(
        self,
    ) -> None:
        with tempfile.NamedTemporaryFile(
            "w", delete=False, encoding="utf-8"
        ) as handle:
            handle.write("")
            jsonl_path = Path(handle.name)
        self.addCleanup(lambda: jsonl_path.unlink(missing_ok=True))

        session_info = self._session_info_with_jsonl(jsonl_path)

        async def fake_session_show(_session_id: str) -> dict:
            return {"id": "deck-a", "status": "waiting"}

        with (
            patch.object(
                agent_deck_bridge,
                "session_show",
                side_effect=fake_session_show,
            ),
        ):
            with self.assertRaisesRegex(
                agent_deck_bridge.AgentDeckBridgeError,
                "never started processing",
            ):
                await agent_deck_bridge.wait_for_agent_deck_turn_completion(
                    session_info,
                    startup_timeout_seconds=0.05,
                    completion_timeout_seconds=1.0,
                    poll_interval_seconds=0.01,
                )


if __name__ == "__main__":
    unittest.main()
