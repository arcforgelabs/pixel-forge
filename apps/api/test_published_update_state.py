import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import published_update_state


class PublishedUpdateStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir

    def test_normalizes_direct_provider_session_without_agent_deck_fields(self) -> None:
        normalized = published_update_state.normalize_pending_preview_update(
            {
                "project_path": "/tmp/project",
                "workspace_path": "/tmp/project/.agents/codex-thread",
                "provider_id": "codex-cli",
                "provider_session_id": "codex-thread-a",
            }
        )

        self.assertEqual(normalized["providerId"], "codex-cli")
        self.assertEqual(normalized["providerSessionId"], "codex-thread-a")
        self.assertIsNone(normalized["agentDeckSessionId"])

    def test_legacy_agent_deck_session_backfills_provider_session(self) -> None:
        normalized = published_update_state.normalize_pending_preview_update(
            {
                "projectPath": "/tmp/project",
                "workspacePath": "/tmp/project/.agents/deck-thread",
                "agentDeckSessionId": "deck-thread-a",
            }
        )

        self.assertEqual(normalized["providerId"], "agent-deck")
        self.assertEqual(normalized["providerSessionId"], "deck-thread-a")
        self.assertEqual(normalized["agentDeckSessionId"], "deck-thread-a")

    def test_reads_latest_update_by_provider_session_id(self) -> None:
        path = published_update_state.pending_preview_updates_path()
        path.write_text(
            json.dumps(
                [
                    {
                        "projectPath": "/tmp/project",
                        "workspacePath": "/tmp/project/.agents/codex-thread",
                        "providerId": "codex-cli",
                        "providerSessionId": "codex-thread-a",
                        "agentDeckSessionId": None,
                    }
                ]
            ),
            encoding="utf-8",
        )

        update = published_update_state.read_latest_pending_preview_update(
            "/tmp/project",
            provider_session_id="codex-thread-a",
        )

        assert update is not None
        self.assertEqual(update["providerId"], "codex-cli")
        self.assertEqual(update["providerSessionId"], "codex-thread-a")
        self.assertIsNone(update["agentDeckSessionId"])


if __name__ == "__main__":
    unittest.main()
