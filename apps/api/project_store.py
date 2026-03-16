from __future__ import annotations

import os
import sqlite3
import threading
from dataclasses import dataclass

from state_db import connect as connect_state_db
from state_db import legacy_live_editor_db_path


_DB_LOCK = threading.Lock()
_DB_INITIALIZED = False


@dataclass(slots=True)
class ProjectUrlRecord:
    url: str
    last_used: str
    use_count: int


@dataclass(slots=True)
class ProjectRecord:
    path: str
    name: str
    output_mode: str
    custom_output_path: str | None
    created_at: str
    last_opened: str
    urls: list[ProjectUrlRecord]


@dataclass(slots=True)
class SessionRecord:
    id: int
    project_path: str
    thread_id: str
    backend: str
    agent_deck_session_id: str | None
    agent_deck_session_title: str | None
    created_at: str
    last_active: str


def normalize_project_path(project_path: str) -> str:
    return os.path.abspath(os.path.expanduser(project_path))


def project_name_for_path(project_path: str) -> str:
    normalized_path = normalize_project_path(project_path).rstrip(os.sep)
    return os.path.basename(normalized_path) or normalized_path


def _connect() -> sqlite3.Connection:
    conn = connect_state_db()
    _ensure_schema(conn)
    return conn


def _migrate_legacy_live_editor_state(conn: sqlite3.Connection) -> None:
    legacy_path = legacy_live_editor_db_path()
    if not legacy_path.is_file():
        return

    with sqlite3.connect(legacy_path) as legacy_conn:
        legacy_conn.row_factory = sqlite3.Row
        table_exists = legacy_conn.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'live_editor_threads'
            """
        ).fetchone()
        if table_exists is None:
            return

        rows = legacy_conn.execute(
            """
            SELECT thread_id, project_path, backend, agent_deck_session_id,
                   agent_deck_session_title, created_at, updated_at
            FROM live_editor_threads
            ORDER BY updated_at DESC
            """
        ).fetchall()

    for row in rows:
        normalized_path = normalize_project_path(row["project_path"])
        conn.execute(
            """
            INSERT OR IGNORE INTO projects (
                path,
                name,
                output_mode,
                custom_output_path,
                created_at,
                last_opened
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                normalized_path,
                project_name_for_path(normalized_path),
                "scratch",
                None,
                row["created_at"],
                row["updated_at"],
            ),
        )
        conn.execute(
            """
            INSERT INTO sessions (
                project_path,
                thread_id,
                backend,
                agent_deck_session_id,
                agent_deck_session_title,
                created_at,
                last_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                project_path = excluded.project_path,
                backend = excluded.backend,
                agent_deck_session_id = excluded.agent_deck_session_id,
                agent_deck_session_title = excluded.agent_deck_session_title,
                last_active = excluded.last_active
            """,
            (
                normalized_path,
                row["thread_id"],
                row["backend"],
                row["agent_deck_session_id"],
                row["agent_deck_session_title"],
                row["created_at"],
                row["updated_at"],
            ),
        )


def _ensure_schema(conn: sqlite3.Connection) -> None:
    global _DB_INITIALIZED
    if _DB_INITIALIZED:
        return

    with _DB_LOCK:
        if _DB_INITIALIZED:
            return

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                output_mode TEXT NOT NULL DEFAULT 'scratch',
                custom_output_path TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_opened TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS project_urls (
                project_path TEXT NOT NULL,
                url TEXT NOT NULL,
                last_used TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                use_count INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (project_path, url),
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                thread_id TEXT NOT NULL UNIQUE,
                backend TEXT NOT NULL,
                agent_deck_session_id TEXT,
                agent_deck_session_title TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_projects_last_opened
                ON projects (last_opened DESC);
            CREATE INDEX IF NOT EXISTS idx_project_urls_last_used
                ON project_urls (project_path, last_used DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_last_active
                ON sessions (project_path, last_active DESC);
            """
        )
        _migrate_legacy_live_editor_state(conn)
        conn.commit()
        _DB_INITIALIZED = True


def _row_to_url_record(row: sqlite3.Row) -> ProjectUrlRecord:
    return ProjectUrlRecord(
        url=row["url"],
        last_used=row["last_used"],
        use_count=row["use_count"],
    )


def _row_to_session_record(row: sqlite3.Row) -> SessionRecord:
    return SessionRecord(
        id=row["id"],
        project_path=row["project_path"],
        thread_id=row["thread_id"],
        backend=row["backend"],
        agent_deck_session_id=row["agent_deck_session_id"],
        agent_deck_session_title=row["agent_deck_session_title"],
        created_at=row["created_at"],
        last_active=row["last_active"],
    )


def list_project_urls(project_path: str) -> list[ProjectUrlRecord]:
    normalized_path = normalize_project_path(project_path)

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT url, last_used, use_count
            FROM project_urls
            WHERE project_path = ?
            ORDER BY last_used DESC, use_count DESC, url ASC
            """,
            (normalized_path,),
        ).fetchall()

    return [_row_to_url_record(row) for row in rows]


def list_project_sessions(project_path: str) -> list[SessionRecord]:
    normalized_path = normalize_project_path(project_path)

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, project_path, thread_id, backend, agent_deck_session_id,
                   agent_deck_session_title, created_at, last_active
            FROM sessions
            WHERE project_path = ?
            ORDER BY last_active DESC, id DESC
            """,
            (normalized_path,),
        ).fetchall()

    return [_row_to_session_record(row) for row in rows]


def get_project(project_path: str) -> ProjectRecord | None:
    normalized_path = normalize_project_path(project_path)

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT path, name, output_mode, custom_output_path, created_at, last_opened
            FROM projects
            WHERE path = ?
            """,
            (normalized_path,),
        ).fetchone()

    if row is None:
        return None

    return ProjectRecord(
        path=row["path"],
        name=row["name"],
        output_mode=row["output_mode"],
        custom_output_path=row["custom_output_path"],
        created_at=row["created_at"],
        last_opened=row["last_opened"],
        urls=list_project_urls(normalized_path),
    )


def list_projects() -> list[ProjectRecord]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT path, name, output_mode, custom_output_path, created_at, last_opened
            FROM projects
            ORDER BY last_opened DESC, created_at DESC, path ASC
            """
        ).fetchall()

    return [
        ProjectRecord(
            path=row["path"],
            name=row["name"],
            output_mode=row["output_mode"],
            custom_output_path=row["custom_output_path"],
            created_at=row["created_at"],
            last_opened=row["last_opened"],
            urls=list_project_urls(row["path"]),
        )
        for row in rows
    ]


def upsert_project(
    project_path: str,
    *,
    name: str | None = None,
    output_mode: str = "scratch",
    custom_output_path: str | None = None,
) -> ProjectRecord:
    normalized_path = normalize_project_path(project_path)
    normalized_name = (name or project_name_for_path(normalized_path)).strip() or project_name_for_path(normalized_path)
    normalized_output_mode = "custom" if output_mode == "custom" else "scratch"
    normalized_custom_output_path = (
        custom_output_path.strip() if normalized_output_mode == "custom" and custom_output_path else None
    )

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO projects (
                path,
                name,
                output_mode,
                custom_output_path
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                output_mode = excluded.output_mode,
                custom_output_path = excluded.custom_output_path,
                last_opened = CURRENT_TIMESTAMP
            """,
            (
                normalized_path,
                normalized_name,
                normalized_output_mode,
                normalized_custom_output_path,
            ),
        )
        conn.commit()

    project = get_project(normalized_path)
    if project is None:
        raise RuntimeError("Project record disappeared during upsert")
    return project


def delete_project(project_path: str) -> bool:
    normalized_path = normalize_project_path(project_path)

    with _connect() as conn:
        result = conn.execute(
            """
            DELETE FROM projects
            WHERE path = ?
            """,
            (normalized_path,),
        )
        conn.commit()

    return result.rowcount > 0


def touch_project_url(project_path: str, url: str) -> list[ProjectUrlRecord]:
    normalized_path = normalize_project_path(project_path)
    normalized_url = url.strip()
    if not normalized_url:
        raise ValueError("URL cannot be empty")

    with _connect() as conn:
        project_exists = conn.execute(
            """
            SELECT 1
            FROM projects
            WHERE path = ?
            """,
            (normalized_path,),
        ).fetchone()
        if project_exists is None:
            raise ValueError("Project does not exist")

        conn.execute(
            """
            INSERT INTO project_urls (
                project_path,
                url
            ) VALUES (?, ?)
            ON CONFLICT(project_path, url) DO UPDATE SET
                last_used = CURRENT_TIMESTAMP,
                use_count = project_urls.use_count + 1
            """,
            (normalized_path, normalized_url),
        )
        conn.execute(
            """
            UPDATE projects
            SET last_opened = CURRENT_TIMESTAMP
            WHERE path = ?
            """,
            (normalized_path,),
        )
        conn.commit()

    return list_project_urls(normalized_path)


def upsert_session(
    project_path: str,
    *,
    thread_id: str,
    backend: str,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
) -> SessionRecord:
    normalized_path = normalize_project_path(project_path)
    if not thread_id.strip():
        raise ValueError("thread_id is required")

    with _connect() as conn:
        project_exists = conn.execute(
            """
            SELECT 1
            FROM projects
            WHERE path = ?
            """,
            (normalized_path,),
        ).fetchone()
        if project_exists is None:
            raise ValueError("Project does not exist")

        conn.execute(
            """
            INSERT INTO sessions (
                project_path,
                thread_id,
                backend,
                agent_deck_session_id,
                agent_deck_session_title
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                project_path = excluded.project_path,
                backend = excluded.backend,
                agent_deck_session_id = excluded.agent_deck_session_id,
                agent_deck_session_title = excluded.agent_deck_session_title,
                last_active = CURRENT_TIMESTAMP
            """,
            (
                normalized_path,
                thread_id.strip(),
                backend.strip() or "agent-deck",
                agent_deck_session_id,
                agent_deck_session_title,
            ),
        )
        conn.execute(
            """
            UPDATE projects
            SET last_opened = CURRENT_TIMESTAMP
            WHERE path = ?
            """,
            (normalized_path,),
        )
        conn.commit()

        row = conn.execute(
            """
            SELECT id, project_path, thread_id, backend, agent_deck_session_id,
                   agent_deck_session_title, created_at, last_active
            FROM sessions
            WHERE thread_id = ?
            """,
            (thread_id.strip(),),
        ).fetchone()

    if row is None:
        raise RuntimeError("Session record disappeared during upsert")
    return _row_to_session_record(row)
