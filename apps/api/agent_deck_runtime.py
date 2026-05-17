from __future__ import annotations

import os
import shlex
import shutil
from pathlib import Path

from memory_governance import agent_deck_governance_env
from runtime_config import (
    agent_deck_home_dir,
    agent_deck_provider_enabled,
    agent_deck_provider_mode,
    shared_db_path,
    source_root,
)
from state_root_migration import default_agent_deck_profile


DEFAULT_AGENT_DECK_PROFILE = default_agent_deck_profile()


def agent_deck_profile() -> str:
    explicit = (
        os.environ.get("PIXEL_FORGE_AGENT_DECK_PROFILE")
        or os.environ.get("AGENTDECK_PROFILE")
        or ""
    ).strip()
    return explicit or DEFAULT_AGENT_DECK_PROFILE


def agent_deck_command() -> list[str]:
    if agent_deck_provider_mode() == "0":
        return []

    explicit = (os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD") or "").strip()
    if explicit:
        explicit_args = shlex.split(explicit)
        executable = explicit_args[0] if explicit_args else ""
        if executable and (
            shutil.which(executable)
            or Path(executable).expanduser().is_file()
            or agent_deck_provider_mode() == "1"
        ):
            return explicit_args

    standalone = shutil.which("agent-deck-standalone")
    if standalone:
        return [standalone]

    installed = shutil.which("agent-deck")
    if installed:
        return [installed]

    runner = source_root() / "scripts" / "agent-deck.sh"
    if runner.is_file():
        return [str(runner)]

    return ["agent-deck"]


def agent_deck_available() -> tuple[bool, str | None]:
    if not agent_deck_provider_enabled():
        return False, "Agent Deck provider is disabled by PIXEL_FORGE_WITH_AGENT_DECK=0"
    command = agent_deck_command()
    executable = command[0] if command else ""
    if not executable:
        return False, "Agent Deck command is not configured"
    if Path(executable).is_absolute() or "/" in executable:
        if Path(executable).expanduser().is_file():
            return True, None
        return False, f"Agent Deck executable is missing: {executable}"
    if shutil.which(executable):
        return True, None
    return False, f"Agent Deck executable is not on PATH: {executable}"


def agent_deck_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("PIXEL_FORGE_AGENT_DECK_PROFILE", agent_deck_profile())
    env.setdefault("AGENTDECK_PROFILE", env["PIXEL_FORGE_AGENT_DECK_PROFILE"])
    env.setdefault("PIXEL_FORGE_DB_PATH", str(shared_db_path()))
    home_dir = str(agent_deck_home_dir())
    env.setdefault("PIXEL_FORGE_AGENT_DECK_HOME", home_dir)
    if (os.environ.get("PIXEL_FORGE_AGENT_DECK_HOME") or "").strip():
        env["AGENTDECK_DIR"] = home_dir
        env["AGENT_DECK_DIR"] = home_dir
    else:
        env.setdefault("AGENTDECK_DIR", home_dir)
        env.setdefault("AGENT_DECK_DIR", home_dir)
    env.update(agent_deck_governance_env(Path(home_dir)))
    for key in ("TMUX", "TMUX_PANE"):
        env.pop(key, None)
    return env
