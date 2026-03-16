from __future__ import annotations

import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path


_DB_LOCK = threading.Lock()
_DB_INITIALIZED = False


@dataclass(slots=True)
class LiveEditorThreadRecord:
    thread_id: str
    project_path: str
    backend: str
    agent_deck_session_id: str | None
    agent_deck_session_title: str | None
    claude_session_id: str | None
    last_request_id: str | None
    created_at: str
    updated_at: str


def _state_dir() -> Path:
    xdg_state_home = os.environ.get("XDG_STATE_HOME")
    base_dir = Path(xdg_state_home) if xdg_state_home else Path.home() / ".local" / "state"
    state_dir = base_dir / "pixel-forge"
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir


def _db_path() -> Path:
    return _state_dir() / "live-editor.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    global _DB_INITIALIZED
    if _DB_INITIALIZED:
        return

    with _DB_LOCK:
        if _DB_INITIALIZED:
            return

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS live_editor_threads (
                thread_id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                backend TEXT NOT NULL,
                agent_deck_session_id TEXT,
                agent_deck_session_title TEXT,
                claude_session_id TEXT,
                last_request_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()
        _DB_INITIALIZED = True


def _row_to_record(row: sqlite3.Row) -> LiveEditorThreadRecord:
    return LiveEditorThreadRecord(
        thread_id=row["thread_id"],
        project_path=row["project_path"],
        backend=row["backend"],
        agent_deck_session_id=row["agent_deck_session_id"],
        agent_deck_session_title=row["agent_deck_session_title"],
        claude_session_id=row["claude_session_id"],
        last_request_id=row["last_request_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def get_live_editor_thread(thread_id: str) -> LiveEditorThreadRecord | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT thread_id, project_path, backend, agent_deck_session_id,
                   agent_deck_session_title, claude_session_id, last_request_id,
                   created_at, updated_at
            FROM live_editor_threads
            WHERE thread_id = ?
            """,
            (thread_id,),
        ).fetchone()

    if row is None:
        return None
    return _row_to_record(row)


def get_or_create_live_editor_thread(
    project_path: str,
    thread_id: str | None = None,
) -> LiveEditorThreadRecord:
    normalized_project_path = str(Path(project_path).resolve())

    if thread_id:
        existing = get_live_editor_thread(thread_id)
        if existing:
            if existing.project_path != normalized_project_path:
                raise ValueError(
                    "Live Editor thread is bound to a different project path"
                )
            return existing

    record_id = thread_id or str(uuid.uuid4())

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO live_editor_threads (
                thread_id,
                project_path,
                backend
            ) VALUES (?, ?, ?)
            """,
            (record_id, normalized_project_path, "agent-deck"),
        )
        conn.commit()

    created = get_live_editor_thread(record_id)
    if created is None:
        raise RuntimeError("Failed to create live editor thread record")
    return created


def update_live_editor_thread(
    thread_id: str,
    *,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    claude_session_id: str | None = None,
    last_request_id: str | None = None,
) -> LiveEditorThreadRecord:
    assignments: list[str] = ["updated_at = CURRENT_TIMESTAMP"]
    values: list[str] = []

    if agent_deck_session_id is not None:
        assignments.append("agent_deck_session_id = ?")
        values.append(agent_deck_session_id)
    if agent_deck_session_title is not None:
        assignments.append("agent_deck_session_title = ?")
        values.append(agent_deck_session_title)
    if claude_session_id is not None:
        assignments.append("claude_session_id = ?")
        values.append(claude_session_id)
    if last_request_id is not None:
        assignments.append("last_request_id = ?")
        values.append(last_request_id)

    values.append(thread_id)

    with _connect() as conn:
        conn.execute(
            f"""
            UPDATE live_editor_threads
            SET {", ".join(assignments)}
            WHERE thread_id = ?
            """,
            values,
        )
        conn.commit()

    updated = get_live_editor_thread(thread_id)
    if updated is None:
        raise RuntimeError("Live Editor thread record disappeared during update")
    return updated
