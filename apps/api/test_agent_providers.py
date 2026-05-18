import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_deck_bridge import AgentDeckSessionActivity, AgentDeckSessionTarget
from agent_providers import list_agent_providers
from agent_providers.agent_deck import AgentDeckProvider
from agent_providers.codex_cli import CodexCliProvider, CodexCliSessionInfo


class AgentProviderRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_env = {
            "PATH": os.environ.get("PATH"),
            "PIXEL_FORGE_WITH_AGENT_DECK": os.environ.get("PIXEL_FORGE_WITH_AGENT_DECK"),
            "PIXEL_FORGE_AGENT_DECK_CMD": os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD"),
            "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": os.environ.get("PIXEL_FORGE_RUNTIME_SOURCE_ROOT"),
        }

    def tearDown(self) -> None:
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
        transports = {
            transport["agent_id"]: transport
            for transport in matches[0]["transports"]  # type: ignore[index]
        }
        self.assertIn("codex", transports)
        self.assertIn("app-server", transports["codex"]["current_transport"])


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

        async def fake_create(project_path: str, **kwargs):
            self.assertEqual(project_path, "/tmp/project")
            self.assertEqual(kwargs["agent_type"], "claude")
            self.assertEqual(kwargs["agent_model"], "claude-opus-4-7")
            self.assertEqual(kwargs["agent_thinking"], "high")
            return target

        with patch(
            "agent_provider_plugins.agent_deck.agent_deck_bridge.create_agent_deck_session_target",
            side_effect=fake_create,
        ):
            session = await AgentDeckProvider().create_session(
                "/tmp/project",
                agent_type="claude",
                agent_model="claude-opus-4-7",
                agent_thinking="high",
            )

        self.assertEqual(session.id, "s2")
        self.assertEqual(session.agent_id, "claude")

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
