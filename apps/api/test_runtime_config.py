import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import runtime_config


class RuntimeConfigTest(unittest.TestCase):
    def test_agent_deck_auto_mode_is_disabled_by_default_on_windows(self) -> None:
        with (
            patch.dict(os.environ, {"PIXEL_FORGE_WITH_AGENT_DECK": ""}, clear=False),
            patch.object(runtime_config.os, "name", "nt"),
        ):
            self.assertEqual(runtime_config.agent_deck_provider_mode(), "0")

    def test_agent_deck_can_be_explicitly_enabled_on_windows(self) -> None:
        with (
            patch.dict(os.environ, {"PIXEL_FORGE_WITH_AGENT_DECK": "1"}, clear=False),
            patch.object(runtime_config.os, "name", "nt"),
        ):
            self.assertEqual(runtime_config.agent_deck_provider_mode(), "1")


if __name__ == "__main__":
    unittest.main()
