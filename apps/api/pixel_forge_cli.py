from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Sequence

from controller_update_state import (
    canonical_project_root,
    clear_pending_controller_update,
    read_pending_controller_update,
    write_pending_controller_update,
)
from workstation_events import append_workstation_event
from agent_deck_runtime import agent_deck_command, agent_deck_env, agent_deck_profile
from agent_deck_surface import (
    ensure_agent_deck_surface_started,
    read_agent_deck_surface_status,
    stop_agent_deck_surface,
)
from runtime_config import (
    agent_deck_home_dir,
    cli_name as runtime_cli_name,
    shared_db_path,
    shared_state_dir,
    url_host as runtime_url_host,
)
from runtime_version import read_runtime_info_for_root
from live_preview_context import read_live_preview_context_artifact
from request_packs import (
    read_request_pack_manifest,
    write_attach_proof_artifact,
)
from selection_tunnel_cli import selection_tunnel_path


APPLY_STATE_FILE = "controller-update-apply-state.json"
BOOTSTRAP_STATE_FILE = "controller-bootstrap-state.json"
DEFAULT_INSTALL_NAME = "pixel-forge"
DEFAULT_AGENT_DECK_TUI_LAUNCHER_NAME = "pixel-forge-agent-deck-alpha"
DEFAULT_AGENT_DECK_TUI_TITLE = "Agent Deck (alpha)"
DEFAULT_AGENT_DECK_TUI_WM_CLASS = "pixel-forge-agent-deck-alpha"


def _normalize_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def install_name() -> str:
    return os.environ.get("PIXEL_FORGE_INSTALL_NAME", DEFAULT_INSTALL_NAME)


def cli_name() -> str:
    return (
        _normalize_text(os.environ.get("PIXEL_FORGE_CLI_NAME"))
        or _normalize_text(os.environ.get("PIXEL_FORGE_INSTALL_NAME"))
        or runtime_cli_name()
    )


def install_dir() -> Path:
    return Path(
        os.environ.get("PIXEL_FORGE_INSTALL_DIR", str(Path.home() / ".local" / "lib" / install_name()))
    ).expanduser().resolve()


def backup_dir() -> Path:
    return Path(
        os.environ.get(
            "PIXEL_FORGE_BACKUP_DIR",
            str(Path.home() / ".local" / "lib" / f"{install_name()}.rollback"),
        )
    ).expanduser().resolve()


def bin_dir() -> Path:
    return Path(
        os.environ.get("PIXEL_FORGE_BIN_DIR", str(Path.home() / ".local" / "bin"))
    ).expanduser().resolve()


def service_name() -> str:
    return os.environ.get("PIXEL_FORGE_SERVICE_NAME", install_name())


def shell_name() -> str:
    return os.environ.get("PIXEL_FORGE_SHELL_NAME", f"{install_name()}-shell")


def agent_deck_tui_launcher_name() -> str:
    return os.environ.get(
        "PIXEL_FORGE_AGENT_DECK_TUI_LAUNCHER_NAME",
        DEFAULT_AGENT_DECK_TUI_LAUNCHER_NAME,
    )


def agent_deck_tui_title() -> str:
    return os.environ.get("PIXEL_FORGE_AGENT_DECK_TUI_TITLE", DEFAULT_AGENT_DECK_TUI_TITLE)


def agent_deck_tui_wm_class() -> str:
    return os.environ.get(
        "PIXEL_FORGE_AGENT_DECK_TUI_WM_CLASS",
        DEFAULT_AGENT_DECK_TUI_WM_CLASS,
    )


def port() -> str:
    return os.environ.get("PIXEL_FORGE_API_PORT") or os.environ.get("PIXEL_FORGE_PORT", "7001")


def url_host() -> str:
    return _normalize_text(os.environ.get("PIXEL_FORGE_URL_HOST")) or runtime_url_host()


def shell_url() -> str:
    return f"http://{url_host()}:{port()}"


def runtime_dir() -> Path:
    override = os.environ.get("PIXEL_FORGE_RUNTIME_DIR")
    resolved = Path(override).expanduser().resolve() if override else shared_state_dir() / "runtime"
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def pid_file() -> Path:
    return Path(
        os.environ.get("PIXEL_FORGE_PID_FILE", str(runtime_dir() / f"{service_name()}.pid"))
    ).expanduser().resolve()


def log_file() -> Path:
    return Path(
        os.environ.get("PIXEL_FORGE_LOG_FILE", str(runtime_dir() / f"{service_name()}.log"))
    ).expanduser().resolve()


def apply_state_path() -> Path:
    return shared_state_dir() / APPLY_STATE_FILE


def bootstrap_state_path() -> Path:
    return shared_state_dir() / BOOTSTRAP_STATE_FILE


def _read_json(path: Path) -> dict[str, Any] | list[Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")


def _sanitize_bootstrap_state(payload: Any) -> dict[str, str | None]:
    active_mode = payload.get("activeMode") if isinstance(payload, dict) else None
    return {
        "projectPath": _normalize_text(payload.get("projectPath")) if isinstance(payload, dict) else None,
        "previewUrl": _normalize_text(payload.get("previewUrl")) if isinstance(payload, dict) else None,
        "activeMode": active_mode if active_mode in {"live-editor", "screenshot"} else None,
    }


def _sanitize_apply_state(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}
    allowed_phases = {
        "idle",
        "preparing",
        "installing",
        "restarting",
        "waiting",
        "finalizing",
        "relaunching",
        "done",
        "error",
    }
    status = payload.get("status") if payload.get("status") in {"running", "error", "done"} else "idle"
    phase = payload.get("phase") if payload.get("phase") in allowed_phases else (
        "error" if status == "error" else "done" if status == "done" else "idle"
    )
    progress = max(0, min(100, round(float(payload.get("progress") or 0))))
    return {
        "status": status,
        "updateId": _normalize_text(payload.get("updateId")),
        "phase": phase,
        "progress": progress,
        "message": _normalize_text(payload.get("message")) or "",
        "error": _normalize_text(payload.get("error")),
        "updatedAt": _normalize_text(payload.get("updatedAt")) or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _read_apply_state() -> dict[str, Any]:
    return _sanitize_apply_state(_read_json(apply_state_path()))


def _write_apply_state(payload: dict[str, Any]) -> None:
    normalized = _sanitize_apply_state(payload)
    if normalized["status"] == "idle":
        try:
            apply_state_path().unlink()
        except FileNotFoundError:
            pass
        return
    _write_json(apply_state_path(), normalized)


def _current_source_root() -> Path:
    here = Path(__file__).resolve()
    if here.parent.name == "api" and here.parent.parent.name == "apps":
        try:
            workspace_root = here.parents[2]
        except IndexError:
            workspace_root = here.parent
        if (workspace_root / "apps" / "desktop" / "controller-update-runner.mjs").is_file():
            return workspace_root
    installed_root = here.parent
    if (installed_root / "main.py").is_file() and (installed_root / "requirements.txt").is_file():
        return installed_root
    return here.parents[2]


def _desktop_root() -> Path:
    root = _current_source_root()
    installed_desktop = root / "desktop"
    if (installed_desktop / "controller-update-runner.mjs").is_file():
        return installed_desktop
    workspace_desktop = root / "apps" / "desktop"
    if (workspace_desktop / "controller-update-runner.mjs").is_file():
        return workspace_desktop
    raise SystemExit(f"Unable to find desktop runtime under {root}")


def _resolve_uvicorn_executable() -> str:
    installed_uvicorn = install_dir() / ".venv" / "bin" / "uvicorn"
    if installed_uvicorn.is_file():
        return str(installed_uvicorn)
    raise SystemExit(f"Missing installed uvicorn binary: {installed_uvicorn}")


def _resolve_shell_launcher() -> str | None:
    candidate = bin_dir() / shell_name()
    if candidate.is_file():
        return str(candidate)
    return shutil.which(shell_name())


def _resolve_node_executable() -> str:
    resolved = shutil.which("node")
    if resolved:
        return resolved
    raise SystemExit("Node.js is required for controller-update apply")


def _base_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("PIXEL_FORGE_INSTALL_NAME", install_name())
    env.setdefault("PIXEL_FORGE_INSTALL_DIR", str(install_dir()))
    env.setdefault("PIXEL_FORGE_BACKUP_DIR", str(backup_dir()))
    env.setdefault("PIXEL_FORGE_SERVICE_NAME", service_name())
    env.setdefault("PIXEL_FORGE_PORT", port())
    env.setdefault("PIXEL_FORGE_URL_HOST", url_host())
    env.setdefault("PIXEL_FORGE_SHARED_STATE_DIR", str(shared_state_dir()))
    env.setdefault("PIXEL_FORGE_RUNTIME_DIR", str(runtime_dir()))
    env.setdefault("PIXEL_FORGE_DB_PATH", str(shared_db_path()))
    env.setdefault("PIXEL_FORGE_AGENT_DECK_HOME", str(agent_deck_home_dir()))
    env.setdefault("AGENTDECK_DIR", env["PIXEL_FORGE_AGENT_DECK_HOME"])
    env.setdefault("AGENT_DECK_DIR", env["PIXEL_FORGE_AGENT_DECK_HOME"])
    return env


def _without_nested_agent_deck_session_env(env: dict[str, str]) -> dict[str, str]:
    cleaned = dict(env)
    for key in (
        "TMUX",
        "TMUX_PANE",
        "AGENTDECK_INSTANCE_ID",
        "AGENTDECK_TITLE",
        "AGENTDECK_TOOL",
        "CLAUDE_SESSION_ID",
        "GEMINI_SESSION_ID",
        "OPENCODE_SESSION_ID",
        "CODEX_SESSION_ID",
    ):
        cleaned.pop(key, None)
    return cleaned


def _have_systemd_service() -> bool:
    try:
        result = subprocess.run(
            ["systemctl", "--user", "cat", service_name()],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False
    return result.returncode == 0


def _read_pid() -> int | None:
    try:
        raw = pid_file().read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _is_pid_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _clear_stale_pid_file() -> None:
    pid = _read_pid()
    if pid and not _is_pid_running(pid):
        try:
            pid_file().unlink()
        except FileNotFoundError:
            pass


def _exec(command: Sequence[str], env: dict[str, str] | None = None) -> "NoReturn":
    os.execvpe(command[0], list(command), env or _base_env())


def _replace_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for child in destination.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in source.iterdir():
        target = destination / child.name
        if child.is_symlink():
            target.symlink_to(os.readlink(child))
        elif child.is_dir():
            shutil.copytree(child, target, symlinks=True)
        else:
            shutil.copy2(child, target, follow_symlinks=False)


def _service_status_background() -> int:
    _clear_stale_pid_file()
    pid = _read_pid()
    if pid and _is_pid_running(pid):
        print(f"Pixel Forge running (PID: {pid})")
        print(f"URL: {shell_url()}")
        return 0
    print("Pixel Forge is not running.")
    return 1


def _command_start(_args: argparse.Namespace) -> int:
    env = _base_env()
    if _have_systemd_service():
        subprocess.run(["systemctl", "--user", "start", service_name()], check=True, env=env)
        print(f"Pixel Forge started (systemd). Open: {shell_url()}")
        return 0

    _clear_stale_pid_file()
    pid = _read_pid()
    if pid and _is_pid_running(pid):
        print(f"Pixel Forge already running (PID: {pid}). Open: {shell_url()}")
        return 0

    log_file().parent.mkdir(parents=True, exist_ok=True)
    with log_file().open("ab") as handle:
        proc = subprocess.Popen(
            [_resolve_uvicorn_executable(), "main:app", "--host", "0.0.0.0", "--port", port()],
            cwd=install_dir(),
            env=env,
            stdout=handle,
            stderr=handle,
            start_new_session=True,
        )
    pid_file().write_text(f"{proc.pid}\n", encoding="utf-8")
    time.sleep(1)
    if not _is_pid_running(proc.pid):
        raise SystemExit(f"Failed to start Pixel Forge. See {log_file()}")
    print(f"Pixel Forge started. Open: {shell_url()}")
    return 0


def _command_run(_args: argparse.Namespace) -> int:
    env = _base_env()
    _exec(
        [_resolve_uvicorn_executable(), "main:app", "--host", "0.0.0.0", "--port", port()],
        env=env,
    )


def _command_stop(_args: argparse.Namespace) -> int:
    env = _base_env()
    if _have_systemd_service():
        subprocess.run(["systemctl", "--user", "stop", service_name()], check=True, env=env)
        print("Pixel Forge stopped.")
        return 0

    _clear_stale_pid_file()
    pid = _read_pid()
    if not pid:
        print("Pixel Forge is not running.")
        return 0

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    for _ in range(20):
        if not _is_pid_running(pid):
            try:
                pid_file().unlink()
            except FileNotFoundError:
                pass
            print("Pixel Forge stopped.")
            return 0
        time.sleep(0.25)

    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        pid_file().unlink()
    except FileNotFoundError:
        pass
    print("Pixel Forge stopped.")
    return 0


def _command_restart(_args: argparse.Namespace) -> int:
    _command_stop(_args)
    time.sleep(1)
    return _command_start(_args)


def _command_rollback(_args: argparse.Namespace) -> int:
    rollback_root = backup_dir()
    if not rollback_root.is_dir():
        raise SystemExit("No rollback build available.")
    _command_stop(_args)
    _replace_tree(rollback_root, install_dir())
    _command_start(_args)
    print("Pixel Forge rolled back to the previous installed build.")
    return 0


def _command_status(_args: argparse.Namespace) -> int:
    env = _base_env()
    if _have_systemd_service():
        return subprocess.run(
            ["systemctl", "--user", "status", service_name(), "--no-pager"],
            check=False,
            env=env,
        ).returncode
    return _service_status_background()


def _command_logs(_args: argparse.Namespace) -> int:
    env = _base_env()
    if _have_systemd_service():
        _exec(["journalctl", "--user", "-u", service_name(), "-f", "--no-pager"], env=env)
    log_file().touch(exist_ok=True)
    _exec(["tail", "-f", str(log_file())], env=env)


def _command_open(_args: argparse.Namespace) -> int:
    launcher = _resolve_shell_launcher()
    if not launcher:
        raise SystemExit(
            f"Unable to find {shell_name()} in PIXEL_FORGE_BIN_DIR or PATH"
        )
    _exec([launcher], env=_base_env())


def _command_open_web(_args: argparse.Namespace) -> int:
    resolved = shutil.which("xdg-open")
    if resolved:
        subprocess.run([resolved, shell_url()], check=False, env=_base_env())
    else:
        print(f"Open: {shell_url()}")
    return 0


def _command_agent_deck_surface_status(_args: argparse.Namespace) -> int:
    print(json.dumps(read_agent_deck_surface_status(), indent=2))
    return 0


def _command_agent_deck_surface_start(_args: argparse.Namespace) -> int:
    print(json.dumps(ensure_agent_deck_surface_started(), indent=2))
    return 0


def _command_agent_deck_surface_stop(_args: argparse.Namespace) -> int:
    print(json.dumps(stop_agent_deck_surface(), indent=2))
    return 0


def _command_agent_deck_surface_open(_args: argparse.Namespace) -> int:
    status = ensure_agent_deck_surface_started()
    resolved = shutil.which("xdg-open")
    if resolved:
        subprocess.run([resolved, status["url"]], check=False, env=_base_env())
    else:
        print(f"Open: {status['url']}")
    print(json.dumps(status, indent=2))
    return 0


def _agent_deck_tui_exec_env(*, for_external_terminal: bool = False) -> dict[str, str]:
    env = _base_env()
    env.update(agent_deck_env())
    env.setdefault("PIXEL_FORGE_AGENT_DECK_TUI_TITLE", agent_deck_tui_title())
    if for_external_terminal:
        env = _without_nested_agent_deck_session_env(env)
    return env


def _agent_deck_tui_terminal_command(
    command: Sequence[str],
    title: str,
    wm_class: str,
) -> list[str] | None:
    candidates: tuple[tuple[str, tuple[str, ...]], ...] = (
        ("ghostty", (f"--class={wm_class}", f"--title={title}", "-e")),
        ("gnome-terminal", (f"--class={wm_class}", f"--title={title}", "--")),
        ("x-terminal-emulator", (f"--title={title}", "--")),
    )
    for binary, prefix in candidates:
        resolved = shutil.which(binary)
        if not resolved:
            continue
        return [resolved, *prefix, *command]
    return None


def _command_agent_deck_tui_run(_args: argparse.Namespace) -> int:
    _exec(agent_deck_command(), env=_agent_deck_tui_exec_env())


def _command_agent_deck_tui_open(_args: argparse.Namespace) -> int:
    command = _agent_deck_tui_terminal_command(
        agent_deck_command(),
        agent_deck_tui_title(),
        agent_deck_tui_wm_class(),
    )
    if command is None:
        raise SystemExit(
            "No supported terminal emulator found for Agent Deck (alpha). "
            f"Run `{agent_deck_tui_launcher_name()} run` in a terminal instead."
        )

    subprocess.Popen(
        command,
        env=_agent_deck_tui_exec_env(for_external_terminal=True),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "terminal": Path(command[0]).name,
                "title": agent_deck_tui_title(),
                "wmClass": agent_deck_tui_wm_class(),
                "profile": agent_deck_profile(),
                "homeDir": str(agent_deck_home_dir()),
                "launcher": agent_deck_tui_launcher_name(),
            },
            indent=2,
        )
    )
    return 0


def _command_tunnel(args: argparse.Namespace) -> int:
    try:
        payload = json.loads(
            selection_tunnel_path(args.project, args.request).read_text(encoding="utf-8")
        )
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc

    if args.selection:
        selections = payload.get("selections")
        if not isinstance(selections, list):
            raise SystemExit("Selection tunnel is empty")
        payload = next(
            (
                entry
                for entry in selections
                if isinstance(entry, dict) and entry.get("id") == args.selection
            ),
            None,
        )
        if payload is None:
            raise SystemExit(f"Selection not found: {args.selection}")

    if args.compact:
        print(json.dumps(payload, separators=(",", ":")))
    else:
        print(json.dumps(payload, indent=2))
    return 0


def _command_preview_context(args: argparse.Namespace) -> int:
    try:
        payload = read_live_preview_context_artifact(args.project, args.request)
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc

    if not args.stored_only:
        query = urllib.parse.urlencode(
            {
                "project_path": args.project,
                "request_id": args.request,
            }
        )
        try:
            with urllib.request.urlopen(
                f"{shell_url()}/api/live-editor/live-preview-context?{query}",
                timeout=4,
            ) as response:
                if response.status == 200:
                    live_payload = json.loads(response.read().decode("utf-8"))
                    if isinstance(live_payload, dict):
                        payload = live_payload
        except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            pass

    if args.compact:
        print(json.dumps(payload, separators=(",", ":")))
    else:
        print(json.dumps(payload, indent=2))
    return 0


def _attach_proof_message(status: str, via: str, *, evidence: str | None, note: str | None) -> str:
    if status == "attempted":
        suffix = f" {note}" if note else ""
        return f"Live preview attach attempt recorded via {via}.{suffix}".strip()
    if status == "succeeded":
        detail = evidence or note or "No live evidence summary provided."
        return f"Live preview attach succeeded via {via}. Evidence: {detail}"
    detail = note or evidence or "No failure detail provided."
    return f"Live preview attach failed via {via}. Detail: {detail}"


def _command_attach_proof(args: argparse.Namespace) -> int:
    try:
        manifest = read_request_pack_manifest(args.project, args.request)
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc

    try:
        live_preview_context = read_live_preview_context_artifact(args.project, args.request)
    except FileNotFoundError:
        live_preview_context = {}

    thread_id = _normalize_text(manifest.get("thread_id"))
    agent_deck_session_id = _normalize_text(manifest.get("agent_deck_session_id"))
    agent_deck_session_title = _normalize_text(manifest.get("agent_deck_session_title"))
    continuation_mode = _normalize_text(manifest.get("continuation_mode"))
    workspace_project_path = str(Path(args.project).expanduser().resolve())
    canonical_project_path = str(
        canonical_project_root(
            _normalize_text(manifest.get("canonical_project_path")) or workspace_project_path
        )
    )
    proof_status = args.status
    via = _normalize_text(args.via)
    if not via:
        raise SystemExit("--via is required")
    note = _normalize_text(args.note)
    evidence = _normalize_text(args.evidence)
    if proof_status == "succeeded" and not evidence:
        raise SystemExit("--evidence is required when --status succeeded")
    attach_hints = (
        live_preview_context.get("attach_hints")
        if isinstance(live_preview_context, dict)
        else None
    )

    proof_payload = {
        "request_id": args.request,
        "thread_id": thread_id,
        "status": proof_status,
        "via": via,
        "recorded_at": int(time.time()),
        "workspace_project_path": workspace_project_path,
        "canonical_project_path": canonical_project_path,
        "note": note,
        "evidence": evidence,
        "attach_hints": attach_hints if isinstance(attach_hints, dict) else None,
    }
    proof_path = write_attach_proof_artifact(args.project, args.request, proof_payload)
    message = _attach_proof_message(proof_status, via, evidence=evidence, note=note)

    if thread_id:
        append_workstation_event(
            canonical_project_path,
            thread_id,
            agent_deck_session_id=agent_deck_session_id,
            event_type="turn_status",
            payload={
                "request_id": args.request,
                "agent_deck_session_id": agent_deck_session_id,
                "agent_deck_session_title": agent_deck_session_title,
                "workspace_path": workspace_project_path,
                "canonical_project_path": canonical_project_path,
                "continuation_mode": continuation_mode,
                "message": message,
                "attach_proof": {
                    "status": proof_status,
                    "via": via,
                    "note": note,
                    "evidence": evidence,
                    "proof_file": str(proof_path.relative_to(Path(args.project).resolve())),
                },
            },
        )

    response = {
        "ok": True,
        "requestId": args.request,
        "threadId": thread_id,
        "status": proof_status,
        "via": via,
        "canonicalProjectPath": canonical_project_path,
        "proofFile": str(proof_path.relative_to(Path(args.project).resolve())),
        "message": message,
    }
    if evidence:
        response["evidence"] = evidence
    if note:
        response["note"] = note
    print(json.dumps(response, indent=2))
    return 0


def _controller_update_payload_from_args(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "projectPath": args.project_path,
        "previewUrl": args.preview_url,
        "activeMode": args.active_mode,
        "summary": args.summary,
        "source": args.source,
        "requestId": args.request_id,
        "commitHash": args.commit_hash,
        "gitRef": args.git_ref,
        "allowNoncanonicalProject": bool(getattr(args, "allow_noncanonical_project", False)),
    }


def _command_controller_update_stage(args: argparse.Namespace) -> int:
    update = write_pending_controller_update(_controller_update_payload_from_args(args))
    print(json.dumps(update, indent=2))
    return 0


def _command_controller_update_show(_args: argparse.Namespace) -> int:
    update = read_pending_controller_update()
    if update is None:
        print("No staged controller update.")
        return 1
    print(json.dumps(update, indent=2))
    return 0


def _command_controller_update_clear(_args: argparse.Namespace) -> int:
    cleared = clear_pending_controller_update()
    if cleared:
        print("Cleared staged controller update.")
    else:
        print("No staged controller update.")
    return 0


def _running_runtime_info() -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"{shell_url()}/api/runtime-info", timeout=2) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
            if isinstance(payload, dict):
                return payload
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    return None


def _installed_runtime_info() -> dict[str, Any]:
    return read_runtime_info_for_root(install_dir())


def _command_controller_update_status(_args: argparse.Namespace) -> int:
    payload = {
        "pendingUpdate": read_pending_controller_update(),
        "applyState": _read_apply_state(),
        "runtimeInfo": _running_runtime_info() or _installed_runtime_info(),
    }
    print(json.dumps(payload, indent=2))
    return 0


def _write_bootstrap_state(project_path: str | None, preview_url: str | None, active_mode: str | None) -> None:
    _write_json(
        bootstrap_state_path(),
        _sanitize_bootstrap_state(
            {
                "projectPath": project_path,
                "previewUrl": preview_url,
                "activeMode": active_mode,
            }
        ),
    )


def _launch_updater_ui() -> None:
    launcher = _resolve_shell_launcher()
    if not launcher:
        print(
            f"Warning: unable to find {shell_name()} for updater UI",
            file=sys.stderr,
        )
        return
    subprocess.Popen(
        [launcher, "--pixel-forge-updater-ui"],
        env=_base_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _runner_args(install_root: str, update_id: str | None) -> list[str]:
    return [
        _resolve_node_executable(),
        str(_desktop_root() / "controller-update-runner.mjs"),
        "--state-dir",
        str(shared_state_dir()),
        "--install-root",
        install_root,
        "--update-id",
        update_id or "",
        "--shell-url",
        shell_url(),
    ]


def _apply_pending_controller_update(args: argparse.Namespace, *, emit_output: bool) -> dict[str, Any]:
    pending_update = read_pending_controller_update()
    if pending_update is None:
        raise SystemExit("No staged Pixel Forge update is ready to apply.")

    install_root = pending_update.get("snapshotPath") or pending_update["projectPath"]
    update_id = pending_update.get("id")
    bootstrap_project = _normalize_text(args.project_path) or pending_update["projectPath"]
    _write_bootstrap_state(bootstrap_project, args.preview_url, args.active_mode)
    _write_apply_state(
        {
            "status": "running",
            "updateId": update_id,
            "phase": "preparing",
            "progress": 10,
            "message": "Preparing staged Pixel Forge update…",
            "error": None,
        }
    )

    env = _base_env()
    env["ELECTRON_RUN_AS_NODE"] = "1"
    if args.no_shell_relaunch:
        env["PIXEL_FORGE_SKIP_SHELL_RELAUNCH"] = "1"

    if args.show_ui:
        _launch_updater_ui()

    command = _runner_args(str(install_root), update_id)
    if args.detach:
        subprocess.Popen(
            command,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        result = {"ok": True, "updateId": update_id, "detached": True}
        if emit_output:
            print(json.dumps(result, indent=2))
        return result

    subprocess.run(command, check=True, env=env)
    result = {"ok": True, "updateId": update_id, "detached": False}
    if emit_output:
        print(json.dumps(result, indent=2))
    return result


def _command_controller_update_apply(args: argparse.Namespace) -> int:
    _apply_pending_controller_update(args, emit_output=True)
    return 0


def _git(args: Sequence[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def _current_branch(cwd: Path) -> str:
    return _git(["branch", "--show-current"], cwd).stdout.strip()


def _command_clone_promote(args: argparse.Namespace) -> int:
    project_root = canonical_project_root(args.project or os.getcwd())
    branch = args.into or _current_branch(project_root)

    finish_command = ["agent-deck", "clone", "finish", args.session, "--into", branch]
    if args.keep_branch:
        finish_command.append("--keep-branch")
    if args.force:
        finish_command.append("--force")
    subprocess.run(finish_command, cwd=project_root, check=True)

    if args.commit:
        message = args.message or f"fix: promote clone {args.session} into {branch}"
        subprocess.run(["git", "add", "-A"], cwd=project_root, check=True)
        subprocess.run(["git", "commit", "-m", message], cwd=project_root, check=True)

    if args.push:
        subprocess.run(["git", "push", "origin", branch], cwd=project_root, check=True)

    staged_update = None
    if args.stage or args.apply:
        git_ref = args.git_ref or ("HEAD" if args.commit else None)
        staged_update = write_pending_controller_update(
            {
                "projectPath": str(project_root),
                "summary": args.summary or f"Promoted clone {args.session} into {branch}.",
                "source": "clone-promote",
                "gitRef": git_ref,
            }
        )

    applied_update = None
    if args.apply:
        apply_args = argparse.Namespace(
            project_path=str(project_root),
            preview_url=None,
            active_mode="live-editor",
            show_ui=args.show_ui,
            detach=False,
            no_shell_relaunch=args.no_shell_relaunch,
        )
        applied_update = _apply_pending_controller_update(apply_args, emit_output=False)

    payload = {
        "ok": True,
        "projectPath": str(project_root),
        "branch": branch,
        "committed": bool(args.commit),
        "pushed": bool(args.push),
        "stagedUpdate": staged_update,
        "appliedUpdate": applied_update,
    }
    print(json.dumps(payload, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=cli_name(),
        description="Operate the Pixel Forge controller, update lane, and clone-promotion workflow.",
    )
    subparsers = parser.add_subparsers(dest="command")

    for command_name, help_text, handler in (
        ("start", "Start the installed Pixel Forge service", _command_start),
        ("run", "Run the installed Pixel Forge service in the foreground", _command_run),
        ("stop", "Stop the installed Pixel Forge service", _command_stop),
        ("restart", "Restart the installed Pixel Forge service", _command_restart),
        ("rollback", "Restore the previous installed Pixel Forge build", _command_rollback),
        ("status", "Show installed service status", _command_status),
        ("logs", "Tail installed service logs", _command_logs),
        ("open", "Open the Pixel Forge desktop shell", _command_open),
        ("open-web", "Open the raw Pixel Forge web UI", _command_open_web),
    ):
        command = subparsers.add_parser(command_name, help=help_text)
        command.set_defaults(handler=handler)

    agent_deck_tui = subparsers.add_parser(
        "agent-deck-tui",
        help="Open or run the alpha-owned Agent Deck terminal app",
    )
    agent_deck_tui_subparsers = agent_deck_tui.add_subparsers(
        dest="agent_deck_tui_command",
        required=True,
    )
    for command_name, help_text, handler in (
        ("open", "Open the Agent Deck alpha TUI in a separate terminal window", _command_agent_deck_tui_open),
        ("run", "Run the Agent Deck alpha TUI in the current terminal", _command_agent_deck_tui_run),
    ):
        command = agent_deck_tui_subparsers.add_parser(command_name, help=help_text)
        command.set_defaults(handler=handler)

    agent_deck_surface = subparsers.add_parser(
        "agent-deck-surface",
        help="Manage the alpha-owned Agent Deck visual surface",
    )
    agent_deck_surface_subparsers = agent_deck_surface.add_subparsers(
        dest="agent_deck_surface_command",
        required=True,
    )
    for command_name, help_text, handler in (
        ("status", "Show Agent Deck surface status", _command_agent_deck_surface_status),
        ("start", "Start the Agent Deck surface", _command_agent_deck_surface_start),
        ("stop", "Stop the Agent Deck surface", _command_agent_deck_surface_stop),
        ("open", "Start and open the Agent Deck surface", _command_agent_deck_surface_open),
    ):
        command = agent_deck_surface_subparsers.add_parser(command_name, help=help_text)
        command.set_defaults(handler=handler)

    tunnel = subparsers.add_parser("tunnel", help="Read a Pixel Forge selection tunnel artifact")
    tunnel.add_argument("--project", required=True, help="Workspace path that owns the request pack")
    tunnel.add_argument("--request", required=True, help="Pixel Forge request id")
    tunnel.add_argument("--selection", help="Optional selection id to print a single selection")
    tunnel.add_argument("--compact", action="store_true", help="Print compact JSON")
    tunnel.set_defaults(handler=_command_tunnel)

    preview_context = subparsers.add_parser(
        "preview-context",
        help="Read a Pixel Forge live preview context artifact",
    )
    preview_context.add_argument("--project", required=True, help="Workspace path that owns the request pack")
    preview_context.add_argument("--request", required=True, help="Pixel Forge request id")
    preview_context.add_argument(
        "--stored-only",
        action="store_true",
        help="Read the stored artifact only and skip live refresh",
    )
    preview_context.add_argument("--compact", action="store_true", help="Print compact JSON")
    preview_context.set_defaults(handler=_command_preview_context)

    attach_proof = subparsers.add_parser(
        "attach-proof",
        help="Record live browser attach proof for a Pixel Forge request",
    )
    attach_proof.add_argument("--project", required=True, help="Workspace path that owns the request pack")
    attach_proof.add_argument("--request", required=True, help="Pixel Forge request id")
    attach_proof.add_argument(
        "--status",
        required=True,
        choices=["attempted", "succeeded", "failed"],
        help="Attach proof status to record",
    )
    attach_proof.add_argument(
        "--via",
        required=True,
        help="Attach mechanism actually used for the live browser session",
    )
    attach_proof.add_argument(
        "--note",
        help="Short note for the attach attempt or failure",
    )
    attach_proof.add_argument(
        "--evidence",
        help="One live-only fact observed after successful attach",
    )
    attach_proof.set_defaults(handler=_command_attach_proof)

    controller_update = subparsers.add_parser(
        "controller-update",
        help="Stage, inspect, apply, and clear controller updates",
    )
    controller_update_subparsers = controller_update.add_subparsers(dest="controller_update_command", required=True)

    stage = controller_update_subparsers.add_parser("stage", help="Stage a controller update snapshot")
    stage.add_argument("--project", dest="project_path", required=True, help="Canonical Pixel Forge project root")
    stage.add_argument("--preview-url", dest="preview_url")
    stage.add_argument("--mode", dest="active_mode", choices=["live-editor", "screenshot"])
    stage.add_argument("--summary", dest="summary")
    stage.add_argument("--source", dest="source", default="manual")
    stage.add_argument("--request-id", dest="request_id")
    stage.add_argument("--commit", dest="commit_hash")
    stage.add_argument("--git-ref", dest="git_ref")
    stage.add_argument(
        "--allow-noncanonical-project",
        action="store_true",
        help="Explicitly allow staging from a clone workspace instead of the canonical root",
    )
    stage.set_defaults(handler=_command_controller_update_stage)

    show = controller_update_subparsers.add_parser("show", help="Show the staged controller update")
    show.set_defaults(handler=_command_controller_update_show)

    status = controller_update_subparsers.add_parser(
        "status",
        help="Show the staged update, apply-state, and current runtime identity",
    )
    status.set_defaults(handler=_command_controller_update_status)

    apply = controller_update_subparsers.add_parser("apply", help="Apply the staged controller update")
    apply.add_argument("--project", dest="project_path", help="Project path to restore after relaunch")
    apply.add_argument("--preview-url", dest="preview_url")
    apply.add_argument("--mode", dest="active_mode", choices=["live-editor", "screenshot"])
    apply.add_argument("--detach", action="store_true", help="Start the apply flow and return immediately")
    apply.add_argument("--show-ui", action="store_true", help="Open the detached updater window")
    apply.add_argument(
        "--no-shell-relaunch",
        action="store_true",
        help="Skip shell relaunch after the updated controller is online",
    )
    apply.set_defaults(handler=_command_controller_update_apply)

    clear = controller_update_subparsers.add_parser("clear", help="Clear the staged controller update")
    clear.set_defaults(handler=_command_controller_update_clear)

    clone = subparsers.add_parser(
        "clone",
        help="Promote and clean up clone-backed Agent Deck workspaces",
    )
    clone_subparsers = clone.add_subparsers(dest="clone_command", required=True)

    promote = clone_subparsers.add_parser(
        "promote",
        help="Merge a clone back into the canonical root and optionally commit/push/stage/apply",
    )
    promote.add_argument("session", help="Clone session title, id prefix, or path")
    promote.add_argument("--project", help="Canonical repo root (defaults to cwd resolved through .agents/)")
    promote.add_argument("--into", help="Target branch (defaults to current branch)")
    promote.add_argument("--commit", action="store_true", help="Commit the canonical root after merge")
    promote.add_argument("--message", help="Commit message when --commit is set")
    promote.add_argument("--push", action="store_true", help="Push the target branch to origin after merge")
    promote.add_argument("--stage", action="store_true", help="Stage a controller update from the canonical root")
    promote.add_argument("--apply", action="store_true", help="Stage and apply the controller update")
    promote.add_argument("--summary", help="Controller-update summary for --stage/--apply")
    promote.add_argument("--git-ref", dest="git_ref", help="Exact local git ref to stage/apply from")
    promote.add_argument("--show-ui", action="store_true", help="Open the updater UI when --apply is used")
    promote.add_argument(
        "--no-shell-relaunch",
        action="store_true",
        help="Skip shell relaunch after controller-update apply",
    )
    promote.add_argument("--keep-branch", action="store_true", help="Preserve the clone branch after finish")
    promote.add_argument("--force", action="store_true", help="Pass --force through to agent-deck clone finish")
    promote.set_defaults(handler=_command_clone_promote)

    return parser


def _rewrite_compatibility_aliases(argv: list[str]) -> list[str]:
    if not argv:
        return argv
    alias_map = {
        "stage-update": ["controller-update", "stage"],
        "show-update": ["controller-update", "show"],
        "clear-update": ["controller-update", "clear"],
        "apply-update": ["controller-update", "apply"],
        "update-status": ["controller-update", "status"],
        "promote-clone": ["clone", "promote"],
        "open-agent-deck-tui": ["agent-deck-tui", "open"],
        "open-agent-deck-surface": ["agent-deck-surface", "open"],
    }
    replacement = alias_map.get(argv[0])
    if replacement:
        return [*replacement, *argv[1:]]
    return argv


def main(argv: Sequence[str] | None = None) -> int:
    raw_argv = list(argv if argv is not None else sys.argv[1:])
    if raw_argv and raw_argv[0] in {"-h", "--help"}:
        parser = build_parser()
        parser.print_help()
        return 0

    normalized_argv = _rewrite_compatibility_aliases(raw_argv)
    parser = build_parser()
    if not normalized_argv:
        normalized_argv = ["start"]
    args = parser.parse_args(normalized_argv)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help()
        return 2
    return int(handler(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
