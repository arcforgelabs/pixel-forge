import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_deck_bridge import AgentDeckBridgeError, AgentDeckSessionActivity
import project_store
import workstation_events


class WorkstationEventsTest(unittest.IsolatedAsyncioTestCase):
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
            workspace_path=str(self.workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="pixel-forge-thread-a",
            agent_deck_tool="codex",
        )

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir

    async def test_sync_chat_activity_event_appends_once_per_distinct_snapshot(self) -> None:
        activity = AgentDeckSessionActivity(
            session_id="deck-a",
            session_title="pixel-forge-thread-a",
            workspace_path=str(self.workspace_path),
            tool="codex",
            status="running",
            output="Working on the change...",
        )

        with patch.object(
            workstation_events,
            "get_agent_deck_session_activity",
            AsyncMock(return_value=activity),
        ):
            first = await workstation_events.sync_chat_activity_event(
                str(self.project_path),
                "thread-a",
            )
            second = await workstation_events.sync_chat_activity_event(
                str(self.project_path),
                "thread-a",
            )

        self.assertIsNotNone(first)
        self.assertIsNone(second)

        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].event_type, "activity")
        self.assertEqual(events[0].payload["binding_state"], "attached")
        self.assertEqual(events[0].payload["output"], "Working on the change...")

    async def test_missing_agent_deck_session_detaches_binding_and_records_detached_snapshot(self) -> None:
        with patch.object(
            workstation_events,
            "get_agent_deck_session_activity",
            AsyncMock(side_effect=AgentDeckBridgeError("session 'deck-a' not found")),
        ):
            record = await workstation_events.sync_chat_activity_event(
                str(self.project_path),
                "thread-a",
            )

        assert record is not None
        self.assertEqual(record.payload["binding_state"], "detached")
        self.assertEqual(record.payload["agent_deck_session_id"], None)
        session = project_store.get_project_session(str(self.project_path), "thread-a")
        assert session is not None
        self.assertIsNone(session.agent_deck_session_id)

    async def test_append_workstation_event_marks_chat_as_typed_turn_history(self) -> None:
        record = workstation_events.append_workstation_event(
            str(self.project_path),
            "thread-a",
            agent_deck_session_id="deck-a",
            event_type="turn_started",
            payload={
                "request_id": "request-1",
                "agent_deck_session_id": "deck-a",
                "agent_deck_session_title": "pixel-forge-thread-a",
                "agent_deck_tool": "codex",
                "workspace_path": str(self.workspace_path),
            },
        )

        self.assertEqual(record.event_type, "turn_started")
        self.assertTrue(
            workstation_events.chat_has_typed_turn_events(
                str(self.project_path),
                "thread-a",
            )
        )

    async def test_session_status_event_counts_as_primary_workstation_history(self) -> None:
        workstation_events.append_workstation_event(
            str(self.project_path),
            "thread-a",
            agent_deck_session_id="deck-a",
            event_type="session_status",
            payload={
                "agent_deck_session_id": "deck-a",
                "agent_deck_session_title": "pixel-forge-thread-a",
                "agent_deck_tool": "codex",
                "agent_deck_session_status": "running",
                "workspace_path": str(self.workspace_path),
                "binding_state": "attached",
                "message": "Codex is working in Agent Deck...",
            },
        )

        self.assertTrue(
            workstation_events.chat_has_primary_workstation_events(
                str(self.project_path),
                "thread-a",
            )
        )


if __name__ == "__main__":
    unittest.main()
