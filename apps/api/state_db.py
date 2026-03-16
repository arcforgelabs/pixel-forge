from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def state_dir() -> Path:
    base_dir = Path.home() / ".pixel-forge"
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def db_path() -> Path:
    return state_dir() / "pixel-forge.db"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def legacy_live_editor_db_path() -> Path:
    xdg_state_home = os.environ.get("XDG_STATE_HOME")
    base_dir = Path(xdg_state_home) if xdg_state_home else Path.home() / ".local" / "state"
    return base_dir / "pixel-forge" / "live-editor.db"
