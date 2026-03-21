from __future__ import annotations

import sys
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


if __name__ == "__main__":
    unittest.main()
