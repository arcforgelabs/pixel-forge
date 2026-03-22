from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pixel_forge_cli


class AgentDeckTuiTerminalCommandTest(unittest.TestCase):
    def test_prefers_ghostty_when_available(self) -> None:
        with patch("pixel_forge_cli.shutil.which") as mock_which:
            mock_which.side_effect = lambda binary: "/usr/bin/ghostty" if binary == "ghostty" else None

            command = pixel_forge_cli._agent_deck_tui_terminal_command(
                ["/tmp/agent-deck-alpha"],
                "Agent Deck (alpha)",
                "pixel-forge-agent-deck-alpha",
            )

        self.assertEqual(
            command,
            [
                "/usr/bin/ghostty",
                "--class=pixel-forge-agent-deck-alpha",
                "--title=Agent Deck (alpha)",
                "-e",
                "/tmp/agent-deck-alpha",
            ],
        )

    def test_falls_back_to_gnome_terminal(self) -> None:
        with patch("pixel_forge_cli.shutil.which") as mock_which:
            mock_which.side_effect = (
                lambda binary: "/usr/bin/gnome-terminal" if binary == "gnome-terminal" else None
            )

            command = pixel_forge_cli._agent_deck_tui_terminal_command(
                ["/tmp/agent-deck-alpha"],
                "Agent Deck (alpha)",
                "pixel-forge-agent-deck-alpha",
            )

        self.assertEqual(
            command,
            [
                "/usr/bin/gnome-terminal",
                "--class=pixel-forge-agent-deck-alpha",
                "--title=Agent Deck (alpha)",
                "--",
                "/tmp/agent-deck-alpha",
            ],
        )

    def test_external_terminal_env_strips_nested_session_context(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "TMUX": "/tmp/tmux-1000/default,123,0",
                "TMUX_PANE": "%7",
                "AGENTDECK_INSTANCE_ID": "inst-123",
                "AGENTDECK_TITLE": "alpha-task",
                "AGENTDECK_TOOL": "codex",
                "CODEX_SESSION_ID": "codex-123",
                "PIXEL_FORGE_AGENT_DECK_HOME": "/tmp/alpha-home",
                "PIXEL_FORGE_DB_PATH": "/tmp/alpha.db",
            },
            clear=False,
        ):
            env = pixel_forge_cli._agent_deck_tui_exec_env(for_external_terminal=True)

        self.assertNotIn("TMUX", env)
        self.assertNotIn("TMUX_PANE", env)
        self.assertNotIn("AGENTDECK_INSTANCE_ID", env)
        self.assertNotIn("AGENTDECK_TITLE", env)
        self.assertNotIn("AGENTDECK_TOOL", env)
        self.assertNotIn("CODEX_SESSION_ID", env)
        self.assertEqual(env["PIXEL_FORGE_AGENT_DECK_HOME"], "/tmp/alpha-home")
        self.assertEqual(env["AGENTDECK_DIR"], "/tmp/alpha-home")
        self.assertEqual(env["AGENT_DECK_DIR"], "/tmp/alpha-home")

    def test_preview_context_command_reads_stored_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_dir = Path(tmpdir) / ".pixel-forge" / "requests" / "request-1"
            request_dir.mkdir(parents=True, exist_ok=True)
            (request_dir / "live-preview-context.json").write_text(
                json.dumps(
                    {
                        "mode": "browser",
                        "browser_tab_id": "browser-tab-1",
                        "live_attach_available": True,
                    }
                ),
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                exit_code = pixel_forge_cli._command_preview_context(
                    argparse.Namespace(
                        project=tmpdir,
                        request="request-1",
                        stored_only=True,
                        compact=False,
                    )
                )

        self.assertEqual(exit_code, 0)
        self.assertIn('"browser_tab_id": "browser-tab-1"', stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
