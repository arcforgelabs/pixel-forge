from __future__ import annotations

import os
import re
from pathlib import Path


DEFAULT_INSTANCE_SLUG = "pixel-forge"
DEFAULT_API_PORT = 7001
DEFAULT_WEB_PORT = 5173
DEFAULT_RUNTIME_KIND = "controller"


def _sanitize_slug(raw_value: str) -> str:
    sanitized = re.sub(r"[^a-z0-9-]+", "-", raw_value.lower()).strip("-")
    return sanitized or DEFAULT_INSTANCE_SLUG


def _truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def instance_slug() -> str:
    return _sanitize_slug(os.environ.get("PIXEL_FORGE_INSTANCE_SLUG", DEFAULT_INSTANCE_SLUG))


def api_port() -> int:
    raw_port = os.environ.get("PIXEL_FORGE_API_PORT") or os.environ.get("PIXEL_FORGE_PORT")
    return int(raw_port or DEFAULT_API_PORT)


def web_port() -> int:
    return int(os.environ.get("PIXEL_FORGE_WEB_PORT") or DEFAULT_WEB_PORT)


def web_host() -> str:
    return os.environ.get("PIXEL_FORGE_WEB_HOST") or f"{instance_slug()}.localhost"


def state_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_STATE_DIR")
    base_dir = Path(override).expanduser() if override else Path.home() / ".pixel-forge"
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def db_path() -> Path:
    override = os.environ.get("PIXEL_FORGE_DB_PATH")
    path = Path(override).expanduser() if override else state_dir() / "pixel-forge.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def managed_browser_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_MANAGED_BROWSER_DIR")
    path = Path(override).expanduser() if override else state_dir() / "managed-browser"
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_root() -> Path:
    override = os.environ.get("PIXEL_FORGE_RUNTIME_SOURCE_ROOT")
    if override:
        return Path(override).expanduser().resolve()

    here = Path(__file__).resolve()
    installed_root = here.parent
    if (
        (installed_root / "main.py").is_file()
        and (installed_root / "requirements.txt").is_file()
        and (installed_root / "frontend" / "index.html").is_file()
    ):
        return installed_root

    repo_root = here.parents[2]
    if (repo_root / "apps" / "api" / "main.py").is_file():
        return repo_root

    return installed_root


def runtime_kind() -> str:
    raw_kind = (os.environ.get("PIXEL_FORGE_RUNTIME_KIND") or "").strip().lower()
    if raw_kind in {"controller", "mirror", "dev"}:
        return raw_kind
    if _truthy(os.environ.get("PIXEL_FORGE_TARGET_MODE")):
        return "dev"
    return DEFAULT_RUNTIME_KIND


def target_mode() -> bool:
    return runtime_kind() == "dev"


def runtime_role() -> str:
    return os.environ.get("PIXEL_FORGE_RUNTIME_ROLE") or (
        "target" if runtime_kind() in {"mirror", "dev"} else "controller"
    )
