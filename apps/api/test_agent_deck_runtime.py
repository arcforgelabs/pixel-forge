import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_deck_runtime


class AgentDeckRuntimeIsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_env = {
            "PIXEL_FORGE_SHARED_STATE_DIR": os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR"),
            "PIXEL_FORGE_AGENT_DECK_HOME": os.environ.get("PIXEL_FORGE_AGENT_DECK_HOME"),
            "PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR": os.environ.get("PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR"),
            "AGENTDECK_DIR": os.environ.get("AGENTDECK_DIR"),
            "AGENT_DECK_DIR": os.environ.get("AGENT_DECK_DIR"),
            "PIXEL_FORGE_AGENT_DECK_PROFILE": os.environ.get("PIXEL_FORGE_AGENT_DECK_PROFILE"),
            "PIXEL_FORGE_AGENT_DECK_CMD": os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD"),
            "PIXEL_FORGE_WITH_AGENT_DECK": os.environ.get("PIXEL_FORGE_WITH_AGENT_DECK"),
            "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": os.environ.get("PIXEL_FORGE_RUNTIME_SOURCE_ROOT"),
            "AGENTDECK_PROFILE": os.environ.get("AGENTDECK_PROFILE"),
            "TMUX": os.environ.get("TMUX"),
            "TMUX_PANE": os.environ.get("TMUX_PANE"),
            "TMUX_TMPDIR": os.environ.get("TMUX_TMPDIR"),
            "PATH": os.environ.get("PATH"),
        }
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_HOME", None)
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR", None)
        os.environ.pop("AGENTDECK_DIR", None)
        os.environ.pop("AGENT_DECK_DIR", None)
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_PROFILE", None)
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_CMD", None)
        os.environ.pop("PIXEL_FORGE_WITH_AGENT_DECK", None)
        os.environ.pop("PIXEL_FORGE_RUNTIME_SOURCE_ROOT", None)
        os.environ.pop("AGENTDECK_PROFILE", None)
        os.environ["TMUX"] = "/tmp/tmux-1000/default,1,0"
        os.environ["TMUX_PANE"] = "%1"
        os.environ.pop("TMUX_TMPDIR", None)

    def tearDown(self) -> None:
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_agent_deck_env_defaults_to_shared_pixel_forge_home(self) -> None:
        env = agent_deck_runtime.agent_deck_env()
        expected = str(Path(self.tempdir.name) / "agent-deck")

        self.assertEqual(env["PIXEL_FORGE_AGENT_DECK_HOME"], expected)
        self.assertEqual(env["AGENTDECK_DIR"], expected)
        self.assertEqual(env["AGENT_DECK_DIR"], expected)
        self.assertEqual(env["PIXEL_FORGE_AGENT_DECK_PROFILE"], "pixel-forge")
        self.assertEqual(env["AGENTDECK_PROFILE"], "pixel-forge")
        self.assertEqual(env["TMUX_TMPDIR"], str(Path(expected) / "tmux"))
        self.assertEqual(env["PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR"], str(Path(expected) / "tmux"))
        self.assertNotIn("TMUX", env)
        self.assertNotIn("TMUX_PANE", env)

    def test_agent_deck_command_prefers_standard_standalone_install(self) -> None:
        fake_bin = Path(self.tempdir.name) / "agent-deck-standalone"
        fake_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        fake_bin.chmod(0o755)
        os.environ["PATH"] = self.tempdir.name
        os.environ["PIXEL_FORGE_RUNTIME_SOURCE_ROOT"] = str(Path(self.tempdir.name) / "repo")

        self.assertEqual(agent_deck_runtime.agent_deck_command(), [str(fake_bin)])

    def test_auto_mode_ignores_stale_explicit_agent_deck_command(self) -> None:
        fake_bin = Path(self.tempdir.name) / "agent-deck-standalone"
        fake_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        fake_bin.chmod(0o755)
        os.environ["PATH"] = self.tempdir.name
        os.environ["PIXEL_FORGE_WITH_AGENT_DECK"] = "auto"
        os.environ["PIXEL_FORGE_AGENT_DECK_CMD"] = str(Path(self.tempdir.name) / "missing-agent-deck")
        os.environ["PIXEL_FORGE_RUNTIME_SOURCE_ROOT"] = str(Path(self.tempdir.name) / "repo")

        self.assertEqual(agent_deck_runtime.agent_deck_command(), [str(fake_bin)])

    def test_agent_deck_availability_reports_disabled_provider(self) -> None:
        os.environ["PIXEL_FORGE_WITH_AGENT_DECK"] = "0"
        available, reason = agent_deck_runtime.agent_deck_available()

        self.assertFalse(available)
        self.assertIn("disabled", str(reason).lower())

    def test_agent_deck_command_returns_empty_when_provider_disabled(self) -> None:
        fake_bin = Path(self.tempdir.name) / "agent-deck-standalone"
        fake_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        fake_bin.chmod(0o755)
        os.environ["PATH"] = self.tempdir.name
        os.environ["PIXEL_FORGE_WITH_AGENT_DECK"] = "0"
        os.environ["PIXEL_FORGE_RUNTIME_SOURCE_ROOT"] = str(Path(self.tempdir.name) / "repo")

        self.assertEqual(agent_deck_runtime.agent_deck_command(), [])
