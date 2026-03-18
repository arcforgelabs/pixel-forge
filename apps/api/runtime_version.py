from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path


DEFAULT_CONTROLLER_VERSION = "0.0.0-dev"


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
