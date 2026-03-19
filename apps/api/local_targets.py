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

from runtime_config import (
    shared_state_dir as runtime_shared_state_dir,
    source_root as runtime_source_root,
)
from controller_update_state import (
    read_pending_controller_update,
    repair_pending_controller_update_snapshot,
)


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
    source_root: str
    build_label: str
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
    created_at: str | None


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
    project_path: str,
    runtime_kind: Literal["mirror", "dev"],
    source_root: str | None = None,
) -> str:
    normalized_path = _normalize_project_path(project_path)
    basename = re.sub(r"[^a-z0-9-]+", "-", Path(normalized_path).name.lower()).strip("-")
    digest_source = normalized_path
    if runtime_kind == "mirror" and source_root:
        digest_source = f"{normalized_path}::{_normalize_project_path(source_root)}"
    digest = hashlib.sha1(digest_source.encode("utf-8")).hexdigest()[:8]
    return f"{basename or 'project'}-{runtime_kind}-target-{digest}"


def _target_state_dir(instance_slug: str) -> Path:
    path = runtime_shared_state_dir() / "instances" / instance_slug
    path.mkdir(parents=True, exist_ok=True)
    return path


@dataclass(slots=True)
class MirrorLaunchSource:
    layout: Literal["installed", "workspace"]
    root: Path
    api_dir: Path
    requirements_path: Path
    frontend_dist: Path | None
    web_dir: Path | None
    venv_python: Path | None


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


def _label_for_source_root(source_root: str) -> str:
    normalized = Path(source_root).expanduser().resolve()
    runtime_root = Path(runtime_source_root()).expanduser().resolve()
    if normalized == runtime_root:
        return "Live Runtime"
    if "controller-updates" in normalized.parts:
        return f"Staged {normalized.name}"
    return normalized.name or str(normalized)


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
        source_root=str(metadata["source_root"]),
        build_label=str(metadata.get("build_label") or _label_for_source_root(str(metadata["source_root"]))),
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
        created_at=str(metadata["created_at"]) if metadata.get("created_at") else None,
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


def _resolve_mirror_launch_source(source_root: str) -> MirrorLaunchSource:
    root = Path(source_root).expanduser().resolve()

    if (root / "main.py").is_file() and (root / "requirements.txt").is_file():
        frontend_dist = root / "frontend"
        return MirrorLaunchSource(
            layout="installed",
            root=root,
            api_dir=root,
            requirements_path=root / "requirements.txt",
            frontend_dist=frontend_dist if (frontend_dist / "index.html").is_file() else None,
            web_dir=None,
            venv_python=root / ".venv" / "bin" / "python",
        )

    if (root / "apps" / "api" / "main.py").is_file() and (root / "apps" / "api" / "requirements.txt").is_file():
        return MirrorLaunchSource(
            layout="workspace",
            root=root,
            api_dir=root / "apps" / "api",
            requirements_path=root / "apps" / "api" / "requirements.txt",
            frontend_dist=None,
            web_dir=root / "apps" / "web",
            venv_python=None,
        )

    raise ValueError(f"Unsupported Pixel Forge mirror source root: {root}")


def _resolve_repaired_mirror_source_root(
    project_path: str,
    source_root: str,
) -> str:
    try:
        _resolve_mirror_launch_source(source_root)
        return source_root
    except ValueError as source_error:
        pending_update = repair_pending_controller_update_snapshot(
            read_pending_controller_update()
        )
        if (
            pending_update
            and pending_update.get("projectPath")
            and _normalize_project_path(str(pending_update["projectPath"])) == project_path
            and pending_update.get("snapshotPath")
            and str(Path(str(pending_update["snapshotPath"])).expanduser().resolve())
            == str(Path(source_root).expanduser().resolve())
        ):
            repaired_source_root = str(
                Path(str(pending_update["snapshotPath"])).expanduser().resolve()
            )
            _resolve_mirror_launch_source(repaired_source_root)
            return repaired_source_root
        raise source_error


def _normalize_listed_target_metadata(metadata: dict[str, Any]) -> dict[str, Any] | None:
    runtime_kind = _normalize_runtime_kind(str(metadata.get("runtime_kind") or DEFAULT_RUNTIME_KIND))
    if runtime_kind != "mirror":
        return metadata

    project_path = str(metadata.get("project_path") or "").strip()
    source_root = str(metadata.get("source_root") or "").strip()
    if not project_path or not source_root:
        return None

    try:
        repaired_source_root = _resolve_repaired_mirror_source_root(
            _normalize_project_path(project_path),
            _normalize_project_path(source_root),
        )
    except ValueError:
        return None

    normalized_source_root = _normalize_project_path(source_root)
    updated = False
    if repaired_source_root != normalized_source_root:
        metadata = {
            **metadata,
            "source_root": repaired_source_root,
        }
        updated = True

    expected_build_label = _label_for_source_root(repaired_source_root)
    if metadata.get("build_label") != expected_build_label:
        metadata = {
            **metadata,
            "build_label": expected_build_label,
        }
        updated = True

    if updated and metadata.get("instance_slug"):
        try:
            _write_metadata(str(metadata["instance_slug"]), metadata)
        except OSError:
            pass

    return metadata


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
    source_root: str,
    state_dir: Path,
    instance_slug: str,
    api_port: int,
    web_host: str,
    log_file: Path,
) -> tuple[list[str], dict[str, str], str, str, str]:
    launch_source = _resolve_mirror_launch_source(source_root)
    log_dir = state_dir / "logs"
    managed_browser_dir = state_dir / "managed-browser"
    log_dir.mkdir(parents=True, exist_ok=True)
    managed_browser_dir.mkdir(parents=True, exist_ok=True)

    if launch_source.layout == "installed":
        if not launch_source.frontend_dist:
            raise RuntimeError(
                f"Installed Pixel Forge source has no bundled frontend: {launch_source.root}"
            )
        if not launch_source.venv_python or not launch_source.venv_python.is_file():
            raise RuntimeError(
                f"Installed Pixel Forge source has no Python runtime: {launch_source.root}"
            )
        frontend_dist = launch_source.frontend_dist
        venv_python = launch_source.venv_python
    else:
        venv_dir = state_dir / "venv"
        venv_python = venv_dir / "bin" / "python"
        frontend_dist = state_dir / "frontend-dist"
        frontend_dist.mkdir(parents=True, exist_ok=True)

        build_env = _build_base_env()
        build_env.update(
            {
                "PIXEL_FORGE_INSTANCE_SLUG": instance_slug,
                "PIXEL_FORGE_RUNTIME_KIND": "mirror",
                "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": str(launch_source.root),
                "VITE_PIXEL_FORGE_RUNTIME_KIND": "mirror",
            }
        )

        if not venv_python.is_file():
            _run_logged_shell(
                f"python3 -m venv {shlex.quote(str(venv_dir))}",
                cwd=str(launch_source.root),
                env=build_env,
                log_file=log_file,
            )

        _run_logged_shell(
            f"{shlex.quote(str(venv_python))} -m pip install -q --upgrade pip",
            cwd=str(launch_source.root),
            env=build_env,
            log_file=log_file,
        )
        _run_logged_shell(
            f"{shlex.quote(str(venv_python))} -m pip install -q -r {shlex.quote(str(launch_source.requirements_path))}",
            cwd=str(launch_source.root),
            env=build_env,
            log_file=log_file,
        )

        web_dir = launch_source.web_dir
        if not web_dir:
            raise RuntimeError(
                f"Workspace Pixel Forge source has no web app: {launch_source.root}"
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
            "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": str(launch_source.root),
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
    return command, api_env, api_url, web_url, str(launch_source.api_dir)


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
            "PIXEL_FORGE_RUNTIME_SOURCE_ROOT": project_path,
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
    source_root: str | None = None,
) -> LocalTargetRecord:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_runtime_kind = _normalize_runtime_kind(runtime_kind)
    if normalized_runtime_kind == "mirror":
        normalized_source_root = _normalize_project_path(
            source_root or str(runtime_source_root())
        )
        normalized_source_root = _resolve_repaired_mirror_source_root(
            normalized_project_path,
            normalized_source_root,
        )
    else:
        normalized_source_root = _normalize_project_path(normalized_project_path)
    _validate_pixel_forge_project(normalized_project_path)

    instance_slug = _slug_for_project(
        normalized_project_path,
        normalized_runtime_kind,
        normalized_source_root,
    )
    state_dir = _target_state_dir(instance_slug)
    metadata = _load_metadata(instance_slug)

    if (
        metadata
        and metadata.get("web_url")
        and metadata.get("runtime_kind") == normalized_runtime_kind
        and metadata.get("source_root") == normalized_source_root
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
            command, env, api_url, web_url, launch_cwd = _ensure_mirror_runtime(
                source_root=normalized_source_root,
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
            launch_cwd = normalized_project_path
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
            cwd=launch_cwd,
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
                "source_root": normalized_source_root,
                "build_label": _label_for_source_root(normalized_source_root),
                "instance_slug": instance_slug,
                "api_port": api_port,
                "web_port": web_port,
                "web_host": web_host,
                "api_url": api_url,
                "web_url": web_url,
                "state_dir": str(state_dir),
                "log_file": str(log_file),
                "pid": proc.pid,
                "created_at": metadata.get("created_at") if metadata else time.strftime("%Y-%m-%dT%H:%M:%S%z"),
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


def list_pixel_forge_targets(
    project_path: str,
    runtime_kind: Literal["mirror", "dev"] | None = "mirror",
) -> list[LocalTargetRecord]:
    normalized_project_path = _normalize_project_path(project_path)
    records: list[LocalTargetRecord] = []
    instances_root = runtime_shared_state_dir() / "instances"
    if not instances_root.exists():
        return records

    for metadata_path in instances_root.glob("*/runtime.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(metadata, dict):
            continue
        metadata = _normalize_listed_target_metadata(metadata)
        if not metadata:
            continue
        if _normalize_project_path(str(metadata.get("project_path") or "")) != normalized_project_path:
            continue
        if runtime_kind and str(metadata.get("runtime_kind") or "") != runtime_kind:
            continue

        pid = int(metadata["pid"]) if metadata.get("pid") else None
        running = _is_http_ready(str(metadata.get("web_url") or "")) and _process_alive(pid)
        try:
            records.append(_record_from_metadata(metadata, already_running=running))
        except Exception:
            continue

    records.sort(
        key=lambda record: (
            record.created_at or "",
            record.instance_slug,
        ),
        reverse=True,
    )
    return records
