from __future__ import annotations

import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from state_db import connect as connect_state_db
from state_db import db_path as state_db_path
from state_db import ensure_migration_markers_table
from state_db import has_migration_marker
from state_db import legacy_instance_db_paths
from state_db import legacy_live_editor_db_path
from state_db import set_migration_marker


_DB_LOCK = threading.Lock()
_DB_INITIALIZED = False


@dataclass(slots=True)
class LiveEditorThreadRecord:
    thread_id: str
    profile_id: str
    project_path: str
    workspace_path: str
    backend: str
    agent_deck_session_id: str | None
    agent_deck_session_title: str | None
    acpx_agent: str | None
    acpx_session_name: str | None
    acpx_record_id: str | None
    acp_session_id: str | None
    claude_session_id: str | None
    last_request_id: str | None
    last_live_preview_hash: str | None
    created_at: str
    updated_at: str
    provider_id: str | None = None
    provider_session_id: str | None = None
    provider_session_title: str | None = None
    provider_agent_id: str | None = None


def _db_path() -> Path:
    return state_db_path()


def _connect() -> sqlite3.Connection:
    conn = connect_state_db()
    _ensure_schema(conn)
    return conn


def _normalize_optional_text(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _normalize_project_path(project_path: str) -> str:
    return os.path.abspath(os.path.expanduser(project_path))


def _normalize_provider_binding(
    *,
    provider_id: str | None = None,
    provider_session_id: str | None = None,
    provider_session_title: str | None = None,
    provider_agent_id: str | None = None,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
) -> tuple[str | None, str | None, str | None, str | None, str | None, str | None]:
    normalized_provider_id = _normalize_optional_text(provider_id)
    normalized_provider_session_id = _normalize_optional_text(provider_session_id)
    normalized_provider_session_title = (
        _normalize_optional_text(provider_session_title)
        or _normalize_optional_text(agent_deck_session_title)
    )
    normalized_provider_agent_id = _normalize_optional_text(provider_agent_id)
    normalized_agent_deck_session_id = _normalize_optional_text(agent_deck_session_id)
    normalized_agent_deck_session_title = _normalize_optional_text(agent_deck_session_title)

    if normalized_agent_deck_session_id and not normalized_provider_session_id:
        normalized_provider_id = "agent-deck"
        normalized_provider_session_id = normalized_agent_deck_session_id
    if normalized_provider_id == "agent-deck":
        normalized_agent_deck_session_id = (
            normalized_agent_deck_session_id or normalized_provider_session_id
        )
        normalized_agent_deck_session_title = (
            normalized_agent_deck_session_title or normalized_provider_session_title
        )
    if not normalized_provider_session_id and not (
        normalized_provider_id
        or normalized_provider_session_title
        or normalized_provider_agent_id
    ):
        normalized_provider_id = None

    return (
        normalized_provider_id,
        normalized_provider_session_id,
        normalized_provider_session_title,
        normalized_provider_agent_id,
        normalized_agent_deck_session_id,
        normalized_agent_deck_session_title,
    )


def _migrate_legacy_rows(conn: sqlite3.Connection) -> None:
    legacy_path = legacy_live_editor_db_path()
    if legacy_path == _db_path() or not legacy_path.is_file():
        return
    marker_key = f"live-editor-threads:legacy-live-editor:{legacy_path.resolve()}"
    if has_migration_marker(conn, marker_key):
        return

    with sqlite3.connect(legacy_path) as legacy_conn:
        legacy_conn.row_factory = sqlite3.Row
        tables = legacy_conn.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'live_editor_threads'
            """
        ).fetchone()
        if tables is None:
            return

        rows = legacy_conn.execute(
            """
            SELECT thread_id, project_path, project_path AS workspace_path, backend, agent_deck_session_id,
                   agent_deck_session_title, NULL AS acpx_agent,
                   NULL AS acpx_session_name, NULL AS acpx_record_id,
                   NULL AS acp_session_id, claude_session_id, last_request_id,
                   created_at, updated_at
            FROM live_editor_threads
            """
        ).fetchall()

    for row in rows:
        conn.execute(
            """
            INSERT OR IGNORE INTO live_editor_threads (
                thread_id,
                profile_id,
                project_path,
                workspace_path,
                backend,
                agent_deck_session_id,
                agent_deck_session_title,
                acpx_agent,
                acpx_session_name,
                acpx_record_id,
                acp_session_id,
                claude_session_id,
                last_request_id,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["thread_id"],
                "default",
                _normalize_project_path(row["project_path"]),
                _normalize_project_path(row["workspace_path"]),
                row["backend"],
                row["agent_deck_session_id"],
                row["agent_deck_session_title"],
                row["acpx_agent"],
                row["acpx_session_name"],
                row["acpx_record_id"],
                row["acp_session_id"],
                row["claude_session_id"],
                row["last_request_id"],
                row["created_at"],
                row["updated_at"],
            ),
        )
    set_migration_marker(conn, marker_key)


def _migrate_legacy_instance_rows(conn: sqlite3.Connection) -> None:
    for legacy_path in legacy_instance_db_paths():
        if legacy_path == _db_path() or not legacy_path.is_file():
            continue
        marker_key = f"live-editor-threads:legacy-instance:{legacy_path.resolve()}"
        if has_migration_marker(conn, marker_key):
            continue

        with sqlite3.connect(legacy_path) as legacy_conn:
            legacy_conn.row_factory = sqlite3.Row
            tables = legacy_conn.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'live_editor_threads'
                """
            ).fetchone()
            if tables is None:
                continue

            rows = legacy_conn.execute(
                """
                SELECT thread_id, project_path, project_path AS workspace_path, backend, agent_deck_session_id,
                       agent_deck_session_title, NULL AS acpx_agent,
                       NULL AS acpx_session_name, NULL AS acpx_record_id,
                       NULL AS acp_session_id, claude_session_id, last_request_id,
                       created_at, updated_at
                FROM live_editor_threads
                """
            ).fetchall()

        for row in rows:
            conn.execute(
                """
                INSERT OR IGNORE INTO live_editor_threads (
                    thread_id,
                    profile_id,
                    project_path,
                    workspace_path,
                    backend,
                    agent_deck_session_id,
                    agent_deck_session_title,
                    acpx_agent,
                    acpx_session_name,
                    acpx_record_id,
                    acp_session_id,
                    claude_session_id,
                    last_request_id,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["thread_id"],
                    "default",
                    _normalize_project_path(row["project_path"]),
                    _normalize_project_path(row["workspace_path"]),
                    row["backend"],
                    row["agent_deck_session_id"],
                    row["agent_deck_session_title"],
                    row["acpx_agent"],
                    row["acpx_session_name"],
                    row["acpx_record_id"],
                    row["acp_session_id"],
                    row["claude_session_id"],
                    row["last_request_id"],
                    row["created_at"],
                    row["updated_at"],
                ),
            )
        set_migration_marker(conn, marker_key)


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
                profile_id TEXT NOT NULL DEFAULT 'default',
                project_path TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                backend TEXT NOT NULL,
                provider_id TEXT,
                provider_session_id TEXT,
                provider_session_title TEXT,
                provider_agent_id TEXT,
                agent_deck_session_id TEXT,
                agent_deck_session_title TEXT,
                acpx_agent TEXT,
                acpx_session_name TEXT,
                acpx_record_id TEXT,
                acp_session_id TEXT,
                claude_session_id TEXT,
                last_request_id TEXT,
                last_live_preview_hash TEXT,
                hidden_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        ensure_migration_markers_table(conn)
        existing_columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(live_editor_threads)").fetchall()
        }
        for column_name in (
            "profile_id",
            "workspace_path",
            "acpx_agent",
            "acpx_session_name",
            "acpx_record_id",
            "acp_session_id",
            "hidden_at",
            "last_live_preview_hash",
            "provider_id",
            "provider_session_id",
            "provider_session_title",
            "provider_agent_id",
        ):
            if column_name in existing_columns:
                continue
            if column_name == "profile_id":
                conn.execute(
                    "ALTER TABLE live_editor_threads ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'"
                )
            else:
                conn.execute(
                    f"ALTER TABLE live_editor_threads ADD COLUMN {column_name} TEXT"
                )
        conn.execute(
            """
            UPDATE live_editor_threads
            SET workspace_path = project_path
            WHERE workspace_path IS NULL OR TRIM(workspace_path) = ''
            """
        )
        conn.execute(
            """
            UPDATE live_editor_threads
            SET profile_id = 'default'
            WHERE profile_id IS NULL OR TRIM(profile_id) = ''
            """
        )
        conn.execute(
            """
            UPDATE live_editor_threads
            SET provider_id = 'agent-deck',
                provider_session_id = agent_deck_session_id,
                provider_session_title = agent_deck_session_title
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
              AND (provider_session_id IS NULL OR TRIM(provider_session_id) = '')
            """
        )
        conn.execute(
            """
            UPDATE live_editor_threads
            SET agent_deck_session_id = provider_session_id,
                agent_deck_session_title = provider_session_title
            WHERE provider_id = 'agent-deck'
              AND provider_session_id IS NOT NULL
              AND TRIM(provider_session_id) <> ''
              AND (agent_deck_session_id IS NULL OR TRIM(agent_deck_session_id) = '')
            """
        )
        _migrate_legacy_rows(conn)
        _migrate_legacy_instance_rows(conn)
        conn.execute(
            """
            UPDATE live_editor_threads
            SET provider_id = 'agent-deck',
                provider_session_id = agent_deck_session_id,
                provider_session_title = agent_deck_session_title
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
              AND (provider_session_id IS NULL OR TRIM(provider_session_id) = '')
            """
        )
        conn.commit()
        _DB_INITIALIZED = True


def _column_or_none(row: sqlite3.Row, column: str) -> str | None:
    try:
        value = row[column]
    except (IndexError, KeyError):
        return None
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _row_to_record(row: sqlite3.Row) -> LiveEditorThreadRecord:
    return LiveEditorThreadRecord(
        thread_id=row["thread_id"],
        profile_id=str(row["profile_id"] or "default").strip() or "default",
        project_path=row["project_path"],
        workspace_path=row["workspace_path"] or row["project_path"],
        backend=row["backend"],
        provider_id=_column_or_none(row, "provider_id"),
        provider_session_id=_column_or_none(row, "provider_session_id"),
        provider_session_title=_column_or_none(row, "provider_session_title"),
        provider_agent_id=_column_or_none(row, "provider_agent_id"),
        agent_deck_session_id=row["agent_deck_session_id"],
        agent_deck_session_title=row["agent_deck_session_title"],
        acpx_agent=row["acpx_agent"],
        acpx_session_name=row["acpx_session_name"],
        acpx_record_id=row["acpx_record_id"],
        acp_session_id=row["acp_session_id"],
        claude_session_id=row["claude_session_id"],
        last_request_id=row["last_request_id"],
        last_live_preview_hash=_column_or_none(row, "last_live_preview_hash"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def get_live_editor_thread(
    thread_id: str,
    *,
    profile_id: str = "default",
) -> LiveEditorThreadRecord | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT thread_id, profile_id, project_path, workspace_path, backend,
                   provider_id, provider_session_id, provider_session_title, provider_agent_id,
                   agent_deck_session_id,
                   agent_deck_session_title, acpx_agent, acpx_session_name,
                   acpx_record_id, acp_session_id, claude_session_id, last_request_id, last_live_preview_hash,
                   created_at, updated_at
            FROM live_editor_threads
            WHERE thread_id = ?
              AND profile_id = ?
              AND hidden_at IS NULL
            """,
            (thread_id, profile_id),
        ).fetchone()

    if row is None:
        return None
    return _row_to_record(row)


def get_or_create_live_editor_thread(
    project_path: str,
    thread_id: str | None = None,
    *,
    profile_id: str = "default",
) -> LiveEditorThreadRecord:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_profile_id = str(profile_id or "default").strip() or "default"

    if thread_id:
        existing = get_live_editor_thread(thread_id, profile_id=normalized_profile_id)
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
                profile_id,
                project_path,
                workspace_path,
                backend,
                provider_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                profile_id = excluded.profile_id,
                project_path = excluded.project_path,
                workspace_path = excluded.workspace_path,
                backend = excluded.backend,
                provider_id = COALESCE(live_editor_threads.provider_id, excluded.provider_id),
                hidden_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                record_id,
                normalized_profile_id,
                normalized_project_path,
                normalized_project_path,
                "agent-deck",
                "agent-deck",
            ),
        )
        conn.commit()

    created = get_live_editor_thread(record_id, profile_id=normalized_profile_id)
    if created is None:
        raise RuntimeError("Failed to create live editor thread record")
    return created


def update_live_editor_thread(
    thread_id: str,
    *,
    profile_id: str = "default",
    backend: str | None = None,
    workspace_path: str | None = None,
    provider_id: str | None = None,
    provider_session_id: str | None = None,
    provider_session_title: str | None = None,
    provider_agent_id: str | None = None,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    acpx_agent: str | None = None,
    acpx_session_name: str | None = None,
    acpx_record_id: str | None = None,
    acp_session_id: str | None = None,
    claude_session_id: str | None = None,
    last_request_id: str | None = None,
    last_live_preview_hash: str | None = None,
) -> LiveEditorThreadRecord:
    assignments: list[str] = ["updated_at = CURRENT_TIMESTAMP"]
    values: list[str] = []

    (
        normalized_provider_id,
        normalized_provider_session_id,
        normalized_provider_session_title,
        normalized_provider_agent_id,
        normalized_agent_deck_session_id,
        normalized_agent_deck_session_title,
    ) = _normalize_provider_binding(
        provider_id=provider_id,
        provider_session_id=provider_session_id,
        provider_session_title=provider_session_title,
        provider_agent_id=provider_agent_id,
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_session_title,
    )

    if (
        provider_id is not None
        or provider_session_id is not None
        or provider_session_title is not None
        or provider_agent_id is not None
        or agent_deck_session_id is not None
    ):
        assignments.append("provider_id = ?")
        values.append(normalized_provider_id)
        assignments.append("provider_session_id = ?")
        values.append(normalized_provider_session_id)
        assignments.append("provider_session_title = ?")
        values.append(normalized_provider_session_title)
        assignments.append("provider_agent_id = ?")
        values.append(normalized_provider_agent_id)
        assignments.append("agent_deck_session_id = ?")
        values.append(normalized_agent_deck_session_id)
    if workspace_path is not None:
        assignments.append("workspace_path = ?")
        values.append(_normalize_project_path(workspace_path))
    if backend is not None:
        assignments.append("backend = ?")
        values.append(backend.strip() or "agent-deck")
    if provider_session_title is not None or agent_deck_session_title is not None:
        assignments.append("agent_deck_session_title = ?")
        values.append(normalized_agent_deck_session_title)
    if acpx_agent is not None:
        assignments.append("acpx_agent = ?")
        values.append(acpx_agent)
    if acpx_session_name is not None:
        assignments.append("acpx_session_name = ?")
        values.append(acpx_session_name)
    if acpx_record_id is not None:
        assignments.append("acpx_record_id = ?")
        values.append(acpx_record_id)
    if acp_session_id is not None:
        assignments.append("acp_session_id = ?")
        values.append(acp_session_id)
    if claude_session_id is not None:
        assignments.append("claude_session_id = ?")
        values.append(claude_session_id)
    if last_request_id is not None:
        assignments.append("last_request_id = ?")
        values.append(last_request_id)
    if last_live_preview_hash is not None:
        assignments.append("last_live_preview_hash = ?")
        values.append(last_live_preview_hash)

    values.append(thread_id)
    values.append(profile_id)

    with _connect() as conn:
        conn.execute(
            f"""
            UPDATE live_editor_threads
            SET {", ".join(assignments)}
            WHERE thread_id = ?
              AND profile_id = ?
            """,
            values,
        )
        conn.commit()

    updated = get_live_editor_thread(thread_id, profile_id=profile_id)
    if updated is None:
        raise RuntimeError("Live Editor thread record disappeared during update")
    return updated


def detach_missing_agent_deck_thread_bindings(
    project_path: str,
    available_session_ids: set[str] | list[str] | tuple[str, ...],
    *,
    profile_id: str = "default",
) -> list[LiveEditorThreadRecord]:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_profile_id = str(profile_id or "default").strip() or "default"
    available_ids = {
        session_id.strip()
        for session_id in available_session_ids
        if isinstance(session_id, str) and session_id.strip()
    }

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT thread_id, profile_id, project_path, workspace_path, backend,
                   provider_id, provider_session_id, provider_session_title, provider_agent_id,
                   agent_deck_session_id,
                   agent_deck_session_title, acpx_agent, acpx_session_name,
                   acpx_record_id, acp_session_id, claude_session_id, last_request_id, last_live_preview_hash,
                   created_at, updated_at
            FROM live_editor_threads
            WHERE project_path = ?
              AND profile_id = ?
              AND hidden_at IS NULL
            ORDER BY updated_at DESC, created_at DESC
            """,
            (normalized_project_path, normalized_profile_id),
        ).fetchall()
        detached_thread_ids = [
            str(row["thread_id"])
            for row in rows
            if isinstance(row["agent_deck_session_id"], str)
            and str(row["agent_deck_session_id"]).strip()
            and str(row["agent_deck_session_id"]).strip() not in available_ids
        ]
        if detached_thread_ids:
            placeholders = ",".join("?" for _ in detached_thread_ids)
            conn.execute(
                f"""
                UPDATE live_editor_threads
                SET provider_id = NULL,
                    provider_session_id = NULL,
                    provider_session_title = NULL,
                    provider_agent_id = NULL,
                    agent_deck_session_id = NULL,
                    agent_deck_session_title = NULL,
                    acpx_agent = NULL,
                    acpx_session_name = NULL,
                    acpx_record_id = NULL,
                    acp_session_id = NULL,
                    claude_session_id = NULL,
                    last_request_id = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE project_path = ?
                  AND profile_id = ?
                  AND thread_id IN ({placeholders})
                """,
                (normalized_project_path, normalized_profile_id, *detached_thread_ids),
            )
            conn.commit()

        refreshed_rows = conn.execute(
            """
            SELECT thread_id, profile_id, project_path, workspace_path, backend,
                   provider_id, provider_session_id, provider_session_title, provider_agent_id,
                   agent_deck_session_id,
                   agent_deck_session_title, acpx_agent, acpx_session_name,
                   acpx_record_id, acp_session_id, claude_session_id, last_request_id, last_live_preview_hash,
                   created_at, updated_at
            FROM live_editor_threads
            WHERE project_path = ?
              AND profile_id = ?
              AND hidden_at IS NULL
            ORDER BY updated_at DESC, created_at DESC
            """,
            (normalized_project_path, normalized_profile_id),
        ).fetchall()

    return [_row_to_record(row) for row in refreshed_rows]


def delete_live_editor_thread(
    thread_id: str,
    *,
    profile_id: str = "default",
    purge: bool = False,
) -> bool:
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return False
    normalized_profile_id = str(profile_id or "default").strip() or "default"

    with _connect() as conn:
        if purge:
            result = conn.execute(
                """
                DELETE FROM live_editor_threads
                WHERE thread_id = ?
                  AND profile_id = ?
                """,
                (normalized_thread_id, normalized_profile_id),
            )
        else:
            result = conn.execute(
                """
                UPDATE live_editor_threads
                SET hidden_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE thread_id = ?
                  AND profile_id = ?
                  AND hidden_at IS NULL
                """,
                (normalized_thread_id, normalized_profile_id),
            )
        conn.commit()

    return result.rowcount > 0


def purge_hidden_live_editor_threads(*, profile_id: str = "default") -> int:
    normalized_profile_id = str(profile_id or "default").strip() or "default"
    with _connect() as conn:
        result = conn.execute(
            """
            DELETE FROM live_editor_threads
            WHERE profile_id = ?
              AND hidden_at IS NOT NULL
            """,
            (normalized_profile_id,),
        )
        conn.commit()
    return int(result.rowcount or 0)
