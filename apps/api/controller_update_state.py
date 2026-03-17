from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from runtime_config import state_dir


PENDING_CONTROLLER_UPDATE_FILE = "pending-controller-update.json"
CONTROLLER_UPDATE_SNAPSHOTS_DIR = "controller-updates"


def pending_controller_update_path() -> Path:
    path = state_dir() / PENDING_CONTROLLER_UPDATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def controller_update_snapshots_dir() -> Path:
    path = state_dir() / CONTROLLER_UPDATE_SNAPSHOTS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _normalize_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def normalize_pending_controller_update(payload: dict[str, Any]) -> dict[str, Any]:
    project_path = _normalize_text(payload.get("projectPath") or payload.get("project_path"))
    if not project_path:
        raise ValueError("projectPath is required")

    active_mode = _normalize_text(payload.get("activeMode") or payload.get("active_mode"))
    if active_mode not in {"live-editor", "screenshot", None}:
        active_mode = None

    preview_url = _normalize_text(payload.get("previewUrl") or payload.get("preview_url"))
    request_id = _normalize_text(payload.get("requestId") or payload.get("request_id"))
    commit_hash = _normalize_text(payload.get("commitHash") or payload.get("commit_hash"))
    created_at = _normalize_text(payload.get("createdAt") or payload.get("created_at"))
    source = _normalize_text(payload.get("source")) or "manual"
    summary = _normalize_text(payload.get("summary")) or "Update ready to load."

    return {
        "id": _normalize_text(payload.get("id")) or uuid4().hex[:12],
        "projectPath": project_path,
        "snapshotPath": _normalize_text(payload.get("snapshotPath") or payload.get("snapshot_path")),
        "previewUrl": preview_url,
        "activeMode": active_mode,
        "summary": summary,
        "source": source,
        "requestId": request_id,
        "commitHash": commit_hash,
        "createdAt": created_at or datetime.now(timezone.utc).isoformat(),
        "canRollback": bool(payload.get("canRollback", True)),
    }


def _snapshot_ignore(directory: str, names: list[str]) -> set[str]:
    ignored: set[str] = set()
    directory_path = Path(directory)
    if ".git" in names:
        ignored.add(".git")
    if ".venv" in names:
        ignored.add(".venv")
    if "node_modules" in names:
        ignored.add("node_modules")
    if directory_path.name == ".pixel-forge":
        for name in ("instances", "requests"):
            if name in names:
                ignored.add(name)
    return ignored


def _delete_snapshot(snapshot_path: str | None) -> None:
    if not snapshot_path:
        return
    path = Path(snapshot_path).expanduser()
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def create_controller_update_snapshot(project_path: str, update_id: str) -> str:
    source = Path(project_path).expanduser().resolve()
    if not source.is_dir():
        raise ValueError(f"projectPath does not exist: {project_path}")

    destination = controller_update_snapshots_dir() / update_id
    if destination.exists():
        shutil.rmtree(destination, ignore_errors=True)

    shutil.copytree(source, destination, ignore=_snapshot_ignore)
    return str(destination)


def read_pending_controller_update() -> dict[str, Any] | None:
    path = pending_controller_update_path()
    if not path.exists():
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict):
        return None

    try:
        return normalize_pending_controller_update(payload)
    except ValueError:
        return None


def write_pending_controller_update(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_pending_controller_update(payload)
    normalized["snapshotPath"] = create_controller_update_snapshot(
        normalized["projectPath"], normalized["id"]
    )
    path = pending_controller_update_path()
    path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    return normalized


def clear_pending_controller_update() -> bool:
    path = pending_controller_update_path()
    existing = read_pending_controller_update()
    if not path.exists():
        return False
    path.unlink()
    _delete_snapshot(existing["snapshotPath"] if existing else None)
    return True
