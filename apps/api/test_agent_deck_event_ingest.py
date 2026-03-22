import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import agent_deck_event_ingest
import project_store
import workstation_events


class AgentDeckNativeEventIngestorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        project_store._DB_INITIALIZED = False
        workstation_events._DB_INITIALIZED = False

        self.project_path = Path(self.tempdir.name) / "project"
        self.workspace_path = self.project_path / ".agents" / "thread-a"
        self.workspace_path.mkdir(parents=True)
        project_store.upsert_project(str(self.project_path))
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-a",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(self.workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="former multi-chat",
            agent_deck_tool="codex",
        )
        self.events_dir = Path(self.tempdir.name) / "agent-deck" / "events"
        self.events_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir

    def _write_status_event(
        self,
        *,
        status: str,
        prev_status: str,
    ) -> None:
        (self.events_dir / "deck-a.json").write_text(
            json.dumps(
                {
                    "instance_id": "deck-a",
                    "title": "former multi-chat",
                    "tool": "codex",
                    "status": status,
                    "prev_status": prev_status,
                    "ts": 1711111111,
                }
            ),
            encoding="utf-8",
        )

    async def test_poll_once_records_primary_session_events_for_bound_chat(self) -> None:
        self._write_status_event(status="idle", prev_status="running")
        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()

        with patch.object(
            agent_deck_event_ingest,
            "get_last_output",
            AsyncMock(return_value="Continuing existing Agent Deck work..."),
        ):
            await ingestor.poll_once()

        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual([event.event_type for event in events], ["session_status", "session_output"])
        self.assertTrue(
            workstation_events.chat_has_primary_workstation_events(
                str(self.project_path),
                "thread-a",
            )
        )
        self.assertEqual(events[0].payload["agent_deck_session_status"], "idle")
        self.assertEqual(events[1].payload["output"], "Continuing existing Agent Deck work...")

    async def test_poll_once_dedupes_identical_rewritten_status_payloads(self) -> None:
        self._write_status_event(status="idle", prev_status="running")
        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()

        with patch.object(
            agent_deck_event_ingest,
            "get_last_output",
            AsyncMock(return_value="Continuing existing Agent Deck work..."),
        ):
            await ingestor.poll_once()

        self._write_status_event(status="idle", prev_status="running")
        ingestor._file_fingerprints.clear()
        with patch.object(
            agent_deck_event_ingest,
            "get_last_output",
            AsyncMock(return_value="Continuing existing Agent Deck work..."),
        ):
            await ingestor.poll_once()

        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual([event.event_type for event in events], ["session_status", "session_output"])


if __name__ == "__main__":
    unittest.main()
