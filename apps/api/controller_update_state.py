from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from runtime_config import shared_state_dir
from runtime_version import read_runtime_version, read_version_for_project


PENDING_CONTROLLER_UPDATE_FILE = "pending-controller-update.json"
CONTROLLER_UPDATE_SNAPSHOTS_DIR = "controller-updates"
VERSION_PACKAGE_RELATIVE_PATHS = (
    Path("package.json"),
    Path("apps/web/package.json"),
    Path("apps/desktop/package.json"),
    Path("packages/sdk-node/package.json"),
)
STABLE_OR_RELEASE_VERSION_REGEX = re.compile(
    r"^(\d{4})\.([1-9]\d?)\.([1-9]\d?)(?:-([1-9]\d*))?$"
)
BETA_VERSION_REGEX = re.compile(r"^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-beta\.([1-9]\d*)$")


def pending_controller_update_path() -> Path:
    path = shared_state_dir() / PENDING_CONTROLLER_UPDATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def controller_update_snapshots_dir() -> Path:
    path = shared_state_dir() / CONTROLLER_UPDATE_SNAPSHOTS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _normalize_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _normalize_version_text(value: Any) -> str | None:
    normalized = _normalize_text(value)
    if not normalized:
        return None
    return normalized[1:] if normalized.startswith("v") else normalized


def _release_date_prefix(now: datetime | None = None) -> str:
    current = now or datetime.now()
    return f"{current.year}.{current.month}.{current.day}"


def _is_supported_calver_version(value: Any) -> bool:
    normalized = _normalize_version_text(value)
    return bool(
        normalized
        and (
            STABLE_OR_RELEASE_VERSION_REGEX.match(normalized)
            or BETA_VERSION_REGEX.match(normalized)
        )
    )


def _release_ordinal_for_date(value: Any, date_prefix: str) -> int | None:
    normalized = _normalize_version_text(value)
    if not normalized:
        return None
    match = STABLE_OR_RELEASE_VERSION_REGEX.match(normalized)
    if not match:
        return None
    prefix = f"{match.group(1)}.{int(match.group(2))}.{int(match.group(3))}"
    if prefix != date_prefix:
        return None
    ordinal = match.group(4)
    return int(ordinal) if ordinal else 0


def _resolve_controller_release_version(project_path: str) -> str | None:
    source_version = read_version_for_project(project_path)
    if source_version and not _is_supported_calver_version(source_version):
        return source_version

    date_prefix = _release_date_prefix()
    existing_pending = read_pending_controller_update()
    candidate_ordinals = [
        _release_ordinal_for_date(read_runtime_version(), date_prefix),
        _release_ordinal_for_date(
            existing_pending.get("version") if existing_pending else None,
            date_prefix,
        ),
    ]
    max_existing_ordinal = max(
        [0, *(ordinal for ordinal in candidate_ordinals if ordinal is not None)]
    )
    source_ordinal = _release_ordinal_for_date(source_version, date_prefix)

    if source_ordinal is not None and source_ordinal > max_existing_ordinal:
        return _normalize_version_text(source_version)

    return f"{date_prefix}-{max_existing_ordinal + 1}"


def _write_controller_snapshot_version(snapshot_path: str, version: str | None) -> None:
    normalized = _normalize_text(version)
    if not normalized:
        return

    root = Path(snapshot_path).expanduser().resolve()
    (root / "VERSION").write_text(f"{normalized}\n", encoding="utf-8")

    for relative_path in VERSION_PACKAGE_RELATIVE_PATHS:
        package_path = root / relative_path
        if not package_path.is_file():
            continue
        try:
            payload = json.loads(package_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        payload["version"] = normalized
        package_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def normalize_project_root(project_path: str | Path) -> Path:
    return Path(project_path).expanduser().resolve()


def canonical_project_root(project_path: str | Path) -> Path:
    root = normalize_project_root(project_path)
    if ".agents" not in root.parts:
        return root

    current = root
    while current.name != ".agents":
        if current.parent == current:
            return root
        current = current.parent

    return current.parent.resolve()


def is_clone_workspace_path(project_path: str | Path) -> bool:
    root = normalize_project_root(project_path)
    return canonical_project_root(root) != root


def has_installable_controller_layout(project_path: str | Path) -> bool:
    root = normalize_project_root(project_path)
    return (
        (root / "install.sh").is_file()
        and (root / "apps" / "api" / "main.py").is_file()
        and (root / "apps" / "api" / "requirements.txt").is_file()
        and (root / "apps" / "web" / "package.json").is_file()
    )


def enforce_controller_update_source_policy(
    project_path: str,
    *,
    allow_noncanonical_project: bool = False,
) -> Path:
    normalized = normalize_project_root(project_path)
    canonical = canonical_project_root(normalized)

    if normalized != canonical and not allow_noncanonical_project:
        raise ValueError(
            "Controller updates must stage from the canonical project root, not a clone workspace under .agents/. "
            f"Merge back into {canonical} first, or pass an explicit allow-noncanonical override."
        )

    if not has_installable_controller_layout(normalized):
        raise ValueError(
            f"Controller update source must be an installable Pixel Forge root: {normalized}"
        )

    return normalized


def _git_error_message(stderr: str, fallback: str) -> str:
    message = stderr.strip()
    return message or fallback


def _resolve_git_commit(project_path: str, git_ref: str) -> str:
    result = subprocess.run(
        ["git", "-C", project_path, "rev-parse", "--verify", f"{git_ref}^{{commit}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(
            _git_error_message(
                result.stderr,
                f"Unable to resolve git ref {git_ref!r} in {project_path}",
            )
        )

    resolved = result.stdout.strip()
    if not resolved:
        raise ValueError(f"Unable to resolve git ref {git_ref!r} in {project_path}")
    return resolved


def normalize_pending_controller_update(payload: dict[str, Any]) -> dict[str, Any]:
    project_path = _normalize_text(payload.get("projectPath") or payload.get("project_path"))
    if not project_path:
        raise ValueError("projectPath is required")

    active_mode = _normalize_text(payload.get("activeMode") or payload.get("active_mode"))
    if active_mode not in {"live-editor", "screenshot", "logo-forge", None}:
        active_mode = None

    preview_url = _normalize_text(payload.get("previewUrl") or payload.get("preview_url"))
    request_id = _normalize_text(payload.get("requestId") or payload.get("request_id"))
    commit_hash = _normalize_text(payload.get("commitHash") or payload.get("commit_hash"))
    git_ref = _normalize_text(payload.get("gitRef") or payload.get("git_ref"))
    created_at = _normalize_text(payload.get("createdAt") or payload.get("created_at"))
    source = _normalize_text(payload.get("source")) or "manual"
    summary = _normalize_text(payload.get("summary")) or "Update ready to load."

    return {
        "id": _normalize_text(payload.get("id")) or uuid4().hex[:12],
        "projectPath": project_path,
        "snapshotPath": _normalize_text(payload.get("snapshotPath") or payload.get("snapshot_path")),
        "version": _normalize_text(payload.get("version")) or read_version_for_project(project_path),
        "previewUrl": preview_url,
        "activeMode": active_mode,
        "summary": summary,
        "source": source,
        "requestId": request_id,
        "commitHash": commit_hash,
        "gitRef": git_ref,
        "createdAt": created_at or datetime.now(timezone.utc).isoformat(),
        "canRollback": bool(payload.get("canRollback", True)),
    }


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


def _delete_snapshot(snapshot_path: str | None) -> None:
    if not snapshot_path:
        return
    path = Path(snapshot_path).expanduser()
    if not path.exists():
        return
    for attempt in range(4):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as error:
            if attempt == 3 or error.errno not in {39, 16, 1}:
                print(
                    f"[pixel-forge] Warning: failed to delete controller update snapshot {path}: {error}"
                )
                return
            time.sleep(0.25 * (attempt + 1))


def create_controller_update_snapshot(project_path: str, update_id: str) -> str:
    source = Path(project_path).expanduser().resolve()
    if not source.is_dir():
        raise ValueError(f"projectPath does not exist: {project_path}")

    destination = controller_update_snapshots_dir() / update_id
    if destination.exists():
        shutil.rmtree(destination, ignore_errors=True)

    shutil.copytree(source, destination, ignore=_snapshot_ignore)
    return str(destination)


def create_controller_update_snapshot_from_git_ref(
    project_path: str,
    update_id: str,
    git_ref: str,
) -> tuple[str, str]:
    source = Path(project_path).expanduser().resolve()
    if not source.is_dir():
        raise ValueError(f"projectPath does not exist: {project_path}")

    resolved_commit = _resolve_git_commit(str(source), git_ref)
    destination = controller_update_snapshots_dir() / update_id
    if destination.exists():
        shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        ["git", "-C", str(source), "archive", "--format=tar", resolved_commit],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        shutil.rmtree(destination, ignore_errors=True)
        raise ValueError(
            _git_error_message(
                result.stderr.decode("utf-8", errors="replace"),
                f"Unable to archive git ref {git_ref!r} from {project_path}",
            )
        )

    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
            archive.extractall(destination, filter="data")
    except (tarfile.TarError, OSError) as exc:
        shutil.rmtree(destination, ignore_errors=True)
        raise ValueError(
            f"Unable to extract git snapshot for ref {git_ref!r}: {exc}"
        ) from exc

    return str(destination), resolved_commit


def controller_update_snapshot_has_runtime_layout(snapshot_path: str | None) -> bool:
    if not snapshot_path:
        return False
    root = Path(snapshot_path).expanduser().resolve()
    return (
        (root / "install.sh").is_file()
        and (root / "apps" / "api" / "main.py").is_file()
        and (root / "apps" / "api" / "requirements.txt").is_file()
        and (root / "apps" / "web" / "package.json").is_file()
    )


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
    allow_noncanonical_project = bool(
        payload.get("allowNoncanonicalProject") or payload.get("allow_noncanonical_project")
    )
    normalized["projectPath"] = str(
        enforce_controller_update_source_policy(
            normalized["projectPath"],
            allow_noncanonical_project=allow_noncanonical_project,
        )
    )
    git_ref = normalized.get("gitRef")
    if isinstance(git_ref, str) and git_ref:
        snapshot_path, resolved_commit = create_controller_update_snapshot_from_git_ref(
            normalized["projectPath"],
            normalized["id"],
            git_ref,
        )
        normalized["snapshotPath"] = snapshot_path
        normalized["commitHash"] = resolved_commit
    else:
        normalized["snapshotPath"] = create_controller_update_snapshot(
            normalized["projectPath"], normalized["id"]
        )
    normalized["version"] = _resolve_controller_release_version(normalized["projectPath"])
    _write_controller_snapshot_version(normalized["snapshotPath"], normalized["version"])
    path = pending_controller_update_path()
    path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    return normalized


def repair_pending_controller_update_snapshot(
    payload: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if payload is None:
        return None

    normalized = normalize_pending_controller_update(payload)
    normalized["projectPath"] = str(
        enforce_controller_update_source_policy(
            normalized["projectPath"],
            allow_noncanonical_project=True,
        )
    )
    if controller_update_snapshot_has_runtime_layout(normalized["snapshotPath"]):
        return normalized

    git_ref = normalized.get("gitRef")
    if isinstance(git_ref, str) and git_ref:
        snapshot_path, resolved_commit = create_controller_update_snapshot_from_git_ref(
            normalized["projectPath"],
            normalized["id"],
            git_ref,
        )
        normalized["snapshotPath"] = snapshot_path
        normalized["commitHash"] = resolved_commit
    else:
        normalized["snapshotPath"] = create_controller_update_snapshot(
            normalized["projectPath"], normalized["id"]
        )
    normalized["version"] = (
        read_version_for_project(normalized["snapshotPath"])
        or normalized["version"]
    )
    path = pending_controller_update_path()
    path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    return normalized


def clear_pending_controller_update() -> bool:
    path = pending_controller_update_path()
    existing = read_pending_controller_update()
    if not path.exists():
        return False
    _delete_snapshot(existing["snapshotPath"] if existing else None)
    path.unlink()
    return True
