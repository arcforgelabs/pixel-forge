from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.error import URLError
from urllib.request import urlopen

from runtime_config import state_dir as runtime_state_dir


PIXEL_FORGE_TARGET_KIND = "pixel-forge"
DEFAULT_RUNTIME_KIND: Literal["mirror", "dev"] = "mirror"
DEFAULT_TARGET_API_PORT = 7101
DEFAULT_TARGET_WEB_PORT = 5175
TARGET_START_TIMEOUT_SECONDS = 120.0


@dataclass(slots=True)
class LocalTargetRecord:
    kind: str
    runtime_kind: Literal["mirror", "dev"]
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


def _normalize_runtime_kind(
    runtime_kind: str | None,
) -> Literal["mirror", "dev"]:
    normalized = (runtime_kind or DEFAULT_RUNTIME_KIND).strip().lower()
    if normalized not in {"mirror", "dev"}:
        raise ValueError(f"Unsupported Pixel Forge target runtime: {runtime_kind}")
    return normalized  # type: ignore[return-value]


def _slug_for_project(
    project_path: str, runtime_kind: Literal["mirror", "dev"]
) -> str:
    normalized_path = _normalize_project_path(project_path)
    basename = re.sub(r"[^a-z0-9-]+", "-", Path(normalized_path).name.lower()).strip("-")
    digest = hashlib.sha1(normalized_path.encode("utf-8")).hexdigest()[:8]
    return f"{basename or 'project'}-{runtime_kind}-target-{digest}"


def _target_state_dir(instance_slug: str) -> Path:
    path = runtime_state_dir() / "instances" / instance_slug
    path.mkdir(parents=True, exist_ok=True)
    return path


def _build_base_env() -> dict[str, str]:
    env = os.environ.copy()
    path_entries = env.get("PATH", "").split(":") if env.get("PATH") else []
    candidate_entries = [
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / ".local" / "share" / "pnpm"),
    ]
    for node_bin in (Path.home() / ".nvm" / "versions" / "node").glob("*/bin"):
        candidate_entries.append(str(node_bin))

    merged_entries: list[str] = []
    for entry in [*candidate_entries, *path_entries]:
        if not entry:
            continue
        if entry not in merged_entries:
            merged_entries.append(entry)

    env["PATH"] = ":".join(merged_entries)
    return env


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
    return "\n".join(lines[-60:])


def _validate_pixel_forge_project(project_path: str) -> None:
    required_paths = [
        "start-dev.sh",
        "install.sh",
        "apps/api/main.py",
        "apps/api/requirements.txt",
        "apps/web/package.json",
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
    runtime_kind = _normalize_runtime_kind(str(metadata.get("runtime_kind") or DEFAULT_RUNTIME_KIND))
    return LocalTargetRecord(
        kind=PIXEL_FORGE_TARGET_KIND,
        runtime_kind=runtime_kind,
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
        target_mode=runtime_kind == "dev",
        already_running=already_running,
    )


def _process_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _terminate_process_group(pid: int | None) -> None:
    if not _process_alive(pid):
        return

    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        return

    deadline = time.time() + 10.0
    while time.time() < deadline:
        if not _process_alive(pid):
            return
        time.sleep(0.2)

    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        return


def _append_log_line(log_file: Path, line: str) -> None:
    with log_file.open("ab") as handle:
        handle.write(f"{line}\n".encode("utf-8", errors="replace"))


def _run_logged_shell(
    command: str,
    *,
    cwd: str,
    env: dict[str, str],
    log_file: Path,
) -> None:
    _append_log_line(log_file, f"$ {command}")
    with log_file.open("ab") as log_handle:
        subprocess.run(
            ["bash", "-lc", command],
            cwd=cwd,
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            check=True,
        )


def _ensure_mirror_runtime(
    *,
    project_path: str,
    state_dir: Path,
    instance_slug: str,
    api_port: int,
    web_host: str,
    log_file: Path,
) -> tuple[list[str], dict[str, str], str, str]:
    venv_dir = state_dir / "venv"
    venv_python = venv_dir / "bin" / "python"
    requirements_path = Path(project_path) / "apps" / "api" / "requirements.txt"
    web_dir = Path(project_path) / "apps" / "web"
    frontend_dist = state_dir / "frontend-dist"
    log_dir = state_dir / "logs"
    managed_browser_dir = state_dir / "managed-browser"
    frontend_dist.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    managed_browser_dir.mkdir(parents=True, exist_ok=True)

    build_env = _build_base_env()
    build_env.update(
        {
            "PIXEL_FORGE_INSTANCE_SLUG": instance_slug,
            "PIXEL_FORGE_RUNTIME_KIND": "mirror",
            "VITE_PIXEL_FORGE_RUNTIME_KIND": "mirror",
        }
    )

    if not venv_python.is_file():
        _run_logged_shell(
            f"python3 -m venv {shlex.quote(str(venv_dir))}",
            cwd=project_path,
            env=build_env,
            log_file=log_file,
        )

    _run_logged_shell(
        f"{shlex.quote(str(venv_python))} -m pip install -q --upgrade pip",
        cwd=project_path,
        env=build_env,
        log_file=log_file,
    )
    _run_logged_shell(
        f"{shlex.quote(str(venv_python))} -m pip install -q -r {shlex.quote(str(requirements_path))}",
        cwd=project_path,
        env=build_env,
        log_file=log_file,
    )

    if not (web_dir / "node_modules").exists():
        _run_logged_shell(
            "pnpm install --frozen-lockfile",
            cwd=str(web_dir),
            env=build_env,
            log_file=log_file,
        )

    _run_logged_shell(
        "pnpm exec tsc --pretty false",
        cwd=str(web_dir),
        env=build_env,
        log_file=log_file,
    )
    _run_logged_shell(
        f"pnpm exec vite build --emptyOutDir --outDir {shlex.quote(str(frontend_dist))}",
        cwd=str(web_dir),
        env=build_env,
        log_file=log_file,
    )

    api_env = _build_base_env()
    api_env.update(
        {
            "PIXEL_FORGE_INSTANCE_SLUG": instance_slug,
            "PIXEL_FORGE_RUNTIME_ROLE": "target",
            "PIXEL_FORGE_RUNTIME_KIND": "mirror",
            "PIXEL_FORGE_API_PORT": str(api_port),
            "PIXEL_FORGE_WEB_PORT": str(api_port),
            "PIXEL_FORGE_WEB_HOST": web_host,
            "PIXEL_FORGE_STATE_DIR": str(state_dir),
            "PIXEL_FORGE_MANAGED_BROWSER_DIR": str(managed_browser_dir),
            "PIXEL_FORGE_LOG_DIR": str(log_dir),
            "PIXEL_FORGE_FRONTEND_DIST": str(frontend_dist),
        }
    )

    command = [
        str(venv_python),
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        "0.0.0.0",
        "--port",
        str(api_port),
    ]
    api_url = f"http://127.0.0.1:{api_port}"
    web_url = f"http://{web_host}:{api_port}"
    return command, api_env, api_url, web_url


def _ensure_dev_runtime(
    *,
    project_path: str,
    state_dir: Path,
    instance_slug: str,
    api_port: int,
    web_port: int,
    web_host: str,
    log_file: Path,
) -> tuple[list[str], dict[str, str], str, str]:
    log_dir = state_dir / "logs"
    managed_browser_dir = state_dir / "managed-browser"
    log_dir.mkdir(parents=True, exist_ok=True)
    managed_browser_dir.mkdir(parents=True, exist_ok=True)

    env = _build_base_env()
    env.update(
        {
            "PIXEL_FORGE_INSTANCE_SLUG": instance_slug,
            "PIXEL_FORGE_RUNTIME_ROLE": "target",
            "PIXEL_FORGE_RUNTIME_KIND": "dev",
            "PIXEL_FORGE_TARGET_MODE": "1",
            "PIXEL_FORGE_NO_BROWSER": "1",
            "PIXEL_FORGE_KILL_STALE": "0",
            "PIXEL_FORGE_API_PORT": str(api_port),
            "PIXEL_FORGE_WEB_PORT": str(web_port),
            "PIXEL_FORGE_WEB_HOST": web_host,
            "PIXEL_FORGE_STATE_DIR": str(state_dir),
            "PIXEL_FORGE_MANAGED_BROWSER_DIR": str(managed_browser_dir),
            "PIXEL_FORGE_LOG_DIR": str(log_dir),
            "PIXEL_FORGE_TARGET_PROJECT_PATH": project_path,
            "PIXEL_FORGE_FORCE_POLLING": "1",
            "CHOKIDAR_USEPOLLING": "1",
            "CHOKIDAR_INTERVAL": "250",
            "WATCHFILES_FORCE_POLLING": "1",
            "VITE_PIXEL_FORGE_RUNTIME_KIND": "dev",
            "VITE_PIXEL_FORGE_TARGET_MODE": "1",
            "VITE_PIXEL_FORGE_TARGET_PROJECT_PATH": project_path,
        }
    )

    api_url = f"http://127.0.0.1:{api_port}"
    web_url = f"http://{web_host}:{web_port}"
    _append_log_line(log_file, "$ bash ./start-dev.sh")
    return ["bash", "./start-dev.sh"], env, api_url, web_url


def start_pixel_forge_target(
    project_path: str,
    runtime_kind: str = DEFAULT_RUNTIME_KIND,
    force_restart: bool = False,
) -> LocalTargetRecord:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_runtime_kind = _normalize_runtime_kind(runtime_kind)
    _validate_pixel_forge_project(normalized_project_path)

    instance_slug = _slug_for_project(normalized_project_path, normalized_runtime_kind)
    state_dir = _target_state_dir(instance_slug)
    metadata = _load_metadata(instance_slug)

    if (
        metadata
        and metadata.get("web_url")
        and metadata.get("runtime_kind") == normalized_runtime_kind
        and _is_http_ready(str(metadata["web_url"]))
        and not force_restart
    ):
        return _record_from_metadata(metadata, already_running=True)

    if metadata:
        _terminate_process_group(int(metadata["pid"]) if metadata.get("pid") else None)

    preferred_api_port = (
        int(metadata["api_port"])
        if metadata and metadata.get("api_port")
        else DEFAULT_TARGET_API_PORT
    )
    api_port = _find_available_port(preferred_api_port)

    if normalized_runtime_kind == "mirror":
        web_port = api_port
    else:
        preferred_web_port = (
            int(metadata["web_port"])
            if metadata and metadata.get("web_port")
            else DEFAULT_TARGET_WEB_PORT
        )
        web_port = _find_available_port(preferred_web_port, exclude={api_port})

    web_host = (
        str(metadata["web_host"])
        if metadata and metadata.get("web_host")
        else f"{instance_slug}.localhost"
    )
    log_dir = state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{normalized_runtime_kind}.log"
    log_file.write_text("", encoding="utf-8")

    try:
        if normalized_runtime_kind == "mirror":
            command, env, api_url, web_url = _ensure_mirror_runtime(
                project_path=normalized_project_path,
                state_dir=state_dir,
                instance_slug=instance_slug,
                api_port=api_port,
                web_host=web_host,
                log_file=log_file,
            )
        else:
            command, env, api_url, web_url = _ensure_dev_runtime(
                project_path=normalized_project_path,
                state_dir=state_dir,
                instance_slug=instance_slug,
                api_port=api_port,
                web_port=web_port,
                web_host=web_host,
                log_file=log_file,
            )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Pixel Forge target build failed before launch.\n"
            f"Command: {exc.cmd}\n"
            f"Log file: {log_file}\n"
            f"{_tail_log(log_file)}"
        ) from exc

    with log_file.open("ab") as log_handle:
        proc = subprocess.Popen(
            command,
            cwd=normalized_project_path
            if normalized_runtime_kind == "dev"
            else str(Path(normalized_project_path) / "apps" / "api"),
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
                "runtime_kind": normalized_runtime_kind,
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
            }
            _write_metadata(instance_slug, payload)
            return _record_from_metadata(payload, already_running=False)
        time.sleep(1.0)

    tail = _tail_log(log_file)
    if proc.poll() is None:
        _terminate_process_group(proc.pid)
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
