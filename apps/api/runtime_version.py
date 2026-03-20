from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from runtime_config import source_root as runtime_source_root


DEFAULT_CONTROLLER_VERSION = "0.0.0-dev"
RUNTIME_INSTALL_METADATA_FILE = "runtime-install-metadata.json"


def _read_version_file(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def _read_package_version(path: Path) -> str | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    value = payload.get("version")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _normalize_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def read_version_for_project(project_path: str | Path | None) -> str | None:
    if project_path is None:
        return None

    root = Path(project_path).expanduser().resolve()
    if not root.exists():
        return None

    version = _read_version_file(root / "VERSION")
    if version:
        return version

    return _read_package_version(root / "package.json")


@lru_cache(maxsize=1)
def read_runtime_version() -> str:
    current_dir = Path(__file__).resolve().parent
    for candidate_root in (current_dir, *current_dir.parents):
        version = read_version_for_project(candidate_root)
        if version:
            return version
    return DEFAULT_CONTROLLER_VERSION


def _detect_runtime_layout(root: Path) -> str:
    if (
        (root / "main.py").is_file()
        and (root / "requirements.txt").is_file()
        and (root / "frontend" / "index.html").is_file()
    ):
        return "installed"
    if (root / "apps" / "api" / "main.py").is_file():
        return "workspace"
    return "unknown"


def _has_acpx_bridge(root: Path) -> bool:
    return any(
        candidate.is_file()
        for candidate in (
            root / "acpx_bridge.py",
            root / "apps" / "api" / "acpx_bridge.py",
        )
    )


def read_runtime_install_metadata(root: Path | str | None) -> dict[str, str | None]:
    if root is None:
        resolved_root = runtime_source_root().expanduser().resolve()
    else:
        resolved_root = Path(root).expanduser().resolve()

    payload = _read_json_file(resolved_root / RUNTIME_INSTALL_METADATA_FILE) or {}
    return {
        "installedAt": _normalize_text(payload.get("installedAt")),
    }


def read_runtime_info_for_root(root: Path | str) -> dict[str, str | bool | None]:
    resolved_root = Path(root).expanduser().resolve()
    install_metadata = read_runtime_install_metadata(resolved_root)
    return {
        "controllerVersion": read_version_for_project(resolved_root) or DEFAULT_CONTROLLER_VERSION,
        "runtimeRoot": str(resolved_root),
        "runtimeLayout": _detect_runtime_layout(resolved_root),
        "acpxBridgeAvailable": _has_acpx_bridge(resolved_root),
        "installedAt": install_metadata["installedAt"],
    }


@lru_cache(maxsize=1)
def read_runtime_info() -> dict[str, str | bool | None]:
    root = runtime_source_root().expanduser().resolve()
    runtime_info = read_runtime_info_for_root(root)
    runtime_info["controllerVersion"] = read_runtime_version()
    return runtime_info
