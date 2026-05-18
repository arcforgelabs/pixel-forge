from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from agent_deck_runtime import agent_deck_command, agent_deck_env, agent_deck_profile
from memory_governance import agent_deck_governance_status
from runtime_config import (
    agent_deck_home_dir,
    agent_deck_surface_host,
    agent_deck_surface_port,
    agent_deck_surface_url,
    runtime_dir,
    shared_db_path,
    source_root,
)


def agent_deck_surface_pid_file() -> Path:
    return runtime_dir() / "agent-deck-surface.pid"


def agent_deck_surface_log_file() -> Path:
    return runtime_dir() / "agent-deck-surface.log"


def _read_pid() -> int | None:
    try:
        raw = agent_deck_surface_pid_file().read_text(encoding="utf-8").strip()
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
            agent_deck_surface_pid_file().unlink()
        except FileNotFoundError:
            pass


def _surface_health_url() -> str:
    return f"{agent_deck_surface_url().rstrip('/')}/healthz"


def _is_surface_ready(timeout_seconds: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(_surface_health_url(), timeout=timeout_seconds) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError, TimeoutError):
        return False


def _wait_until_surface_ready(timeout_seconds: float) -> bool:
    deadline = time.time() + max(0.5, timeout_seconds)
    while time.time() < deadline:
        if _is_surface_ready(timeout_seconds=1.0):
            return True
        time.sleep(0.25)
    return _is_surface_ready(timeout_seconds=1.0)


def _tail_log_excerpt(max_bytes: int = 4096) -> str | None:
    try:
        raw = agent_deck_surface_log_file().read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        return None
    excerpt = raw[-max_bytes:].decode("utf-8", errors="replace").strip()
    return excerpt or None


def _expose_local_status_paths() -> bool:
    return (os.environ.get("PIXEL_FORGE_EXPOSE_LOCAL_STATUS_PATHS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def read_agent_deck_surface_status() -> dict[str, Any]:
    _clear_stale_pid_file()
    pid = _read_pid()
    running = _is_pid_running(pid)
    ready = _is_surface_ready(timeout_seconds=1.0)
    running = running or ready
    status: dict[str, Any] = {
        "running": running,
        "ready": ready,
        "pid": pid if running else None,
        "url": agent_deck_surface_url(),
        "host": agent_deck_surface_host(),
        "port": agent_deck_surface_port(),
        "profile": agent_deck_profile(),
    }
    if _expose_local_status_paths():
        status["localPaths"] = {
            "homeDir": str(agent_deck_home_dir()),
            "dbPath": str(shared_db_path()),
            "logFile": str(agent_deck_surface_log_file()),
            "pidFile": str(agent_deck_surface_pid_file()),
        }
        status["governance"] = agent_deck_governance_status(agent_deck_home_dir())
    return status


def agent_deck_surface_command() -> list[str]:
    command = agent_deck_command()
    if not command:
        raise RuntimeError(
            "Agent Deck provider is disabled or no Agent Deck command is configured"
        )
    return [
        *command,
        "web-standalone",
        f"-listen={agent_deck_surface_host()}:{agent_deck_surface_port()}",
    ]


def _popen_process_kwargs() -> dict[str, Any]:
    if os.name != "nt":
        return {"start_new_session": True}

    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
    return {"creationflags": creationflags} if creationflags else {}


def ensure_agent_deck_surface_started(timeout_seconds: float = 15.0) -> dict[str, Any]:
    status = read_agent_deck_surface_status()
    if status["ready"]:
        return status
    if status["running"]:
        if _wait_until_surface_ready(timeout_seconds):
            return read_agent_deck_surface_status()
        raise RuntimeError(
            "Agent Deck surface process is running but never became ready. "
            f"See {agent_deck_surface_log_file()}"
        )

    env = agent_deck_env()
    env.setdefault("PIXEL_FORGE_DB_PATH", str(shared_db_path()))
    env.setdefault("PIXEL_FORGE_AGENT_DECK_SURFACE_HOST", agent_deck_surface_host())
    env.setdefault("PIXEL_FORGE_AGENT_DECK_SURFACE_PORT", str(agent_deck_surface_port()))
    env.setdefault("PIXEL_FORGE_AGENT_DECK_SURFACE_URL", agent_deck_surface_url())

    log_path = agent_deck_surface_log_file()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("ab") as handle:
        proc = subprocess.Popen(
            agent_deck_surface_command(),
            cwd=str(source_root()),
            env=env,
            stdout=handle,
            stderr=handle,
            **_popen_process_kwargs(),
        )

    agent_deck_surface_pid_file().write_text(f"{proc.pid}\n", encoding="utf-8")

    if _wait_until_surface_ready(timeout_seconds):
        return read_agent_deck_surface_status()

    if not _is_pid_running(proc.pid):
        excerpt = _tail_log_excerpt()
        detail = f" Last log output:\n{excerpt}" if excerpt else ""
        raise RuntimeError(
            "Agent Deck surface exited before it became ready. "
            f"See {log_path}.{detail}"
        )

    raise RuntimeError(
        "Agent Deck surface did not become ready before the timeout expired. "
        f"See {log_path}"
    )


def stop_agent_deck_surface(timeout_seconds: float = 5.0) -> dict[str, Any]:
    _clear_stale_pid_file()
    pid = _read_pid()
    if not pid:
        return read_agent_deck_surface_status()

    try:
        if os.name == "nt":
            os.kill(pid, signal.CTRL_BREAK_EVENT)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    except ValueError:
        if sys.platform == "win32":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T"],
                    capture_output=True,
                    check=False,
                    timeout=2,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass

    deadline = time.time() + max(0.5, timeout_seconds)
    while time.time() < deadline:
        if not _is_pid_running(pid):
            break
        time.sleep(0.1)

    if _is_pid_running(pid):
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    check=False,
                    timeout=2,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    try:
        agent_deck_surface_pid_file().unlink()
    except FileNotFoundError:
        pass

    return read_agent_deck_surface_status()
