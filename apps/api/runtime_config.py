from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from state_root_migration import (
    default_legacy_shared_state_dir,
    default_shared_state_dir,
    ensure_state_root_ready,
)


DEFAULT_INSTANCE_SLUG = "pixel-forge"
DEFAULT_API_PORT = 7001
DEFAULT_WEB_PORT = 5173
DEFAULT_AGENT_DECK_SURFACE_HOST = "127.0.0.1"
DEFAULT_AGENT_DECK_SURFACE_PORT = 8422
DEFAULT_RUNTIME_KIND = "controller"
RETIRED_CLI_NAMES = frozenset({"pixel-forge-alpha", "pixel-forge-workstation-v2"})
AGENT_DECK_ENABLED_VALUES = frozenset({"1", "true", "yes", "on"})
AGENT_DECK_DISABLED_VALUES = frozenset({"0", "false", "no", "off"})


def _sanitize_slug(raw_value: str) -> str:
    sanitized = re.sub(r"[^a-z0-9-]+", "-", raw_value.lower()).strip("-")
    return sanitized or DEFAULT_INSTANCE_SLUG


def _truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def agent_deck_provider_mode() -> str:
    raw_mode = (os.environ.get("PIXEL_FORGE_WITH_AGENT_DECK") or "auto").strip().lower()
    if raw_mode in AGENT_DECK_ENABLED_VALUES:
        return "1"
    if raw_mode in AGENT_DECK_DISABLED_VALUES:
        return "0"
    if os.name == "nt":
        return "0"
    return "auto"


def agent_deck_provider_enabled() -> bool:
    mode = agent_deck_provider_mode()
    if mode == "1":
        return True
    if mode == "0":
        return False
    explicit_command = (os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD") or "").strip()
    if explicit_command:
        return True
    return bool(
        shutil.which("agent-deck-standalone")
        or shutil.which("agent-deck")
        or (source_root() / "scripts" / "agent-deck.sh").is_file()
        or (source_root() / "foundations" / "agent-deck" / "build" / "agent-deck").is_file()
        or (source_root() / "foundations" / "agent-deck" / "agent-deck").is_file()
    )


def instance_slug() -> str:
    return _sanitize_slug(os.environ.get("PIXEL_FORGE_INSTANCE_SLUG", DEFAULT_INSTANCE_SLUG))


def api_port() -> int:
    raw_port = os.environ.get("PIXEL_FORGE_API_PORT") or os.environ.get("PIXEL_FORGE_PORT")
    return int(raw_port or DEFAULT_API_PORT)


def web_port() -> int:
    return int(os.environ.get("PIXEL_FORGE_WEB_PORT") or DEFAULT_WEB_PORT)


def web_host() -> str:
    return os.environ.get("PIXEL_FORGE_WEB_HOST") or f"{instance_slug()}.localhost"


def url_host() -> str:
    return os.environ.get("PIXEL_FORGE_URL_HOST") or web_host()


def shell_url() -> str:
    explicit = os.environ.get("PIXEL_FORGE_SHELL_URL")
    if explicit:
        return explicit
    return f"http://{url_host()}:{api_port()}"


def cli_name() -> str:
    explicit = (os.environ.get("PIXEL_FORGE_CLI_NAME") or "").strip()
    if explicit and explicit not in RETIRED_CLI_NAMES:
        return explicit
    return instance_slug()


def agent_deck_surface_host() -> str:
    return os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_HOST") or DEFAULT_AGENT_DECK_SURFACE_HOST


def agent_deck_surface_port() -> int:
    return int(
        os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_PORT") or DEFAULT_AGENT_DECK_SURFACE_PORT
    )


def agent_deck_surface_url() -> str:
    explicit = os.environ.get("PIXEL_FORGE_AGENT_DECK_SURFACE_URL")
    if explicit:
        return explicit
    return f"http://{agent_deck_surface_host()}:{agent_deck_surface_port()}"


def shared_state_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
    legacy_override = os.environ.get("PIXEL_FORGE_LEGACY_SHARED_STATE_DIR")
    base_dir = Path(override).expanduser() if override else default_shared_state_dir()
    legacy_dir = (
        Path(legacy_override).expanduser()
        if legacy_override
        else (default_legacy_shared_state_dir() if not override else None)
    )
    ensure_state_root_ready(target_dir=base_dir, legacy_dir=legacy_dir)
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def runtime_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_RUNTIME_DIR")
    path = Path(override).expanduser() if override else shared_state_dir() / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def agent_deck_home_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_AGENT_DECK_HOME")
    path = Path(override).expanduser() if override else shared_state_dir() / "agent-deck"
    path.mkdir(parents=True, exist_ok=True)
    return path


def skills_install_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_SKILLS_INSTALL_DIR")
    path = Path(override).expanduser() if override else shared_state_dir() / "skills"
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_STATE_DIR")
    base_dir = Path(override).expanduser() if override else shared_state_dir()
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def shared_db_path() -> Path:
    override = os.environ.get("PIXEL_FORGE_DB_PATH")
    path = Path(override).expanduser() if override else shared_state_dir() / "pixel-forge.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    return shared_db_path()


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
