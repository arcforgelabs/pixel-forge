from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from runtime_config import state_dir as runtime_state_dir


PIXEL_FORGE_TARGET_KIND = "pixel-forge"
DEFAULT_TARGET_API_PORT = 7101
DEFAULT_TARGET_WEB_PORT = 5175
TARGET_START_TIMEOUT_SECONDS = 90.0


@dataclass(slots=True)
class LocalTargetRecord:
    kind: str
    project_path: str
    instance_slug: str
    api_port: int
    web_port: int
    web_host: str
    api_url: str
    web_url: str
    state_dir: str
    log_file: str
    pid: int | None
    target_mode: bool
    already_running: bool


def _normalize_project_path(project_path: str) -> str:
    return str(Path(project_path).expanduser().resolve())


def _slug_for_project(project_path: str) -> str:
    normalized_path = _normalize_project_path(project_path)
    basename = re.sub(r"[^a-z0-9-]+", "-", Path(normalized_path).name.lower()).strip("-")
    digest = hashlib.sha1(normalized_path.encode("utf-8")).hexdigest()[:8]
    return f"{basename or 'project'}-target-{digest}"


def _target_state_dir(instance_slug: str) -> Path:
    path = runtime_state_dir() / "instances" / instance_slug
    path.mkdir(parents=True, exist_ok=True)
    return path


def _metadata_path(instance_slug: str) -> Path:
    return _target_state_dir(instance_slug) / "runtime.json"


def _load_metadata(instance_slug: str) -> dict[str, Any] | None:
    path = _metadata_path(instance_slug)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_metadata(instance_slug: str, payload: dict[str, Any]) -> None:
    _metadata_path(instance_slug).write_text(
        json.dumps(payload, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _find_available_port(preferred_port: int, *, exclude: set[int] | None = None) -> int:
    excluded = exclude or set()
    for port in range(max(1024, preferred_port), max(1024, preferred_port) + 200):
        if port in excluded:
            continue
        if _is_port_free(port):
            return port

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        fallback_port = int(sock.getsockname()[1])

    if fallback_port in excluded:
        return _find_available_port(fallback_port + 1, exclude=excluded)
    return fallback_port


def _is_http_ready(url: str) -> bool:
    try:
        with urlopen(url, timeout=2.0) as response:
            return 200 <= response.status < 500
    except URLError:
        return False
    except OSError:
        return False


def _tail_log(log_file: Path) -> str:
    if not log_file.is_file():
        return ""
    try:
        lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-40:])


def _validate_pixel_forge_project(project_path: str) -> None:
    required_paths = [
        "start-dev.sh",
        "apps/api/main.py",
        "apps/web/package.json",
        "apps/desktop/package.json",
    ]
    missing = [
        relative_path
        for relative_path in required_paths
        if not (Path(project_path) / relative_path).exists()
    ]
    if missing:
        raise ValueError(
            "Workspace is not launchable as a Pixel Forge target: missing "
            + ", ".join(missing)
        )


def _record_from_metadata(metadata: dict[str, Any], *, already_running: bool) -> LocalTargetRecord:
    return LocalTargetRecord(
        kind=PIXEL_FORGE_TARGET_KIND,
        project_path=str(metadata["project_path"]),
        instance_slug=str(metadata["instance_slug"]),
        api_port=int(metadata["api_port"]),
        web_port=int(metadata["web_port"]),
        web_host=str(metadata["web_host"]),
        api_url=str(metadata["api_url"]),
        web_url=str(metadata["web_url"]),
        state_dir=str(metadata["state_dir"]),
        log_file=str(metadata["log_file"]),
        pid=int(metadata["pid"]) if metadata.get("pid") else None,
        target_mode=True,
        already_running=already_running,
    )


def start_pixel_forge_target(project_path: str) -> LocalTargetRecord:
    normalized_project_path = _normalize_project_path(project_path)
    _validate_pixel_forge_project(normalized_project_path)

    instance_slug = _slug_for_project(normalized_project_path)
    state_dir = _target_state_dir(instance_slug)
    metadata = _load_metadata(instance_slug)

    if metadata and metadata.get("web_url") and _is_http_ready(str(metadata["web_url"])):
        return _record_from_metadata(metadata, already_running=True)

    preferred_api_port = int(metadata["api_port"]) if metadata and metadata.get("api_port") else DEFAULT_TARGET_API_PORT
    api_port = _find_available_port(preferred_api_port)

    preferred_web_port = int(metadata["web_port"]) if metadata and metadata.get("web_port") else DEFAULT_TARGET_WEB_PORT
    web_port = _find_available_port(preferred_web_port, exclude={api_port})

    web_host = str(metadata["web_host"]) if metadata and metadata.get("web_host") else f"{instance_slug}.localhost"
    api_url = f"http://127.0.0.1:{api_port}"
    web_url = f"http://{web_host}:{web_port}"
    log_dir = state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "start-dev.log"
    managed_browser_dir = state_dir / "managed-browser"
    managed_browser_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env.update(
        {
            "PIXEL_FORGE_INSTANCE_SLUG": instance_slug,
            "PIXEL_FORGE_RUNTIME_ROLE": "target",
            "PIXEL_FORGE_TARGET_MODE": "1",
            "PIXEL_FORGE_NO_BROWSER": "1",
            "PIXEL_FORGE_KILL_STALE": "0",
            "PIXEL_FORGE_API_PORT": str(api_port),
            "PIXEL_FORGE_WEB_PORT": str(web_port),
            "PIXEL_FORGE_WEB_HOST": web_host,
            "PIXEL_FORGE_STATE_DIR": str(state_dir),
            "PIXEL_FORGE_MANAGED_BROWSER_DIR": str(managed_browser_dir),
            "PIXEL_FORGE_LOG_DIR": str(log_dir),
            "PIXEL_FORGE_TARGET_PROJECT_PATH": normalized_project_path,
            "PIXEL_FORGE_FORCE_POLLING": "1",
            "CHOKIDAR_USEPOLLING": "1",
            "CHOKIDAR_INTERVAL": "250",
            "WATCHFILES_FORCE_POLLING": "1",
            "VITE_PIXEL_FORGE_TARGET_MODE": "1",
            "VITE_PIXEL_FORGE_TARGET_PROJECT_PATH": normalized_project_path,
        }
    )

    with open(log_file, "ab") as log_handle:
        proc = subprocess.Popen(
            ["bash", "./start-dev.sh"],
            cwd=normalized_project_path,
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.time() + TARGET_START_TIMEOUT_SECONDS
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        if _is_http_ready(web_url):
            payload = {
                "kind": PIXEL_FORGE_TARGET_KIND,
                "project_path": normalized_project_path,
                "instance_slug": instance_slug,
                "api_port": api_port,
                "web_port": web_port,
                "web_host": web_host,
                "api_url": api_url,
                "web_url": web_url,
                "state_dir": str(state_dir),
                "log_file": str(log_file),
                "pid": proc.pid,
                "target_mode": True,
            }
            _write_metadata(instance_slug, payload)
            return _record_from_metadata(payload, already_running=False)
        time.sleep(1.0)

    tail = _tail_log(log_file)
    if proc.poll() is None:
        raise RuntimeError(
            "Pixel Forge target did not become ready in time.\n"
            f"Expected URL: {web_url}\n"
            f"Log file: {log_file}\n"
            f"{tail}"
        )

    raise RuntimeError(
        "Pixel Forge target exited during startup.\n"
        f"Log file: {log_file}\n"
        f"{tail}"
    )


def serialize_local_target(record: LocalTargetRecord) -> dict[str, Any]:
    return asdict(record)
