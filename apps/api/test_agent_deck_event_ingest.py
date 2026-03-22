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
        self.original_claude_config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ["CLAUDE_CONFIG_DIR"] = str(Path(self.tempdir.name) / "claude-config")
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
        self.hooks_dir = Path(self.tempdir.name) / "agent-deck" / "hooks"
        self.hooks_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        if self.original_claude_config_dir is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self.original_claude_config_dir

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

    def _write_hook_event(
        self,
        *,
        instance_id: str,
        session_id: str,
        status: str,
        event: str,
        timestamp: int = 1711111111,
    ) -> None:
        (self.hooks_dir / f"{instance_id}.json").write_text(
            json.dumps(
                {
                    "status": status,
                    "session_id": session_id,
                    "event": event,
                    "ts": timestamp,
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
        ingestor._event_file_fingerprints.clear()
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

    async def test_poll_once_emits_claude_turn_events_from_hooks_and_jsonl(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-claude"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-claude",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-claude",
            agent_deck_session_title="manual claude",
            agent_deck_tool="claude",
        )

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        self._write_hook_event(
            instance_id="deck-claude",
            session_id="claude-session-1",
            status="running",
            event="UserPromptSubmit",
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-claude",
        )
        self.assertEqual([event.event_type for event in events], ["turn_started"])
        request_id = events[0].payload["request_id"]

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            "claude-session-1",
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text(
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello from Claude"}]}}\n',
            encoding="utf-8",
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-claude",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_started", "turn_chunk"],
        )
        self.assertEqual(events[1].payload["content"], "Hello from Claude")
        self.assertEqual(events[1].payload["request_id"], request_id)

        self._write_hook_event(
            instance_id="deck-claude",
            session_id="claude-session-1",
            status="waiting",
            event="Stop",
            timestamp=1711111112,
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-claude",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_started", "turn_chunk", "turn_completed"],
        )
        self.assertEqual(events[2].payload["request_id"], request_id)
        self.assertEqual(events[2].payload["assistant_output"], "Hello from Claude")


if __name__ == "__main__":
    unittest.main()
