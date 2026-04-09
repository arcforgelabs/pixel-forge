from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from agent_deck_bridge import (
    AgentDeckBridgeError,
    _session_output_has_meaningful_activity,
    claude_jsonl_path,
    codex_jsonl_path,
    get_last_output,
    read_claude_jsonl_payloads,
    read_codex_jsonl_text_chunks,
)
from project_store import SessionRecord, list_sessions_by_agent_deck_session_id
from runtime_config import agent_deck_home_dir
from workstation_events import (
    append_workstation_event,
    latest_workstation_event,
    normalize_workstation_event_payload,
    request_has_terminal_workstation_event,
)


AGENT_DECK_EVENT_POLL_INTERVAL_SECONDS = 0.5
ACTIVE_SESSION_STATUSES = {
    "active",
    "busy",
    "connected",
    "running",
    "starting",
}
SETTLED_SESSION_STATUSES = {
    "error",
    "idle",
    "waiting",
}
CHANNEL_WRAPPER_RE = re.compile(
    r"^\s*<channel\b[^>]*>\s*(.*?)\s*</channel>\s*$",
    re.DOTALL | re.IGNORECASE,
)
COMMAND_MESSAGE_WRAPPER_RE = re.compile(
    r"^\s*<command-message\b[^>]*>\s*(.*?)\s*</command-message>\s*$",
    re.DOTALL | re.IGNORECASE,
)
COMMAND_MESSAGE_TAG_RE = re.compile(
    r"<command-message\b[^>]*>\s*(.*?)\s*</command-message>",
    re.DOTALL | re.IGNORECASE,
)
COMMAND_NAME_TAG_RE = re.compile(
    r"<command-name\b[^>]*>.*?</command-name>",
    re.DOTALL | re.IGNORECASE,
)


@dataclass(slots=True)
class AgentDeckNativeStatusEvent:
    session_id: str
    title: str | None
    tool: str | None
    status: str | None
    prev_status: str | None


@dataclass(slots=True)
class AgentDeckNativeHookEvent:
    agent_deck_session_id: str
    upstream_session_id: str | None
    status: str | None
    event: str | None
    timestamp: int


@dataclass(slots=True)
class ClaudeJSONLCursor:
    claude_session_id: str
    jsonl_path: Path | None
    offset: int = 0
    seen_uuids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class ClaudeTurnState:
    request_id: str
    claude_session_id: str
    assistant_output: str = ""
    user_prompt: str | None = None
    input_emitted: bool = False


@dataclass(slots=True)
class CodexJSONLCursor:
    codex_session_id: str
    jsonl_path: Path | None
    offset: int = 0


@dataclass(slots=True)
class CodexTurnState:
    request_id: str
    codex_session_id: str
    assistant_output: str = ""


def _normalized_text(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _is_claude_tool(tool: str | None) -> bool:
    return (tool or "").strip().lower() == "claude"


def _is_codex_tool(tool: str | None) -> bool:
    return (tool or "").strip().lower() == "codex"


def _canonical_hook_event(event_name: str | None) -> str:
    return (event_name or "").strip().lower().replace(".", "/").replace("-", "/").replace("_", "/")


def _is_codex_turn_started_event(event_name: str | None) -> bool:
    return _canonical_hook_event(event_name) == "turn/started"


def _is_codex_turn_failed_event(event_name: str | None) -> bool:
    canonical = _canonical_hook_event(event_name)
    return canonical in {
        "turn/failed",
        "turn/aborted",
        "turn/cancelled",
        "turn/canceled",
    }


def _is_codex_turn_terminal_event(event_name: str | None) -> bool:
    canonical = _canonical_hook_event(event_name)
    return canonical in {
        "agent/turn/complete",
        "agent/turn/completed",
        "turn/complete",
        "turn/completed",
        "turn/failed",
        "turn/aborted",
        "turn/cancelled",
        "turn/canceled",
    }


def _status_message(
    *,
    session_id: str,
    session_title: str | None,
    tool: str | None,
    status: str | None,
) -> str:
    session_label = session_title or session_id
    tool_label = (tool or "Agent Deck").strip() or "Agent Deck"
    normalized_status = (status or "").strip().lower()

    if normalized_status in ACTIVE_SESSION_STATUSES:
        return f"{tool_label.capitalize()} is working in Agent Deck..."
    if normalized_status == "error":
        return f"Agent Deck session `{session_label}` entered an error state."
    if normalized_status in {"idle", "waiting"}:
        return f"Attached to Agent Deck session `{session_label}`. Waiting for output..."
    if normalized_status:
        return f"Attached to Agent Deck session `{session_label}` ({normalized_status})."
    return f"Attached to Agent Deck session `{session_label}`."


def _hook_status_message(event_name: str | None) -> str | None:
    normalized_event = (event_name or "").strip()
    if normalized_event == "PermissionRequest":
        return "Claude is waiting for permission in Agent Deck..."
    if normalized_event == "Notification":
        return "Claude is waiting for input in Agent Deck..."
    return None


def _extract_claude_user_prompt(record: dict[str, object]) -> str | None:
    if record.get("type") != "user":
        return None

    message = record.get("message")
    if not isinstance(message, dict):
        return None

    content_value = message.get("content")
    if isinstance(content_value, str):
        normalized = content_value.strip()
        return normalized or None
    if not isinstance(content_value, list):
        return None

    parts: list[str] = []
    for block in content_value:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "text":
            continue
        text = block.get("text")
        if isinstance(text, str):
            normalized = text.strip()
            if normalized:
                parts.append(normalized)

    if not parts:
        return None
    return "\n\n".join(parts)


def _normalize_observed_claude_prompt(prompt_text: str | None) -> str | None:
    if not isinstance(prompt_text, str):
        return None

    normalized = prompt_text.strip()
    if not normalized:
        return None

    match = CHANNEL_WRAPPER_RE.fullmatch(normalized)
    if match is not None:
        normalized = match.group(1).strip()

    normalized = COMMAND_NAME_TAG_RE.sub("", normalized).strip()

    match = COMMAND_MESSAGE_WRAPPER_RE.fullmatch(normalized)
    if match is not None:
        normalized = match.group(1).strip()
    else:
        normalized = COMMAND_MESSAGE_TAG_RE.sub(lambda found: found.group(1).strip(), normalized).strip()

    return normalized or None


def _should_emit_transcript_user_prompt(entrypoint: str | None) -> bool:
    normalized_entrypoint = (entrypoint or "").strip().lower()
    return normalized_entrypoint != "sdk-cli"


def _latest_claude_user_turn(
    jsonl_path: Path | None,
) -> tuple[int | None, str | None, str | None]:
    if jsonl_path is None or not jsonl_path.exists():
        return None, None, None

    latest_offset: int | None = None
    latest_prompt: str | None = None
    latest_entrypoint: str | None = None
    offset = 0

    try:
        with jsonl_path.open("r", encoding="utf-8") as handle:
            while True:
                line = handle.readline()
                if not line:
                    break
                offset = handle.tell()

                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if not isinstance(record, dict):
                    continue
                if record.get("type") != "user":
                    continue

                latest_offset = offset
                latest_prompt = _normalize_observed_claude_prompt(
                    _extract_claude_user_prompt(record),
                )
                latest_entrypoint = _normalized_text(record.get("entrypoint"))
    except OSError:
        return None, None, None

    return latest_offset, latest_prompt, latest_entrypoint


class AgentDeckNativeEventIngestor:
    def __init__(
        self,
        *,
        poll_interval_seconds: float = AGENT_DECK_EVENT_POLL_INTERVAL_SECONDS,
    ) -> None:
        self.poll_interval_seconds = poll_interval_seconds
        self._event_file_fingerprints: dict[str, tuple[int, int]] = {}
        self._hook_file_fingerprints: dict[str, tuple[int, int]] = {}
        self._latest_handled_hook_signatures: dict[
            str,
            tuple[str | None, str | None, str | None, int],
        ] = {}
        self._latest_hook_events: dict[str, AgentDeckNativeHookEvent] = {}
        self._claude_jsonl_cursors: dict[str, ClaudeJSONLCursor] = {}
        self._active_claude_turns: dict[str, ClaudeTurnState] = {}
        self._codex_jsonl_cursors: dict[str, CodexJSONLCursor] = {}
        self._active_codex_turns: dict[str, CodexTurnState] = {}

    def events_dir(self) -> Path:
        path = agent_deck_home_dir() / "events"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def hooks_dir(self) -> Path:
        path = agent_deck_home_dir() / "hooks"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def hook_events_dir(self) -> Path:
        path = agent_deck_home_dir() / "hook-events"
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def run(self) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(self.poll_interval_seconds)

    async def poll_once(self) -> None:
        await self._poll_status_events()
        await self._poll_hook_queue_events()
        await self._poll_hook_events()
        await self._poll_active_claude_turns()
        await self._poll_active_codex_turns()

    async def _poll_status_events(self) -> None:
        await self._poll_json_files(
            self.events_dir(),
            self._event_file_fingerprints,
            self._read_status_event,
            self._ingest_status_event,
        )

    async def _poll_hook_events(self) -> None:
        seen_paths: set[str] = set()

        for path in sorted(self.hooks_dir().glob("*.json")):
            path_key = str(path)
            seen_paths.add(path_key)
            try:
                stat = path.stat()
            except OSError:
                continue

            fingerprint = (stat.st_mtime_ns, stat.st_size)
            if self._hook_file_fingerprints.get(path_key) == fingerprint:
                continue

            self._hook_file_fingerprints[path_key] = fingerprint
            event = self._read_hook_event(path)
            if event is None:
                continue

            event_signature = self._hook_event_signature(event)
            if self._latest_handled_hook_signatures.get(event.agent_deck_session_id) == event_signature:
                continue

            await self._ingest_hook_event(event)
            self._latest_handled_hook_signatures[event.agent_deck_session_id] = event_signature

        stale_paths = set(self._hook_file_fingerprints) - seen_paths
        for path_key in stale_paths:
            self._hook_file_fingerprints.pop(path_key, None)

    async def _poll_hook_queue_events(self) -> None:
        for path in sorted(self.hook_events_dir().glob("*.json")):
            event = self._read_hook_queue_event(path)
            if event is None:
                try:
                    path.unlink()
                except OSError:
                    pass
                continue
            try:
                await self._ingest_hook_event(event)
                self._latest_handled_hook_signatures[
                    event.agent_deck_session_id
                ] = self._hook_event_signature(event)
            finally:
                try:
                    path.unlink()
                except OSError:
                    pass

    async def _poll_json_files(
        self,
        root: Path,
        fingerprints: dict[str, tuple[int, int]],
        reader,
        handler,
    ) -> None:
        seen_paths: set[str] = set()

        for path in sorted(root.glob("*.json")):
            path_key = str(path)
            seen_paths.add(path_key)
            try:
                stat = path.stat()
            except OSError:
                continue

            fingerprint = (stat.st_mtime_ns, stat.st_size)
            if fingerprints.get(path_key) == fingerprint:
                continue

            fingerprints[path_key] = fingerprint
            record = reader(path)
            if record is None:
                continue
            await handler(record)

        stale_paths = set(fingerprints) - seen_paths
        for path_key in stale_paths:
            fingerprints.pop(path_key, None)

    def _read_status_event(self, path: Path) -> AgentDeckNativeStatusEvent | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

        if not isinstance(payload, dict):
            return None

        session_id = _normalized_text(payload.get("instance_id"))
        if session_id is None:
            return None

        return AgentDeckNativeStatusEvent(
            session_id=session_id,
            title=_normalized_text(payload.get("title")),
            tool=_normalized_text(payload.get("tool")),
            status=_normalized_text(payload.get("status")),
            prev_status=_normalized_text(payload.get("prev_status")),
        )

    def _read_hook_event(self, path: Path) -> AgentDeckNativeHookEvent | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

        if not isinstance(payload, dict):
            return None

        agent_deck_session_id = _normalized_text(path.stem)
        if agent_deck_session_id is None:
            return None

        timestamp = payload.get("ts")
        return AgentDeckNativeHookEvent(
            agent_deck_session_id=agent_deck_session_id,
            upstream_session_id=_normalized_text(payload.get("session_id")),
            status=_normalized_text(payload.get("status")),
            event=_normalized_text(payload.get("event")),
            timestamp=int(timestamp) if isinstance(timestamp, int) else 0,
        )

    def _read_hook_queue_event(self, path: Path) -> AgentDeckNativeHookEvent | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

        if not isinstance(payload, dict):
            return None

        agent_deck_session_id = _normalized_text(payload.get("instance_id"))
        if agent_deck_session_id is None:
            return None

        timestamp = payload.get("ts")
        return AgentDeckNativeHookEvent(
            agent_deck_session_id=agent_deck_session_id,
            upstream_session_id=_normalized_text(payload.get("session_id")),
            status=_normalized_text(payload.get("status")),
            event=_normalized_text(payload.get("event")),
            timestamp=int(timestamp) if isinstance(timestamp, int) else 0,
        )

    def _hook_event_signature(
        self,
        event: AgentDeckNativeHookEvent,
    ) -> tuple[str | None, str | None, str | None, int]:
        return (
            event.upstream_session_id,
            event.status,
            event.event,
            event.timestamp,
        )

    async def _ingest_status_event(self, event: AgentDeckNativeStatusEvent) -> None:
        bound_sessions = list_sessions_by_agent_deck_session_id(event.session_id)
        if not bound_sessions:
            return

        output_snapshot: str | None = None
        normalized_status = (event.status or "").strip().lower()
        if normalized_status in SETTLED_SESSION_STATUSES:
            try:
                current_output = await get_last_output(event.session_id)
            except AgentDeckBridgeError:
                current_output = ""
            output_snapshot = current_output if _session_output_has_meaningful_activity(current_output) else ""

        for session in bound_sessions:
            self._append_if_changed(
                session,
                event_type="session_status",
                payload={
                    "agent_deck_session_id": event.session_id,
                    "agent_deck_session_title": event.title or session.agent_deck_session_title,
                    "agent_deck_tool": event.tool or session.agent_deck_tool,
                    "agent_deck_session_status": event.status,
                    "workspace_path": session.workspace_path,
                    "binding_state": "attached",
                    "message": _status_message(
                        session_id=event.session_id,
                        session_title=event.title or session.agent_deck_session_title,
                        tool=event.tool or session.agent_deck_tool,
                        status=event.status,
                    ),
                },
            )
            if output_snapshot:
                self._append_if_changed(
                    session,
                    event_type="session_output",
                    payload={
                        "agent_deck_session_id": event.session_id,
                        "agent_deck_session_title": event.title or session.agent_deck_session_title,
                        "agent_deck_tool": event.tool or session.agent_deck_tool,
                        "agent_deck_session_status": event.status,
                        "workspace_path": session.workspace_path,
                        "binding_state": "attached",
                        "output": output_snapshot,
                    },
                )

    async def _ingest_hook_event(self, event: AgentDeckNativeHookEvent) -> None:
        self._latest_hook_events[event.agent_deck_session_id] = event
        claude_sessions = self._bound_claude_sessions(event.agent_deck_session_id)
        codex_sessions = self._bound_codex_sessions(event.agent_deck_session_id)
        if not claude_sessions and not codex_sessions:
            self._active_claude_turns.pop(event.agent_deck_session_id, None)
            self._active_codex_turns.pop(event.agent_deck_session_id, None)
            return

        if event.upstream_session_id and claude_sessions:
            self._ensure_claude_cursor(
                event.agent_deck_session_id,
                claude_sessions,
                event.upstream_session_id,
                anchor_to_end=(event.event or "") not in {"UserPromptSubmit", "Stop", "SessionEnd"},
                start_from_latest_user_turn=(event.event or "") == "UserPromptSubmit",
            )

        normalized_event = (event.event or "").strip()
        if normalized_event == "UserPromptSubmit" and claude_sessions:
            if event.upstream_session_id:
                cursor = self._ensure_claude_cursor(
                    event.agent_deck_session_id,
                    claude_sessions,
                    event.upstream_session_id,
                    anchor_to_end=False,
                    start_from_latest_user_turn=True,
                )
                _, prompt_text, prompt_entrypoint = _latest_claude_user_turn(
                    cursor.jsonl_path if cursor is not None else None,
                )
                if not _should_emit_transcript_user_prompt(prompt_entrypoint):
                    return
                self._ensure_active_claude_turn(
                    event.agent_deck_session_id,
                    claude_sessions,
                    event.upstream_session_id,
                    event.timestamp,
                    prompt_text=prompt_text,
                )
            return

        if normalized_event in {"PermissionRequest", "Notification"} and claude_sessions:
            turn_state = self._active_claude_turns.get(event.agent_deck_session_id)
            status_message = _hook_status_message(normalized_event)
            if turn_state is not None and status_message:
                self._append_turn_status_if_changed(
                    claude_sessions,
                    request_id=turn_state.request_id,
                    message=status_message,
                )
            return

        if normalized_event == "Stop" and claude_sessions:
            await self._sync_claude_turn_output(
                event.agent_deck_session_id,
                claude_sessions,
                allow_backfill_start=True,
            )
            self._complete_claude_turn(
                event.agent_deck_session_id,
                claude_sessions,
            )
            return

        if normalized_event == "SessionEnd" and claude_sessions:
            await self._sync_claude_turn_output(
                event.agent_deck_session_id,
                claude_sessions,
                allow_backfill_start=False,
            )
            self._fail_claude_turn(
                event.agent_deck_session_id,
                claude_sessions,
                message="Claude session ended during the observed turn.",
            )
            return

        if not codex_sessions:
            return

        codex_session_id = self._resolve_codex_session_id(
            event.agent_deck_session_id,
            event=event,
        )
        if codex_session_id:
            self._ensure_codex_cursor(
                event.agent_deck_session_id,
                codex_session_id,
                anchor_to_end=not _is_codex_turn_started_event(normalized_event),
            )

        if _is_codex_turn_started_event(normalized_event):
            if codex_session_id:
                self._ensure_codex_cursor(
                    event.agent_deck_session_id,
                    codex_session_id,
                    anchor_to_end=True,
                )
                self._ensure_active_codex_turn(
                    event.agent_deck_session_id,
                    codex_sessions,
                    codex_session_id,
                    event.timestamp,
                )
            return

        if _is_codex_turn_terminal_event(normalized_event):
            await self._sync_codex_turn_output(
                event.agent_deck_session_id,
                codex_sessions,
                allow_backfill_start=True,
            )
            if _is_codex_turn_failed_event(normalized_event):
                self._fail_codex_turn(
                    event.agent_deck_session_id,
                    codex_sessions,
                    message="Codex turn ended unsuccessfully in Agent Deck.",
                )
            else:
                self._complete_codex_turn(
                    event.agent_deck_session_id,
                    codex_sessions,
                )

    async def _poll_active_claude_turns(self) -> None:
        tracked_session_ids = set(self._active_claude_turns)
        tracked_session_ids.update(self._claude_jsonl_cursors)
        tracked_session_ids.update(self._latest_hook_events)
        for path in self.hooks_dir().glob("*.sid"):
            tracked_session_ids.add(path.stem)

        for agent_deck_session_id in tracked_session_ids:
            bound_sessions = self._bound_claude_sessions(agent_deck_session_id)
            if not bound_sessions:
                self._active_claude_turns.pop(agent_deck_session_id, None)
                self._claude_jsonl_cursors.pop(agent_deck_session_id, None)
                continue
            latest_event = self._latest_hook_events.get(agent_deck_session_id)
            await self._sync_claude_turn_output(
                agent_deck_session_id,
                bound_sessions,
                allow_backfill_start=(latest_event is not None and (latest_event.event or "") in {"Stop", "SessionEnd"}),
            )

    async def _poll_active_codex_turns(self) -> None:
        for agent_deck_session_id in list(self._active_codex_turns):
            bound_sessions = self._bound_codex_sessions(agent_deck_session_id)
            if not bound_sessions:
                self._active_codex_turns.pop(agent_deck_session_id, None)
                continue
            await self._sync_codex_turn_output(
                agent_deck_session_id,
                bound_sessions,
                allow_backfill_start=False,
            )

    def _bound_claude_sessions(self, agent_deck_session_id: str) -> list[SessionRecord]:
        return [
            session
            for session in list_sessions_by_agent_deck_session_id(agent_deck_session_id)
            if _is_claude_tool(session.agent_deck_tool)
        ]

    def _bound_codex_sessions(self, agent_deck_session_id: str) -> list[SessionRecord]:
        return [
            session
            for session in list_sessions_by_agent_deck_session_id(agent_deck_session_id)
            if _is_codex_tool(session.agent_deck_tool)
        ]

    def _read_hook_session_anchor(self, agent_deck_session_id: str) -> str | None:
        path = self.hooks_dir() / f"{agent_deck_session_id}.sid"
        try:
            anchor = path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return anchor or None

    def _resolve_claude_jsonl_path(
        self,
        session: SessionRecord,
        claude_session_id: str,
    ) -> Path | None:
        workspace_candidate = claude_jsonl_path(session.workspace_path, claude_session_id)
        if workspace_candidate is not None and workspace_candidate.exists():
            return workspace_candidate

        project_candidate = claude_jsonl_path(session.project_path, claude_session_id)
        if project_candidate is not None and project_candidate.exists():
            return project_candidate

        return workspace_candidate or project_candidate

    def _resolve_codex_session_id(
        self,
        agent_deck_session_id: str,
        *,
        event: AgentDeckNativeHookEvent | None = None,
    ) -> str | None:
        if event is not None and event.upstream_session_id:
            return event.upstream_session_id

        turn_state = self._active_codex_turns.get(agent_deck_session_id)
        if turn_state is not None:
            return turn_state.codex_session_id

        cursor = self._codex_jsonl_cursors.get(agent_deck_session_id)
        if cursor is not None:
            return cursor.codex_session_id

        return self._read_hook_session_anchor(agent_deck_session_id)

    def _ensure_claude_cursor(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        claude_session_id: str,
        *,
        anchor_to_end: bool,
        start_from_latest_user_turn: bool = False,
    ) -> ClaudeJSONLCursor | None:
        if not sessions:
            return None

        path = self._resolve_claude_jsonl_path(sessions[0], claude_session_id)
        cursor = self._claude_jsonl_cursors.get(agent_deck_session_id)
        if cursor is not None and cursor.claude_session_id == claude_session_id:
            cursor.jsonl_path = path
            if path is not None and path.exists():
                if start_from_latest_user_turn:
                    latest_user_offset, _, _ = _latest_claude_user_turn(path)
                    if latest_user_offset is not None and latest_user_offset > cursor.offset:
                        cursor.offset = latest_user_offset
            return cursor

        offset = 0
        if path is not None and path.exists():
            try:
                file_size = path.stat().st_size
            except OSError:
                file_size = 0
            if start_from_latest_user_turn:
                latest_user_offset, _, _ = _latest_claude_user_turn(path)
                offset = latest_user_offset if latest_user_offset is not None else file_size
            elif anchor_to_end:
                offset = file_size

        cursor = ClaudeJSONLCursor(
            claude_session_id=claude_session_id,
            jsonl_path=path,
            offset=offset,
        )
        self._claude_jsonl_cursors[agent_deck_session_id] = cursor
        return cursor

    def _ensure_active_claude_turn(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        claude_session_id: str,
        timestamp: int,
        *,
        prompt_text: str | None = None,
    ) -> ClaudeTurnState:
        normalized_prompt = prompt_text.strip() if isinstance(prompt_text, str) else ""
        prompt_text = normalized_prompt or None

        existing = self._active_claude_turns.get(agent_deck_session_id)
        if existing is not None and existing.claude_session_id == claude_session_id:
            if prompt_text and not existing.input_emitted:
                self._emit_claude_turn_input(
                    sessions,
                    request_id=existing.request_id,
                    prompt_text=prompt_text,
                )
                existing.user_prompt = prompt_text
                existing.input_emitted = True
            return existing

        request_id = f"offpath-claude-{agent_deck_session_id}-{timestamp or int(time.time())}"
        state = ClaudeTurnState(
            request_id=request_id,
            claude_session_id=claude_session_id,
            user_prompt=prompt_text,
            input_emitted=bool(prompt_text),
        )
        self._active_claude_turns[agent_deck_session_id] = state

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_started",
                payload={
                    "request_id": request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                },
            )

        if prompt_text:
            self._emit_claude_turn_input(
                sessions,
                request_id=request_id,
                prompt_text=prompt_text,
            )

        return state

    def _emit_claude_turn_input(
        self,
        sessions: list[SessionRecord],
        *,
        request_id: str,
        prompt_text: str,
    ) -> None:
        normalized_prompt = prompt_text.strip()
        if not normalized_prompt:
            return

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_input",
                payload={
                    "request_id": request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                    "content": normalized_prompt,
                    "turn_input": {
                        "prompt_text": normalized_prompt,
                    },
                },
            )

    async def _sync_claude_turn_output(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        *,
        allow_backfill_start: bool,
    ) -> None:
        hook_event = self._latest_hook_events.get(agent_deck_session_id)
        turn_state = self._active_claude_turns.get(agent_deck_session_id)
        claude_session_id = (
            hook_event.upstream_session_id
            if hook_event is not None and hook_event.upstream_session_id
            else (turn_state.claude_session_id if turn_state is not None else None)
        )
        if not claude_session_id:
            cursor = self._claude_jsonl_cursors.get(agent_deck_session_id)
            claude_session_id = cursor.claude_session_id if cursor is not None else None
        if not claude_session_id:
            claude_session_id = self._read_hook_session_anchor(agent_deck_session_id)
        if not claude_session_id:
            return

        request_id_hint = (
            f"offpath-claude-{agent_deck_session_id}-{hook_event.timestamp}"
            if turn_state is None
            and allow_backfill_start
            and hook_event is not None
            and hook_event.timestamp
            else None
        )
        cursor = self._ensure_claude_cursor(
            agent_deck_session_id,
            sessions,
            claude_session_id,
            anchor_to_end=(turn_state is None and not allow_backfill_start),
            start_from_latest_user_turn=(turn_state is None and allow_backfill_start),
        )
        if cursor is None or cursor.jsonl_path is None:
            return
        if (
            request_id_hint
            and all(
                request_has_terminal_workstation_event(
                    session.project_path,
                    session.thread_id,
                    request_id_hint,
                )
                for session in sessions
            )
        ):
            try:
                cursor.offset = cursor.jsonl_path.stat().st_size
            except OSError:
                pass
            return

        _, latest_user_prompt, latest_user_entrypoint = _latest_claude_user_turn(
            cursor.jsonl_path,
        )
        if (
            turn_state is not None
            and latest_user_prompt
            and not turn_state.input_emitted
            and _should_emit_transcript_user_prompt(latest_user_entrypoint)
        ):
            self._emit_claude_turn_input(
                sessions,
                request_id=turn_state.request_id,
                prompt_text=latest_user_prompt,
            )
            turn_state.user_prompt = latest_user_prompt
            turn_state.input_emitted = True

        next_offset, payloads = read_claude_jsonl_payloads(
            cursor.jsonl_path,
            cursor.offset,
            seen_uuids=cursor.seen_uuids,
        )
        cursor.offset = next_offset
        if not payloads:
            return

        fallback_prompt = (
            latest_user_prompt
            if _should_emit_transcript_user_prompt(latest_user_entrypoint)
            else None
        )

        for payload in payloads:
            payload_type = _normalized_text(payload.get("type"))
            if payload_type == "user_prompt":
                prompt_text = _normalize_observed_claude_prompt(
                    _normalized_text(payload.get("content")),
                )
                if not prompt_text:
                    continue
                if not _should_emit_transcript_user_prompt(
                    _normalized_text(payload.get("entrypoint")),
                ):
                    continue
                if turn_state is not None and turn_state.assistant_output:
                    self._complete_claude_turn(
                        agent_deck_session_id,
                        sessions,
                    )
                    turn_state = None
                turn_state = self._ensure_active_claude_turn(
                    agent_deck_session_id,
                    sessions,
                    claude_session_id,
                    hook_event.timestamp if hook_event is not None else int(time.time()),
                    prompt_text=prompt_text,
                )
                continue

            if payload_type == "chunk":
                chunk = _normalized_text(payload.get("content"))
                if not chunk:
                    continue
                if turn_state is None:
                    if not fallback_prompt:
                        continue
                    turn_state = self._ensure_active_claude_turn(
                        agent_deck_session_id,
                        sessions,
                        claude_session_id,
                        hook_event.timestamp if hook_event is not None else int(time.time()),
                        prompt_text=fallback_prompt,
                    )
                turn_state.assistant_output += chunk
                for session in sessions:
                    append_workstation_event(
                        session.project_path,
                        session.thread_id,
                        agent_deck_session_id=session.agent_deck_session_id,
                        event_type="turn_chunk",
                        payload={
                            "request_id": turn_state.request_id,
                            "agent_deck_session_id": session.agent_deck_session_id,
                            "agent_deck_session_title": session.agent_deck_session_title,
                            "agent_deck_tool": session.agent_deck_tool,
                            "workspace_path": session.workspace_path,
                            "content": chunk,
                        },
                    )
                continue

            if payload_type == "turn_stop" and turn_state is not None:
                self._complete_claude_turn(
                    agent_deck_session_id,
                    sessions,
                )
                turn_state = None

    def _ensure_codex_cursor(
        self,
        agent_deck_session_id: str,
        codex_session_id: str,
        *,
        anchor_to_end: bool,
    ) -> CodexJSONLCursor:
        path = codex_jsonl_path(codex_session_id)
        cursor = self._codex_jsonl_cursors.get(agent_deck_session_id)
        if cursor is not None and cursor.codex_session_id == codex_session_id:
            cursor.jsonl_path = path
            return cursor

        offset = 0
        if anchor_to_end and path is not None and path.exists():
            try:
                offset = path.stat().st_size
            except OSError:
                offset = 0

        cursor = CodexJSONLCursor(
            codex_session_id=codex_session_id,
            jsonl_path=path,
            offset=offset,
        )
        self._codex_jsonl_cursors[agent_deck_session_id] = cursor
        return cursor

    def _ensure_active_codex_turn(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        codex_session_id: str,
        timestamp: int,
    ) -> CodexTurnState:
        existing = self._active_codex_turns.get(agent_deck_session_id)
        if existing is not None and existing.codex_session_id == codex_session_id:
            return existing

        request_id = f"offpath-codex-{agent_deck_session_id}-{timestamp or int(time.time())}"
        state = CodexTurnState(
            request_id=request_id,
            codex_session_id=codex_session_id,
        )
        self._active_codex_turns[agent_deck_session_id] = state

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_started",
                payload={
                    "request_id": request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                },
            )

        return state

    async def _sync_codex_turn_output(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        *,
        allow_backfill_start: bool,
    ) -> None:
        hook_event = self._latest_hook_events.get(agent_deck_session_id)
        turn_state = self._active_codex_turns.get(agent_deck_session_id)
        codex_session_id = self._resolve_codex_session_id(
            agent_deck_session_id,
            event=hook_event,
        )
        if not codex_session_id:
            return

        cursor = self._ensure_codex_cursor(
            agent_deck_session_id,
            codex_session_id,
            anchor_to_end=(turn_state is None and not allow_backfill_start),
        )
        if cursor.jsonl_path is None:
            return

        next_offset, text_chunks = read_codex_jsonl_text_chunks(
            cursor.jsonl_path,
            cursor.offset,
        )
        cursor.offset = next_offset
        if not text_chunks:
            return

        if turn_state is None:
            turn_state = self._ensure_active_codex_turn(
                agent_deck_session_id,
                sessions,
                codex_session_id,
                hook_event.timestamp if hook_event is not None else int(time.time()),
            )

        for chunk in text_chunks:
            if not chunk:
                continue
            turn_state.assistant_output += chunk
            for session in sessions:
                append_workstation_event(
                    session.project_path,
                    session.thread_id,
                    agent_deck_session_id=session.agent_deck_session_id,
                    event_type="turn_chunk",
                    payload={
                        "request_id": turn_state.request_id,
                        "agent_deck_session_id": session.agent_deck_session_id,
                        "agent_deck_session_title": session.agent_deck_session_title,
                        "agent_deck_tool": session.agent_deck_tool,
                        "workspace_path": session.workspace_path,
                        "content": chunk,
                    },
                )

    def _append_turn_status_if_changed(
        self,
        sessions: list[SessionRecord],
        *,
        request_id: str,
        message: str,
    ) -> None:
        for session in sessions:
            payload = {
                "request_id": request_id,
                "agent_deck_session_id": session.agent_deck_session_id,
                "agent_deck_session_title": session.agent_deck_session_title,
                "agent_deck_tool": session.agent_deck_tool,
                "workspace_path": session.workspace_path,
                "message": message,
            }
            normalized_payload = normalize_workstation_event_payload(
                session.thread_id,
                payload,
            )
            latest = latest_workstation_event(
                session.project_path,
                session.thread_id,
                event_type="turn_status",
            )
            if latest is not None and latest.payload == normalized_payload:
                continue
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_status",
                payload=payload,
            )

    def _complete_claude_turn(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
    ) -> None:
        turn_state = self._active_claude_turns.pop(agent_deck_session_id, None)
        if turn_state is None:
            return

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_completed",
                payload={
                    "request_id": turn_state.request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                    "assistant_output": turn_state.assistant_output,
                },
            )

    def _complete_codex_turn(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
    ) -> None:
        turn_state = self._active_codex_turns.pop(agent_deck_session_id, None)
        if turn_state is None:
            return

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_completed",
                payload={
                    "request_id": turn_state.request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                    "assistant_output": turn_state.assistant_output,
                },
            )

    def _fail_claude_turn(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        *,
        message: str,
    ) -> None:
        turn_state = self._active_claude_turns.pop(agent_deck_session_id, None)
        if turn_state is None:
            return

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_failed",
                payload={
                    "request_id": turn_state.request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                    "message": message,
                },
            )

    def _fail_codex_turn(
        self,
        agent_deck_session_id: str,
        sessions: list[SessionRecord],
        *,
        message: str,
    ) -> None:
        turn_state = self._active_codex_turns.pop(agent_deck_session_id, None)
        if turn_state is None:
            return

        for session in sessions:
            append_workstation_event(
                session.project_path,
                session.thread_id,
                agent_deck_session_id=session.agent_deck_session_id,
                event_type="turn_failed",
                payload={
                    "request_id": turn_state.request_id,
                    "agent_deck_session_id": session.agent_deck_session_id,
                    "agent_deck_session_title": session.agent_deck_session_title,
                    "agent_deck_tool": session.agent_deck_tool,
                    "workspace_path": session.workspace_path,
                    "message": message,
                },
            )

    def _append_if_changed(
        self,
        session: SessionRecord,
        *,
        event_type: str,
        payload: dict[str, object],
    ) -> None:
        normalized_payload = normalize_workstation_event_payload(
            session.thread_id,
            payload,
        )
        latest = latest_workstation_event(
            session.project_path,
            session.thread_id,
            event_type=event_type,
        )
        if latest is not None and latest.payload == normalized_payload:
            return

        append_workstation_event(
            session.project_path,
            session.thread_id,
            agent_deck_session_id=session.agent_deck_session_id,
            event_type=event_type,
            payload=payload,
        )
