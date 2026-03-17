from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from runtime_config import db_path as runtime_db_path
from runtime_config import state_dir as runtime_state_dir


def state_dir() -> Path:
    return runtime_state_dir()


def db_path() -> Path:
    return runtime_db_path()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def legacy_live_editor_db_path() -> Path:
    xdg_state_home = os.environ.get("XDG_STATE_HOME")
    base_dir = Path(xdg_state_home) if xdg_state_home else Path.home() / ".local" / "state"
    return base_dir / "pixel-forge" / "live-editor.db"
