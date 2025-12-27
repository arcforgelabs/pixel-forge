"""
Session Manager for pixel-forge

Generates and tracks Claude CLI session IDs per project.
Session IDs are unique per server run - restarting creates fresh sessions.
"""

import uuid
import time
from typing import Dict, Optional


# Server start time - makes session IDs unique per server run
_server_start_time: str = str(int(time.time()))

# Track active sessions: session_id -> project_path
_active_sessions: Dict[str, str] = {}


def generate_session_id(project_path: str) -> str:
    """
    Generate a session ID unique to this server run + project path.

    - Same project path within same server run = same session ID
    - Server restart = new session ID (avoids Claude CLI conflicts)
    """
    # Combine server start time with project path for uniqueness
    unique_key = f"{_server_start_time}:{project_path}"
    namespace = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    return str(uuid.uuid5(namespace, unique_key))


def get_or_create_session(project_path: str) -> tuple[str, bool]:
    """
    Get existing session ID for project or create new one.
    Returns (session_id, is_new_session).
    """
    session_id = generate_session_id(project_path)
    is_new = session_id not in _active_sessions

    if is_new:
        _active_sessions[session_id] = project_path

    return session_id, is_new


def is_session_active(session_id: str) -> bool:
    """Check if a session has been used before in this server run."""
    return session_id in _active_sessions


def mark_session_active(session_id: str, project_path: str) -> None:
    """Mark a session as active (used at least once)."""
    _active_sessions[session_id] = project_path


def clear_session(session_id: str) -> None:
    """Clear a session (for new conversation)."""
    if session_id in _active_sessions:
        del _active_sessions[session_id]


def get_project_for_session(session_id: str) -> Optional[str]:
    """Get the project path for a session ID."""
    return _active_sessions.get(session_id)
