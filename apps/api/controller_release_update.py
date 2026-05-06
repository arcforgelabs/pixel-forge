from __future__ import annotations

import json
import os
import re
import shutil
import tarfile
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from controller_update_state import (
    clear_pending_controller_update,
    controller_update_snapshots_dir,
    controller_update_snapshot_has_runtime_layout,
    read_pending_controller_update,
    write_pending_controller_update_snapshot,
)
from runtime_config import shared_state_dir
from runtime_version import read_runtime_version


DEFAULT_RELEASE_REPO = "IAMSamuelRodda/pixel-forge"
DEFAULT_CHECK_INTERVAL_SECONDS = 24 * 60 * 60
ERROR_BACKOFF_SECONDS = 2 * 60 * 60
RELEASE_CHECK_FILE = "controller-release-update.json"
CALVER_STABLE_REGEX = re.compile(r"^(\d{4})\.([1-9]\d?)\.([1-9]\d?)$")
CALVER_RELEASE_REGEX = re.compile(r"^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-([1-9]\d*)$")
CALVER_BETA_REGEX = re.compile(r"^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-beta\.([1-9]\d*)$")


def controller_release_update_path() -> Path:
    path = shared_state_dir() / RELEASE_CHECK_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat()


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _normalize_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _normalize_version(value: Any) -> str | None:
    normalized = _normalize_text(value)
    if not normalized:
        return None
    return normalized[1:] if normalized.startswith("v") else normalized


def _version_parts(value: Any) -> tuple[int, int, int, int, int] | None:
    normalized = _normalize_version(value)
    if not normalized:
        return None
    stable = CALVER_STABLE_REGEX.match(normalized)
    if stable:
        return (int(stable[1]), int(stable[2]), int(stable[3]), 0, 0)
    release = CALVER_RELEASE_REGEX.match(normalized)
    if release:
        return (int(release[1]), int(release[2]), int(release[3]), 1, int(release[4]))
    beta = CALVER_BETA_REGEX.match(normalized)
    if beta:
        return (int(beta[1]), int(beta[2]), int(beta[3]), -1, int(beta[4]))
    return None


def _compare_calver(left: Any, right: Any) -> int | None:
    left_parts = _version_parts(left)
    right_parts = _version_parts(right)
    if left_parts is None or right_parts is None:
        return None
    if left_parts == right_parts:
        return 0
    return 1 if left_parts > right_parts else -1


def _release_repo() -> str:
    return (
        _normalize_text(os.environ.get("PIXEL_FORGE_RELEASE_REPO"))
        or DEFAULT_RELEASE_REPO
    )


def _check_interval_seconds() -> int:
    raw_value = _normalize_text(os.environ.get("PIXEL_FORGE_RELEASE_CHECK_INTERVAL_SECONDS"))
    if not raw_value:
        return DEFAULT_CHECK_INTERVAL_SECONDS
    try:
        return max(300, int(raw_value))
    except ValueError:
        return DEFAULT_CHECK_INTERVAL_SECONDS


def _api_url(repo: str) -> str:
    explicit = _normalize_text(os.environ.get("PIXEL_FORGE_RELEASE_API_URL"))
    if explicit:
        return explicit
    return f"https://api.github.com/repos/{repo}/releases/latest"


def _auth_token() -> str | None:
    return _normalize_text(os.environ.get("GITHUB_TOKEN")) or _normalize_text(
        os.environ.get("GH_TOKEN")
    )


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_controller_release_update() -> dict[str, Any]:
    payload = _read_json(controller_release_update_path()) or {}
    repo = _normalize_text(payload.get("repo")) or _release_repo()
    current_version = read_runtime_version()
    latest = payload.get("latest") if isinstance(payload.get("latest"), dict) else None
    latest_version = _normalize_version(latest.get("version") if latest else None)
    comparison = _compare_calver(latest_version, current_version)
    update_available = bool(comparison is not None and comparison > 0)
    skipped_version = _normalize_version(payload.get("skippedVersion"))
    if skipped_version and latest_version and skipped_version == latest_version:
        update_available = False

    return {
        "repo": repo,
        "channel": _normalize_text(payload.get("channel")) or "stable",
        "lastCheckedAt": _normalize_text(payload.get("lastCheckedAt")),
        "nextCheckAfter": _normalize_text(payload.get("nextCheckAfter")),
        "etag": _normalize_text(payload.get("etag")),
        "lastModified": _normalize_text(payload.get("lastModified")),
        "latest": latest,
        "currentVersion": current_version,
        "updateAvailable": update_available,
        "skippedVersion": skipped_version,
        "status": _normalize_text(payload.get("status")) or "idle",
        "error": _normalize_text(payload.get("error")),
        "errorAt": _normalize_text(payload.get("errorAt")),
    }


def _headers_for_request(state: dict[str, Any]) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Pixel-Forge-Updater",
    }
    etag = _normalize_text(state.get("etag"))
    last_modified = _normalize_text(state.get("lastModified"))
    token = _auth_token()
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _latest_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    tag_name = _normalize_text(payload.get("tag_name"))
    version = _normalize_version(tag_name)
    return {
        "id": payload.get("id") if isinstance(payload.get("id"), int) else None,
        "tagName": tag_name,
        "version": version,
        "name": _normalize_text(payload.get("name")),
        "htmlUrl": _normalize_text(payload.get("html_url")),
        "tarballUrl": _normalize_text(payload.get("tarball_url")),
        "zipballUrl": _normalize_text(payload.get("zipball_url")),
        "publishedAt": _normalize_text(payload.get("published_at")),
        "prerelease": bool(payload.get("prerelease")),
        "draft": bool(payload.get("draft")),
    }


def check_controller_release_update(*, force: bool = False) -> dict[str, Any]:
    state = read_controller_release_update()
    next_check_after = _parse_time(state.get("nextCheckAfter"))
    if not force and next_check_after and _now() < next_check_after:
        state["status"] = "cached"
        return state

    repo = _release_repo()
    checked_at = _now()
    next_check = checked_at + timedelta(seconds=_check_interval_seconds())
    request = Request(_api_url(repo), headers=_headers_for_request(state), method="GET")

    try:
        with urlopen(request, timeout=8) as response:
            raw_payload = response.read().decode("utf-8")
            payload = json.loads(raw_payload)
            if not isinstance(payload, dict):
                raise ValueError("GitHub release response was not an object")
            next_state = {
                **state,
                "repo": repo,
                "channel": "stable",
                "lastCheckedAt": _iso(checked_at),
                "nextCheckAfter": _iso(next_check),
                "etag": _normalize_text(response.headers.get("ETag")),
                "lastModified": _normalize_text(response.headers.get("Last-Modified")),
                "latest": _latest_from_payload(payload),
                "status": "checked",
                "error": None,
                "errorAt": None,
            }
    except HTTPError as error:
        if error.code != 304:
            next_state = {
                **state,
                "repo": repo,
                "lastCheckedAt": _iso(checked_at),
                "nextCheckAfter": _iso(checked_at + timedelta(seconds=ERROR_BACKOFF_SECONDS)),
                "status": "error",
                "error": str(error),
                "errorAt": _iso(checked_at),
            }
        else:
            next_state = {
                **state,
                "repo": repo,
                "lastCheckedAt": _iso(checked_at),
                "nextCheckAfter": _iso(next_check),
                "status": "not_modified",
                "error": None,
                "errorAt": None,
            }
    except (OSError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        next_state = {
            **state,
            "repo": repo,
            "lastCheckedAt": _iso(checked_at),
            "nextCheckAfter": _iso(checked_at + timedelta(seconds=ERROR_BACKOFF_SECONDS)),
            "status": "error",
            "error": str(error),
            "errorAt": _iso(checked_at),
        }

    _write_json(controller_release_update_path(), next_state)
    return read_controller_release_update()


def skip_controller_release_update(version: str | None) -> dict[str, Any]:
    state = read_controller_release_update()
    normalized = _normalize_version(version) or _normalize_version(
        state.get("latest", {}).get("version") if isinstance(state.get("latest"), dict) else None
    )
    if normalized:
        state["skippedVersion"] = normalized
        _write_json(controller_release_update_path(), state)
    return read_controller_release_update()


def _archive_headers() -> dict[str, str]:
    headers = {"User-Agent": "Pixel-Forge-Updater"}
    token = _auth_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _download_release_snapshot(url: str, update_id: str) -> str:
    destination = controller_update_snapshots_dir() / update_id
    if destination.exists():
        shutil.rmtree(destination, ignore_errors=True)

    with tempfile.TemporaryDirectory(prefix="release-download-", dir=str(controller_update_snapshots_dir())) as tmp:
        archive_path = Path(tmp) / "release.tar.gz"
        with urlopen(Request(url, headers=_archive_headers()), timeout=45) as response:
            archive_path.write_bytes(response.read())

        extract_root = Path(tmp) / "extract"
        extract_root.mkdir()
        with tarfile.open(archive_path, mode="r:gz") as archive:
            archive.extractall(extract_root, filter="data")

        entries = [entry for entry in extract_root.iterdir()]
        if len(entries) == 1 and entries[0].is_dir():
            shutil.move(str(entries[0]), destination)
        else:
            destination.mkdir(parents=True)
            for entry in entries:
                shutil.move(str(entry), destination / entry.name)

    if not controller_update_snapshot_has_runtime_layout(str(destination)):
        shutil.rmtree(destination, ignore_errors=True)
        raise ValueError("Downloaded release archive is not an installable Pixel Forge root")
    return str(destination)


def stage_controller_release_update(*, force_check: bool = False) -> dict[str, Any]:
    state = check_controller_release_update(force=force_check)
    latest = state.get("latest") if isinstance(state.get("latest"), dict) else None
    if not latest or not state.get("updateAvailable"):
        return {
            "state": state,
            "update": read_pending_controller_update(),
            "staged": False,
        }

    latest_version = _normalize_version(latest.get("version"))
    tarball_url = _normalize_text(latest.get("tarballUrl"))
    if not latest_version or not tarball_url:
        raise ValueError("Latest GitHub release does not include an installable source archive")

    existing = read_pending_controller_update()
    if (
        existing
        and existing.get("source") == "github-release"
        and _normalize_version(existing.get("version")) == latest_version
        and controller_update_snapshot_has_runtime_layout(existing.get("snapshotPath"))
    ):
        return {"state": state, "update": existing, "staged": False}

    update_id = f"github-{re.sub(r'[^A-Za-z0-9_.-]+', '-', latest_version)}-{uuid4().hex[:8]}"
    snapshot_path = _download_release_snapshot(tarball_url, update_id)
    clear_pending_controller_update()
    update = write_pending_controller_update_snapshot(
        {
            "id": update_id,
            "projectPath": snapshot_path,
            "snapshotPath": snapshot_path,
            "version": latest_version,
            "summary": f"Pixel Forge {latest.get('tagName') or latest_version} is ready to install.",
            "source": "github-release",
            "commitHash": None,
            "gitRef": latest.get("tagName"),
            "createdAt": _iso(),
            "canRollback": True,
        }
    )
    state = read_controller_release_update()
    return {"state": state, "update": update, "staged": True}
