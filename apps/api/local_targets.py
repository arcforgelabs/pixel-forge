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
from contextlib import suppress
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
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
WORKSPACE_PREVIEW_TARGET_KIND = "workspace-preview"
WORKSPACE_PREVIEW_ADAPTER_FILENAME = "pixel-forge.preview.json"
DEFAULT_RUNTIME_KIND: Literal["mirror", "dev"] = "mirror"
DEFAULT_TARGET_API_PORT = 7101
DEFAULT_TARGET_WEB_PORT = 5175
DEFAULT_WORKSPACE_WEB_PORT = 3100
TARGET_START_TIMEOUT_SECONDS = 120.0


@dataclass(slots=True)
class LocalTargetRecord:
    kind: str
    runtime_kind: Literal["mirror", "dev"]
    project_path: str
    workspace_path: str | None
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


@dataclass(slots=True)
class WorkspacePreviewLaunchPlan:
    mode: Literal["managed-process", "self-managed-script"]
    launch_cwd: Path
    command: list[str]
    env: dict[str, str]
    ready_path: str
    build_label: str
    stop_command: list[str] | None = None
    resolution_kind: Literal["adapter", "heuristic"] = "heuristic"
    adapter_id: str | None = None


@dataclass(slots=True)
class WorkspacePreviewAdapter:
    adapter_id: str
    label: str
    mode: Literal["managed-process", "self-managed-script"]
    cwd: str
    command: list[str]
    env: dict[str, str]
    stop_command: list[str] | None
    preferred_port: int | None
    ready_path: str | None
    match_origins: tuple[str, ...]
    match_hosts: tuple[str, ...]
    match_path_prefixes: tuple[str, ...]
    is_default: bool = False


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


def _iter_package_json_candidates(workspace_root: Path, *, max_depth: int = 4) -> list[Path]:
    candidates: list[Path] = []
    root_depth = len(workspace_root.parts)

    for current_root, dirnames, filenames in os.walk(workspace_root):
        current_path = Path(current_root)
        depth = len(current_path.parts) - root_depth
        dirnames[:] = [
            entry
            for entry in dirnames
            if entry not in {"node_modules", ".git", ".agents", "dist", "build", ".next"}
            and depth < max_depth
        ]
        if "package.json" not in filenames:
            continue
        candidates.append(current_path / "package.json")

    return sorted(candidates)


def _workspace_preview_adapter_path(workspace_root: Path) -> Path:
    return workspace_root / WORKSPACE_PREVIEW_ADAPTER_FILENAME


def _normalize_adapter_string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    normalized: list[str] = []
    for entry in value:
        if not isinstance(entry, str):
            continue
        stripped = entry.strip()
        if stripped:
            normalized.append(stripped)
    return tuple(normalized)


def _parse_workspace_preview_adapter(
    raw: dict[str, Any],
    *,
    source_path: Path,
    index: int,
) -> WorkspacePreviewAdapter:
    adapter_id = str(raw.get("id") or "").strip() or f"adapter-{index}"
    label = str(raw.get("label") or adapter_id).strip() or adapter_id
    mode = str(raw.get("mode") or "managed-process").strip().lower()
    if mode not in {"managed-process", "self-managed-script"}:
        raise ValueError(
            f"Unsupported workspace preview adapter mode '{mode}' in {source_path}"
        )

    command = raw.get("command")
    if not isinstance(command, list) or not all(isinstance(part, str) and part.strip() for part in command):
        raise ValueError(
            f"Workspace preview adapter '{adapter_id}' in {source_path} must define a non-empty command array"
        )

    stop_command_value = raw.get("stopCommand")
    stop_command: list[str] | None = None
    if isinstance(stop_command_value, list) and all(
        isinstance(part, str) and part.strip() for part in stop_command_value
    ):
        stop_command = [part.strip() for part in stop_command_value]

    env_value = raw.get("env")
    env: dict[str, str] = {}
    if isinstance(env_value, dict):
        for key, value in env_value.items():
            if isinstance(key, str) and isinstance(value, str):
                env[key] = value

    preferred_port = raw.get("preferredPort")
    normalized_preferred_port = (
        int(preferred_port)
        if isinstance(preferred_port, int) and preferred_port > 0
        else None
    )

    ready_path_value = raw.get("readyPath")
    ready_path = (
        str(ready_path_value).strip()
        if isinstance(ready_path_value, str) and str(ready_path_value).strip()
        else None
    )

    match_value = raw.get("match")
    match = match_value if isinstance(match_value, dict) else {}
    return WorkspacePreviewAdapter(
        adapter_id=adapter_id,
        label=label,
        mode=mode,  # type: ignore[arg-type]
        cwd=str(raw.get("cwd") or ".").strip() or ".",
        command=[part.strip() for part in command],
        env=env,
        stop_command=stop_command,
        preferred_port=normalized_preferred_port,
        ready_path=ready_path,
        match_origins=_normalize_adapter_string_list(match.get("origins")),
        match_hosts=_normalize_adapter_string_list(match.get("hosts")),
        match_path_prefixes=_normalize_adapter_string_list(match.get("pathPrefixes")),
        is_default=bool(raw.get("default")),
    )


def _load_workspace_preview_adapters(workspace_root: Path) -> list[WorkspacePreviewAdapter]:
    adapter_path = _workspace_preview_adapter_path(workspace_root)
    if not adapter_path.is_file():
        return []

    try:
        payload = json.loads(adapter_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(
            f"Workspace preview adapter file is unreadable: {adapter_path}"
        ) from exc

    adapters_value = None
    if isinstance(payload, dict):
        adapters_value = payload.get("workspacePreviewAdapters")
        if adapters_value is None:
            adapters_value = payload.get("workspace_preview_adapters")
    if not isinstance(adapters_value, list):
        raise ValueError(
            f"Workspace preview adapter file must define a workspacePreviewAdapters array: {adapter_path}"
        )

    adapters: list[WorkspacePreviewAdapter] = []
    for index, raw_adapter in enumerate(adapters_value, start=1):
        if not isinstance(raw_adapter, dict):
            continue
        adapters.append(
            _parse_workspace_preview_adapter(
                raw_adapter,
                source_path=adapter_path,
                index=index,
            )
        )
    return adapters


def _select_workspace_preview_adapter(
    adapters: list[WorkspacePreviewAdapter],
    *,
    requested_url: str | None,
) -> WorkspacePreviewAdapter | None:
    if not adapters:
        return None

    requested_origin = ""
    requested_host = ""
    requested_path = _normalize_local_preview_path(requested_url)
    if requested_url:
        with suppress(ValueError):
            parsed = urlparse(requested_url)
            requested_host = (parsed.hostname or "").strip().lower()
            if parsed.scheme and parsed.netloc:
                requested_origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")

    ranked: list[tuple[int, int, WorkspacePreviewAdapter]] = []
    for index, adapter in enumerate(adapters):
        score = 0

        if requested_origin and adapter.match_origins:
            if requested_origin in adapter.match_origins:
                score += 1000
            else:
                continue

        if requested_host and adapter.match_hosts:
            if requested_host in {host.lower() for host in adapter.match_hosts}:
                score += 100
            else:
                continue

        if adapter.match_path_prefixes:
            matching_prefixes = [
                prefix
                for prefix in adapter.match_path_prefixes
                if requested_path.startswith(prefix)
            ]
            if not matching_prefixes:
                continue
            score += max(len(prefix) for prefix in matching_prefixes)

        if adapter.is_default:
            score += 1
        elif not adapter.match_origins and not adapter.match_hosts and not adapter.match_path_prefixes:
            score += 1

        ranked.append((score, -index, adapter))

    if ranked:
        ranked.sort(reverse=True)
        return ranked[0][2]

    default_adapters = [adapter for adapter in adapters if adapter.is_default]
    if default_adapters:
        return default_adapters[0]
    if len(adapters) == 1:
        sole_adapter = adapters[0]
        if (
            not sole_adapter.match_origins
            and not sole_adapter.match_hosts
            and not sole_adapter.match_path_prefixes
        ):
            return sole_adapter
    return None


def _render_workspace_preview_adapter_template(
    value: str,
    tokens: dict[str, str],
) -> str:
    rendered = value
    for key, token_value in tokens.items():
        rendered = rendered.replace(f"{{{key}}}", token_value)
    return rendered


def _resolve_workspace_adapter_path(workspace_root: Path, raw_path: str) -> Path:
    candidate = Path(raw_path).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (workspace_root / candidate).resolve()


def _build_workspace_preview_launch_plan_from_adapter(
    *,
    adapter: WorkspacePreviewAdapter,
    project_path: str,
    workspace_path: str,
    requested_url: str | None,
    port: int,
    web_host: str,
) -> WorkspacePreviewLaunchPlan:
    workspace_root = Path(workspace_path).expanduser().resolve()
    requested_path = _normalize_local_preview_path(requested_url)
    ready_path = _normalize_local_preview_path(adapter.ready_path or requested_url)
    bind_host = "127.0.0.1"
    tokens = {
        "port": str(port),
        "host": bind_host,
        "web_host": web_host,
        "project": project_path,
        "workspace": workspace_path,
        "project_name": Path(project_path).name,
        "workspace_name": Path(workspace_path).name,
        "requested_path": requested_path,
        "ready_path": ready_path,
    }

    launch_cwd = _resolve_workspace_adapter_path(
        workspace_root,
        _render_workspace_preview_adapter_template(adapter.cwd, tokens),
    )
    command = [
        _render_workspace_preview_adapter_template(part, tokens)
        for part in adapter.command
    ]
    stop_command = (
        [
            _render_workspace_preview_adapter_template(part, tokens)
            for part in adapter.stop_command
        ]
        if adapter.stop_command
        else None
    )

    env = _build_base_env()
    env.update(
        {
            "HOST": bind_host,
            "PORT": str(port),
            "FIELD_PORT": str(port),
            "PIXEL_FORGE_PREVIEW_PORT": str(port),
            "PIXEL_FORGE_PREVIEW_HOST": bind_host,
            "PIXEL_FORGE_PREVIEW_PUBLIC_HOST": web_host,
            "CHOKIDAR_USEPOLLING": env.get("CHOKIDAR_USEPOLLING", "1"),
            "CHOKIDAR_INTERVAL": env.get("CHOKIDAR_INTERVAL", "250"),
            "WATCHFILES_FORCE_POLLING": env.get("WATCHFILES_FORCE_POLLING", "1"),
        }
    )
    for key, value in adapter.env.items():
        env[key] = _render_workspace_preview_adapter_template(value, tokens)

    return WorkspacePreviewLaunchPlan(
        mode=adapter.mode,
        launch_cwd=launch_cwd,
        command=command,
        stop_command=stop_command,
        env=env,
        ready_path=ready_path,
        build_label=adapter.label,
        resolution_kind="adapter",
        adapter_id=adapter.adapter_id,
    )


def _package_manager_command(package_dir: Path, workspace_root: Path) -> list[str]:
    current = package_dir
    workspace_root = workspace_root.resolve()
    while True:
        if (current / "pnpm-lock.yaml").is_file():
            return ["pnpm", "run"]
        if (current / "yarn.lock").is_file():
            return ["yarn"]
        if (current / "package-lock.json").is_file():
            return ["npm", "run"]
        if current == workspace_root or current.parent == current:
            break
        current = current.parent
    return ["npm", "run"]


def _pick_workspace_package_candidate(
    workspace_root: Path,
) -> tuple[Path, dict[str, Any]] | None:
    ranked: list[tuple[int, int, Path, dict[str, Any]]] = []

    for package_json_path in _iter_package_json_candidates(workspace_root):
        try:
            payload = json.loads(package_json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        scripts = payload.get("scripts")
        if not isinstance(scripts, dict):
            continue
        if "dev" not in scripts and "start" not in scripts:
            continue

        package_dir = package_json_path.parent
        depth = len(package_dir.relative_to(workspace_root).parts)
        name_penalty = 1 if package_dir.name.lower() in {"client", "frontend", "web"} else 0
        ranked.append((depth, name_penalty, package_json_path, payload))

    if not ranked:
        return None

    ranked.sort(key=lambda entry: (entry[0], entry[1], str(entry[2])))
    _, _, package_json_path, payload = ranked[0]
    return package_json_path.parent, payload


def _build_workspace_dev_command(
    workspace_root: Path,
    package_dir: Path,
    package_payload: dict[str, Any],
    port: int,
) -> tuple[list[str], dict[str, str]]:
    scripts = package_payload.get("scripts") if isinstance(package_payload, dict) else {}
    if not isinstance(scripts, dict):
        raise ValueError("Workspace package scripts are not available")

    script_name = "dev" if "dev" in scripts else "start"
    script_body = str(scripts.get(script_name) or "")
    command = [*_package_manager_command(package_dir, workspace_root), script_name]

    if "vite" in script_body:
        command.extend(["--", "--host", "127.0.0.1", "--port", str(port)])

    env = _build_base_env()
    env.update(
        {
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "FIELD_PORT": str(port),
            "PIXEL_FORGE_PREVIEW_PORT": str(port),
            "PIXEL_FORGE_PREVIEW_HOST": "127.0.0.1",
            "CHOKIDAR_USEPOLLING": env.get("CHOKIDAR_USEPOLLING", "1"),
            "CHOKIDAR_INTERVAL": env.get("CHOKIDAR_INTERVAL", "250"),
            "WATCHFILES_FORCE_POLLING": env.get("WATCHFILES_FORCE_POLLING", "1"),
        }
    )
    return command, env


def _detect_workspace_preview_launch_plan(
    *,
    project_path: str,
    workspace_path: str,
    requested_url: str | None,
    port: int,
) -> WorkspacePreviewLaunchPlan:
    workspace_root = Path(workspace_path).expanduser().resolve()
    if not workspace_root.is_dir():
        raise ValueError(f"Workspace does not exist: {workspace_root}")

    control_room_stack = workspace_root / "scripts" / "control-room-stack.sh"
    if control_room_stack.is_file():
        env = _build_base_env()
        env.update(
            {
                "PORT": str(port),
            }
        )
        return WorkspacePreviewLaunchPlan(
            mode="self-managed-script",
            launch_cwd=workspace_root,
            command=["bash", str(control_room_stack), "up"],
            stop_command=["bash", str(control_room_stack), "down"],
            env=env,
            ready_path=_normalize_local_preview_path(requested_url),
            build_label=_label_for_workspace(workspace_path, project_path),
        )

    package_candidate = _pick_workspace_package_candidate(workspace_root)
    if package_candidate is None:
        raise ValueError(
            "Workspace does not expose a launchable local preview path yet. "
            "Expected a repo-native stack script or a package.json with a dev/start script."
        )

    package_dir, package_payload = package_candidate
    command, env = _build_workspace_dev_command(
        workspace_root,
        package_dir,
        package_payload,
        port,
    )
    return WorkspacePreviewLaunchPlan(
        mode="managed-process",
        launch_cwd=package_dir,
        command=command,
        stop_command=None,
        env=env,
        ready_path=_normalize_local_preview_path(requested_url),
        build_label=_label_for_workspace(workspace_path, project_path),
        resolution_kind="heuristic",
        adapter_id=None,
    )


def _resolve_workspace_preview_launch_plan(
    *,
    project_path: str,
    workspace_path: str,
    requested_url: str | None,
    port: int,
    web_host: str,
) -> WorkspacePreviewLaunchPlan:
    workspace_root = Path(workspace_path).expanduser().resolve()
    adapters = _load_workspace_preview_adapters(workspace_root)
    adapter = _select_workspace_preview_adapter(
        adapters,
        requested_url=requested_url,
    )
    if adapter is not None:
        return _build_workspace_preview_launch_plan_from_adapter(
            adapter=adapter,
            project_path=project_path,
            workspace_path=workspace_path,
            requested_url=requested_url,
            port=port,
            web_host=web_host,
        )

    return _detect_workspace_preview_launch_plan(
        project_path=project_path,
        workspace_path=workspace_path,
        requested_url=requested_url,
        port=port,
    )


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


def _label_for_workspace(workspace_path: str, project_path: str) -> str:
    normalized_workspace = Path(workspace_path).expanduser().resolve()
    normalized_project = Path(project_path).expanduser().resolve()
    if normalized_workspace == normalized_project:
        return normalized_project.name or str(normalized_project)

    with suppress(ValueError):
        relative = normalized_workspace.relative_to(normalized_project)
        return relative.as_posix()

    return normalized_workspace.name or str(normalized_workspace)


def _slug_for_workspace(project_path: str, workspace_path: str) -> str:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_workspace_path = _normalize_project_path(workspace_path)
    basename = re.sub(r"[^a-z0-9-]+", "-", Path(normalized_workspace_path).name.lower()).strip("-")
    digest = hashlib.sha1(
        f"{normalized_project_path}::{normalized_workspace_path}".encode("utf-8")
    ).hexdigest()[:8]
    return f"{basename or 'workspace'}-preview-target-{digest}"


def _normalize_local_preview_path(url: str | None) -> str:
    if not url:
        return "/"
    try:
        parsed = urlparse(url)
    except ValueError:
        return "/"

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    return path


def _preferred_port_from_url(url: str | None, default_port: int) -> int:
    if not url:
        return default_port
    try:
        parsed = urlparse(url)
    except ValueError:
        return default_port
    if not parsed.port:
        return default_port
    return int(parsed.port)


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
        kind=str(metadata.get("kind") or PIXEL_FORGE_TARGET_KIND),
        runtime_kind=runtime_kind,
        project_path=str(metadata["project_path"]),
        workspace_path=str(metadata["workspace_path"]) if metadata.get("workspace_path") else None,
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


def _run_stop_command(
    command: list[str] | None,
    *,
    cwd: str | Path,
    env: dict[str, str] | None,
    log_file: Path,
) -> None:
    if not command:
        return
    with log_file.open("ab") as log_handle:
        subprocess.run(
            command,
            cwd=str(cwd),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            check=False,
        )


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
    project_path: str,
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
                "PIXEL_FORGE_TARGET_PROJECT_PATH": project_path,
                "VITE_PIXEL_FORGE_RUNTIME_KIND": "mirror",
                "VITE_PIXEL_FORGE_TARGET_PROJECT_PATH": project_path,
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
            "PIXEL_FORGE_TARGET_PROJECT_PATH": project_path,
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


def start_workspace_preview_target(
    project_path: str,
    workspace_path: str,
    *,
    requested_url: str | None = None,
    force_restart: bool = False,
) -> LocalTargetRecord:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_workspace_path = _normalize_project_path(workspace_path)
    instance_slug = _slug_for_workspace(normalized_project_path, normalized_workspace_path)
    state_dir = _target_state_dir(instance_slug)
    metadata = _load_metadata(instance_slug)

    if (
        metadata
        and metadata.get("kind") == WORKSPACE_PREVIEW_TARGET_KIND
        and metadata.get("web_url")
        and metadata.get("workspace_path") == normalized_workspace_path
        and _is_http_ready(str(metadata["web_url"]))
        and not force_restart
    ):
        return _record_from_metadata(metadata, already_running=True)

    log_dir = state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "workspace-preview.log"
    log_file.write_text("", encoding="utf-8")

    if metadata:
        stop_command = metadata.get("stop_command")
        if isinstance(stop_command, list):
            _run_stop_command(
                [str(entry) for entry in stop_command],
                cwd=str(metadata.get("launch_cwd") or normalized_workspace_path),
                env=_build_base_env(),
                log_file=log_file,
            )
        else:
            _terminate_process_group(int(metadata["pid"]) if metadata.get("pid") else None)

    workspace_root = Path(normalized_workspace_path).expanduser().resolve()
    adapters = _load_workspace_preview_adapters(workspace_root)
    selected_adapter = _select_workspace_preview_adapter(
        adapters,
        requested_url=requested_url,
    )
    preferred_web_port = (
        int(metadata["web_port"])
        if metadata and metadata.get("web_port")
        else (
            selected_adapter.preferred_port
            if selected_adapter and selected_adapter.preferred_port
            else _preferred_port_from_url(requested_url, DEFAULT_WORKSPACE_WEB_PORT)
        )
    )
    web_port = _find_available_port(preferred_web_port)
    web_host = (
        str(metadata["web_host"])
        if metadata and metadata.get("web_host")
        else f"{instance_slug}.localhost"
    )
    web_url = f"http://{web_host}:{web_port}"
    plan = (
        _build_workspace_preview_launch_plan_from_adapter(
            adapter=selected_adapter,
            project_path=normalized_project_path,
            workspace_path=normalized_workspace_path,
            requested_url=requested_url,
            port=web_port,
            web_host=web_host,
        )
        if selected_adapter is not None
        else _detect_workspace_preview_launch_plan(
            project_path=normalized_project_path,
            workspace_path=normalized_workspace_path,
            requested_url=requested_url,
            port=web_port,
        )
    )
    ready_url = f"{web_url.rstrip('/')}{plan.ready_path if plan.ready_path.startswith('/') else f'/{plan.ready_path}'}"

    if not selected_adapter and adapters:
        _append_log_line(
            log_file,
            "No workspace preview adapter matched the requested URL; falling back to bounded launch inference.",
        )

    if selected_adapter is not None:
        _append_log_line(
            log_file,
            f"Using workspace preview adapter: {selected_adapter.adapter_id}",
        )

    if plan.mode == "self-managed-script":
        with log_file.open("ab") as log_handle:
            completed = subprocess.run(
                plan.command,
                cwd=str(plan.launch_cwd),
                env=plan.env,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                check=False,
            )
        if completed.returncode != 0:
            raise RuntimeError(
                "Workspace preview failed during startup.\n"
                f"Command: {' '.join(shlex.quote(part) for part in plan.command)}\n"
                f"Log file: {log_file}\n"
                f"{_tail_log(log_file)}"
            )
        if not _is_http_ready(ready_url):
            raise RuntimeError(
                "Workspace preview did not become ready in time.\n"
                f"Expected URL: {ready_url}\n"
                f"Log file: {log_file}\n"
                f"{_tail_log(log_file)}"
            )
        payload = {
            "kind": WORKSPACE_PREVIEW_TARGET_KIND,
            "runtime_kind": "dev",
            "project_path": normalized_project_path,
            "workspace_path": normalized_workspace_path,
            "source_root": normalized_workspace_path,
            "build_label": plan.build_label,
            "instance_slug": instance_slug,
            "api_port": web_port,
            "web_port": web_port,
            "web_host": web_host,
            "api_url": web_url,
            "web_url": web_url,
            "state_dir": str(state_dir),
            "log_file": str(log_file),
            "pid": None,
            "target_mode": False,
            "created_at": metadata.get("created_at") if metadata else time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "launch_cwd": str(plan.launch_cwd),
            "stop_command": plan.stop_command,
            "mode": plan.mode,
            "adapter_id": plan.adapter_id,
            "resolution_kind": plan.resolution_kind,
        }
        _write_metadata(instance_slug, payload)
        return _record_from_metadata(payload, already_running=False)

    with log_file.open("ab") as log_handle:
        proc = subprocess.Popen(
            plan.command,
            cwd=str(plan.launch_cwd),
            env=plan.env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.time() + TARGET_START_TIMEOUT_SECONDS
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        if _is_http_ready(ready_url):
            payload = {
                "kind": WORKSPACE_PREVIEW_TARGET_KIND,
                "runtime_kind": "dev",
                "project_path": normalized_project_path,
                "workspace_path": normalized_workspace_path,
                "source_root": normalized_workspace_path,
                "build_label": plan.build_label,
                "instance_slug": instance_slug,
                "api_port": web_port,
                "web_port": web_port,
                "web_host": web_host,
                "api_url": web_url,
                "web_url": web_url,
                "state_dir": str(state_dir),
                "log_file": str(log_file),
                "pid": proc.pid,
                "target_mode": False,
                "created_at": metadata.get("created_at") if metadata else time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "launch_cwd": str(plan.launch_cwd),
                "stop_command": plan.stop_command,
                "mode": plan.mode,
                "adapter_id": plan.adapter_id,
                "resolution_kind": plan.resolution_kind,
            }
            _write_metadata(instance_slug, payload)
            return _record_from_metadata(payload, already_running=False)
        time.sleep(1.0)

    tail = _tail_log(log_file)
    if proc.poll() is None:
        _terminate_process_group(proc.pid)
        raise RuntimeError(
            "Workspace preview did not become ready in time.\n"
            f"Expected URL: {ready_url}\n"
            f"Log file: {log_file}\n"
            f"{tail}"
        )

    raise RuntimeError(
        "Workspace preview exited during startup.\n"
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
        if str(metadata.get("kind") or PIXEL_FORGE_TARGET_KIND) != PIXEL_FORGE_TARGET_KIND:
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


def list_workspace_preview_targets(
    project_path: str,
    workspace_path: str | None = None,
) -> list[LocalTargetRecord]:
    normalized_project_path = _normalize_project_path(project_path)
    normalized_workspace_path = (
        _normalize_project_path(workspace_path)
        if isinstance(workspace_path, str) and workspace_path.strip()
        else None
    )
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
        if str(metadata.get("kind") or "") != WORKSPACE_PREVIEW_TARGET_KIND:
            continue
        if _normalize_project_path(str(metadata.get("project_path") or "")) != normalized_project_path:
            continue
        if normalized_workspace_path and _normalize_project_path(str(metadata.get("workspace_path") or "")) != normalized_workspace_path:
            continue

        web_url = str(metadata.get("web_url") or "")
        pid = int(metadata["pid"]) if metadata.get("pid") else None
        running = _is_http_ready(web_url) and (pid is None or _process_alive(pid))
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
