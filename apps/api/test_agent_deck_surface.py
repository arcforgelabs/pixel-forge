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
            "PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR": os.environ.get("PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR"),
            "PIXEL_FORGE_DB_PATH": os.environ.get("PIXEL_FORGE_DB_PATH"),
            "PIXEL_FORGE_AGENT_DECK_SURFACE_HOST": os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_HOST"),
            "PIXEL_FORGE_AGENT_DECK_SURFACE_PORT": os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_PORT"),
            "PIXEL_FORGE_AGENT_DECK_SURFACE_URL": os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_URL"),
            "PIXEL_FORGE_EXPOSE_LOCAL_STATUS_PATHS": os.environ.get("PIXEL_FORGE_EXPOSE_LOCAL_STATUS_PATHS"),
            "AGENTDECK_DIR": os.environ.get("AGENTDECK_DIR"),
            "AGENT_DECK_DIR": os.environ.get("AGENT_DECK_DIR"),
        }
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ["PIXEL_FORGE_RUNTIME_DIR"] = str(Path(self.tempdir.name) / "runtime")
        os.environ["PIXEL_FORGE_AGENT_DECK_HOME"] = str(Path(self.tempdir.name) / "agent-deck")
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR", None)
        os.environ["PIXEL_FORGE_DB_PATH"] = str(Path(self.tempdir.name) / "pixel-forge.db")
        os.environ["PIXEL_FORGE_AGENT_DECK_SURFACE_HOST"] = "127.0.0.1"
        os.environ["PIXEL_FORGE_AGENT_DECK_SURFACE_PORT"] = "8842"
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_SURFACE_URL", None)
        os.environ.pop("PIXEL_FORGE_EXPOSE_LOCAL_STATUS_PATHS", None)
        os.environ.pop("AGENTDECK_DIR", None)
        os.environ.pop("AGENT_DECK_DIR", None)

    def tearDown(self) -> None:
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_agent_deck_surface_command_uses_standalone_web_mode(self) -> None:
        command = agent_deck_surface.agent_deck_surface_command()

        self.assertEqual(command[-3], "web")
        self.assertEqual(command[-2], "--listen")
        self.assertEqual(command[-1], "127.0.0.1:8842")

    def test_read_agent_deck_surface_status_reports_pixel_forge_paths(self) -> None:
        os.environ["PIXEL_FORGE_EXPOSE_LOCAL_STATUS_PATHS"] = "1"

        with patch.object(agent_deck_surface, "_is_surface_ready", return_value=False):
            status = agent_deck_surface.read_agent_deck_surface_status()

        self.assertFalse(status["running"])
        self.assertFalse(status["ready"])
        self.assertEqual(status["url"], "http://127.0.0.1:8842")
        self.assertEqual(status["localPaths"]["homeDir"], str(Path(self.tempdir.name) / "agent-deck"))
        self.assertEqual(status["localPaths"]["dbPath"], str(Path(self.tempdir.name) / "pixel-forge.db"))
        self.assertEqual(
            status["governance"]["tmuxTmpdir"],
            str(Path(self.tempdir.name) / "agent-deck" / "tmux"),
        )

    def test_read_agent_deck_surface_status_hides_local_paths_by_default(self) -> None:
        with patch.object(agent_deck_surface, "_is_surface_ready", return_value=False):
            status = agent_deck_surface.read_agent_deck_surface_status()

        self.assertFalse(status["running"])
        self.assertEqual(status["url"], "http://127.0.0.1:8842")
        self.assertNotIn("homeDir", status)
        self.assertNotIn("dbPath", status)
        self.assertNotIn("localPaths", status)
        self.assertNotIn("governance", status)

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
            patch.object(agent_deck_surface.shutil, "which", return_value="/usr/bin/script"),
            patch.object(agent_deck_surface.subprocess, "Popen", return_value=process) as popen,
        ):
            status = agent_deck_surface.ensure_agent_deck_surface_started(timeout_seconds=1.0)

        launched_command = popen.call_args.args[0]
        launched_env = popen.call_args.kwargs["env"]
        self.assertEqual(launched_command[:5], ["/usr/bin/script", "-q", "-a", "-f", "-c"])
        self.assertIn(" web ", launched_command[5])
        self.assertIn("--listen 127.0.0.1:8842", launched_command[5])
        self.assertEqual(launched_command[-1], str(agent_deck_surface.agent_deck_surface_log_file()))
        self.assertEqual(popen.call_args.kwargs["stdout"], agent_deck_surface.subprocess.DEVNULL)
        self.assertEqual(popen.call_args.kwargs["stderr"], agent_deck_surface.subprocess.DEVNULL)
        self.assertEqual(launched_env["PIXEL_FORGE_DB_PATH"], str(Path(self.tempdir.name) / "pixel-forge.db"))
        self.assertEqual(launched_env["TMUX_TMPDIR"], str(Path(self.tempdir.name) / "agent-deck" / "tmux"))
        self.assertTrue(status["ready"])
        self.assertEqual(status["pid"], 43210)

    def test_surface_launch_command_falls_back_without_script(self) -> None:
        command = ["agent-deck", "web", "--listen", "127.0.0.1:8842"]

        with patch.object(agent_deck_surface.shutil, "which", return_value=None):
            launch_command = agent_deck_surface._surface_launch_command(
                command,
                agent_deck_surface.agent_deck_surface_log_file(),
            )

        self.assertEqual(launch_command, command)

    def test_windows_launch_uses_detached_process_group_flags(self) -> None:
        with (
            patch.object(agent_deck_surface.os, "name", "nt"),
            patch.object(
                agent_deck_surface.subprocess,
                "CREATE_NEW_PROCESS_GROUP",
                0x200,
                create=True,
            ),
            patch.object(
                agent_deck_surface.subprocess,
                "DETACHED_PROCESS",
                0x8,
                create=True,
            ),
        ):
            kwargs = agent_deck_surface._popen_process_kwargs()

        self.assertEqual(kwargs, {"creationflags": 0x208})
