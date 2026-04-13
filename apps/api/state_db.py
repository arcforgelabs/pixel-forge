from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from runtime_config import shared_db_path as runtime_shared_db_path
from runtime_config import shared_state_dir as runtime_shared_state_dir


def state_dir() -> Path:
    return runtime_shared_state_dir()


def db_path() -> Path:
    return runtime_shared_db_path()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def ensure_migration_markers_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS migration_markers (
            key TEXT PRIMARY KEY,
            completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def has_migration_marker(conn: sqlite3.Connection, key: str) -> bool:
    ensure_migration_markers_table(conn)
    row = conn.execute(
        """
        SELECT 1
        FROM migration_markers
        WHERE key = ?
        LIMIT 1
        """,
        (key,),
    ).fetchone()
    return row is not None


def set_migration_marker(conn: sqlite3.Connection, key: str) -> None:
    ensure_migration_markers_table(conn)
    conn.execute(
        """
        INSERT INTO migration_markers (key)
        VALUES (?)
        ON CONFLICT(key) DO UPDATE SET
            completed_at = CURRENT_TIMESTAMP
        """,
        (key,),
    )


def legacy_live_editor_db_path() -> Path:
    xdg_state_home = os.environ.get("XDG_STATE_HOME")
    base_dir = Path(xdg_state_home) if xdg_state_home else Path.home() / ".local" / "state"
    return base_dir / "pixel-forge" / "live-editor.db"


def legacy_instance_db_paths() -> list[Path]:
    instances_root = state_dir() / "instances"
    if not instances_root.is_dir():
        return []

    current_db = db_path().resolve()
    paths: list[Path] = []
    for candidate in instances_root.glob("*/pixel-forge.db"):
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved == current_db or not resolved.is_file():
            continue
        paths.append(resolved)
    return paths
