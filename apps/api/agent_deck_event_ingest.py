from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from agent_deck_bridge import (
    AgentDeckBridgeError,
    _session_output_has_meaningful_activity,
    get_last_output,
)
from project_store import SessionRecord, list_sessions_by_agent_deck_session_id
from runtime_config import agent_deck_home_dir
from workstation_events import (
    append_workstation_event,
    latest_workstation_event,
    normalize_workstation_event_payload,
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


@dataclass(slots=True)
class AgentDeckNativeStatusEvent:
    session_id: str
    title: str | None
    tool: str | None
    status: str | None
    prev_status: str | None


def _normalized_text(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


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


class AgentDeckNativeEventIngestor:
    def __init__(
        self,
        *,
        poll_interval_seconds: float = AGENT_DECK_EVENT_POLL_INTERVAL_SECONDS,
    ) -> None:
        self.poll_interval_seconds = poll_interval_seconds
        self._file_fingerprints: dict[str, tuple[int, int]] = {}

    def events_dir(self) -> Path:
        path = agent_deck_home_dir() / "events"
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def run(self) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(self.poll_interval_seconds)

    async def poll_once(self) -> None:
        events_dir = self.events_dir()
        seen_paths: set[str] = set()

        for path in sorted(events_dir.glob("*.json")):
            path_key = str(path)
            seen_paths.add(path_key)
            try:
                stat = path.stat()
            except OSError:
                continue

            fingerprint = (stat.st_mtime_ns, stat.st_size)
            if self._file_fingerprints.get(path_key) == fingerprint:
                continue

            self._file_fingerprints[path_key] = fingerprint
            event = self._read_status_event(path)
            if event is None:
                continue
            await self._ingest_status_event(event)

        stale_paths = set(self._file_fingerprints) - seen_paths
        for path_key in stale_paths:
            self._file_fingerprints.pop(path_key, None)

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
