from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from controller_update_state import (
    canonical_project_root,
    has_installable_controller_layout,
    normalize_project_root,
)
from runtime_config import shared_state_dir


PENDING_PREVIEW_UPDATES_FILE = "pending-preview-updates.json"
PREVIEW_UPDATE_SNAPSHOTS_DIR = "preview-updates"


def pending_preview_updates_path() -> Path:
    path = shared_state_dir() / PENDING_PREVIEW_UPDATES_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def preview_update_snapshots_dir() -> Path:
    path = shared_state_dir() / PREVIEW_UPDATE_SNAPSHOTS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _normalize_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _snapshot_ignore(directory: str, names: list[str]) -> set[str]:
    ignored: set[str] = set()
    directory_path = Path(directory)
    if ".git" in names:
        ignored.add(".git")
    if ".agents" in names:
        ignored.add(".agents")
    if ".venv" in names:
        ignored.add(".venv")
    if "node_modules" in names:
        ignored.add("node_modules")
    if directory_path.name == ".pixel-forge":
        for name in ("instances", "requests"):
            if name in names:
                ignored.add(name)
    return ignored


def create_preview_update_snapshot(workspace_path: str, update_id: str) -> str:
    source = Path(workspace_path).expanduser().resolve()
    if not source.is_dir():
        raise ValueError(f"workspacePath does not exist: {workspace_path}")

    destination = preview_update_snapshots_dir() / update_id
    if destination.exists():
        shutil.rmtree(destination, ignore_errors=True)

    shutil.copytree(source, destination, ignore=_snapshot_ignore)
    return str(destination)


def normalize_pending_preview_update(payload: dict[str, Any]) -> dict[str, Any]:
    project_path = _normalize_text(payload.get("projectPath") or payload.get("project_path"))
    if not project_path:
        raise ValueError("projectPath is required")

    workspace_path = _normalize_text(payload.get("workspacePath") or payload.get("workspace_path"))
    if not workspace_path:
        raise ValueError("workspacePath is required")

    active_mode = _normalize_text(payload.get("activeMode") or payload.get("active_mode"))
    if active_mode not in {"live-editor", "screenshot", "logo-forge", None}:
        active_mode = None

    agent_deck_session_id = _normalize_text(
        payload.get("agentDeckSessionId") or payload.get("agent_deck_session_id")
    )
    provider_session_id = _normalize_text(
        payload.get("providerSessionId") or payload.get("provider_session_id")
    ) or agent_deck_session_id
    provider_id = _normalize_text(payload.get("providerId") or payload.get("provider_id"))
    if not provider_id and agent_deck_session_id:
        provider_id = "agent-deck"

    return {
        "id": _normalize_text(payload.get("id")) or uuid4().hex[:12],
        "projectPath": project_path,
        "workspacePath": workspace_path,
        "snapshotPath": _normalize_text(payload.get("snapshotPath") or payload.get("snapshot_path")),
        "previewUrl": _normalize_text(payload.get("previewUrl") or payload.get("preview_url")),
        "activeMode": active_mode,
        "summary": _normalize_text(payload.get("summary")) or "Preview update ready to load.",
        "source": _normalize_text(payload.get("source")) or "live-editor",
        "requestId": _normalize_text(payload.get("requestId") or payload.get("request_id")),
        "providerId": provider_id,
        "providerSessionId": provider_session_id,
        "agentDeckSessionId": agent_deck_session_id,
        "createdAt": _normalize_text(payload.get("createdAt") or payload.get("created_at"))
        or datetime.now(timezone.utc).isoformat(),
    }


def _read_preview_update_payloads() -> list[dict[str, Any]]:
    path = pending_preview_updates_path()
    if not path.exists():
        return []

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    if not isinstance(payload, list):
        return []

    updates: list[dict[str, Any]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        try:
            updates.append(normalize_pending_preview_update(entry))
        except ValueError:
            continue
    return updates


def read_pending_preview_updates() -> list[dict[str, Any]]:
    return _read_preview_update_payloads()


def _write_pending_preview_updates(payload: list[dict[str, Any]]) -> None:
    pending_preview_updates_path().write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )


def _preview_update_audience_key(payload: dict[str, Any]) -> tuple[str, str]:
    project_path = str(payload["projectPath"])
    audience = str(
        payload.get("providerSessionId")
        or payload.get("agentDeckSessionId")
        or payload["workspacePath"]
    )
    return project_path, audience


def write_pending_preview_update(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_pending_preview_update(payload)
    normalized_project_path = normalize_project_root(normalized["projectPath"])
    normalized_workspace_path = normalize_project_root(normalized["workspacePath"])
    workspace_canonical_root = canonical_project_root(normalized_workspace_path)

    if workspace_canonical_root != normalized_project_path:
        raise ValueError(
            "Preview updates must publish from a clone workspace that belongs to the active canonical project root."
        )

    if normalized_workspace_path == normalized_project_path:
        raise ValueError(
            "Preview updates must publish from an isolated clone workspace under .agents/, not the canonical project root."
        )

    if not has_installable_controller_layout(normalized_workspace_path):
        raise ValueError(
            f"Preview update source must be an installable Pixel Forge root: {normalized_workspace_path}"
        )

    normalized["projectPath"] = str(normalized_project_path)
    normalized["workspacePath"] = str(normalized_workspace_path)
    normalized["snapshotPath"] = create_preview_update_snapshot(
        str(normalized_workspace_path),
        normalized["id"],
    )

    updates = _read_preview_update_payloads()
    normalized_audience_key = _preview_update_audience_key(normalized)
    next_updates = [
        update
        for update in updates
        if _preview_update_audience_key(update) != normalized_audience_key
    ]
    next_updates.insert(0, normalized)
    _write_pending_preview_updates(next_updates)
    return normalized


def read_latest_pending_preview_update(
    project_path: str,
    *,
    workspace_path: str | None = None,
    provider_session_id: str | None = None,
    agent_deck_session_id: str | None = None,
) -> dict[str, Any] | None:
    normalized_project_path = str(normalize_project_root(project_path))
    normalized_workspace_path = (
        str(normalize_project_root(workspace_path))
        if workspace_path
        else None
    )
    normalized_provider_session_id = (
        _normalize_text(provider_session_id)
        or _normalize_text(agent_deck_session_id)
    )

    for update in _read_preview_update_payloads():
        if update["projectPath"] != normalized_project_path:
            continue
        if normalized_provider_session_id:
            if (
                update.get("providerSessionId") == normalized_provider_session_id
                or update.get("agentDeckSessionId") == normalized_provider_session_id
            ):
                return update
            continue
        if normalized_workspace_path and update["workspacePath"] == normalized_workspace_path:
            return update
    return None


def clear_pending_preview_update(update_id: str) -> bool:
    normalized_update_id = _normalize_text(update_id)
    if not normalized_update_id:
        return False

    updates = _read_preview_update_payloads()
    next_updates = [update for update in updates if update["id"] != normalized_update_id]
    if len(next_updates) == len(updates):
        return False

    _write_pending_preview_updates(next_updates)
    return True
