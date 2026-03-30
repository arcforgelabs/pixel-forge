from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any

from agent_deck_bridge import AgentDeckBridgeError, get_agent_deck_session_activity
from project_store import (
    detach_project_session_binding,
    get_project_session,
    normalize_project_path,
)
from state_db import connect as connect_state_db


_DB_LOCK = threading.Lock()
_DB_INITIALIZED = False
TURN_EVENT_TYPES = {
    "turn_input",
    "turn_started",
    "turn_status",
    "turn_chunk",
    "turn_completed",
    "turn_failed",
}
SESSION_EVENT_TYPES = {
    "session_status",
    "session_output",
}
PRIMARY_EVENT_TYPES = TURN_EVENT_TYPES | SESSION_EVENT_TYPES


@dataclass(slots=True)
class WorkstationEventRecord:
    id: int
    project_path: str
    chat_id: str
    agent_deck_session_id: str | None
    event_type: str
    payload: dict[str, Any]
    created_at: str


def _connect() -> sqlite3.Connection:
    conn = connect_state_db()
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    global _DB_INITIALIZED
    if _DB_INITIALIZED:
        return

    with _DB_LOCK:
        if _DB_INITIALIZED:
            return

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS workstation_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                agent_deck_session_id TEXT,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
                FOREIGN KEY (chat_id) REFERENCES sessions(thread_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_workstation_events_chat
                ON workstation_events (project_path, chat_id, id DESC);
            """
        )
        conn.commit()
        _DB_INITIALIZED = True


def _row_to_event_record(row: sqlite3.Row) -> WorkstationEventRecord:
    payload = json.loads(row["payload_json"])
    return WorkstationEventRecord(
        id=row["id"],
        project_path=row["project_path"],
        chat_id=row["chat_id"],
        agent_deck_session_id=row["agent_deck_session_id"],
        event_type=row["event_type"],
        payload=payload if isinstance(payload, dict) else {},
        created_at=row["created_at"],
    )


def normalize_workstation_event_payload(
    chat_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    normalized_chat_id = chat_id.strip()
    normalized_payload: dict[str, Any] = {
        "chat_id": normalized_chat_id,
        "thread_id": normalized_chat_id,
    }
    normalized_payload.update(payload)
    return normalized_payload


def _append_event(
    conn: sqlite3.Connection,
    *,
    project_path: str,
    chat_id: str,
    agent_deck_session_id: str | None,
    event_type: str,
    payload: dict[str, Any],
) -> WorkstationEventRecord:
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    cursor = conn.execute(
        """
        INSERT INTO workstation_events (
            project_path,
            chat_id,
            agent_deck_session_id,
            event_type,
            payload_json
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            project_path,
            chat_id,
            agent_deck_session_id,
            event_type,
            payload_json,
        ),
    )
    row = conn.execute(
        """
        SELECT id, project_path, chat_id, agent_deck_session_id, event_type, payload_json, created_at
        FROM workstation_events
        WHERE id = ?
        """,
        (cursor.lastrowid,),
    ).fetchone()
    if row is None:
        raise RuntimeError("Workstation event disappeared during insert")
    return _row_to_event_record(row)


def _latest_activity_payload(
    conn: sqlite3.Connection,
    *,
    project_path: str,
    chat_id: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT payload_json
        FROM workstation_events
        WHERE project_path = ?
          AND chat_id = ?
          AND event_type = 'activity'
        ORDER BY id DESC
        LIMIT 1
        """,
        (project_path, chat_id),
    ).fetchone()
    if row is None:
        return None
    payload = json.loads(row["payload_json"])
    return payload if isinstance(payload, dict) else None


def list_workstation_events(
    project_path: str,
    chat_id: str,
    *,
    after_id: int = 0,
    limit: int = 100,
) -> list[WorkstationEventRecord]:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        return []

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, project_path, chat_id, agent_deck_session_id, event_type, payload_json, created_at
            FROM workstation_events
            WHERE project_path = ?
              AND chat_id = ?
              AND id > ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (normalized_project_path, normalized_chat_id, max(after_id, 0), max(limit, 1)),
        ).fetchall()

    return [_row_to_event_record(row) for row in rows]


def append_workstation_event(
    project_path: str,
    chat_id: str,
    *,
    agent_deck_session_id: str | None,
    event_type: str,
    payload: dict[str, Any],
) -> WorkstationEventRecord:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    normalized_event_type = event_type.strip()
    if not normalized_chat_id:
        raise ValueError("chat_id is required")
    if not normalized_event_type:
        raise ValueError("event_type is required")

    normalized_payload = normalize_workstation_event_payload(
        normalized_chat_id,
        payload,
    )

    with _connect() as conn:
        record = _append_event(
            conn,
            project_path=normalized_project_path,
            chat_id=normalized_chat_id,
            agent_deck_session_id=agent_deck_session_id,
            event_type=normalized_event_type,
            payload=normalized_payload,
        )
        conn.commit()
        return record


def latest_workstation_event(
    project_path: str,
    chat_id: str,
    *,
    event_type: str,
) -> WorkstationEventRecord | None:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    normalized_event_type = event_type.strip()
    if not normalized_chat_id or not normalized_event_type:
        return None

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT id, project_path, chat_id, agent_deck_session_id, event_type, payload_json, created_at
            FROM workstation_events
            WHERE project_path = ?
              AND chat_id = ?
              AND event_type = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (
                normalized_project_path,
                normalized_chat_id,
                normalized_event_type,
            ),
        ).fetchone()

    if row is None:
        return None
    return _row_to_event_record(row)


def latest_workstation_event_id(
    project_path: str,
    chat_id: str,
) -> int:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        return 0

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT COALESCE(MAX(id), 0) AS latest_id
            FROM workstation_events
            WHERE project_path = ?
              AND chat_id = ?
            """,
            (normalized_project_path, normalized_chat_id),
        ).fetchone()

    if row is None:
        return 0
    value = row["latest_id"]
    return int(value) if isinstance(value, int) else 0


def chat_has_typed_turn_events(project_path: str, chat_id: str) -> bool:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        return False

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT 1
            FROM workstation_events
            WHERE project_path = ?
              AND chat_id = ?
              AND event_type LIKE 'turn_%'
            LIMIT 1
            """,
            (normalized_project_path, normalized_chat_id),
        ).fetchone()
    return row is not None


def chat_has_primary_workstation_events(project_path: str, chat_id: str) -> bool:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        return False

    event_types = sorted(PRIMARY_EVENT_TYPES)
    placeholders = ",".join("?" for _ in event_types)
    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT 1
            FROM workstation_events
            WHERE project_path = ?
              AND chat_id = ?
              AND event_type IN ({placeholders})
            LIMIT 1
            """,
            (normalized_project_path, normalized_chat_id, *event_types),
        ).fetchone()
    return row is not None


def request_has_terminal_workstation_event(
    project_path: str,
    chat_id: str,
    request_id: str,
) -> bool:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    normalized_request_id = request_id.strip()
    if not normalized_chat_id or not normalized_request_id:
        return False

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT 1
            FROM workstation_events
            WHERE project_path = ?
              AND chat_id = ?
              AND event_type IN ('turn_completed', 'turn_failed')
              AND json_extract(payload_json, '$.request_id') = ?
            LIMIT 1
            """,
            (
                normalized_project_path,
                normalized_chat_id,
                normalized_request_id,
            ),
        ).fetchone()
    return row is not None


def _is_missing_session_error(error: BaseException | str) -> bool:
    message = str(error).lower()
    return (
        "not_found" in message
        or "not found" in message
        or "session missing" in message
    )


def _activity_snapshot(
    *,
    project_path: str,
    chat_id: str,
    workspace_path: str,
    agent_deck_session_id: str | None,
    agent_deck_session_title: str | None,
    agent_deck_tool: str | None,
    agent_deck_session_status: str | None,
    binding_state: str,
    output: str,
) -> dict[str, Any]:
    return {
        "chat_id": chat_id,
        "thread_id": chat_id,
        "agent_deck_session_id": agent_deck_session_id,
        "agent_deck_session_title": agent_deck_session_title,
        "agent_deck_tool": agent_deck_tool,
        "agent_deck_session_status": agent_deck_session_status,
        "workspace_path": workspace_path,
        "binding_state": binding_state,
        "output": output,
    }


async def _build_current_activity_snapshot(
    project_path: str,
    chat_id: str,
) -> tuple[str | None, dict[str, Any]]:
    session_record = get_project_session(project_path, chat_id)
    if session_record is None:
        raise ValueError("Chat not found")

    if not session_record.agent_deck_session_id:
        return None, _activity_snapshot(
            project_path=project_path,
            chat_id=chat_id,
            workspace_path=session_record.workspace_path,
            agent_deck_session_id=None,
            agent_deck_session_title=session_record.agent_deck_session_title,
            agent_deck_tool=session_record.agent_deck_tool,
            agent_deck_session_status=None,
            binding_state="detached",
            output="",
        )

    try:
        activity = await get_agent_deck_session_activity(
            project_path,
            session_record.agent_deck_session_id,
        )
        return activity.session_id, _activity_snapshot(
            project_path=project_path,
            chat_id=chat_id,
            workspace_path=activity.workspace_path,
            agent_deck_session_id=activity.session_id,
            agent_deck_session_title=activity.session_title,
            agent_deck_tool=activity.tool,
            agent_deck_session_status=activity.status,
            binding_state="attached",
            output=activity.output,
        )
    except AgentDeckBridgeError as exc:
        if not _is_missing_session_error(exc):
            raise

    detached = detach_project_session_binding(project_path, chat_id)
    detached_workspace_path = (
        detached.workspace_path
        if detached is not None
        else session_record.workspace_path
    )
    detached_title = (
        detached.agent_deck_session_title
        if detached is not None
        else session_record.agent_deck_session_title
    )
    detached_tool = (
        detached.agent_deck_tool
        if detached is not None
        else session_record.agent_deck_tool
    )
    return None, _activity_snapshot(
        project_path=project_path,
        chat_id=chat_id,
        workspace_path=detached_workspace_path,
        agent_deck_session_id=None,
        agent_deck_session_title=detached_title,
        agent_deck_tool=detached_tool,
        agent_deck_session_status=None,
        binding_state="detached",
        output="",
    )


async def sync_chat_activity_event(
    project_path: str,
    chat_id: str,
) -> WorkstationEventRecord | None:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        raise ValueError("chat_id is required")

    agent_deck_session_id, snapshot = await _build_current_activity_snapshot(
        normalized_project_path,
        normalized_chat_id,
    )

    with _connect() as conn:
        latest = _latest_activity_payload(
            conn,
            project_path=normalized_project_path,
            chat_id=normalized_chat_id,
        )
        if latest == snapshot:
            return None
        record = _append_event(
            conn,
            project_path=normalized_project_path,
            chat_id=normalized_chat_id,
            agent_deck_session_id=agent_deck_session_id,
            event_type="activity",
            payload=snapshot,
        )
        conn.commit()
        return record


async def get_chat_activity_snapshot(
    project_path: str,
    chat_id: str,
) -> dict[str, Any]:
    normalized_project_path = normalize_project_path(project_path)
    normalized_chat_id = chat_id.strip()
    if not normalized_chat_id:
        raise ValueError("chat_id is required")

    await sync_chat_activity_event(normalized_project_path, normalized_chat_id)
    with _connect() as conn:
        latest = _latest_activity_payload(
            conn,
            project_path=normalized_project_path,
            chat_id=normalized_chat_id,
        )
    if latest is not None:
        return latest

    session_record = get_project_session(normalized_project_path, normalized_chat_id)
    if session_record is None:
        raise ValueError("Chat not found")

    return _activity_snapshot(
        project_path=normalized_project_path,
        chat_id=normalized_chat_id,
        workspace_path=session_record.workspace_path,
        agent_deck_session_id=session_record.agent_deck_session_id,
        agent_deck_session_title=session_record.agent_deck_session_title,
        agent_deck_tool=session_record.agent_deck_tool,
        agent_deck_session_status=None,
        binding_state="attached" if session_record.agent_deck_session_id else "detached",
        output="",
    )
