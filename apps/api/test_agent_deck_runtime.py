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
            "AGENTDECK_DIR": os.environ.get("AGENTDECK_DIR"),
            "AGENT_DECK_DIR": os.environ.get("AGENT_DECK_DIR"),
            "PIXEL_FORGE_AGENT_DECK_PROFILE": os.environ.get("PIXEL_FORGE_AGENT_DECK_PROFILE"),
            "AGENTDECK_PROFILE": os.environ.get("AGENTDECK_PROFILE"),
            "TMUX": os.environ.get("TMUX"),
            "TMUX_PANE": os.environ.get("TMUX_PANE"),
        }
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_HOME", None)
        os.environ.pop("AGENTDECK_DIR", None)
        os.environ.pop("AGENT_DECK_DIR", None)
        os.environ.pop("PIXEL_FORGE_AGENT_DECK_PROFILE", None)
        os.environ.pop("AGENTDECK_PROFILE", None)
        os.environ["TMUX"] = "/tmp/tmux-1000/default,1,0"
        os.environ["TMUX_PANE"] = "%1"

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
