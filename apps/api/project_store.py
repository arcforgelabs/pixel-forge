from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from state_db import connect as connect_state_db
from state_db import legacy_instance_db_paths
from state_db import legacy_live_editor_db_path


_DB_LOCK = threading.Lock()
_DB_INITIALIZED = False
DEFAULT_PROFILE_ID = "default"


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
    workspace_path: str
    thread_id: str
    backend: str
    origin_kind: str
    agent_deck_session_id: str | None
    agent_deck_session_title: str | None
    agent_deck_tool: str | None
    editor_state: dict[str, Any] | None
    created_at: str
    last_active: str


@dataclass(slots=True)
class ProfileStateRecord:
    profile_id: str
    active_project_path: str | None
    active_mode: str
    active_live_editor_thread_id: str | None
    default_agent_type: str
    updated_at: str


def normalize_project_path(project_path: str) -> str:
    return os.path.abspath(os.path.expanduser(project_path))


def project_name_for_path(project_path: str) -> str:
    normalized_path = normalize_project_path(project_path).rstrip(os.sep)
    return os.path.basename(normalized_path) or normalized_path


def _next_chat_id() -> str:
    return f"chat-{uuid4().hex[:12]}"


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
            SELECT thread_id, project_path, project_path AS workspace_path, backend, agent_deck_session_id,
                   agent_deck_session_title, NULL AS agent_deck_tool, created_at, updated_at
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
            INSERT OR IGNORE INTO sessions (
                project_path,
                workspace_path,
                thread_id,
                backend,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                created_at,
                last_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                normalized_path,
                normalized_path,
                row["thread_id"],
                row["backend"],
                row["agent_deck_session_id"],
                row["agent_deck_session_title"],
                row["agent_deck_tool"],
                row["created_at"],
                row["updated_at"],
            ),
        )


def _migrate_legacy_instance_state(conn: sqlite3.Connection) -> None:
    for legacy_path in legacy_instance_db_paths():
        with sqlite3.connect(legacy_path) as legacy_conn:
            legacy_conn.row_factory = sqlite3.Row

            tables = {
                str(row["name"])
                for row in legacy_conn.execute(
                    """
                    SELECT name
                    FROM sqlite_master
                    WHERE type = 'table'
                      AND name IN ('projects', 'project_urls', 'sessions')
                    """
                ).fetchall()
            }

            if "projects" in tables:
                rows = legacy_conn.execute(
                    """
                    SELECT path, name, output_mode, custom_output_path, created_at, last_opened
                    FROM projects
                    ORDER BY last_opened DESC
                    """
                ).fetchall()
                for row in rows:
                    normalized_path = normalize_project_path(row["path"])
                    conn.execute(
                        """
                        INSERT INTO projects (
                            path,
                            name,
                            output_mode,
                            custom_output_path,
                            created_at,
                            last_opened
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(path) DO UPDATE SET
                            name = excluded.name,
                            output_mode = excluded.output_mode,
                            custom_output_path = excluded.custom_output_path,
                            created_at = MIN(projects.created_at, excluded.created_at),
                            last_opened = MAX(projects.last_opened, excluded.last_opened)
                        """,
                        (
                            normalized_path,
                            row["name"] or project_name_for_path(normalized_path),
                            row["output_mode"] or "scratch",
                            row["custom_output_path"],
                            row["created_at"],
                            row["last_opened"],
                        ),
                    )

            if "project_urls" in tables:
                rows = legacy_conn.execute(
                    """
                    SELECT project_path, url, last_used, use_count
                    FROM project_urls
                    ORDER BY last_used DESC
                    """
                ).fetchall()
                for row in rows:
                    normalized_path = normalize_project_path(row["project_path"])
                    conn.execute(
                        """
                        INSERT INTO project_urls (
                            project_path,
                            url,
                            last_used,
                            use_count
                        ) VALUES (?, ?, ?, ?)
                        ON CONFLICT(project_path, url) DO UPDATE SET
                            last_used = MAX(project_urls.last_used, excluded.last_used),
                            use_count = MAX(project_urls.use_count, excluded.use_count)
                        """,
                        (
                            normalized_path,
                            row["url"],
                            row["last_used"],
                            int(row["use_count"] or 1),
                        ),
                    )

            if "sessions" in tables:
                rows = legacy_conn.execute(
                    """
                    SELECT project_path, project_path AS workspace_path, thread_id, backend, agent_deck_session_id,
                           agent_deck_session_title, NULL AS agent_deck_tool, created_at, last_active
                    FROM sessions
                    ORDER BY last_active DESC
                    """
                ).fetchall()
                for row in rows:
                    normalized_path = normalize_project_path(row["project_path"])
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO sessions (
                            project_path,
                            workspace_path,
                            thread_id,
                            backend,
                            agent_deck_session_id,
                            agent_deck_session_title,
                            agent_deck_tool,
                            created_at,
                            last_active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            normalized_path,
                            normalize_project_path(row["workspace_path"]),
                            row["thread_id"],
                            row["backend"],
                            row["agent_deck_session_id"],
                            row["agent_deck_session_title"],
                            row["agent_deck_tool"],
                            row["created_at"],
                            row["last_active"],
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
                workspace_path TEXT NOT NULL,
                thread_id TEXT NOT NULL UNIQUE,
                backend TEXT NOT NULL,
                origin_kind TEXT NOT NULL DEFAULT 'managed',
                agent_deck_session_id TEXT,
                agent_deck_session_title TEXT,
                agent_deck_tool TEXT,
                editor_state_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_session_bindings (
                chat_id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                agent_deck_session_id TEXT NOT NULL UNIQUE,
                agent_deck_session_title TEXT,
                agent_deck_tool TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
                FOREIGN KEY (chat_id) REFERENCES sessions(thread_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS profile_state (
                profile_id TEXT PRIMARY KEY,
                active_project_path TEXT,
                active_mode TEXT NOT NULL DEFAULT 'screenshot',
                active_live_editor_thread_id TEXT,
                default_agent_type TEXT NOT NULL DEFAULT 'claude',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_projects_last_opened
                ON projects (last_opened DESC);
            CREATE INDEX IF NOT EXISTS idx_project_urls_last_used
                ON project_urls (project_path, last_used DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_last_active
                ON sessions (project_path, last_active DESC);
            CREATE INDEX IF NOT EXISTS idx_chat_session_bindings_project
                ON chat_session_bindings (project_path, updated_at DESC);
            """
        )
        existing_session_columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
        }
        if "workspace_path" not in existing_session_columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN workspace_path TEXT"
            )
        if "agent_deck_tool" not in existing_session_columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN agent_deck_tool TEXT"
            )
        if "origin_kind" not in existing_session_columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'managed'"
            )
        if "editor_state_json" not in existing_session_columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN editor_state_json TEXT"
            )
        existing_profile_columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(profile_state)").fetchall()
        }
        if existing_profile_columns:
            if "active_project_path" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN active_project_path TEXT"
                )
            if "active_mode" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN active_mode TEXT NOT NULL DEFAULT 'screenshot'"
                )
            if "active_live_editor_thread_id" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN active_live_editor_thread_id TEXT"
                )
            if "default_agent_type" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN default_agent_type TEXT NOT NULL DEFAULT 'claude'"
                )
            if "updated_at" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
                )
        conn.execute(
            """
            UPDATE sessions
            SET workspace_path = project_path
            WHERE workspace_path IS NULL OR TRIM(workspace_path) = ''
            """
        )
        conn.execute(
            """
            UPDATE sessions
            SET origin_kind = 'managed'
            WHERE origin_kind IS NULL OR TRIM(origin_kind) = ''
            """
        )
        _migrate_legacy_live_editor_state(conn)
        _migrate_legacy_instance_state(conn)
        conn.execute(
            """
            INSERT INTO chat_session_bindings (
                chat_id,
                project_path,
                workspace_path,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                created_at,
                updated_at
            )
            SELECT
                thread_id,
                project_path,
                workspace_path,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                created_at,
                last_active
            FROM sessions
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
            ON CONFLICT(chat_id) DO UPDATE SET
                project_path = excluded.project_path,
                workspace_path = excluded.workspace_path,
                agent_deck_session_id = excluded.agent_deck_session_id,
                agent_deck_session_title = excluded.agent_deck_session_title,
                agent_deck_tool = excluded.agent_deck_tool,
                updated_at = excluded.updated_at
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO profile_state (
                profile_id,
                active_mode
            ) VALUES (?, 'screenshot')
            """,
            (DEFAULT_PROFILE_ID,),
        )
        conn.commit()
        _DB_INITIALIZED = True


def ensure_state_store_initialized() -> None:
    with _connect():
        return


def _row_to_url_record(row: sqlite3.Row) -> ProjectUrlRecord:
    return ProjectUrlRecord(
        url=row["url"],
        last_used=row["last_used"],
        use_count=row["use_count"],
    )


def _normalize_active_mode(value: object | None) -> str:
    return "live-editor" if value == "live-editor" else "screenshot"


def _normalize_agent_type(value: object | None) -> str:
    return "codex" if value == "codex" else "claude"


def _normalize_origin_kind(value: object | None) -> str:
    return "adopted" if value == "adopted" else "managed"


def _normalize_profile_id(profile_id: str | None = None) -> str:
    normalized = str(profile_id or "").strip()
    return normalized or DEFAULT_PROFILE_ID


def _normalize_active_preview_tool(value: object) -> str | None:
    return "select" if value == "select" else None


def _normalize_active_panel_tab(value: object) -> str:
    return "elements" if value == "elements" else "chat"


def _normalize_viewport_mode(value: object) -> str:
    return str(value) if value in {"fluid", "desktop", "phone"} else "fluid"


def _normalize_preview_mode(value: object) -> str | None:
    if value in {"proxy", "browser"}:
        return str(value)
    return None


def _normalize_local_target(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    kind = str(value.get("kind") or "").strip()
    runtime_kind = str(value.get("runtimeKind") or "").strip()
    project_path = str(value.get("projectPath") or "").strip()
    source_root = str(value.get("sourceRoot") or "").strip()
    audience_workspace_path = str(value.get("audienceWorkspacePath") or "").strip()
    if kind != "pixel-forge" or runtime_kind not in {"mirror", "dev"}:
        return None
    if not project_path or not source_root:
        return None

    created_at = value.get("createdAt")
    return {
        "kind": kind,
        "runtimeKind": runtime_kind,
        "instanceSlug": str(value.get("instanceSlug") or "").strip(),
        "projectPath": project_path,
        "sourceRoot": source_root,
        "audienceWorkspacePath": audience_workspace_path or None,
        "buildLabel": str(value.get("buildLabel") or "").strip(),
        "createdAt": created_at if isinstance(created_at, str) and created_at.strip() else None,
    }


def _normalize_preview_tab(value: object, index: int) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    tab_id = str(value.get("id") or "").strip()
    if not tab_id:
        return None

    url = str(value.get("url") or "").strip()
    title = str(value.get("title") or "").strip() or f"Tab {index}"

    return {
        "id": tab_id,
        "url": url,
        "title": title,
        "mode": _normalize_preview_mode(value.get("mode")),
        "localTarget": _normalize_local_target(value.get("localTarget")),
    }


def normalize_session_editor_state(editor_state: object | None) -> dict[str, Any] | None:
    if not isinstance(editor_state, dict):
        return None

    normalized_tabs = [
        normalized_tab
        for index, raw_tab in enumerate(editor_state.get("previewTabs") or [], start=1)
        for normalized_tab in [_normalize_preview_tab(raw_tab, index)]
        if normalized_tab is not None
    ]
    if not normalized_tabs:
        normalized_tabs = [
            {
                "id": "preview-restored",
                "url": "",
                "title": "Tab 1",
                "mode": None,
                "localTarget": None,
            }
        ]

    active_preview_tab_id = str(editor_state.get("activePreviewTabId") or "").strip() or None
    if active_preview_tab_id and not any(
        tab["id"] == active_preview_tab_id for tab in normalized_tabs
    ):
        active_preview_tab_id = normalized_tabs[0]["id"]
    if active_preview_tab_id is None:
        active_preview_tab_id = normalized_tabs[0]["id"]

    url_history = [
        entry.strip()
        for entry in editor_state.get("urlHistory") or []
        if isinstance(entry, str) and entry.strip()
    ][:50]

    raw_url_history_cursor = editor_state.get("urlHistoryCursor")
    if isinstance(raw_url_history_cursor, bool):
        url_history_cursor = -1
    elif isinstance(raw_url_history_cursor, (int, float)):
        url_history_cursor = int(raw_url_history_cursor)
    else:
        url_history_cursor = -1
    if not url_history:
        url_history_cursor = -1
    else:
        url_history_cursor = max(-1, min(url_history_cursor, len(url_history) - 1))

    return {
        "draftAgentType": _normalize_agent_type(editor_state.get("draftAgentType")),
        "activePreviewTool": _normalize_active_preview_tool(
            editor_state.get("activePreviewTool")
        ),
        "targetUrl": str(editor_state.get("targetUrl") or "").strip(),
        "activeTab": _normalize_active_panel_tab(editor_state.get("activeTab")),
        "viewportMode": _normalize_viewport_mode(editor_state.get("viewportMode")),
        "showUrlHistory": bool(editor_state.get("showUrlHistory")),
        "previewTabs": normalized_tabs[:20],
        "activePreviewTabId": active_preview_tab_id,
        "urlHistory": url_history,
        "urlHistoryCursor": url_history_cursor,
    }


def _serialize_session_editor_state(editor_state: object | None) -> str | None:
    normalized_state = normalize_session_editor_state(editor_state)
    if normalized_state is None:
        return None
    return json.dumps(normalized_state, separators=(",", ":"), sort_keys=True)


def _row_to_session_record(row: sqlite3.Row) -> SessionRecord:
    editor_state: dict[str, Any] | None = None
    if "editor_state_json" in row.keys():
        raw_editor_state = row["editor_state_json"]
        if isinstance(raw_editor_state, str) and raw_editor_state.strip():
            try:
                parsed_editor_state = json.loads(raw_editor_state)
            except json.JSONDecodeError:
                parsed_editor_state = None
            if isinstance(parsed_editor_state, dict):
                editor_state = parsed_editor_state

    return SessionRecord(
        id=row["id"],
        project_path=row["project_path"],
        workspace_path=row["workspace_path"] or row["project_path"],
        thread_id=row["thread_id"],
        backend=row["backend"],
        origin_kind=_normalize_origin_kind(row["origin_kind"]),
        agent_deck_session_id=row["agent_deck_session_id"],
        agent_deck_session_title=row["agent_deck_session_title"],
        agent_deck_tool=row["agent_deck_tool"],
        editor_state=editor_state,
        created_at=row["created_at"],
        last_active=row["last_active"],
    )


_SESSION_SELECT_SQL = """
    SELECT
        sessions.id,
        sessions.project_path,
        COALESCE(chat_session_bindings.workspace_path, sessions.workspace_path) AS workspace_path,
        sessions.thread_id,
        sessions.backend,
        sessions.origin_kind,
        COALESCE(
            chat_session_bindings.agent_deck_session_id,
            sessions.agent_deck_session_id
        ) AS agent_deck_session_id,
        COALESCE(
            chat_session_bindings.agent_deck_session_title,
            sessions.agent_deck_session_title
        ) AS agent_deck_session_title,
        COALESCE(
            chat_session_bindings.agent_deck_tool,
            sessions.agent_deck_tool
        ) AS agent_deck_tool,
        sessions.editor_state_json,
        sessions.created_at,
        CASE
            WHEN chat_session_bindings.updated_at IS NOT NULL
             AND chat_session_bindings.updated_at > sessions.last_active
                THEN chat_session_bindings.updated_at
            ELSE sessions.last_active
        END AS last_active
    FROM sessions
    LEFT JOIN chat_session_bindings
        ON chat_session_bindings.chat_id = sessions.thread_id
"""


def _fetch_session_records(
    conn: sqlite3.Connection,
    *,
    where_sql: str,
    params: tuple[object, ...],
) -> list[SessionRecord]:
    rows = conn.execute(
        f"""
        {_SESSION_SELECT_SQL}
        WHERE {where_sql}
        ORDER BY last_active DESC, sessions.id DESC
        """,
        params,
    ).fetchall()
    return [_row_to_session_record(row) for row in rows]


def _delete_chat_binding(conn: sqlite3.Connection, chat_id: str) -> None:
    conn.execute(
        """
        DELETE FROM chat_session_bindings
        WHERE chat_id = ?
        """,
        (chat_id,),
    )


def _upsert_chat_binding(
    conn: sqlite3.Connection,
    *,
    project_path: str,
    chat_id: str,
    workspace_path: str,
    agent_deck_session_id: str,
    agent_deck_session_title: str | None,
    agent_deck_tool: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO chat_session_bindings (
            chat_id,
            project_path,
            workspace_path,
            agent_deck_session_id,
            agent_deck_session_title,
            agent_deck_tool
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
            project_path = excluded.project_path,
            workspace_path = excluded.workspace_path,
            agent_deck_session_id = excluded.agent_deck_session_id,
            agent_deck_session_title = excluded.agent_deck_session_title,
            agent_deck_tool = excluded.agent_deck_tool,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            chat_id,
            project_path,
            workspace_path,
            agent_deck_session_id,
            agent_deck_session_title,
            agent_deck_tool,
        ),
    )


def _row_to_profile_state_record(row: sqlite3.Row) -> ProfileStateRecord:
    active_project_path = row["active_project_path"]
    normalized_project_path = (
        normalize_project_path(active_project_path)
        if isinstance(active_project_path, str) and active_project_path.strip()
        else None
    )
    active_thread_id = row["active_live_editor_thread_id"]
    return ProfileStateRecord(
        profile_id=row["profile_id"],
        active_project_path=normalized_project_path,
        active_mode=_normalize_active_mode(row["active_mode"]),
        active_live_editor_thread_id=(
            active_thread_id.strip()
            if isinstance(active_thread_id, str) and active_thread_id.strip()
            else None
        ),
        default_agent_type=_normalize_agent_type(row["default_agent_type"]),
        updated_at=row["updated_at"],
    )


def _is_stale_clone_session(record: SessionRecord) -> bool:
    if record.workspace_path == record.project_path:
        return False
    if f"{os.sep}.agents{os.sep}" not in record.workspace_path:
        return False
    return not os.path.isdir(record.workspace_path)


def detach_missing_agent_deck_session_bindings(
    project_path: str,
    available_session_ids: set[str] | list[str] | tuple[str, ...],
) -> list[SessionRecord]:
    normalized_path = normalize_project_path(project_path)
    available_ids = {
        session_id.strip()
        for session_id in available_session_ids
        if isinstance(session_id, str) and session_id.strip()
    }

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ?",
            params=(normalized_path,),
        )
        stale_ids = [record.id for record in records if _is_stale_clone_session(record)]
        detached_thread_ids = [
            record.thread_id
            for record in records
            if record.id not in stale_ids
            and record.agent_deck_session_id
            and record.agent_deck_session_id not in available_ids
        ]
        if stale_ids:
            placeholders = ",".join("?" for _ in stale_ids)
            conn.execute(
                f"DELETE FROM sessions WHERE id IN ({placeholders})",
                stale_ids,
            )
        if detached_thread_ids:
            placeholders = ",".join("?" for _ in detached_thread_ids)
            conn.execute(
                f"""
                DELETE FROM chat_session_bindings
                WHERE project_path = ?
                  AND chat_id IN ({placeholders})
                """,
                (normalized_path, *detached_thread_ids),
            )
            conn.execute(
                f"""
                UPDATE sessions
                SET agent_deck_session_id = NULL,
                    agent_deck_session_title = NULL,
                    agent_deck_tool = NULL
                WHERE project_path = ?
                  AND thread_id IN ({placeholders})
                """,
                (normalized_path, *detached_thread_ids),
            )
        if stale_ids or detached_thread_ids:
            conn.commit()

        return _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ?",
            params=(normalized_path,),
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
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ?",
            params=(normalized_path,),
        )
        stale_ids = [record.id for record in records if _is_stale_clone_session(record)]
        if stale_ids:
            placeholders = ",".join("?" for _ in stale_ids)
            conn.execute(
                f"DELETE FROM sessions WHERE id IN ({placeholders})",
                stale_ids,
            )
            conn.commit()
        return [record for record in records if record.id not in stale_ids]


def get_project_session(
    project_path: str,
    thread_id: str,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return None

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ? AND sessions.thread_id = ?",
            params=(normalized_path, normalized_thread_id),
        )

    if not records:
        return None
    return records[0]


def get_project_session_by_agent_deck_session_id(
    project_path: str,
    agent_deck_session_id: str,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_session_id = agent_deck_session_id.strip()
    if not normalized_session_id:
        return None

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql=(
                "sessions.project_path = ? AND COALESCE("
                "chat_session_bindings.agent_deck_session_id, sessions.agent_deck_session_id"
                ") = ?"
            ),
            params=(normalized_path, normalized_session_id),
        )

    if not records:
        return None
    return records[0]


def list_sessions_by_agent_deck_session_id(
    agent_deck_session_id: str,
) -> list[SessionRecord]:
    normalized_session_id = agent_deck_session_id.strip()
    if not normalized_session_id:
        return []

    with _connect() as conn:
        return _fetch_session_records(
            conn,
            where_sql=(
                "COALESCE("
                "chat_session_bindings.agent_deck_session_id, sessions.agent_deck_session_id"
                ") = ?"
            ),
            params=(normalized_session_id,),
        )


def detach_project_session_binding(
    project_path: str,
    thread_id: str,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return None

    with _connect() as conn:
        _delete_chat_binding(conn, normalized_thread_id)
        conn.execute(
            """
            UPDATE sessions
            SET agent_deck_session_id = NULL,
                agent_deck_session_title = NULL,
                agent_deck_tool = NULL,
                last_active = CURRENT_TIMESTAMP
            WHERE project_path = ?
              AND thread_id = ?
            """,
            (normalized_path, normalized_thread_id),
        )
        conn.commit()

    return get_project_session(normalized_path, normalized_thread_id)


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


def get_profile_state(profile_id: str = DEFAULT_PROFILE_ID) -> ProfileStateRecord:
    normalized_profile_id = _normalize_profile_id(profile_id)

    with _connect() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO profile_state (
                profile_id,
                active_mode,
                default_agent_type
            ) VALUES (?, 'screenshot', 'claude')
            """,
            (normalized_profile_id,),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT profile_id, active_project_path, active_mode, active_live_editor_thread_id,
                   default_agent_type, updated_at
            FROM profile_state
            WHERE profile_id = ?
            """,
            (normalized_profile_id,),
        ).fetchone()

    if row is None:
        raise RuntimeError("Profile state record disappeared during fetch")

    return _row_to_profile_state_record(row)


def upsert_profile_state(
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
    active_project_path: str | None = None,
    active_mode: str = "screenshot",
    active_live_editor_thread_id: str | None = None,
    default_agent_type: str = "claude",
) -> ProfileStateRecord:
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_project_path = (
        normalize_project_path(active_project_path)
        if isinstance(active_project_path, str) and active_project_path.strip()
        else None
    )
    normalized_thread_id = (
        active_live_editor_thread_id.strip()
        if isinstance(active_live_editor_thread_id, str) and active_live_editor_thread_id.strip()
        else None
    )
    normalized_default_agent_type = _normalize_agent_type(default_agent_type)

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO profile_state (
                profile_id,
                active_project_path,
                active_mode,
                active_live_editor_thread_id,
                default_agent_type
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET
                active_project_path = excluded.active_project_path,
                active_mode = excluded.active_mode,
                active_live_editor_thread_id = CASE
                    WHEN excluded.active_project_path IS NULL THEN NULL
                    ELSE excluded.active_live_editor_thread_id
                END,
                default_agent_type = excluded.default_agent_type,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                normalized_profile_id,
                normalized_project_path,
                _normalize_active_mode(active_mode),
                normalized_thread_id,
                normalized_default_agent_type,
            ),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT profile_id, active_project_path, active_mode, active_live_editor_thread_id,
                   default_agent_type, updated_at
            FROM profile_state
            WHERE profile_id = ?
            """,
            (normalized_profile_id,),
        ).fetchone()

    if row is None:
        raise RuntimeError("Profile state record disappeared during upsert")

    return _row_to_profile_state_record(row)


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
        conn.execute(
            """
            UPDATE profile_state
            SET active_project_path = NULL,
                active_live_editor_thread_id = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE active_project_path = ?
            """,
            (normalized_path,),
        )
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
    origin_kind: str = "managed",
    workspace_path: str | None = None,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    agent_deck_tool: str | None = None,
    editor_state: dict[str, Any] | None = None,
) -> SessionRecord:
    normalized_path = normalize_project_path(project_path)
    if not thread_id.strip():
        raise ValueError("thread_id is required")
    normalized_agent_deck_session_id = (
        agent_deck_session_id.strip()
        if isinstance(agent_deck_session_id, str) and agent_deck_session_id.strip()
        else None
    )
    normalized_workspace_path = normalize_project_path(workspace_path or project_path)
    serialized_editor_state = _serialize_session_editor_state(editor_state)

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

        conflicting_record: SessionRecord | None = None
        stale_ids: list[int] = []
        if normalized_agent_deck_session_id:
            rows = _fetch_session_records(
                conn,
                where_sql=(
                    "sessions.project_path = ? AND COALESCE("
                    "chat_session_bindings.agent_deck_session_id, sessions.agent_deck_session_id"
                    ") = ? AND sessions.thread_id <> ?"
                ),
                params=(
                    normalized_path,
                    normalized_agent_deck_session_id,
                    thread_id.strip(),
                ),
            )
            for record in rows:
                if _is_stale_clone_session(record):
                    stale_ids.append(record.id)
                    continue
                conflicting_record = record
                break
            if stale_ids:
                placeholders = ",".join("?" for _ in stale_ids)
                conn.execute(
                    f"DELETE FROM sessions WHERE id IN ({placeholders})",
                    stale_ids,
                )
            if conflicting_record is not None:
                raise ValueError(
                    "Agent Deck session "
                    f"{normalized_agent_deck_session_id} is already bound to Live Editor thread "
                    f"{conflicting_record.thread_id}"
                )

        conn.execute(
            """
            INSERT INTO sessions (
                project_path,
                workspace_path,
                thread_id,
                backend,
                origin_kind,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                editor_state_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                project_path = excluded.project_path,
                workspace_path = excluded.workspace_path,
                backend = excluded.backend,
                origin_kind = excluded.origin_kind,
                agent_deck_session_id = excluded.agent_deck_session_id,
                agent_deck_session_title = excluded.agent_deck_session_title,
                agent_deck_tool = excluded.agent_deck_tool,
                editor_state_json = COALESCE(excluded.editor_state_json, sessions.editor_state_json),
                last_active = CURRENT_TIMESTAMP
            """,
            (
                normalized_path,
                normalized_workspace_path,
                thread_id.strip(),
                backend.strip() or "agent-deck",
                _normalize_origin_kind(origin_kind),
                normalized_agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                serialized_editor_state,
            ),
        )
        if normalized_agent_deck_session_id:
            _upsert_chat_binding(
                conn,
                project_path=normalized_path,
                chat_id=thread_id.strip(),
                workspace_path=normalized_workspace_path,
                agent_deck_session_id=normalized_agent_deck_session_id,
                agent_deck_session_title=agent_deck_session_title,
                agent_deck_tool=agent_deck_tool,
            )
        else:
            _delete_chat_binding(conn, thread_id.strip())
        conn.execute(
            """
            UPDATE projects
            SET last_opened = CURRENT_TIMESTAMP
            WHERE path = ?
            """,
            (normalized_path,),
        )
        conn.commit()

    saved = get_project_session(normalized_path, thread_id.strip())
    if saved is None:
        raise RuntimeError("Session record disappeared during upsert")
    return saved


def create_adopted_project_session(
    project_path: str,
    *,
    workspace_path: str,
    agent_deck_session_id: str,
    agent_deck_session_title: str | None,
    agent_deck_tool: str | None,
) -> SessionRecord:
    existing = get_project_session_by_agent_deck_session_id(
        project_path,
        agent_deck_session_id,
    )
    if existing is not None:
        return upsert_session(
            project_path,
            thread_id=existing.thread_id,
            backend=existing.backend,
            origin_kind="adopted",
            workspace_path=workspace_path,
            agent_deck_session_id=agent_deck_session_id,
            agent_deck_session_title=agent_deck_session_title,
            agent_deck_tool=agent_deck_tool,
            editor_state=existing.editor_state,
        )

    return upsert_session(
        project_path,
        thread_id=_next_chat_id(),
        backend="agent-deck",
        origin_kind="adopted",
        workspace_path=workspace_path,
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_session_title,
        agent_deck_tool=agent_deck_tool,
        editor_state=None,
    )


def update_session_title(
    project_path: str,
    thread_id: str,
    title: str | None,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return None

    normalized_title = title.strip() if isinstance(title, str) else None

    with _connect() as conn:
        conn.execute(
            """
            UPDATE sessions
            SET agent_deck_session_title = ?,
                last_active = CURRENT_TIMESTAMP
            WHERE project_path = ?
              AND thread_id = ?
            """,
            (normalized_title, normalized_path, normalized_thread_id),
        )
        conn.execute(
            """
            UPDATE chat_session_bindings
            SET agent_deck_session_title = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE project_path = ?
              AND chat_id = ?
            """,
            (normalized_title, normalized_path, normalized_thread_id),
        )
        conn.commit()

    return get_project_session(normalized_path, normalized_thread_id)


def delete_session(
    project_path: str,
    thread_id: str,
) -> bool:
    normalized_path = normalize_project_path(project_path)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return False

    with _connect() as conn:
        _delete_chat_binding(conn, normalized_thread_id)
        result = conn.execute(
            """
            DELETE FROM sessions
            WHERE project_path = ?
              AND thread_id = ?
            """,
            (normalized_path, normalized_thread_id),
        )
        conn.commit()

    return result.rowcount > 0
