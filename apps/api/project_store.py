from __future__ import annotations

import json
import os
import re
import sqlite3
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from state_db import connect as connect_state_db
from state_db import ensure_migration_markers_table
from state_db import has_migration_marker
from state_db import legacy_instance_db_paths
from state_db import legacy_live_editor_db_path
from state_db import set_migration_marker


_DB_LOCK = threading.Lock()
_DB_INITIALIZED = False
DEFAULT_PROFILE_ID = "default"
SAFE_THREAD_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
DEFAULT_CLAUDE_MODEL = "claude-opus-4-7"
DEFAULT_CLAUDE_THINKING = "xhigh"
CLAUDE_MODEL_ALIASES = {
    "opus": DEFAULT_CLAUDE_MODEL,
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}
CLAUDE_MODEL_ALLOWLIST = frozenset({
    DEFAULT_CLAUDE_MODEL,
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
})
CLAUDE_THINKING_ALLOWLIST = frozenset({"low", "medium", "high", "xhigh", "max"})
CODEX_MODEL_ALLOWLIST = frozenset(
    {"gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"}
)
CODEX_THINKING_ALLOWLIST = frozenset({"minimal", "low", "medium", "high", "xhigh"})


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
    profile_id: str
    project_path: str
    workspace_path: str
    thread_id: str
    backend: str
    origin_kind: str
    provider_id: str | None
    provider_session_id: str | None
    provider_session_title: str | None
    provider_agent_id: str | None
    agent_deck_session_id: str | None
    agent_deck_session_title: str | None
    agent_deck_tool: str | None
    editor_state: dict[str, Any] | None
    created_at: str
    last_active: str


def _session_has_meaningful_editor_state(session: SessionRecord) -> bool:
    editor_state = session.editor_state
    if not isinstance(editor_state, dict):
        return False

    if str(editor_state.get("targetUrl") or "").strip():
        return True

    if str(editor_state.get("targetPreviewTabId") or "").strip():
        return True

    if editor_state.get("activePreviewTool") == "select":
        return True

    url_history = editor_state.get("urlHistory")
    if isinstance(url_history, list) and any(
        isinstance(entry, str) and entry.strip() for entry in url_history
    ):
        return True

    preview_tabs = editor_state.get("previewTabs")
    if isinstance(preview_tabs, list):
        if len(preview_tabs) > 1:
            return True
        if len(preview_tabs) == 1 and isinstance(preview_tabs[0], dict):
            tab = preview_tabs[0]
            if str(tab.get("url") or "").strip():
                return True
            if tab.get("localTarget") is not None:
                return True

    return False


def _clone_root(project_path: str) -> str:
    return os.path.join(normalize_project_path(project_path), ".agents")


def _is_descendant_path(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _workspace_matches_project_context(
    workspace_path: str,
    project_path: str,
) -> bool:
    normalized_workspace_path = normalize_project_path(workspace_path)
    normalized_project_path = normalize_project_path(project_path)
    if normalized_workspace_path == normalized_project_path:
        return True
    return _is_descendant_path(
        normalized_workspace_path,
        _clone_root(normalized_project_path),
    )


def should_surface_session(
    session: SessionRecord,
    project_path: str,
) -> bool:
    normalized_project_path = normalize_project_path(project_path)
    workspace_matches_project = _workspace_matches_project_context(
        session.workspace_path,
        normalized_project_path,
    )
    normalized_thread_id = (
        session.thread_id.strip()
        if isinstance(session.thread_id, str) and session.thread_id.strip()
        else ""
    )

    if (
        normalized_thread_id.startswith("draft-")
        and normalize_project_path(session.workspace_path) == normalized_project_path
        and not session.provider_session_id
    ):
        return False

    if not workspace_matches_project:
        return False

    if session.provider_session_id:
        return True

    if normalize_project_path(session.workspace_path) != normalized_project_path:
        return True

    # Explicit chat-* sessions are always surfaced — they were created by
    # the user through the chat flow and should remain visible even when
    # temporarily detached from an AD session.
    if normalized_thread_id.startswith("chat-"):
        return True

    # No AD binding, root workspace, non-chat thread: only surface if
    # there is meaningful editor state.  Detached legacy sessions without
    # content are empty shells.
    return _session_has_meaningful_editor_state(session)


@dataclass(slots=True)
class ProfileStateRecord:
    profile_id: str
    active_project_path: str | None
    last_workspace_browse_directory: str | None
    active_mode: str
    active_live_editor_thread_id: str | None
    default_agent_provider_id: str
    default_agent_type: str
    default_workspace_mode: str
    claude_default_model: str | None
    claude_default_thinking: str | None
    codex_default_model: str | None
    codex_default_thinking: str | None
    gemini_default_model: str | None
    pi_default_model: str | None
    pi_default_thinking: str | None
    updated_at: str


def normalize_project_path(project_path: str) -> str:
    return os.path.abspath(os.path.expanduser(project_path))


def project_name_for_path(project_path: str) -> str:
    normalized_path = normalize_project_path(project_path).rstrip(os.sep)
    return os.path.basename(normalized_path) or normalized_path


def _next_chat_id() -> str:
    return f"chat-{uuid4().hex[:12]}"


def _safe_thread_name(name: str, fallback: str = "thread") -> str:
    stripped = SAFE_THREAD_NAME_RE.sub("-", name).strip(".-")
    return stripped or fallback


def _thread_artifact_root(project_path: str, thread_id: str) -> Path:
    return Path(normalize_project_path(project_path)) / ".pixel-forge" / "threads" / _safe_thread_name(
        thread_id,
        "thread",
    )


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        """,
        (table_name,),
    ).fetchone()
    return row is not None


def _maybe_move_thread_artifacts(
    project_path: str,
    from_thread_id: str,
    to_thread_id: str,
) -> None:
    source_root = _thread_artifact_root(project_path, from_thread_id)
    target_root = _thread_artifact_root(project_path, to_thread_id)
    if source_root == target_root or not source_root.exists():
        return

    target_root.parent.mkdir(parents=True, exist_ok=True)
    if not target_root.exists():
        shutil.move(str(source_root), str(target_root))
        return

    for child in source_root.iterdir():
        destination = target_root / child.name
        if destination.exists():
            continue
        shutil.move(str(child), str(destination))

    try:
        source_root.rmdir()
    except OSError:
        pass


def _should_promote_attached_draft_thread(
    thread_id: str,
    agent_deck_session_id: str | None,
) -> bool:
    normalized_thread_id = thread_id.strip()
    return bool(
        normalized_thread_id.startswith("draft-")
        and isinstance(agent_deck_session_id, str)
        and agent_deck_session_id.strip()
    )


def _normalize_optional_text(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _provider_binding_from_agent_deck(
    *,
    agent_deck_session_id: str | None,
    agent_deck_session_title: str | None = None,
    agent_deck_tool: str | None = None,
) -> tuple[str | None, str | None, str | None, str | None]:
    normalized_session_id = _normalize_optional_text(agent_deck_session_id)
    if not normalized_session_id:
        return None, None, None, None
    return (
        "agent-deck",
        normalized_session_id,
        _normalize_optional_text(agent_deck_session_title),
        _normalize_optional_text(agent_deck_tool),
    )


def _normalize_provider_binding(
    *,
    provider_id: str | None = None,
    provider_session_id: str | None = None,
    provider_session_title: str | None = None,
    provider_agent_id: str | None = None,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    agent_deck_tool: str | None = None,
) -> tuple[
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
]:
    normalized_provider_id = _normalize_optional_text(provider_id)
    normalized_provider_session_id = _normalize_optional_text(provider_session_id)
    normalized_provider_session_title = (
        _normalize_optional_text(provider_session_title)
        or _normalize_optional_text(agent_deck_session_title)
    )
    normalized_provider_agent_id = (
        _normalize_optional_text(provider_agent_id)
        or _normalize_optional_text(agent_deck_tool)
    )
    normalized_agent_deck_session_id = _normalize_optional_text(agent_deck_session_id)
    normalized_agent_deck_session_title = _normalize_optional_text(agent_deck_session_title)
    normalized_agent_deck_tool = _normalize_optional_text(agent_deck_tool)

    if normalized_provider_session_id and not normalized_provider_id:
        normalized_provider_id = "agent-deck" if normalized_agent_deck_session_id else "unknown"

    if normalized_agent_deck_session_id and not normalized_provider_session_id:
        (
            normalized_provider_id,
            normalized_provider_session_id,
            fallback_title,
            fallback_agent_id,
        ) = _provider_binding_from_agent_deck(
            agent_deck_session_id=normalized_agent_deck_session_id,
            agent_deck_session_title=normalized_agent_deck_session_title,
            agent_deck_tool=normalized_agent_deck_tool,
        )
        normalized_provider_session_title = normalized_provider_session_title or fallback_title
        normalized_provider_agent_id = normalized_provider_agent_id or fallback_agent_id

    if normalized_provider_id == "agent-deck":
        normalized_agent_deck_session_id = (
            normalized_agent_deck_session_id or normalized_provider_session_id
        )
        normalized_agent_deck_session_title = (
            normalized_agent_deck_session_title or normalized_provider_session_title
        )
        normalized_agent_deck_tool = normalized_agent_deck_tool or normalized_provider_agent_id

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
        normalized_agent_deck_tool,
    )


def _next_unique_chat_id(conn: sqlite3.Connection) -> str:
    has_live_editor_threads = _table_exists(conn, "live_editor_threads")
    while True:
        candidate = _next_chat_id()
        session_collision = conn.execute(
            """
            SELECT 1
            FROM sessions
            WHERE thread_id = ?
            LIMIT 1
            """,
            (candidate,),
        ).fetchone()
        live_editor_collision = (
            conn.execute(
                """
                SELECT 1
                FROM live_editor_threads
                WHERE thread_id = ?
                LIMIT 1
                """,
                (candidate,),
            ).fetchone()
            if has_live_editor_threads
            else None
        )
        if session_collision is None and live_editor_collision is None:
            return candidate


def _update_workstation_event_thread_identity(
    conn: sqlite3.Connection,
    *,
    project_path: str,
    from_thread_id: str,
    to_thread_id: str,
) -> None:
    rows = conn.execute(
        """
        SELECT id, payload_json
        FROM workstation_events
        WHERE project_path = ?
          AND chat_id = ?
        """,
        (project_path, to_thread_id),
    ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        changed = False
        if payload.get("chat_id") == from_thread_id:
            payload["chat_id"] = to_thread_id
            changed = True
        if payload.get("thread_id") == from_thread_id:
            payload["thread_id"] = to_thread_id
            changed = True
        if not changed:
            continue
        conn.execute(
            """
            UPDATE workstation_events
            SET payload_json = ?
            WHERE id = ?
            """,
            (json.dumps(payload, separators=(",", ":"), sort_keys=True), row["id"]),
        )


def _promote_session_thread_identity(
    conn: sqlite3.Connection,
    *,
    project_path: str,
    from_thread_id: str,
    to_thread_id: str,
) -> bool:
    normalized_project_path = normalize_project_path(project_path)
    normalized_from_thread_id = from_thread_id.strip()
    normalized_to_thread_id = to_thread_id.strip()
    if not normalized_from_thread_id or not normalized_to_thread_id:
        return False
    if normalized_from_thread_id == normalized_to_thread_id:
        return False

    existing_session = conn.execute(
        """
        SELECT 1
        FROM sessions
        WHERE project_path = ?
          AND thread_id = ?
        """,
        (normalized_project_path, normalized_from_thread_id),
    ).fetchone()
    if existing_session is None:
        return False

    session_collision = conn.execute(
        """
        SELECT 1
        FROM sessions
        WHERE thread_id = ?
        LIMIT 1
        """,
        (normalized_to_thread_id,),
    ).fetchone()
    live_editor_collision = (
        conn.execute(
            """
            SELECT 1
            FROM live_editor_threads
            WHERE thread_id = ?
            LIMIT 1
            """,
            (normalized_to_thread_id,),
        ).fetchone()
        if _table_exists(conn, "live_editor_threads")
        else None
    )
    if session_collision is not None or live_editor_collision is not None:
        raise ValueError(
            f"Cannot promote {normalized_from_thread_id} to existing thread id {normalized_to_thread_id}"
        )

    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute(
            """
            UPDATE sessions
            SET thread_id = ?
            WHERE project_path = ?
              AND thread_id = ?
            """,
            (normalized_to_thread_id, normalized_project_path, normalized_from_thread_id),
        )
        conn.execute(
            """
            UPDATE chat_session_bindings
            SET chat_id = ?
            WHERE project_path = ?
              AND chat_id = ?
            """,
            (normalized_to_thread_id, normalized_project_path, normalized_from_thread_id),
        )
        conn.execute(
            """
            UPDATE workstation_events
            SET chat_id = ?
            WHERE project_path = ?
              AND chat_id = ?
            """,
            (normalized_to_thread_id, normalized_project_path, normalized_from_thread_id),
        )
        _update_workstation_event_thread_identity(
            conn,
            project_path=normalized_project_path,
            from_thread_id=normalized_from_thread_id,
            to_thread_id=normalized_to_thread_id,
        )
        conn.execute(
            """
            UPDATE live_editor_threads
            SET thread_id = ?
            WHERE project_path = ?
              AND thread_id = ?
            """,
            (normalized_to_thread_id, normalized_project_path, normalized_from_thread_id),
        )
        conn.execute(
            """
            UPDATE profile_state
            SET active_live_editor_thread_id = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE active_live_editor_thread_id = ?
            """,
            (normalized_to_thread_id, normalized_from_thread_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")

    violations = conn.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError(
            f"Foreign key violations detected after promoting {normalized_from_thread_id}"
        )

    _maybe_move_thread_artifacts(
        normalized_project_path,
        normalized_from_thread_id,
        normalized_to_thread_id,
    )
    return True


def _promote_legacy_attached_draft_sessions(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT project_path, thread_id
        FROM sessions
        WHERE thread_id LIKE 'draft-%'
          AND agent_deck_session_id IS NOT NULL
          AND TRIM(agent_deck_session_id) <> ''
        ORDER BY id ASC
        """
    ).fetchall()
    for row in rows:
        _promote_session_thread_identity(
            conn,
            project_path=row["project_path"],
            from_thread_id=row["thread_id"],
            to_thread_id=_next_unique_chat_id(conn),
        )


def _connect() -> sqlite3.Connection:
    conn = connect_state_db()
    _ensure_schema(conn)
    return conn


def _migrate_legacy_live_editor_state(conn: sqlite3.Connection) -> None:
    legacy_path = legacy_live_editor_db_path()
    if not legacy_path.is_file():
        return
    marker_key = f"project-store:legacy-live-editor:{legacy_path.resolve()}"
    if has_migration_marker(conn, marker_key):
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
                profile_id,
                project_path,
                workspace_path,
                thread_id,
                backend,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                created_at,
                last_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                DEFAULT_PROFILE_ID,
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
    set_migration_marker(conn, marker_key)


def _migrate_legacy_instance_state(conn: sqlite3.Connection) -> None:
    for legacy_path in legacy_instance_db_paths():
        marker_key = f"project-store:legacy-instance:{legacy_path.resolve()}"
        if has_migration_marker(conn, marker_key):
            continue
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
                            profile_id,
                            project_path,
                            workspace_path,
                            thread_id,
                            backend,
                            agent_deck_session_id,
                            agent_deck_session_title,
                            agent_deck_tool,
                            created_at,
                            last_active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            DEFAULT_PROFILE_ID,
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
        set_migration_marker(conn, marker_key)


def _backfill_claude_opus_47_defaults(conn: sqlite3.Connection) -> None:
    marker_key = "project-store:claude-opus-4-7-defaults-2026-04-17"
    if has_migration_marker(conn, marker_key):
        return

    conn.execute(
        """
        UPDATE profile_state
        SET claude_default_model = ?,
            claude_default_thinking = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(TRIM(claude_default_model), '') = ''
           OR COALESCE(TRIM(claude_default_thinking), '') = ''
        """,
        (DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_THINKING),
    )
    set_migration_marker(conn, marker_key)


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
                profile_id TEXT NOT NULL DEFAULT 'default',
                project_path TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                thread_id TEXT NOT NULL UNIQUE,
                backend TEXT NOT NULL,
                origin_kind TEXT NOT NULL DEFAULT 'managed',
                provider_id TEXT,
                provider_session_id TEXT,
                provider_session_title TEXT,
                provider_agent_id TEXT,
                agent_deck_session_id TEXT,
                agent_deck_session_title TEXT,
                agent_deck_tool TEXT,
                editor_state_json TEXT,
                hidden_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_session_bindings (
                chat_id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL DEFAULT 'default',
                project_path TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                provider_id TEXT,
                provider_session_id TEXT,
                provider_session_title TEXT,
                provider_agent_id TEXT,
                agent_deck_session_id TEXT NOT NULL UNIQUE,
                agent_deck_session_title TEXT,
                agent_deck_tool TEXT,
                hidden_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
                FOREIGN KEY (chat_id) REFERENCES sessions(thread_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS profile_state (
                profile_id TEXT PRIMARY KEY,
                active_project_path TEXT,
                last_workspace_browse_directory TEXT,
                active_mode TEXT NOT NULL DEFAULT 'screenshot',
                active_live_editor_thread_id TEXT,
                default_agent_provider_id TEXT NOT NULL DEFAULT 'agent-deck',
                default_agent_type TEXT NOT NULL DEFAULT 'claude',
                default_workspace_mode TEXT NOT NULL DEFAULT 'root',
                claude_default_model TEXT,
                claude_default_thinking TEXT,
                codex_default_model TEXT,
                codex_default_thinking TEXT,
                gemini_default_model TEXT,
                pi_default_model TEXT,
                pi_default_thinking TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS profile_projects (
                profile_id TEXT NOT NULL,
                project_path TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_opened TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (profile_id, project_path),
                FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
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
            CREATE INDEX IF NOT EXISTS idx_profile_projects_last_opened
                ON profile_projects (profile_id, last_opened DESC);
            """
        )
        ensure_migration_markers_table(conn)
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
        if "profile_id" not in existing_session_columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'"
            )
        if "hidden_at" not in existing_session_columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN hidden_at TEXT"
            )
        for column_name in (
            "provider_id",
            "provider_session_id",
            "provider_session_title",
            "provider_agent_id",
        ):
            if column_name not in existing_session_columns:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {column_name} TEXT")
        existing_binding_columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(chat_session_bindings)").fetchall()
        }
        if "profile_id" not in existing_binding_columns:
            conn.execute(
                "ALTER TABLE chat_session_bindings ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'"
            )
        if "hidden_at" not in existing_binding_columns:
            conn.execute(
                "ALTER TABLE chat_session_bindings ADD COLUMN hidden_at TEXT"
            )
        for column_name in (
            "provider_id",
            "provider_session_id",
            "provider_session_title",
            "provider_agent_id",
        ):
            if column_name not in existing_binding_columns:
                conn.execute(
                    f"ALTER TABLE chat_session_bindings ADD COLUMN {column_name} TEXT"
                )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_provider_session
                ON sessions (provider_id, provider_session_id)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chat_session_bindings_provider_session
                ON chat_session_bindings (provider_id, provider_session_id)
            """
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
            if "last_workspace_browse_directory" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN last_workspace_browse_directory TEXT"
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
            if "default_agent_provider_id" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN default_agent_provider_id TEXT NOT NULL DEFAULT 'agent-deck'"
                )
            if "default_workspace_mode" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN default_workspace_mode TEXT NOT NULL DEFAULT 'root'"
                )
            if "updated_at" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
                )
            if "claude_default_model" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN claude_default_model TEXT"
                )
            if "claude_default_thinking" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN claude_default_thinking TEXT"
                )
            if "codex_default_model" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN codex_default_model TEXT"
                )
            if "codex_default_thinking" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN codex_default_thinking TEXT"
                )
            if "gemini_default_model" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN gemini_default_model TEXT"
                )
            if "pi_default_model" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN pi_default_model TEXT"
                )
            if "pi_default_thinking" not in existing_profile_columns:
                conn.execute(
                    "ALTER TABLE profile_state ADD COLUMN pi_default_thinking TEXT"
                )
        existing_projects_columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(projects)").fetchall()
        }
        if "logo_forge_state_json" not in existing_projects_columns:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN logo_forge_state_json TEXT"
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
        conn.execute(
            """
            UPDATE sessions
            SET profile_id = ?
            WHERE profile_id IS NULL OR TRIM(profile_id) = ''
            """,
            (DEFAULT_PROFILE_ID,),
        )
        conn.execute(
            """
            UPDATE chat_session_bindings
            SET profile_id = ?
            WHERE profile_id IS NULL OR TRIM(profile_id) = ''
            """,
            (DEFAULT_PROFILE_ID,),
        )
        conn.execute(
            """
            UPDATE sessions
            SET provider_id = 'agent-deck',
                provider_session_id = agent_deck_session_id,
                provider_session_title = agent_deck_session_title,
                provider_agent_id = agent_deck_tool
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
              AND (provider_session_id IS NULL OR TRIM(provider_session_id) = '')
            """
        )
        conn.execute(
            """
            UPDATE sessions
            SET agent_deck_session_id = provider_session_id,
                agent_deck_session_title = provider_session_title,
                agent_deck_tool = provider_agent_id
            WHERE provider_id = 'agent-deck'
              AND provider_session_id IS NOT NULL
              AND TRIM(provider_session_id) <> ''
              AND (agent_deck_session_id IS NULL OR TRIM(agent_deck_session_id) = '')
            """
        )
        conn.execute(
            """
            UPDATE chat_session_bindings
            SET provider_id = 'agent-deck',
                provider_session_id = agent_deck_session_id,
                provider_session_title = agent_deck_session_title,
                provider_agent_id = agent_deck_tool
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
              AND (provider_session_id IS NULL OR TRIM(provider_session_id) = '')
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO profile_projects (profile_id, project_path, created_at, last_opened)
            SELECT ?, path, created_at, last_opened
            FROM projects
            """,
            (DEFAULT_PROFILE_ID,),
        )
        _migrate_legacy_live_editor_state(conn)
        _migrate_legacy_instance_state(conn)
        conn.execute(
            """
            UPDATE sessions
            SET provider_id = 'agent-deck',
                provider_session_id = agent_deck_session_id,
                provider_session_title = agent_deck_session_title,
                provider_agent_id = agent_deck_tool
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
              AND (provider_session_id IS NULL OR TRIM(provider_session_id) = '')
            """
        )
        _backfill_claude_opus_47_defaults(conn)
        conn.commit()
        _promote_legacy_attached_draft_sessions(conn)
        # Migrate session bindings — use a subquery to pick only the most
        # recently active session per agent_deck_session_id so the UNIQUE
        # constraint on agent_deck_session_id is never violated when two
        # chats happen to share a binding (e.g. from testing or rebinding).
        conn.execute(
            """
            INSERT INTO chat_session_bindings (
                chat_id,
                profile_id,
                project_path,
                workspace_path,
                provider_id,
                provider_session_id,
                provider_session_title,
                provider_agent_id,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                created_at,
                updated_at
            )
            SELECT
                thread_id,
                profile_id,
                project_path,
                workspace_path,
                COALESCE(provider_id, 'agent-deck'),
                COALESCE(provider_session_id, agent_deck_session_id),
                COALESCE(provider_session_title, agent_deck_session_title),
                COALESCE(provider_agent_id, agent_deck_tool),
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                created_at,
                last_active
            FROM sessions s
            WHERE agent_deck_session_id IS NOT NULL
              AND TRIM(agent_deck_session_id) <> ''
              AND s.rowid = (
                  SELECT s2.rowid FROM sessions s2
                  WHERE s2.agent_deck_session_id = s.agent_deck_session_id
                    AND s2.agent_deck_session_id IS NOT NULL
                    AND TRIM(s2.agent_deck_session_id) <> ''
                  ORDER BY s2.last_active DESC
                  LIMIT 1
              )
            ON CONFLICT(chat_id) DO UPDATE SET
                profile_id = excluded.profile_id,
                project_path = excluded.project_path,
                workspace_path = excluded.workspace_path,
                provider_id = excluded.provider_id,
                provider_session_id = excluded.provider_session_id,
                provider_session_title = excluded.provider_session_title,
                provider_agent_id = excluded.provider_agent_id,
                agent_deck_session_id = excluded.agent_deck_session_id,
                agent_deck_session_title = excluded.agent_deck_session_title,
                agent_deck_tool = excluded.agent_deck_tool,
                hidden_at = NULL,
                updated_at = excluded.updated_at
            ON CONFLICT(agent_deck_session_id) DO NOTHING
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO profile_state (
                profile_id,
                active_mode,
                default_agent_provider_id,
                default_agent_type,
                default_workspace_mode,
                claude_default_model,
                claude_default_thinking
            ) VALUES (?, 'screenshot', 'agent-deck', 'claude', 'root', ?, ?)
            """,
            (DEFAULT_PROFILE_ID, DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_THINKING),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO app_state (key, value)
            VALUES ('active_profile_id', ?)
            """,
            (DEFAULT_PROFILE_ID,),
        )
        conn.commit()
        _DB_INITIALIZED = True


def ensure_state_store_initialized() -> None:
    with _connect():
        return


def list_profiles() -> list[ProfileStateRecord]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT profile_id, active_project_path, active_mode, active_live_editor_thread_id,
                   last_workspace_browse_directory,
                   default_agent_provider_id,
                   default_agent_type, default_workspace_mode,
                   claude_default_model, claude_default_thinking,
                   codex_default_model, codex_default_thinking,
                   gemini_default_model,
                   pi_default_model, pi_default_thinking,
                   updated_at
            FROM profile_state
            ORDER BY CASE WHEN profile_id = ? THEN 0 ELSE 1 END, updated_at DESC, profile_id ASC
            """,
            (DEFAULT_PROFILE_ID,),
        ).fetchall()
    return [_row_to_profile_state_record(row) for row in rows]


def get_active_profile_id() -> str:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT value
            FROM app_state
            WHERE key = 'active_profile_id'
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT OR IGNORE INTO app_state (key, value)
                VALUES ('active_profile_id', ?)
                """,
                (DEFAULT_PROFILE_ID,),
            )
            conn.commit()
            return DEFAULT_PROFILE_ID
    return _normalize_profile_id(row["value"])


def set_active_profile_id(profile_id: str) -> str:
    normalized_profile_id = _normalize_profile_id(profile_id)
    upsert_profile_state(profile_id=normalized_profile_id)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO app_state (key, value)
            VALUES ('active_profile_id', ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            """,
            (normalized_profile_id,),
        )
        conn.commit()
    return normalized_profile_id


def _row_to_url_record(row: sqlite3.Row) -> ProjectUrlRecord:
    return ProjectUrlRecord(
        url=row["url"],
        last_used=row["last_used"],
        use_count=row["use_count"],
    )


def _normalize_active_mode(value: object | None) -> str:
    if value == "live-editor":
        return "live-editor"
    if value == "logo-forge":
        return "logo-forge"
    return "screenshot"


def _normalize_agent_type(value: object | None) -> str:
    return str(value) if value in {"claude", "codex", "gemini", "pi", "openclaw"} else "claude"


def _normalize_agent_provider_id(value: object | None) -> str:
    normalized = str(value or "").strip()
    return normalized if normalized in {"agent-deck", "claude-cli", "codex-cli"} else "agent-deck"


def _normalize_workspace_mode(value: object | None) -> str:
    return "root"


def _normalize_origin_kind(value: object | None) -> str:
    return "adopted" if value == "adopted" else "managed"


def _normalize_claude_model(value: object | None) -> str | None:
    normalized = str(value or "").strip()
    normalized = CLAUDE_MODEL_ALIASES.get(normalized, normalized)
    return normalized if normalized in CLAUDE_MODEL_ALLOWLIST else None


def _claude_thinking_allowlist_for_model(model: object | None) -> frozenset[str]:
    normalized_model = _normalize_claude_model(model)
    if normalized_model == DEFAULT_CLAUDE_MODEL:
        return frozenset({"low", "medium", "high", "xhigh", "max"})
    return frozenset({"low", "medium", "high", "max"})


def _normalize_claude_thinking(
    value: object | None,
    model: object | None = None,
) -> str | None:
    normalized = str(value or "").strip()
    allowlist = _claude_thinking_allowlist_for_model(model)
    return normalized if normalized in allowlist else None


def _normalize_codex_model(value: object | None) -> str | None:
    normalized = str(value or "").strip()
    return normalized if normalized in CODEX_MODEL_ALLOWLIST else None


def _normalize_codex_thinking(value: object | None) -> str | None:
    normalized = str(value or "").strip()
    return normalized if normalized in CODEX_THINKING_ALLOWLIST else None


GEMINI_MODEL_ALLOWLIST = frozenset({
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
})
PI_MODEL_ALLOWLIST = frozenset({
    "xai/grok-code-fast-1",
    "xai/grok-4.20-0309-reasoning",
    "xai/grok-4.20-0309-non-reasoning",
    "xai/grok-4-1-fast",
    "xai/grok-4-1-fast-non-reasoning",
    "xai/grok-4-fast",
    "xai/grok-4-fast-non-reasoning",
    "xai/grok-4",
    "xai/grok-3-mini-fast",
    "xai/grok-3-mini",
    "ollama/qwen2.5:32b",
    "ollama/deepseek-coder:33b",
    "ollama/qwq:32b",
    "ollama/deepseek-r1:32b",
    "ollama/qwen2.5:14b",
    "ollama/deepseek-r1:14b",
    "ollama/qwen2.5:7b",
    "ollama/llama3.1:8b",
    "ollama/mistral:7b",
})
PI_THINKING_ALLOWLIST = frozenset({"off", "minimal", "low", "medium", "high", "xhigh"})
PI_LOCAL_MODEL_RE = re.compile(r"^ollama/[A-Za-z0-9._:/+-]+$")


def _normalize_gemini_model(value: object | None) -> str | None:
    normalized = str(value or "").strip()
    return normalized if normalized in GEMINI_MODEL_ALLOWLIST else None


def _normalize_pi_model(value: object | None) -> str | None:
    normalized = str(value or "").strip()
    return (
        normalized
        if normalized in PI_MODEL_ALLOWLIST or PI_LOCAL_MODEL_RE.fullmatch(normalized)
        else None
    )


def _normalize_pi_thinking(value: object | None) -> str | None:
    normalized = str(value or "").strip()
    return normalized if normalized in PI_THINKING_ALLOWLIST else None


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
        "draftWorkspaceMode": _normalize_workspace_mode(
            editor_state.get("draftWorkspaceMode")
        ),
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
        profile_id=_normalize_profile_id(row["profile_id"]),
        project_path=row["project_path"],
        workspace_path=row["workspace_path"] or row["project_path"],
        thread_id=row["thread_id"],
        backend=row["backend"],
        origin_kind=_normalize_origin_kind(row["origin_kind"]),
        provider_id=row["provider_id"],
        provider_session_id=row["provider_session_id"],
        provider_session_title=row["provider_session_title"],
        provider_agent_id=row["provider_agent_id"],
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
        sessions.profile_id,
        sessions.project_path,
        COALESCE(chat_session_bindings.workspace_path, sessions.workspace_path) AS workspace_path,
        sessions.thread_id,
        sessions.backend,
        sessions.origin_kind,
        COALESCE(
            chat_session_bindings.provider_id,
            sessions.provider_id,
            CASE
                WHEN COALESCE(chat_session_bindings.agent_deck_session_id, sessions.agent_deck_session_id) IS NOT NULL
                 AND TRIM(COALESCE(chat_session_bindings.agent_deck_session_id, sessions.agent_deck_session_id)) <> ''
                    THEN 'agent-deck'
                ELSE NULL
            END
        ) AS provider_id,
        COALESCE(
            chat_session_bindings.provider_session_id,
            sessions.provider_session_id,
            chat_session_bindings.agent_deck_session_id,
            sessions.agent_deck_session_id
        ) AS provider_session_id,
        COALESCE(
            chat_session_bindings.provider_session_title,
            sessions.provider_session_title,
            chat_session_bindings.agent_deck_session_title,
            sessions.agent_deck_session_title
        ) AS provider_session_title,
        COALESCE(
            chat_session_bindings.provider_agent_id,
            sessions.provider_agent_id,
            chat_session_bindings.agent_deck_tool,
            sessions.agent_deck_tool
        ) AS provider_agent_id,
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
       AND chat_session_bindings.hidden_at IS NULL
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
        ORDER BY sessions.id ASC
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


def _hide_chat_binding(
    conn: sqlite3.Connection,
    *,
    profile_id: str,
    chat_id: str,
) -> None:
    conn.execute(
        """
        UPDATE chat_session_bindings
        SET hidden_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE profile_id = ?
          AND chat_id = ?
          AND hidden_at IS NULL
        """,
        (profile_id, chat_id),
    )


def _upsert_chat_binding(
    conn: sqlite3.Connection,
    *,
    profile_id: str,
    project_path: str,
    chat_id: str,
    workspace_path: str,
    provider_id: str | None,
    provider_session_id: str | None,
    provider_session_title: str | None,
    provider_agent_id: str | None,
    agent_deck_session_id: str,
    agent_deck_session_title: str | None,
    agent_deck_tool: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO chat_session_bindings (
            chat_id,
            profile_id,
            project_path,
            workspace_path,
            provider_id,
            provider_session_id,
            provider_session_title,
            provider_agent_id,
            agent_deck_session_id,
            agent_deck_session_title,
            agent_deck_tool
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
            profile_id = excluded.profile_id,
            project_path = excluded.project_path,
            workspace_path = excluded.workspace_path,
            provider_id = excluded.provider_id,
            provider_session_id = excluded.provider_session_id,
            provider_session_title = excluded.provider_session_title,
            provider_agent_id = excluded.provider_agent_id,
            agent_deck_session_id = excluded.agent_deck_session_id,
            agent_deck_session_title = excluded.agent_deck_session_title,
            agent_deck_tool = excluded.agent_deck_tool,
            hidden_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            chat_id,
            profile_id,
            project_path,
            workspace_path,
            provider_id,
            provider_session_id,
            provider_session_title,
            provider_agent_id,
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
    last_workspace_browse_directory = row["last_workspace_browse_directory"]
    normalized_last_workspace_browse_directory = (
        normalize_project_path(last_workspace_browse_directory)
        if isinstance(last_workspace_browse_directory, str)
        and last_workspace_browse_directory.strip()
        else None
    )
    active_thread_id = row["active_live_editor_thread_id"]
    return ProfileStateRecord(
        profile_id=row["profile_id"],
        active_project_path=normalized_project_path,
        last_workspace_browse_directory=normalized_last_workspace_browse_directory,
        active_mode=_normalize_active_mode(row["active_mode"]),
        active_live_editor_thread_id=(
            active_thread_id.strip()
            if isinstance(active_thread_id, str) and active_thread_id.strip()
            else None
        ),
        default_agent_type=_normalize_agent_type(row["default_agent_type"]),
        default_agent_provider_id=_normalize_agent_provider_id(
            row["default_agent_provider_id"]
        ),
        default_workspace_mode=_normalize_workspace_mode(row["default_workspace_mode"]),
        claude_default_model=_normalize_claude_model(row["claude_default_model"]),
        claude_default_thinking=_normalize_claude_thinking(
            row["claude_default_thinking"],
            row["claude_default_model"],
        ),
        codex_default_model=_normalize_codex_model(row["codex_default_model"]),
        codex_default_thinking=_normalize_codex_thinking(row["codex_default_thinking"]),
        gemini_default_model=_normalize_gemini_model(row["gemini_default_model"]),
        pi_default_model=_normalize_pi_model(row["pi_default_model"]),
        pi_default_thinking=_normalize_pi_thinking(row["pi_default_thinking"]),
        updated_at=row["updated_at"],
    )


def _is_stale_clone_session(record: SessionRecord) -> bool:
    if record.workspace_path == record.project_path:
        return False
    if f"{os.sep}.agents{os.sep}" not in record.workspace_path:
        return False
    return not os.path.isdir(record.workspace_path)


def _session_has_workstation_events(conn: sqlite3.Connection, thread_id: str) -> bool:
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return False

    if _table_exists(conn, "workstation_events"):
        row = conn.execute(
            """
            SELECT 1
            FROM workstation_events
            WHERE chat_id = ?
            LIMIT 1
            """,
            (normalized_thread_id,),
        ).fetchone()
        if row is not None:
            return True
    return False


def _live_editor_thread_has_meaningful_state(
    conn: sqlite3.Connection,
    thread_id: str,
) -> bool:
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id or not _table_exists(conn, "live_editor_threads"):
        return False

    row = conn.execute(
        """
        SELECT agent_deck_session_id, agent_deck_session_title, last_request_id
        FROM live_editor_threads
        WHERE thread_id = ?
        LIMIT 1
        """,
        (normalized_thread_id,),
    ).fetchone()
    if row is None:
        return False

    for column in ("agent_deck_session_id", "agent_deck_session_title", "last_request_id"):
        value = row[column]
        if isinstance(value, str) and value.strip():
            return True
    return False


def _profile_state_references_thread(
    conn: sqlite3.Connection,
    thread_id: str,
) -> bool:
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id or not _table_exists(conn, "profile_state"):
        return False

    row = conn.execute(
        """
        SELECT 1
        FROM profile_state
        WHERE active_live_editor_thread_id = ?
        LIMIT 1
        """,
        (normalized_thread_id,),
    ).fetchone()
    return row is not None


def _session_has_saved_activity(conn: sqlite3.Connection, thread_id: str) -> bool:
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return False

    if _live_editor_thread_has_meaningful_state(conn, normalized_thread_id):
        return True

    if _session_has_workstation_events(conn, normalized_thread_id):
        return True

    return False


def _should_prune_detached_legacy_managed_root_session(
    conn: sqlite3.Connection,
    record: SessionRecord,
    project_path: str,
) -> bool:
    if record.origin_kind != "managed":
        return False
    if record.agent_deck_session_id:
        return False
    if normalize_project_path(record.workspace_path) != normalize_project_path(project_path):
        return False

    normalized_thread_id = (
        record.thread_id.strip()
        if isinstance(record.thread_id, str) and record.thread_id.strip()
        else ""
    )
    if not normalized_thread_id:
        return False
    if normalized_thread_id.startswith("chat-") or normalized_thread_id.startswith("draft-"):
        return False
    if (
        isinstance(record.agent_deck_session_title, str)
        and record.agent_deck_session_title.strip()
    ):
        return False
    if _session_has_meaningful_editor_state(record):
        return False
    if _profile_state_references_thread(conn, normalized_thread_id):
        return False
    return not _session_has_saved_activity(conn, normalized_thread_id)


def _delete_project_thread_rows(
    conn: sqlite3.Connection,
    project_path: str,
    thread_ids: list[str],
) -> None:
    if not thread_ids:
        return

    placeholders = ",".join("?" for _ in thread_ids)
    conn.execute(
        f"""
        DELETE FROM chat_session_bindings
        WHERE project_path = ?
          AND chat_id IN ({placeholders})
        """,
        (project_path, *thread_ids),
    )
    if _table_exists(conn, "live_editor_threads"):
        conn.execute(
            f"""
            DELETE FROM live_editor_threads
            WHERE thread_id IN ({placeholders})
            """,
            (*thread_ids,),
        )
    conn.execute(
        f"""
        DELETE FROM sessions
        WHERE project_path = ?
          AND thread_id IN ({placeholders})
        """,
        (project_path, *thread_ids),
    )


def _should_prune_detached_adopted_root_session(
    conn: sqlite3.Connection,
    record: SessionRecord,
    project_path: str,
) -> bool:
    if record.origin_kind != "adopted":
        return False
    if record.agent_deck_session_id:
        return False
    if normalize_project_path(record.workspace_path) != normalize_project_path(project_path):
        return False
    if _session_has_meaningful_editor_state(record):
        return False
    return not _session_has_saved_activity(conn, record.thread_id)


def detach_missing_agent_deck_session_bindings(
    project_path: str,
    available_session_ids: set[str] | list[str] | tuple[str, ...],
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> list[SessionRecord]:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    available_ids = {
        session_id.strip()
        for session_id in available_session_ids
        if isinstance(session_id, str) and session_id.strip()
    }

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL",
            params=(normalized_path, normalized_profile_id),
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
                  AND profile_id = ?
                  AND chat_id IN ({placeholders})
                """,
                (normalized_path, normalized_profile_id, *detached_thread_ids),
            )
            conn.execute(
                f"""
                UPDATE sessions
                SET provider_id = NULL,
                    provider_session_id = NULL,
                    provider_session_title = NULL,
                    provider_agent_id = NULL,
                    agent_deck_session_id = NULL,
                    agent_deck_session_title = NULL,
                    agent_deck_tool = NULL
                WHERE project_path = ?
                  AND profile_id = ?
                  AND thread_id IN ({placeholders})
                """,
                (normalized_path, normalized_profile_id, *detached_thread_ids),
            )
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL",
            params=(normalized_path, normalized_profile_id),
        )
        pruned_thread_ids = [
            record.thread_id
            for record in records
            if _should_prune_detached_adopted_root_session(conn, record, normalized_path)
            or _should_prune_detached_legacy_managed_root_session(conn, record, normalized_path)
        ]
        if pruned_thread_ids:
            _delete_project_thread_rows(conn, normalized_path, pruned_thread_ids)
        if stale_ids or detached_thread_ids or pruned_thread_ids:
            conn.commit()

        return _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL",
            params=(normalized_path, normalized_profile_id),
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


def list_project_sessions(
    project_path: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> list[SessionRecord]:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL",
            params=(normalized_path, normalized_profile_id),
        )
        stale_ids = [record.id for record in records if _is_stale_clone_session(record)]
        pruned_thread_ids = [
            record.thread_id
            for record in records
            if _should_prune_detached_adopted_root_session(conn, record, normalized_path)
            or _should_prune_detached_legacy_managed_root_session(conn, record, normalized_path)
        ]
        if stale_ids:
            placeholders = ",".join("?" for _ in stale_ids)
            conn.execute(
                f"DELETE FROM sessions WHERE id IN ({placeholders})",
                stale_ids,
            )
        if pruned_thread_ids:
            _delete_project_thread_rows(conn, normalized_path, pruned_thread_ids)
        if stale_ids or pruned_thread_ids:
            conn.commit()
        return [
            record
            for record in records
            if record.id not in stale_ids
            and record.thread_id not in pruned_thread_ids
            and should_surface_session(record, normalized_path)
        ]


def get_project_session(
    project_path: str,
    thread_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return None

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql="sessions.project_path = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL AND sessions.thread_id = ?",
            params=(normalized_path, normalized_profile_id, normalized_thread_id),
        )

    if not records:
        return None
    return records[0]


def get_project_session_by_agent_deck_session_id(
    project_path: str,
    agent_deck_session_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> SessionRecord | None:
    return get_project_session_by_provider_session_id(
        project_path,
        "agent-deck",
        agent_deck_session_id,
        profile_id=profile_id,
    )


def get_project_session_by_provider_session_id(
    project_path: str,
    provider_id: str,
    provider_session_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_provider_id = _normalize_optional_text(provider_id)
    normalized_session_id = _normalize_optional_text(provider_session_id)
    if not normalized_provider_id or not normalized_session_id:
        return None

    with _connect() as conn:
        records = _fetch_session_records(
            conn,
            where_sql=(
                "sessions.project_path = ? AND COALESCE("
                "chat_session_bindings.provider_id, sessions.provider_id"
                ") = ? AND COALESCE("
                "chat_session_bindings.provider_session_id, sessions.provider_session_id"
                ") = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL"
            ),
            params=(
                normalized_path,
                normalized_provider_id,
                normalized_session_id,
                normalized_profile_id,
            ),
        )

    if not records:
        return None
    return records[0]


def list_sessions_by_agent_deck_session_id(
    agent_deck_session_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> list[SessionRecord]:
    return list_sessions_by_provider_session_id(
        "agent-deck",
        agent_deck_session_id,
        profile_id=profile_id,
    )


def list_sessions_by_provider_session_id(
    provider_id: str,
    provider_session_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> list[SessionRecord]:
    normalized_provider_id = _normalize_optional_text(provider_id)
    normalized_session_id = _normalize_optional_text(provider_session_id)
    normalized_profile_id = _normalize_profile_id(profile_id)
    if not normalized_provider_id or not normalized_session_id:
        return []

    with _connect() as conn:
        return _fetch_session_records(
            conn,
            where_sql=(
                "COALESCE("
                "chat_session_bindings.provider_id, sessions.provider_id"
                ") = ? AND COALESCE("
                "chat_session_bindings.provider_session_id, sessions.provider_session_id"
                ") = ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL"
            ),
            params=(normalized_provider_id, normalized_session_id, normalized_profile_id),
        )


def detach_project_session_binding(
    project_path: str,
    thread_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return None

    with _connect() as conn:
        _delete_chat_binding(conn, normalized_thread_id)
        conn.execute(
            """
            UPDATE sessions
            SET provider_id = NULL,
                provider_session_id = NULL,
                provider_session_title = NULL,
                provider_agent_id = NULL,
                agent_deck_session_id = NULL,
                agent_deck_session_title = NULL,
                agent_deck_tool = NULL,
                last_active = CURRENT_TIMESTAMP
            WHERE project_path = ?
              AND profile_id = ?
              AND thread_id = ?
            """,
            (normalized_path, normalized_profile_id, normalized_thread_id),
        )
        conn.commit()

    return get_project_session(normalized_path, normalized_thread_id, profile_id=normalized_profile_id)


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


def get_project_logo_forge_state(project_path: str) -> dict[str, object] | None:
    normalized_path = normalize_project_path(project_path)
    with _connect() as conn:
        row = conn.execute(
            "SELECT logo_forge_state_json FROM projects WHERE path = ?",
            (normalized_path,),
        ).fetchone()
    if row is None:
        return None
    raw = row["logo_forge_state_json"]
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def upsert_project_logo_forge_state(
    project_path: str, state: dict[str, object] | None
) -> bool:
    normalized_path = normalize_project_path(project_path)
    serialized = json.dumps(state) if isinstance(state, dict) else None
    with _connect() as conn:
        result = conn.execute(
            "UPDATE projects SET logo_forge_state_json = ? WHERE path = ?",
            (serialized, normalized_path),
        )
        conn.commit()
        return result.rowcount > 0


def list_projects() -> list[ProjectRecord]:
    with _connect() as conn:
        temp_root = Path(tempfile.gettempdir()).resolve()
        stale_temp_paths: list[str] = []
        for row in conn.execute("SELECT path FROM projects").fetchall():
            project_path = row["path"]
            try:
                resolved_path = Path(project_path).expanduser().resolve(strict=False)
            except OSError:
                continue
            if resolved_path.exists():
                continue
            try:
                is_temp_project = os.path.commonpath([str(resolved_path), str(temp_root)]) == str(temp_root)
            except ValueError:
                is_temp_project = False
            if is_temp_project:
                stale_temp_paths.append(project_path)

        if stale_temp_paths:
            conn.executemany(
                """
                DELETE FROM projects
                WHERE path = ?
                """,
                ((path,) for path in stale_temp_paths),
            )
            conn.commit()

        rows = conn.execute(
            """
            SELECT path, name, output_mode, custom_output_path, created_at, last_opened
            FROM projects
            ORDER BY created_at ASC, path ASC
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
                default_agent_provider_id,
                default_agent_type,
                default_workspace_mode,
                claude_default_model,
                claude_default_thinking
            ) VALUES (?, 'screenshot', 'agent-deck', 'claude', 'root', ?, ?)
            """,
            (normalized_profile_id, DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_THINKING),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT profile_id, active_project_path, active_mode, active_live_editor_thread_id,
                   last_workspace_browse_directory,
                   default_agent_provider_id,
                   default_agent_type, default_workspace_mode,
                   claude_default_model, claude_default_thinking,
                   codex_default_model, codex_default_thinking,
                   gemini_default_model,
                   pi_default_model, pi_default_thinking,
                   updated_at
            FROM profile_state
            WHERE profile_id = ?
            """,
            (normalized_profile_id,),
        ).fetchone()

    if row is None:
        raise RuntimeError("Profile state record disappeared during fetch")

    return _row_to_profile_state_record(row)


def create_profile(
    profile_id: str,
    *,
    clone_from_profile_id: str | None = None,
) -> ProfileStateRecord:
    normalized_profile_id = _normalize_profile_id(profile_id)
    if normalized_profile_id == DEFAULT_PROFILE_ID:
        return get_profile_state(normalized_profile_id)

    source_profile = (
        get_profile_state(clone_from_profile_id)
        if isinstance(clone_from_profile_id, str) and clone_from_profile_id.strip()
        else get_profile_state(DEFAULT_PROFILE_ID)
    )
    return upsert_profile_state(
        profile_id=normalized_profile_id,
        active_project_path=None,
        last_workspace_browse_directory=source_profile.last_workspace_browse_directory,
        active_mode="screenshot",
        active_live_editor_thread_id=None,
        default_agent_provider_id=source_profile.default_agent_provider_id,
        default_agent_type=source_profile.default_agent_type,
        default_workspace_mode=source_profile.default_workspace_mode,
        claude_default_model=source_profile.claude_default_model,
        claude_default_thinking=source_profile.claude_default_thinking,
        codex_default_model=source_profile.codex_default_model,
        codex_default_thinking=source_profile.codex_default_thinking,
        gemini_default_model=source_profile.gemini_default_model,
        pi_default_model=source_profile.pi_default_model,
        pi_default_thinking=source_profile.pi_default_thinking,
    )


def upsert_profile_state(
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
    active_project_path: str | None = None,
    last_workspace_browse_directory: str | None = None,
    active_mode: str = "screenshot",
    active_live_editor_thread_id: str | None = None,
    default_agent_provider_id: str = "agent-deck",
    default_agent_type: str = "claude",
    default_workspace_mode: str = "root",
    claude_default_model: str | None = None,
    claude_default_thinking: str | None = None,
    codex_default_model: str | None = None,
    codex_default_thinking: str | None = None,
    gemini_default_model: str | None = None,
    pi_default_model: str | None = None,
    pi_default_thinking: str | None = None,
) -> ProfileStateRecord:
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_project_path = (
        normalize_project_path(active_project_path)
        if isinstance(active_project_path, str) and active_project_path.strip()
        else None
    )
    normalized_last_workspace_browse_directory = (
        normalize_project_path(last_workspace_browse_directory)
        if isinstance(last_workspace_browse_directory, str)
        and last_workspace_browse_directory.strip()
        else None
    )
    normalized_thread_id = (
        active_live_editor_thread_id.strip()
        if isinstance(active_live_editor_thread_id, str) and active_live_editor_thread_id.strip()
        else None
    )
    normalized_default_agent_provider_id = _normalize_agent_provider_id(
        default_agent_provider_id
    )
    normalized_default_agent_type = _normalize_agent_type(default_agent_type)
    normalized_default_workspace_mode = _normalize_workspace_mode(default_workspace_mode)
    normalized_claude_default_model = _normalize_claude_model(claude_default_model)
    normalized_claude_default_thinking = _normalize_claude_thinking(
        claude_default_thinking,
        normalized_claude_default_model,
    )
    normalized_codex_default_model = _normalize_codex_model(codex_default_model)
    normalized_codex_default_thinking = _normalize_codex_thinking(codex_default_thinking)
    normalized_gemini_default_model = _normalize_gemini_model(gemini_default_model)
    normalized_pi_default_model = _normalize_pi_model(pi_default_model)
    normalized_pi_default_thinking = _normalize_pi_thinking(pi_default_thinking)

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO profile_state (
                profile_id,
                active_project_path,
                last_workspace_browse_directory,
                active_mode,
                active_live_editor_thread_id,
                default_agent_provider_id,
                default_agent_type,
                default_workspace_mode,
                claude_default_model,
                claude_default_thinking,
                codex_default_model,
                codex_default_thinking,
                gemini_default_model,
                pi_default_model,
                pi_default_thinking
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET
                active_project_path = excluded.active_project_path,
                last_workspace_browse_directory = excluded.last_workspace_browse_directory,
                active_mode = excluded.active_mode,
                active_live_editor_thread_id = CASE
                    WHEN excluded.active_project_path IS NULL THEN NULL
                    ELSE excluded.active_live_editor_thread_id
                END,
                default_agent_provider_id = excluded.default_agent_provider_id,
                default_agent_type = excluded.default_agent_type,
                default_workspace_mode = excluded.default_workspace_mode,
                claude_default_model = excluded.claude_default_model,
                claude_default_thinking = excluded.claude_default_thinking,
                codex_default_model = excluded.codex_default_model,
                codex_default_thinking = excluded.codex_default_thinking,
                gemini_default_model = excluded.gemini_default_model,
                pi_default_model = excluded.pi_default_model,
                pi_default_thinking = excluded.pi_default_thinking,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                normalized_profile_id,
                normalized_project_path,
                normalized_last_workspace_browse_directory,
                _normalize_active_mode(active_mode),
                normalized_thread_id,
                normalized_default_agent_provider_id,
                normalized_default_agent_type,
                normalized_default_workspace_mode,
                normalized_claude_default_model,
                normalized_claude_default_thinking,
                normalized_codex_default_model,
                normalized_codex_default_thinking,
                normalized_gemini_default_model,
                normalized_pi_default_model,
                normalized_pi_default_thinking,
            ),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT profile_id, active_project_path, active_mode, active_live_editor_thread_id,
                   last_workspace_browse_directory,
                   default_agent_provider_id,
                   default_agent_type, default_workspace_mode,
                   claude_default_model, claude_default_thinking,
                   codex_default_model, codex_default_thinking,
                   gemini_default_model,
                   pi_default_model, pi_default_thinking,
                   updated_at
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
    profile_id: str = DEFAULT_PROFILE_ID,
    origin_kind: str = "managed",
    workspace_path: str | None = None,
    provider_id: str | None = None,
    provider_session_id: str | None = None,
    provider_session_title: str | None = None,
    provider_agent_id: str | None = None,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    agent_deck_tool: str | None = None,
    editor_state: dict[str, Any] | None = None,
) -> SessionRecord:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        raise ValueError("thread_id is required")
    (
        normalized_provider_id,
        normalized_provider_session_id,
        normalized_provider_session_title,
        normalized_provider_agent_id,
        normalized_agent_deck_session_id,
        normalized_agent_deck_session_title,
        normalized_agent_deck_tool,
    ) = _normalize_provider_binding(
        provider_id=provider_id,
        provider_session_id=provider_session_id,
        provider_session_title=provider_session_title,
        provider_agent_id=provider_agent_id,
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_session_title,
        agent_deck_tool=agent_deck_tool,
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

        effective_thread_id = normalized_thread_id
        if _should_promote_attached_draft_thread(
            normalized_thread_id,
            normalized_agent_deck_session_id,
        ):
            existing_draft_row = conn.execute(
                """
                SELECT 1
                FROM sessions
                WHERE project_path = ?
                  AND thread_id = ?
                """,
                (normalized_path, normalized_thread_id),
            ).fetchone()
            effective_thread_id = _next_unique_chat_id(conn)
            if existing_draft_row is not None:
                _promote_session_thread_identity(
                    conn,
                    project_path=normalized_path,
                    from_thread_id=normalized_thread_id,
                    to_thread_id=effective_thread_id,
                )

        conflicting_record: SessionRecord | None = None
        stale_ids: list[int] = []
        if normalized_provider_session_id:
            rows = _fetch_session_records(
                conn,
                where_sql=(
                    "sessions.project_path = ? AND COALESCE("
                    "chat_session_bindings.provider_id, sessions.provider_id"
                    ") = ? AND COALESCE("
                    "chat_session_bindings.provider_session_id, sessions.provider_session_id"
                    ") = ? AND sessions.thread_id <> ? AND sessions.profile_id = ? AND sessions.hidden_at IS NULL"
                ),
                params=(
                    normalized_path,
                    normalized_provider_id,
                    normalized_provider_session_id,
                    effective_thread_id,
                    normalized_profile_id,
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
                    "Agent provider session "
                    f"{normalized_provider_session_id} is already bound to Live Editor thread "
                    f"{conflicting_record.thread_id}"
                )

        conn.execute(
            """
            INSERT INTO sessions (
                profile_id,
                project_path,
                workspace_path,
                thread_id,
                backend,
                origin_kind,
                provider_id,
                provider_session_id,
                provider_session_title,
                provider_agent_id,
                agent_deck_session_id,
                agent_deck_session_title,
                agent_deck_tool,
                editor_state_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                profile_id = excluded.profile_id,
                project_path = excluded.project_path,
                workspace_path = excluded.workspace_path,
                backend = excluded.backend,
                origin_kind = excluded.origin_kind,
                provider_id = excluded.provider_id,
                provider_session_id = excluded.provider_session_id,
                provider_session_title = excluded.provider_session_title,
                provider_agent_id = excluded.provider_agent_id,
                agent_deck_session_id = excluded.agent_deck_session_id,
                agent_deck_session_title = excluded.agent_deck_session_title,
                agent_deck_tool = excluded.agent_deck_tool,
                editor_state_json = COALESCE(excluded.editor_state_json, sessions.editor_state_json),
                hidden_at = NULL,
                last_active = CURRENT_TIMESTAMP
            """,
            (
                normalized_profile_id,
                normalized_path,
                normalized_workspace_path,
                effective_thread_id,
                backend.strip() or "agent-deck",
                _normalize_origin_kind(origin_kind),
                normalized_provider_id,
                normalized_provider_session_id,
                normalized_provider_session_title,
                normalized_provider_agent_id,
                normalized_agent_deck_session_id,
                normalized_agent_deck_session_title,
                normalized_agent_deck_tool,
                serialized_editor_state,
            ),
        )
        if normalized_agent_deck_session_id:
            _upsert_chat_binding(
                conn,
                profile_id=normalized_profile_id,
                project_path=normalized_path,
                chat_id=effective_thread_id,
                workspace_path=normalized_workspace_path,
                provider_id=normalized_provider_id,
                provider_session_id=normalized_provider_session_id,
                provider_session_title=normalized_provider_session_title,
                provider_agent_id=normalized_provider_agent_id,
                agent_deck_session_id=normalized_agent_deck_session_id,
                agent_deck_session_title=normalized_agent_deck_session_title,
                agent_deck_tool=normalized_agent_deck_tool,
            )
        else:
            _delete_chat_binding(conn, effective_thread_id)
        conn.execute(
            """
            UPDATE projects
            SET last_opened = CURRENT_TIMESTAMP
            WHERE path = ?
            """,
            (normalized_path,),
        )
        conn.commit()

    saved = get_project_session(normalized_path, effective_thread_id, profile_id=normalized_profile_id)
    if saved is None:
        raise RuntimeError("Session record disappeared during upsert")
    return saved


def create_adopted_project_session(
    project_path: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
    workspace_path: str,
    agent_deck_session_id: str,
    agent_deck_session_title: str | None,
    agent_deck_tool: str | None,
) -> SessionRecord:
    existing = get_project_session_by_agent_deck_session_id(
        project_path,
        agent_deck_session_id,
        profile_id=profile_id,
    )
    if existing is not None:
        return upsert_session(
            project_path,
            thread_id=existing.thread_id,
            backend=existing.backend,
            profile_id=profile_id,
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
        profile_id=profile_id,
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
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> SessionRecord | None:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return None

    normalized_title = title.strip() if isinstance(title, str) else None

    with _connect() as conn:
        conn.execute(
            """
            UPDATE sessions
            SET provider_session_title = ?,
                agent_deck_session_title = CASE
                    WHEN COALESCE(provider_id, 'agent-deck') = 'agent-deck'
                    THEN ?
                    ELSE agent_deck_session_title
                END,
                last_active = CURRENT_TIMESTAMP
            WHERE project_path = ?
              AND profile_id = ?
              AND thread_id = ?
            """,
            (
                normalized_title,
                normalized_title,
                normalized_path,
                normalized_profile_id,
                normalized_thread_id,
            ),
        )
        conn.execute(
            """
            UPDATE chat_session_bindings
            SET provider_session_title = ?,
                agent_deck_session_title = CASE
                    WHEN COALESCE(provider_id, 'agent-deck') = 'agent-deck'
                    THEN ?
                    ELSE agent_deck_session_title
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE project_path = ?
              AND profile_id = ?
              AND chat_id = ?
            """,
            (
                normalized_title,
                normalized_title,
                normalized_path,
                normalized_profile_id,
                normalized_thread_id,
            ),
        )
        conn.commit()

    return get_project_session(normalized_path, normalized_thread_id, profile_id=normalized_profile_id)


def delete_session(
    project_path: str,
    thread_id: str,
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
    purge: bool = False,
) -> bool:
    normalized_path = normalize_project_path(project_path)
    normalized_profile_id = _normalize_profile_id(profile_id)
    normalized_thread_id = thread_id.strip()
    if not normalized_thread_id:
        return False

    with _connect() as conn:
        if purge:
            _delete_chat_binding(conn, normalized_thread_id)
            result = conn.execute(
                """
                DELETE FROM sessions
                WHERE project_path = ?
                  AND profile_id = ?
                  AND thread_id = ?
                """,
                (normalized_path, normalized_profile_id, normalized_thread_id),
            )
        else:
            _hide_chat_binding(
                conn,
                profile_id=normalized_profile_id,
                chat_id=normalized_thread_id,
            )
            conn.execute(
                """
                UPDATE profile_state
                SET active_live_editor_thread_id = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE profile_id = ?
                  AND active_live_editor_thread_id = ?
                """,
                (normalized_profile_id, normalized_thread_id),
            )
            result = conn.execute(
                """
                UPDATE sessions
                SET hidden_at = CURRENT_TIMESTAMP,
                    last_active = CURRENT_TIMESTAMP
                WHERE project_path = ?
                  AND profile_id = ?
                  AND thread_id = ?
                  AND hidden_at IS NULL
                """,
                (normalized_path, normalized_profile_id, normalized_thread_id),
            )
        conn.commit()

    return bool(result.rowcount)


def purge_hidden_profile_history(
    *,
    profile_id: str = DEFAULT_PROFILE_ID,
) -> dict[str, int]:
    normalized_profile_id = _normalize_profile_id(profile_id)

    with _connect() as conn:
        hidden_rows = conn.execute(
            """
            SELECT project_path, thread_id
            FROM sessions
            WHERE profile_id = ?
              AND hidden_at IS NOT NULL
            """,
            (normalized_profile_id,),
        ).fetchall()
        hidden_thread_ids = [str(row["thread_id"]) for row in hidden_rows]

        workstation_events_deleted = 0
        if hidden_thread_ids and _table_exists(conn, "workstation_events"):
            placeholders = ",".join("?" for _ in hidden_thread_ids)
            result = conn.execute(
                f"""
                DELETE FROM workstation_events
                WHERE chat_id IN ({placeholders})
                """,
                tuple(hidden_thread_ids),
            )
            workstation_events_deleted = int(result.rowcount or 0)

        bindings_deleted = int(
            conn.execute(
                """
                DELETE FROM chat_session_bindings
                WHERE profile_id = ?
                  AND hidden_at IS NOT NULL
                """,
                (normalized_profile_id,),
            ).rowcount
            or 0
        )
        sessions_deleted = int(
            conn.execute(
                """
                DELETE FROM sessions
                WHERE profile_id = ?
                  AND hidden_at IS NOT NULL
                """,
                (normalized_profile_id,),
            ).rowcount
            or 0
        )
        conn.commit()

    for row in hidden_rows:
        artifact_root = _thread_artifact_root(row["project_path"], row["thread_id"])
        if artifact_root.exists():
            shutil.rmtree(artifact_root, ignore_errors=True)

    return {
        "sessions_deleted": sessions_deleted,
        "bindings_deleted": bindings_deleted,
        "workstation_events_deleted": workstation_events_deleted,
    }
