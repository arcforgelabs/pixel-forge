import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_editor_threads


class LiveEditorThreadStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        self.original_db_path = os.environ.get("PIXEL_FORGE_DB_PATH")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ["PIXEL_FORGE_DB_PATH"] = str(Path(self.tempdir.name) / "pixel-forge.db")
        live_editor_threads._DB_INITIALIZED = False

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        if self.original_db_path is None:
            os.environ.pop("PIXEL_FORGE_DB_PATH", None)
        else:
            os.environ["PIXEL_FORGE_DB_PATH"] = self.original_db_path
        live_editor_threads._DB_INITIALIZED = False

    def test_detach_missing_agent_deck_binding_preserves_thread_workspace(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_path = project_path / ".agents" / "thread-a"
        workspace_path.mkdir(parents=True)

        thread = live_editor_threads.get_or_create_live_editor_thread(
            str(project_path),
            thread_id="thread-a",
        )
        updated = live_editor_threads.update_live_editor_thread(
            thread.thread_id,
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="pixel-forge-thread-a",
            acpx_agent="codex",
            acpx_session_name="session-a",
            acpx_record_id="record-a",
            acp_session_id="acp-a",
            claude_session_id="claude-a",
            last_request_id="request-a",
        )

        self.assertEqual(updated.workspace_path, str(workspace_path.resolve()))
        self.assertEqual(updated.agent_deck_session_id, "deck-a")
        self.assertEqual(updated.provider_id, "agent-deck")
        self.assertEqual(updated.provider_session_id, "deck-a")

        refreshed = live_editor_threads.detach_missing_agent_deck_thread_bindings(
            str(project_path),
            set(),
        )

        self.assertEqual(len(refreshed), 1)
        self.assertEqual(refreshed[0].workspace_path, str(workspace_path.resolve()))
        self.assertIsNone(refreshed[0].agent_deck_session_id)
        self.assertIsNone(refreshed[0].provider_session_id)
        self.assertIsNone(refreshed[0].agent_deck_session_title)
        self.assertIsNone(refreshed[0].acpx_agent)
        self.assertIsNone(refreshed[0].acpx_session_name)
        self.assertIsNone(refreshed[0].acpx_record_id)
        self.assertIsNone(refreshed[0].acp_session_id)
        self.assertIsNone(refreshed[0].claude_session_id)
        self.assertIsNone(refreshed[0].last_request_id)

    def test_update_live_editor_thread_persists_provider_neutral_binding(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)

        thread = live_editor_threads.get_or_create_live_editor_thread(
            str(project_path),
            thread_id="thread-codex",
        )
        updated = live_editor_threads.update_live_editor_thread(
            thread.thread_id,
            provider_id="codex-cli",
            provider_session_id="codex-thread-a",
            provider_session_title="Codex thread",
            provider_agent_id="codex",
        )

        self.assertEqual(updated.provider_id, "codex-cli")
        self.assertEqual(updated.provider_session_id, "codex-thread-a")
        self.assertEqual(updated.provider_session_title, "Codex thread")
        self.assertEqual(updated.provider_agent_id, "codex")
        self.assertIsNone(updated.agent_deck_session_id)

    def test_update_live_editor_thread_can_switch_backend_to_direct_provider(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)

        thread = live_editor_threads.get_or_create_live_editor_thread(
            str(project_path),
            thread_id="thread-direct",
        )
        updated = live_editor_threads.update_live_editor_thread(
            thread.thread_id,
            backend="codex-cli",
            provider_id="codex-cli",
            provider_session_id="codex-thread-a",
            provider_session_title="Codex thread",
            provider_agent_id="codex",
            agent_deck_session_id=None,
            agent_deck_session_title=None,
        )

        self.assertEqual(updated.backend, "codex-cli")
        self.assertEqual(updated.provider_id, "codex-cli")
        self.assertEqual(updated.provider_session_id, "codex-thread-a")
        self.assertIsNone(updated.agent_deck_session_id)


if __name__ == "__main__":
    unittest.main()
