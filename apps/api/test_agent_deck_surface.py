import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_deck_surface


class AgentDeckSurfaceRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_env = {
            "PIXEL_FORGE_SHARED_STATE_DIR": os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR"),
            "PIXEL_FORGE_RUNTIME_DIR": os.environ.get("PIXEL_FORGE_RUNTIME_DIR"),
            "PIXEL_FORGE_AGENT_DECK_HOME": os.environ.get("PIXEL_FORGE_AGENT_DECK_HOME"),
            "PIXEL_FORGE_DB_PATH": os.environ.get("PIXEL_FORGE_DB_PATH"),
            "PIXEL_FORGE_AGENT_DECK_SURFACE_HOST": os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_HOST"),
            "PIXEL_FORGE_AGENT_DECK_SURFACE_PORT": os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_PORT"),
        }
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ["PIXEL_FORGE_RUNTIME_DIR"] = str(Path(self.tempdir.name) / "runtime")
        os.environ["PIXEL_FORGE_AGENT_DECK_HOME"] = str(Path(self.tempdir.name) / "agent-deck")
        os.environ["PIXEL_FORGE_DB_PATH"] = str(Path(self.tempdir.name) / "pixel-forge.db")
        os.environ["PIXEL_FORGE_AGENT_DECK_SURFACE_HOST"] = "127.0.0.1"
        os.environ["PIXEL_FORGE_AGENT_DECK_SURFACE_PORT"] = "8842"

    def tearDown(self) -> None:
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_agent_deck_surface_command_uses_standalone_web_mode(self) -> None:
        command = agent_deck_surface.agent_deck_surface_command()

        self.assertEqual(command[-2], "web-standalone")
        self.assertEqual(command[-1], "-listen=127.0.0.1:8842")

    def test_read_agent_deck_surface_status_reports_pixel_forge_paths(self) -> None:
        with patch.object(agent_deck_surface, "_is_surface_ready", return_value=False):
            status = agent_deck_surface.read_agent_deck_surface_status()

        self.assertFalse(status["running"])
        self.assertFalse(status["ready"])
        self.assertEqual(status["url"], "http://127.0.0.1:8842")
        self.assertEqual(status["homeDir"], str(Path(self.tempdir.name) / "agent-deck"))
        self.assertEqual(status["dbPath"], str(Path(self.tempdir.name) / "pixel-forge.db"))

    def test_ensure_agent_deck_surface_started_launches_standalone_server(self) -> None:
        process = Mock()
        process.pid = 43210

        with (
            patch.object(agent_deck_surface, "_is_surface_ready", side_effect=[False, True, True]),
            patch.object(
                agent_deck_surface,
                "_is_pid_running",
                side_effect=lambda pid: pid == process.pid,
            ),
            patch.object(agent_deck_surface.subprocess, "Popen", return_value=process) as popen,
        ):
            status = agent_deck_surface.ensure_agent_deck_surface_started(timeout_seconds=1.0)

        launched_command = popen.call_args.args[0]
        launched_env = popen.call_args.kwargs["env"]
        self.assertEqual(launched_command[-2], "web-standalone")
        self.assertEqual(launched_command[-1], "-listen=127.0.0.1:8842")
        self.assertEqual(launched_env["PIXEL_FORGE_DB_PATH"], str(Path(self.tempdir.name) / "pixel-forge.db"))
        self.assertTrue(status["ready"])
        self.assertEqual(status["pid"], 43210)
