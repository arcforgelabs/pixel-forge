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
        self.original_db_path = os.environ.get("PIXEL_FORGE_DB_PATH")
        self.original_agent_deck_home = os.environ.get("PIXEL_FORGE_AGENT_DECK_HOME")
        self.original_claude_config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
        self.original_codex_home = os.environ.get("CODEX_HOME")
        self.original_agentdeck_dir = os.environ.get("AGENTDECK_DIR")
        self.original_agent_deck_dir = os.environ.get("AGENT_DECK_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ["PIXEL_FORGE_DB_PATH"] = str(Path(self.tempdir.name) / "pixel-forge.db")
        os.environ["PIXEL_FORGE_AGENT_DECK_HOME"] = str(Path(self.tempdir.name) / "agent-deck")
        os.environ["CLAUDE_CONFIG_DIR"] = str(Path(self.tempdir.name) / "claude-config")
        os.environ["CODEX_HOME"] = str(Path(self.tempdir.name) / "codex-home")
        os.environ["AGENTDECK_DIR"] = str(Path(self.tempdir.name) / "agent-deck")
        os.environ["AGENT_DECK_DIR"] = str(Path(self.tempdir.name) / "agent-deck")
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
        self.hook_events_dir = Path(self.tempdir.name) / "agent-deck" / "hook-events"
        self.hook_events_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        if self.original_db_path is None:
            os.environ.pop("PIXEL_FORGE_DB_PATH", None)
        else:
            os.environ["PIXEL_FORGE_DB_PATH"] = self.original_db_path
        if self.original_agent_deck_home is None:
            os.environ.pop("PIXEL_FORGE_AGENT_DECK_HOME", None)
        else:
            os.environ["PIXEL_FORGE_AGENT_DECK_HOME"] = self.original_agent_deck_home
        if self.original_claude_config_dir is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self.original_claude_config_dir
        if self.original_codex_home is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = self.original_codex_home
        if self.original_agentdeck_dir is None:
            os.environ.pop("AGENTDECK_DIR", None)
        else:
            os.environ["AGENTDECK_DIR"] = self.original_agentdeck_dir
        if self.original_agent_deck_dir is None:
            os.environ.pop("AGENT_DECK_DIR", None)
        else:
            os.environ["AGENT_DECK_DIR"] = self.original_agent_deck_dir

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

    def _write_hook_queue_event(
        self,
        *,
        name: str,
        instance_id: str,
        session_id: str,
        status: str,
        event: str,
        timestamp: int,
    ) -> None:
        (self.hook_events_dir / name).write_text(
            json.dumps(
                {
                    "instance_id": instance_id,
                    "status": status,
                    "session_id": session_id,
                    "event": event,
                    "ts": timestamp,
                }
            ),
            encoding="utf-8",
        )

    def _write_codex_session_file(
        self,
        *,
        session_id: str,
        lines: list[str],
    ) -> Path:
        sessions_dir = (
            Path(os.environ["CODEX_HOME"])
            / "sessions"
            / "2026"
            / "03"
            / "22"
        )
        sessions_dir.mkdir(parents=True, exist_ok=True)
        path = sessions_dir / f"rollout-2026-03-22T00-00-00-{session_id}.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

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

    async def test_poll_once_consumes_queued_hook_events_for_fast_claude_turns(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-fast-claude"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-fast-claude",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-fast-claude",
            agent_deck_session_title="fast claude",
            agent_deck_tool="claude",
        )

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            "claude-session-fast",
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text(
            "\n".join(
                [
                    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Checking from Agent Deck"}]}}',
                    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fast Claude reply"}]}}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        self._write_hook_queue_event(
            name="0001-user-prompt.json",
            instance_id="deck-fast-claude",
            session_id="claude-session-fast",
            status="running",
            event="UserPromptSubmit",
            timestamp=1711111111,
        )
        self._write_hook_queue_event(
            name="0002-stop.json",
            instance_id="deck-fast-claude",
            session_id="claude-session-fast",
            status="waiting",
            event="Stop",
            timestamp=1711111112,
        )
        self._write_hook_event(
            instance_id="deck-fast-claude",
            session_id="claude-session-fast",
            status="waiting",
            event="Stop",
            timestamp=1711111112,
        )

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await ingestor.poll_once()

        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-fast-claude",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_input", "turn_started", "turn_chunk", "turn_completed"],
        )
        request_id = events[0].payload["request_id"]
        self.assertEqual(events[0].payload["turn_input"]["prompt_text"], "Checking from Agent Deck")
        self.assertEqual(events[1].payload["request_id"], request_id)
        self.assertEqual(events[2].payload["request_id"], request_id)
        self.assertEqual(events[2].payload["content"], "Fast Claude reply")
        self.assertEqual(events[3].payload["request_id"], request_id)
        self.assertEqual(events[3].payload["assistant_output"], "Fast Claude reply")
        self.assertFalse(any(self.hook_events_dir.glob("*.json")))

    async def test_stop_snapshot_backfill_is_idempotent_across_ingestor_restart(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-stop-idempotent"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-stop-idempotent",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-stop-idempotent",
            agent_deck_session_title="stop idempotent",
            agent_deck_tool="claude",
        )

        session_id = "claude-session-stop-idempotent"
        (self.hooks_dir / "deck-stop-idempotent.sid").write_text(
            session_id,
            encoding="utf-8",
        )
        self._write_hook_event(
            instance_id="deck-stop-idempotent",
            session_id=session_id,
            status="waiting",
            event="Stop",
            timestamp=1711112222,
        )

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            session_id,
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text(
            "\n".join(
                [
                    '{"type":"user","entrypoint":"cli","message":{"role":"user","content":"checking if this works"}}',
                    '{"type":"assistant","entrypoint":"cli","message":{"role":"assistant","content":[{"type":"text","text":"It works. How can I help?"}]}}',
                    '{"type":"system","entrypoint":"cli","subtype":"stop_hook_summary"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await ingestor.poll_once()

        restarted_ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await restarted_ingestor.poll_once()

        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-stop-idempotent",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_input", "turn_started", "turn_chunk", "turn_completed"],
        )
        self.assertEqual(
            events[0].payload["turn_input"]["prompt_text"],
            "checking if this works",
        )
        self.assertEqual(events[2].payload["content"], "It works. How can I help?")
        self.assertEqual(events[3].payload["assistant_output"], "It works. How can I help?")

    async def test_poll_once_emits_transcript_only_cli_turns_without_hooks(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-transcript-claude"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-transcript-claude",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-transcript-claude",
            agent_deck_session_title="transcript claude",
            agent_deck_tool="claude",
        )

        session_id = "claude-session-transcript"
        (self.hooks_dir / "deck-transcript-claude.sid").write_text(
            session_id,
            encoding="utf-8",
        )

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            session_id,
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text("", encoding="utf-8")

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await ingestor.poll_once()

        jsonl_path.write_text(
            "\n".join(
                [
                    '{"type":"user","entrypoint":"cli","message":{"role":"user","content":[{"type":"text","text":"<channel source=\\"plugin:pixel-forge-channel:pixel-forge-channel\\" request_id=\\"req-1\\">\\nPixel Forge live smoke probe from installed alpha lane\\n</channel>"}]}}',
                    '{"type":"assistant","entrypoint":"cli","message":{"role":"assistant","content":[{"type":"text","text":"Pixel Forge channel probe received — installed alpha lane is live and connected."}]}}',
                    '{"type":"system","entrypoint":"cli","subtype":"stop_hook_summary"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-transcript-claude",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_input", "turn_started", "turn_chunk", "turn_completed"],
        )
        self.assertEqual(
            events[0].payload["turn_input"]["prompt_text"],
            "Pixel Forge live smoke probe from installed alpha lane",
        )
        self.assertEqual(
            events[2].payload["content"],
            "Pixel Forge channel probe received — installed alpha lane is live and connected.",
        )
        self.assertEqual(
            events[3].payload["assistant_output"],
            "Pixel Forge channel probe received — installed alpha lane is live and connected.",
        )

    async def test_poll_once_normalizes_command_wrapped_cli_user_prompt(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-command-claude"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-command-claude",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-command-claude",
            agent_deck_session_title="command claude",
            agent_deck_tool="claude",
        )

        session_id = "claude-session-command"
        (self.hooks_dir / "deck-command-claude.sid").write_text(
            session_id,
            encoding="utf-8",
        )

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            session_id,
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text("", encoding="utf-8")

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await ingestor.poll_once()

        jsonl_path.write_text(
            "\n".join(
                [
                    '{"type":"user","entrypoint":"cli","message":{"role":"user","content":[{"type":"text","text":"<command-name>/frontend-design</command-name>\\n<command-message>Trace the selected profile issue</command-message>"}]}}',
                    '{"type":"assistant","entrypoint":"cli","message":{"role":"assistant","content":[{"type":"text","text":"Tracing now."}]}}',
                    '{"type":"system","entrypoint":"cli","subtype":"stop_hook_summary"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-command-claude",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_input", "turn_started", "turn_chunk", "turn_completed"],
        )
        self.assertEqual(
            events[0].payload["turn_input"]["prompt_text"],
            "Trace the selected profile issue",
        )

    async def test_poll_once_backfills_cli_turns_from_stop_snapshot_only(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-stop-only-claude"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-stop-only-claude",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-stop-only-claude",
            agent_deck_session_title="stop only claude",
            agent_deck_tool="claude",
        )

        session_id = "claude-session-stop-only"
        (self.hooks_dir / "deck-stop-only-claude.sid").write_text(
            session_id,
            encoding="utf-8",
        )
        (self.hooks_dir / "deck-stop-only-claude.json").write_text(
            json.dumps(
                {
                    "status": "waiting",
                    "session_id": session_id,
                    "event": "Stop",
                    "ts": 1774617647,
                }
            ),
            encoding="utf-8",
        )

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            session_id,
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text(
            "\n".join(
                [
                    '{"type":"user","entrypoint":"cli","message":{"role":"user","content":"checking if this works"}}',
                    '{"type":"assistant","entrypoint":"cli","message":{"role":"assistant","content":[{"type":"text","text":"It works. How can I help?"}]}}',
                    '{"type":"system","entrypoint":"cli","subtype":"stop_hook_summary"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-stop-only-claude",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_input", "turn_started", "turn_chunk", "turn_completed"],
        )
        self.assertEqual(events[0].payload["turn_input"]["prompt_text"], "checking if this works")
        self.assertEqual(events[2].payload["content"], "It works. How can I help?")
        self.assertEqual(events[3].payload["assistant_output"], "It works. How can I help?")

    async def test_poll_once_ignores_transcript_only_sdk_cli_turns(self) -> None:
        claude_workspace_path = self.project_path / ".agents" / "thread-sdk-claude"
        claude_workspace_path.mkdir(parents=True)
        project_store.upsert_session(
            str(self.project_path),
            thread_id="thread-sdk-claude",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(claude_workspace_path),
            agent_deck_session_id="deck-sdk-claude",
            agent_deck_session_title="sdk claude",
            agent_deck_tool="claude",
        )

        session_id = "claude-session-sdk"
        (self.hooks_dir / "deck-sdk-claude.sid").write_text(
            session_id,
            encoding="utf-8",
        )

        jsonl_path = agent_deck_event_ingest.claude_jsonl_path(
            str(claude_workspace_path),
            session_id,
        )
        assert jsonl_path is not None
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        jsonl_path.write_text("", encoding="utf-8")

        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        await ingestor.poll_once()

        jsonl_path.write_text(
            "\n".join(
                [
                    '{"type":"user","entrypoint":"sdk-cli","message":{"role":"user","content":[{"type":"text","text":"Request pack prompt from Pixel Forge"}]}}',
                    '{"type":"assistant","entrypoint":"sdk-cli","message":{"role":"assistant","content":[{"type":"text","text":"Canonical Pixel Forge reply"}]}}',
                    '{"type":"system","entrypoint":"sdk-cli","subtype":"stop_hook_summary"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-sdk-claude",
        )
        self.assertEqual(events, [])

    async def test_poll_once_emits_codex_turn_events_from_hooks_and_jsonl(self) -> None:
        codex_session_id = "11111111-1111-4111-8111-111111111111"
        ingestor = agent_deck_event_ingest.AgentDeckNativeEventIngestor()
        self._write_hook_event(
            instance_id="deck-a",
            session_id=codex_session_id,
            status="running",
            event="turn/started",
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual([event.event_type for event in events], ["turn_started"])
        request_id = events[0].payload["request_id"]

        self._write_codex_session_file(
            session_id=codex_session_id,
            lines=[
                json.dumps(
                    {
                        "timestamp": "2026-03-22T00:00:00.000Z",
                        "type": "session_meta",
                        "payload": {
                            "id": codex_session_id,
                            "cwd": str(self.workspace_path),
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-03-22T00:00:01.000Z",
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "phase": "commentary",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "Hello from Codex",
                                }
                            ],
                        },
                    }
                ),
            ],
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_started", "turn_chunk"],
        )
        self.assertEqual(events[1].payload["content"], "Hello from Codex")
        self.assertEqual(events[1].payload["request_id"], request_id)

        self._write_hook_event(
            instance_id="deck-a",
            session_id="",
            status="waiting",
            event="turn/completed",
            timestamp=1711111112,
        )

        await ingestor.poll_once()
        events = workstation_events.list_workstation_events(
            str(self.project_path),
            "thread-a",
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["turn_started", "turn_chunk", "turn_completed"],
        )
        self.assertEqual(events[2].payload["request_id"], request_id)
        self.assertEqual(events[2].payload["assistant_output"], "Hello from Codex")


if __name__ == "__main__":
    unittest.main()
