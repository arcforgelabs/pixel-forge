"""
Session Manager for pixel-forge

Generates and tracks Claude CLI session IDs per project.
Session ID is deterministic based on project path, so same project = same session.
"""

import hashlib
import uuid
from typing import Dict, Optional


# Track active sessions: session_id -> project_path
_active_sessions: Dict[str, str] = {}


def generate_session_id(project_path: str) -> str:
    """
    Generate a deterministic session ID from project path.
    Same project path always returns same session ID.
    """
    # Create a hash of the project path
    path_hash = hashlib.sha256(project_path.encode()).hexdigest()[:16]
    # Format as UUID-like string for Claude CLI compatibility
    return f"pf-{path_hash}"


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
    """Check if a session has been used before."""
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
