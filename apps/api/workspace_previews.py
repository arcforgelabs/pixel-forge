from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from local_targets import (
    _build_base_env,
    _find_available_port,
    _is_http_ready,
    _process_alive,
    _tail_log,
    _terminate_process_group,
    stable_preview_url_for_host,
)
from runtime_config import shared_state_dir as runtime_shared_state_dir


WORKSPACE_PREVIEW_KIND = "workspace-preview"
WORKSPACE_PREVIEW_START_TIMEOUT_SECONDS = 120.0
WORKSPACE_PREVIEW_SCRIPT_ORDER = ("dev", "start", "serve")
WORKSPACE_PREVIEW_IGNORED_DIRS = {
    ".agents",
    ".git",
    ".idea",
    ".next",
    ".nuxt",
    ".pixel-forge",
    ".turbo",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "storybook-static",
    "target",
    "tmp",
}
WORKSPACE_PREVIEW_PATH_BONUS_TOKENS = {
    "app",
    "apps",
    "client",
    "dashboard",
    "frontend",
    "site",
    "ui",
    "web",
}
WORKSPACE_PREVIEW_PATH_PENALTY_TOKENS = {
    "docs",
    "doc",
    "example",
    "examples",
    "playground",
    "storybook",
    "test",
    "tests",
}
FRAMEWORK_DEFAULT_PORTS: dict[str, int] = {
    "astro": 4321,
    "gatsby": 8000,
    "next": 3000,
    "nuxt": 3000,
    "react-scripts": 3000,
    "sveltekit": 5173,
    "vite": 5173,
}
FRAMEWORK_PACKAGE_HINTS: tuple[tuple[str, str], ...] = (
    ("next", "next"),
    ("astro", "astro"),
    ("nuxt", "nuxt"),
    ("react-scripts", "react-scripts"),
    ("@sveltejs/kit", "sveltekit"),
    ("gatsby", "gatsby"),
    ("vite", "vite"),
)
PORT_FLAG_PATTERNS = (
    re.compile(r"(?<!\w)--port(?:=|\s+)(\d{2,5})"),
    re.compile(r"(?<!\w)-p(?:=|\s+)(\d{2,5})"),
    re.compile(r"\bPORT=(\d{2,5})\b"),
)


@dataclass(slots=True)
class WorkspacePreviewCandidate:
    candidate_id: str
    workspace_path: str
    workspace_root: str
    app_path: str
    relative_app_path: str
    title: str
    script_name: str
    package_manager: Literal["pnpm", "npm", "yarn", "bun"]
    framework: str | None
    preferred_port: int | None
    command_preview: str
    recommended: bool
    recommendation_score: int


@dataclass(slots=True)
class WorkspacePreviewRecord:
    kind: str
    workspace_path: str
    workspace_root: str
    app_path: str
    relative_app_path: str
    title: str
    script_name: str
    package_manager: Literal["pnpm", "npm", "yarn", "bun"]
    framework: str | None
    preferred_port: int | None
    instance_slug: str
    web_port: int
    web_host: str
    web_url: str
    stable_url: str
    state_dir: str
    log_file: str
    pid: int | None
    already_running: bool
    created_at: str | None


def _normalize_workspace_path(workspace_path: str) -> str:
    return str(Path(workspace_path).expanduser().resolve())


def _workspace_preview_root() -> Path:
    root = runtime_shared_state_dir() / "workspace-previews"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _workspace_preview_state_dir(instance_slug: str) -> Path:
    path = _workspace_preview_root() / "instances" / instance_slug
    path.mkdir(parents=True, exist_ok=True)
    return path


def _workspace_preview_metadata_path(instance_slug: str) -> Path:
    return _workspace_preview_state_dir(instance_slug) / "runtime.json"


def _load_metadata(instance_slug: str) -> dict[str, Any] | None:
    path = _workspace_preview_metadata_path(instance_slug)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_metadata(instance_slug: str, payload: dict[str, Any]) -> None:
    _workspace_preview_metadata_path(instance_slug).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _workspace_preview_slug(
    workspace_path: str,
    relative_app_path: str,
    script_name: str,
) -> str:
    workspace_name = re.sub(
        r"[^a-z0-9-]+",
        "-",
        Path(workspace_path).name.lower(),
    ).strip("-") or "workspace"
    digest = hashlib.sha1(
        f"{workspace_path}::{relative_app_path}::{script_name}".encode("utf-8")
    ).hexdigest()[:10]
    return f"{workspace_name}-workspace-preview-{digest}"


def _candidate_id(relative_app_path: str, script_name: str) -> str:
    return hashlib.sha1(
        f"{relative_app_path}::{script_name}".encode("utf-8")
    ).hexdigest()[:12]


def _iter_package_json_paths(workspace_path: str) -> list[Path]:
    root = Path(workspace_path)
    package_paths: list[Path] = []
    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            entry
            for entry in dirnames
            if entry not in WORKSPACE_PREVIEW_IGNORED_DIRS
        ]
        if "package.json" in filenames:
            package_paths.append(Path(current_root) / "package.json")
    return sorted(package_paths)


def _read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _find_workspace_root(
    app_path: Path,
    workspace_path: Path,
) -> Path:
    current = app_path
    resolved_workspace = workspace_path.resolve()
    last_match = app_path
    while True:
        if (current / "pnpm-workspace.yaml").is_file():
            return current
        if any(
            (current / lock_name).exists()
            for lock_name in ("pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock")
        ):
            last_match = current
        if current == resolved_workspace:
            break
        if current.parent == current:
            break
        current = current.parent
    return last_match


def _detect_package_manager(
    workspace_root: Path,
) -> Literal["pnpm", "npm", "yarn", "bun"]:
    if (workspace_root / "pnpm-lock.yaml").exists() or (workspace_root / "pnpm-workspace.yaml").exists():
        return "pnpm"
    if (workspace_root / "yarn.lock").exists():
        return "yarn"
    if (workspace_root / "bun.lockb").exists() or (workspace_root / "bun.lock").exists():
        return "bun"
    return "npm"


def _detect_framework(package_json: dict[str, Any]) -> str | None:
    dependency_blocks = []
    for key in ("dependencies", "devDependencies"):
        block = package_json.get(key)
        if isinstance(block, dict):
            dependency_blocks.append(block)

    for package_name, framework in FRAMEWORK_PACKAGE_HINTS:
        for block in dependency_blocks:
            if package_name in block:
                return framework
    return None


def _extract_script_port(script_body: str | None) -> int | None:
    if not script_body:
        return None
    for pattern in PORT_FLAG_PATTERNS:
        match = pattern.search(script_body)
        if match:
            try:
                port = int(match.group(1))
            except ValueError:
                continue
            if 1 <= port <= 65535:
                return port
    return None


def _candidate_title(app_path: Path, workspace_path: Path, package_json: dict[str, Any]) -> str:
    package_name = str(package_json.get("name") or "").strip()
    if package_name:
        return package_name
    if app_path == workspace_path:
        return workspace_path.name or str(workspace_path)
    return app_path.name or str(app_path)


def _recommendation_score(
    *,
    relative_app_path: str,
    script_name: str,
    framework: str | None,
    app_path: Path,
    workspace_path: Path,
) -> int:
    score = 0
    relative_parts = [part.lower() for part in Path(relative_app_path).parts if part]

    if app_path == workspace_path:
        score += 45

    if script_name == "dev":
        score += 40
    elif script_name == "start":
        score += 30
    elif script_name == "serve":
        score += 20

    if framework:
        score += 25

    score += 10 * sum(1 for part in relative_parts if part in WORKSPACE_PREVIEW_PATH_BONUS_TOKENS)
    score -= 15 * sum(1 for part in relative_parts if part in WORKSPACE_PREVIEW_PATH_PENALTY_TOKENS)

    if relative_app_path in {".", ""}:
        score += 10

    return score


def _command_preview(
    package_manager: Literal["pnpm", "npm", "yarn", "bun"],
    script_name: str,
    framework: str | None,
    preferred_port: int | None,
) -> str:
    base_command = (
        f"{package_manager} run {script_name}"
        if package_manager != "yarn"
        else f"yarn run {script_name}"
    )
    extra_args = _framework_cli_args(framework, preferred_port)
    if extra_args:
        if package_manager == "yarn":
            return f"{base_command} {' '.join(shlex.quote(arg) for arg in extra_args)}"
        return f"{base_command} -- {' '.join(shlex.quote(arg) for arg in extra_args)}"
    return base_command


def _framework_cli_args(framework: str | None, port: int | None) -> list[str]:
    if port is None:
        return []
    if framework == "next":
        return ["--hostname", "127.0.0.1", "--port", str(port)]
    if framework in {"astro", "gatsby", "nuxt", "sveltekit", "vite"}:
        return ["--host", "127.0.0.1", "--port", str(port)]
    return []


def discover_workspace_preview_candidates(
    workspace_path: str,
) -> list[WorkspacePreviewCandidate]:
    normalized_workspace_path = _normalize_workspace_path(workspace_path)
    workspace_root = Path(normalized_workspace_path)
    if not workspace_root.is_dir():
        raise ValueError(f"Workspace does not exist: {workspace_path}")

    candidates: list[WorkspacePreviewCandidate] = []

    for package_json_path in _iter_package_json_paths(normalized_workspace_path):
        package_json = _read_json_file(package_json_path)
        if not package_json:
            continue

        scripts = package_json.get("scripts")
        if not isinstance(scripts, dict):
            continue

        app_path = package_json_path.parent
        resolved_workspace_root = _find_workspace_root(app_path, workspace_root)
        package_manager = _detect_package_manager(resolved_workspace_root)
        framework = _detect_framework(package_json)
        relative_app_path = str(app_path.relative_to(workspace_root)) if app_path != workspace_root else "."
        title = _candidate_title(app_path, workspace_root, package_json)

        for script_name in WORKSPACE_PREVIEW_SCRIPT_ORDER:
            script_body = scripts.get(script_name)
            if not isinstance(script_body, str) or not script_body.strip():
                continue

            preferred_port = _extract_script_port(script_body) or FRAMEWORK_DEFAULT_PORTS.get(framework or "")
            score = _recommendation_score(
                relative_app_path=relative_app_path,
                script_name=script_name,
                framework=framework,
                app_path=app_path,
                workspace_path=workspace_root,
            )
            candidates.append(
                WorkspacePreviewCandidate(
                    candidate_id=_candidate_id(relative_app_path, script_name),
                    workspace_path=normalized_workspace_path,
                    workspace_root=str(resolved_workspace_root),
                    app_path=str(app_path),
                    relative_app_path=relative_app_path,
                    title=title,
                    script_name=script_name,
                    package_manager=package_manager,
                    framework=framework,
                    preferred_port=preferred_port,
                    command_preview=_command_preview(
                        package_manager,
                        script_name,
                        framework,
                        preferred_port,
                    ),
                    recommended=False,
                    recommendation_score=score,
                )
            )

    candidates.sort(
        key=lambda candidate: (
            candidate.recommendation_score,
            candidate.relative_app_path == ".",
            candidate.script_name == "dev",
            candidate.framework is not None,
            candidate.title,
        ),
        reverse=True,
    )

    if candidates:
        best_candidate = candidates[0]
        candidates[0] = WorkspacePreviewCandidate(
            **{
                **asdict(best_candidate),
                "recommended": True,
            }
        )

    return candidates


def _candidate_from_selection(
    workspace_path: str,
    *,
    relative_app_path: str | None = None,
    script_name: str | None = None,
    package_manager: str | None = None,
) -> WorkspacePreviewCandidate:
    candidates = discover_workspace_preview_candidates(workspace_path)
    if not candidates:
        raise ValueError("No supported workspace preview candidates were found.")

    if not relative_app_path and not script_name and not package_manager:
        return candidates[0]

    normalized_relative_app_path = (relative_app_path or ".").strip() or "."
    normalized_script_name = (script_name or "").strip()
    normalized_package_manager = (package_manager or "").strip()

    for candidate in candidates:
        if candidate.relative_app_path != normalized_relative_app_path:
            continue
        if normalized_script_name and candidate.script_name != normalized_script_name:
            continue
        if normalized_package_manager and candidate.package_manager != normalized_package_manager:
            continue
        return candidate

    raise ValueError("Requested workspace preview candidate no longer exists.")


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


def _install_command(
    package_manager: Literal["pnpm", "npm", "yarn", "bun"],
) -> str:
    if package_manager == "pnpm":
        return "pnpm install --frozen-lockfile"
    if package_manager == "yarn":
        return "yarn install --frozen-lockfile"
    if package_manager == "bun":
        return "bun install --frozen-lockfile"
    return "npm install"


def _ensure_dependencies_installed(
    candidate: WorkspacePreviewCandidate,
    *,
    env: dict[str, str],
    log_file: Path,
) -> None:
    workspace_root = Path(candidate.workspace_root)
    app_path = Path(candidate.app_path)
    if (app_path / "node_modules").exists() or (workspace_root / "node_modules").exists():
        return
    _run_logged_shell(
        _install_command(candidate.package_manager),
        cwd=candidate.workspace_root,
        env=env,
        log_file=log_file,
    )


def _start_command(
    candidate: WorkspacePreviewCandidate,
    port: int,
) -> str:
    base_command = (
        f"{candidate.package_manager} run {shlex.quote(candidate.script_name)}"
        if candidate.package_manager != "yarn"
        else f"yarn run {shlex.quote(candidate.script_name)}"
    )
    extra_args = _framework_cli_args(candidate.framework, port)
    if not extra_args:
        return base_command
    if candidate.package_manager == "yarn":
        return f"{base_command} {' '.join(shlex.quote(arg) for arg in extra_args)}"
    return f"{base_command} -- {' '.join(shlex.quote(arg) for arg in extra_args)}"


def _record_from_metadata(metadata: dict[str, Any], *, already_running: bool) -> WorkspacePreviewRecord:
    web_host = str(metadata["web_host"])
    preferred_port_value = metadata.get("preferred_port")
    preferred_port = int(preferred_port_value) if isinstance(preferred_port_value, int) else None
    return WorkspacePreviewRecord(
        kind=WORKSPACE_PREVIEW_KIND,
        workspace_path=str(metadata["workspace_path"]),
        workspace_root=str(metadata["workspace_root"]),
        app_path=str(metadata["app_path"]),
        relative_app_path=str(metadata["relative_app_path"]),
        title=str(metadata["title"]),
        script_name=str(metadata["script_name"]),
        package_manager=str(metadata["package_manager"]),  # type: ignore[arg-type]
        framework=str(metadata["framework"]) if metadata.get("framework") else None,
        preferred_port=preferred_port,
        instance_slug=str(metadata["instance_slug"]),
        web_port=int(metadata["web_port"]),
        web_host=web_host,
        web_url=str(metadata["web_url"]),
        stable_url=stable_preview_url_for_host(web_host),
        state_dir=str(metadata["state_dir"]),
        log_file=str(metadata["log_file"]),
        pid=int(metadata["pid"]) if metadata.get("pid") else None,
        already_running=already_running,
        created_at=str(metadata["created_at"]) if metadata.get("created_at") else None,
    )


def serialize_workspace_preview_candidate(candidate: WorkspacePreviewCandidate) -> dict[str, Any]:
    return asdict(candidate)


def serialize_workspace_preview(record: WorkspacePreviewRecord) -> dict[str, Any]:
    return asdict(record)


def start_workspace_preview(
    workspace_path: str,
    *,
    relative_app_path: str | None = None,
    script_name: str | None = None,
    package_manager: str | None = None,
    force_restart: bool = False,
) -> WorkspacePreviewRecord:
    candidate = _candidate_from_selection(
        workspace_path,
        relative_app_path=relative_app_path,
        script_name=script_name,
        package_manager=package_manager,
    )
    normalized_workspace_path = _normalize_workspace_path(candidate.workspace_path)
    instance_slug = _workspace_preview_slug(
        normalized_workspace_path,
        candidate.relative_app_path,
        candidate.script_name,
    )
    state_dir = _workspace_preview_state_dir(instance_slug)
    metadata = _load_metadata(instance_slug)

    if (
        metadata
        and metadata.get("web_url")
        and metadata.get("workspace_path") == normalized_workspace_path
        and metadata.get("relative_app_path") == candidate.relative_app_path
        and metadata.get("script_name") == candidate.script_name
        and not force_restart
    ):
        pid = int(metadata["pid"]) if metadata.get("pid") else None
        running = _is_http_ready(str(metadata["web_url"])) and _process_alive(pid)
        if running:
            return _record_from_metadata(metadata, already_running=True)

    if metadata:
        _terminate_process_group(int(metadata["pid"]) if metadata.get("pid") else None)

    preferred_port = (
        int(metadata["preferred_port"])
        if metadata and isinstance(metadata.get("preferred_port"), int)
        else candidate.preferred_port or 3000
    )
    web_port = _find_available_port(preferred_port)
    web_host = (
        str(metadata["web_host"])
        if metadata and metadata.get("web_host")
        else f"{instance_slug}.localhost"
    )
    target_url = f"http://127.0.0.1:{web_port}"
    log_dir = state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "preview.log"
    log_file.write_text("", encoding="utf-8")

    env = _build_base_env()
    env.update(
        {
            "BROWSER": "none",
            "CI": "1",
            "FORCE_COLOR": "0",
            "HOST": "127.0.0.1",
            "NO_COLOR": "1",
            "PORT": str(web_port),
            "PIXEL_FORGE_WORKSPACE_PREVIEW": "1",
            "PIXEL_FORGE_WORKSPACE_PATH": normalized_workspace_path,
            "PIXEL_FORGE_WORKSPACE_PREVIEW_APP_PATH": candidate.app_path,
            "PIXEL_FORGE_WORKSPACE_PREVIEW_PORT": str(web_port),
        }
    )

    try:
        _ensure_dependencies_installed(candidate, env=env, log_file=log_file)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Workspace preview dependency install failed before launch.\n"
            f"Command: {exc.cmd}\n"
            f"Log file: {log_file}\n"
            f"{_tail_log(log_file)}"
        ) from exc

    command = _start_command(candidate, web_port)
    _append_log_line(log_file, f"$ {command}")

    with log_file.open("ab") as log_handle:
        process = subprocess.Popen(
            ["bash", "-lc", command],
            cwd=candidate.app_path,
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.time() + WORKSPACE_PREVIEW_START_TIMEOUT_SECONDS
    while time.time() < deadline:
        if process.poll() is not None:
            break
        if _is_http_ready(target_url):
            payload = {
                "kind": WORKSPACE_PREVIEW_KIND,
                "workspace_path": normalized_workspace_path,
                "workspace_root": candidate.workspace_root,
                "app_path": candidate.app_path,
                "relative_app_path": candidate.relative_app_path,
                "title": candidate.title,
                "script_name": candidate.script_name,
                "package_manager": candidate.package_manager,
                "framework": candidate.framework,
                "preferred_port": candidate.preferred_port,
                "instance_slug": instance_slug,
                "web_port": web_port,
                "web_host": web_host,
                "web_url": target_url,
                "state_dir": str(state_dir),
                "log_file": str(log_file),
                "pid": process.pid,
                "created_at": (
                    metadata.get("created_at")
                    if metadata and metadata.get("created_at")
                    else time.strftime("%Y-%m-%dT%H:%M:%S%z")
                ),
            }
            _write_metadata(instance_slug, payload)
            return _record_from_metadata(payload, already_running=False)
        time.sleep(1.0)

    tail = _tail_log(log_file)
    if process.poll() is None:
        _terminate_process_group(process.pid)
        raise RuntimeError(
            "Workspace preview did not become ready in time.\n"
            f"Expected URL: {target_url}\n"
            f"Log file: {log_file}\n"
            f"{tail}"
        )

    raise RuntimeError(
        "Workspace preview exited during startup.\n"
        f"Log file: {log_file}\n"
        f"{tail}"
    )


def get_workspace_preview_by_host(web_host: str) -> WorkspacePreviewRecord | None:
    normalized_web_host = web_host.strip().lower()
    if not normalized_web_host:
        return None

    instances_root = _workspace_preview_root() / "instances"
    if not instances_root.exists():
        return None

    for metadata_path in instances_root.glob("*/runtime.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(metadata, dict):
            continue
        if str(metadata.get("web_host") or "").strip().lower() != normalized_web_host:
            continue

        pid = int(metadata["pid"]) if metadata.get("pid") else None
        running = _is_http_ready(str(metadata.get("web_url") or "")) and _process_alive(pid)
        try:
            return _record_from_metadata(metadata, already_running=running)
        except Exception:
            return None

    return None
