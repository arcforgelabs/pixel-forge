import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_deck_bridge import AgentDeckSessionActivity, AgentDeckSessionTarget
from agent_provider_plugins import codex_cli as codex_cli_plugin
from agent_providers import list_agent_providers
from agent_providers.agent_deck import AgentDeckProvider
from agent_providers.claude_cli import ClaudeCliSessionInfo
from agent_providers.codex_cli import CodexCliProvider, CodexCliSessionInfo
from agent_providers.models import AgentTurnPolicy, AgentTurnRequest


class AgentProviderRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_env = {
            "PATH": os.environ.get("PATH"),
            "HOME": os.environ.get("HOME"),
            "PIXEL_FORGE_WITH_AGENT_DECK": os.environ.get("PIXEL_FORGE_WITH_AGENT_DECK"),
            "PIXEL_FORGE_AGENT_DECK_CMD": os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD"),
            "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": os.environ.get("PIXEL_FORGE_RUNTIME_SOURCE_ROOT"),
        }
        codex_cli_plugin._resolve_codex_executable.cache_clear()

    def tearDown(self) -> None:
        codex_cli_plugin._resolve_codex_executable.cache_clear()
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _agent_deck_status(self) -> dict[str, object]:
        statuses = [status.to_dict() for status in list_agent_providers()]
        matches = [status for status in statuses if status["id"] == "agent-deck"]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_agent_deck_can_be_disabled_without_breaking_registry(self) -> None:
        with patch.dict(
            os.environ,
            {
                "PIXEL_FORGE_WITH_AGENT_DECK": "0",
                "PIXEL_FORGE_AGENT_DECK_CMD": "",
                "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": self.tempdir.name,
            },
            clear=False,
        ):
            status = self._agent_deck_status()

        self.assertFalse(status["enabled"])
        self.assertFalse(status["available"])
        self.assertEqual(status["command"], [])
        self.assertIn("disabled", str(status["reason"]).lower())

    def test_agent_deck_prefers_explicit_standard_command(self) -> None:
        fake_bin = Path(self.tempdir.name) / "agent-deck-standalone"
        fake_bin.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"launch\" ] && [ \"$2\" = \"--help\" ]; then\n"
            "  echo 'Usage: agent-deck launch [--yolo]'\n"
            "  exit 0\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        fake_bin.chmod(0o755)

        with patch.dict(
            os.environ,
            {
                "PATH": self.tempdir.name,
                "PIXEL_FORGE_WITH_AGENT_DECK": "auto",
                "PIXEL_FORGE_AGENT_DECK_CMD": "",
                "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": self.tempdir.name,
            },
            clear=False,
        ):
            status = self._agent_deck_status()

        self.assertTrue(status["enabled"])
        self.assertTrue(status["available"])
        self.assertEqual(status["command"], [str(fake_bin)])

    def test_agent_deck_status_splits_surface_and_launch_runtimes(self) -> None:
        external = Path(self.tempdir.name) / "agent-deck-standalone"
        external.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"launch\" ] && [ \"$2\" = \"--help\" ]; then\n"
            "  echo 'Usage: agent-deck launch'\n"
            "  exit 0\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        external.chmod(0o755)
        repo = Path(self.tempdir.name) / "repo"
        bundled = repo / "foundations" / "agent-deck" / "agent-deck"
        bundled.parent.mkdir(parents=True)
        bundled.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"launch\" ] && [ \"$2\" = \"--help\" ]; then\n"
            "  echo 'Usage: agent-deck launch [--yolo]'\n"
            "  exit 0\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        bundled.chmod(0o755)

        with patch.dict(
            os.environ,
            {
                "PATH": self.tempdir.name,
                "PIXEL_FORGE_WITH_AGENT_DECK": "auto",
                "PIXEL_FORGE_AGENT_DECK_CMD": "",
                "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": str(repo),
            },
            clear=False,
        ):
            status = self._agent_deck_status()

        diagnostics = status["diagnostics"]  # type: ignore[index]
        self.assertEqual(diagnostics["surface_command"], [str(external)])
        self.assertEqual(diagnostics["launch_command"], [str(bundled)])
        self.assertIn("config_home", diagnostics)
        self.assertEqual(diagnostics["surface_runtime_origin"], "external")
        self.assertEqual(diagnostics["launch_runtime_origin"], "bundled")
        self.assertTrue(diagnostics["launch_capabilities"]["no_approval"])

    def test_agent_deck_exposes_codex_transport_direction(self) -> None:
        with patch.dict(
            os.environ,
            {"PIXEL_FORGE_WITH_AGENT_DECK": "0"},
            clear=False,
        ):
            status = self._agent_deck_status()

        transports = {
            transport["agent_id"]: transport
            for transport in status["transports"]  # type: ignore[index]
        }
        self.assertIn("codex", transports)
        self.assertIn("exec resume", transports["codex"]["current_transport"])
        self.assertIn("app-server", transports["codex"]["preferred_transport"])

    def test_codex_cli_provider_is_registered_with_app_server_transport(self) -> None:
        statuses = [status.to_dict() for status in list_agent_providers()]
        matches = [status for status in statuses if status["id"] == "codex-cli"]
        self.assertEqual(len(matches), 1)
        self.assertIn("config_home", matches[0]["diagnostics"])
        transports = {
            transport["agent_id"]: transport
            for transport in matches[0]["transports"]  # type: ignore[index]
        }
        self.assertIn("codex", transports)
        self.assertIn("app-server", transports["codex"]["current_transport"])

    def test_claude_cli_provider_is_registered_as_direct_retry_transport(self) -> None:
        statuses = [status.to_dict() for status in list_agent_providers()]
        matches = [status for status in statuses if status["id"] == "claude-cli"]
        self.assertEqual(len(matches), 1)
        self.assertIn("config_home", matches[0]["diagnostics"])
        transports = {
            transport["agent_id"]: transport
            for transport in matches[0]["transports"]  # type: ignore[index]
        }
        self.assertIn("claude", transports)
        self.assertIn("direct-CLI replay", transports["claude"]["architecture_note"])

    def test_codex_cli_provider_resolves_user_npm_global_bin_without_service_path(self) -> None:
        codex_bin = Path(self.tempdir.name) / ".npm-global" / "bin" / "codex"
        codex_bin.parent.mkdir(parents=True)
        codex_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        codex_bin.chmod(0o755)

        with patch.dict(
            os.environ,
            {
                "HOME": self.tempdir.name,
                "PATH": "/usr/bin:/bin",
            },
            clear=False,
        ):
            codex_cli_plugin._resolve_codex_executable.cache_clear()
            status = CodexCliProvider().status()

        self.assertTrue(status.available)
        self.assertEqual(status.command, [str(codex_bin)])


class AgentDeckProviderBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_list_sessions_delegates_to_bridge_and_returns_neutral_shape(self) -> None:
        target = AgentDeckSessionTarget(
            id="s1",
            title="Session 1",
            path="/tmp/project",
            group="/tmp/project",
            tool="codex",
            command="codex exec resume",
            status="running",
            created_at="now",
        )

        async def fake_list(project_path: str):
            self.assertEqual(project_path, "/tmp/project")
            return [target]

        with patch(
            "agent_provider_plugins.agent_deck.agent_deck_bridge.list_project_agent_deck_sessions",
            side_effect=fake_list,
        ):
            sessions = await AgentDeckProvider().list_sessions("/tmp/project")

        self.assertEqual(len(sessions), 1)
        serialized = sessions[0].to_dict()
        self.assertEqual(serialized["provider_id"], "agent-deck")
        self.assertEqual(serialized["provider_session_id"], "s1")
        self.assertEqual(serialized["agent_id"], "codex")
        self.assertEqual(serialized["workspace_path"], "/tmp/project")

    async def test_create_session_delegates_model_options(self) -> None:
        target = AgentDeckSessionTarget(
            id="s2",
            title="Session 2",
            path="/tmp/project",
            group=None,
            tool="claude",
            command=None,
            status=None,
            created_at=None,
        )

        launch_mock = AsyncMock(
            return_value={
                "id": target.id,
                "title": target.title,
                "path": target.path,
                "group": target.group,
                "tool": target.tool,
                "command": target.command,
                "status": target.status,
                "created_at": target.created_at,
            }
        )

        with patch.object(AgentDeckProvider, "_launch_session", launch_mock):
            session = await AgentDeckProvider().create_session(
                "/tmp/project",
                agent_type="claude",
                title="Session 2",
                agent_model="claude-opus-4-7",
                agent_thinking="high",
            )

        launch_mock.assert_awaited_once_with(
            "/tmp/project",
            session_title="Session 2",
            agent_type="claude",
            workspace_mode="root",
            agent_model="claude-opus-4-7",
            agent_thinking="high",
        )
        self.assertEqual(session.id, "s2")
        self.assertEqual(session.agent_id, "claude")

    async def test_launch_session_maps_no_approval_policy_to_agent_deck_yolo_args(self) -> None:
        run_mock = AsyncMock(
            return_value={
                "id": "deck-a",
                "title": "Chat chat-a",
                "path": "/tmp/project",
                "tool": "codex",
            }
        )
        request = AgentTurnRequest(
            project_path="/tmp/project",
            prompt="test",
            agent_id="codex",
            policy=AgentTurnPolicy(autonomy="no-approval", no_approval=True),
        )

        with (
            patch(
                "agent_provider_plugins.agent_deck.agent_deck_available",
                return_value=(True, None),
            ),
            patch(
                "agent_provider_plugins.agent_deck.agent_deck_bridge._enforce_agent_deck_launch_admission",
                AsyncMock(),
            ),
            patch(
                "agent_provider_plugins.agent_deck.agent_deck_bridge._run_agent_deck_json_object_command",
                run_mock,
            ),
        ):
            await AgentDeckProvider()._launch_session(
                "/tmp/project",
                session_title="Chat chat-a",
                agent_type="codex",
                agent_model="gpt-5.5",
                agent_thinking="xhigh",
                turn_request=request,
            )

        run_mock.assert_awaited_once_with(
            [
                "launch",
                "-json",
                "-no-wait",
                "-t=Chat chat-a",
                "-g=pixel-forge/project",
                "-c=codex",
                "--model",
                "gpt-5.5",
                "--effort",
                "xhigh",
                "--yolo",
                "/tmp/project",
            ]
        )

    async def test_launch_session_raises_loudly_when_no_approval_contract_is_missing(self) -> None:
        request = AgentTurnRequest(
            project_path="/tmp/project",
            prompt="test",
            agent_id="codex",
            policy=AgentTurnPolicy(autonomy="no-approval", no_approval=True),
        )

        with patch(
            "agent_provider_plugins.agent_deck.agent_deck_available",
            return_value=(False, "missing launch --yolo"),
        ):
            with self.assertRaisesRegex(Exception, "launch --yolo"):
                await AgentDeckProvider()._launch_session(
                    "/tmp/project",
                    session_title="Chat chat-a",
                    agent_type="codex",
                    turn_request=request,
                )

    async def test_get_activity_returns_neutral_shape(self) -> None:
        activity = AgentDeckSessionActivity(
            session_id="s3",
            session_title="Session 3",
            workspace_path="/tmp/project",
            tool="pi",
            status="idle",
            output="done",
        )

        async def fake_activity(project_path: str, session_id: str):
            self.assertEqual(project_path, "/tmp/project")
            self.assertEqual(session_id, "s3")
            return activity

        with patch(
            "agent_provider_plugins.agent_deck.agent_deck_bridge.get_agent_deck_session_activity",
            side_effect=fake_activity,
        ):
            serialized = (
                await AgentDeckProvider().get_activity("/tmp/project", "s3")
            ).to_dict()

        self.assertEqual(serialized["provider_id"], "agent-deck")
        self.assertEqual(serialized["provider_session_id"], "s3")
        self.assertEqual(serialized["agent_id"], "pi")
        self.assertEqual(serialized["output"], "done")


class CodexCliProviderBridgeTest(unittest.IsolatedAsyncioTestCase):
    def test_direct_provider_session_infos_do_not_populate_agent_deck_fields(self) -> None:
        codex_session = CodexCliSessionInfo(
            provider_session_id="codex-thread-a",
            title="Codex thread",
            workspace_path="/tmp/project",
            status="idle",
            codex_session_id="codex-thread-a",
        )
        claude_session = ClaudeCliSessionInfo(
            provider_session_id="claude-thread-a",
            title="Claude thread",
            workspace_path="/tmp/project",
            status="idle",
            claude_session_id="claude-thread-a",
        )

        self.assertIsNone(codex_session.agent_deck_session_id)
        self.assertIsNone(codex_session.agent_deck_session_title)
        self.assertIsNone(claude_session.agent_deck_session_id)
        self.assertIsNone(claude_session.agent_deck_session_title)

    async def test_dispatch_turn_uses_codex_app_server_runner(self) -> None:
        session = CodexCliSessionInfo(
            provider_session_id="codex-thread-a",
            title="Codex thread",
            workspace_path="/tmp/project",
            status="idle",
            codex_session_id="codex-thread-a",
        )

        async def fake_run(session_info, **kwargs):
            self.assertEqual(session_info.provider_session_id, "codex-thread-a")
            self.assertEqual(kwargs["prompt"], "hello")
            return "done"

        with patch(
            "agent_provider_plugins.codex_cli._run_codex_turn",
            side_effect=fake_run,
        ):
            dispatch = await CodexCliProvider().dispatch_turn(
                session,
                project_path="/tmp/project",
                prompt="hello",
                image_paths=[],
                startup_timeout_seconds=1.0,
                completion_timeout_seconds=2.0,
            )
            result = await dispatch.wait_task

        self.assertEqual(dispatch.provider_id, "codex-cli")
        self.assertEqual(dispatch.provider_session_id, "codex-thread-a")
        self.assertEqual(dispatch.agent_id, "codex")
        self.assertEqual(result, "done")
