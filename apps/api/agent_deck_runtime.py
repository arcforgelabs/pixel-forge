from __future__ import annotations

import os
import shlex

from runtime_config import agent_deck_home_dir, shared_db_path, source_root
from state_root_migration import default_alpha_agent_deck_profile


DEFAULT_AGENT_DECK_PROFILE = default_alpha_agent_deck_profile()


def agent_deck_profile() -> str:
    explicit = (
        os.environ.get("PIXEL_FORGE_AGENT_DECK_PROFILE")
        or os.environ.get("AGENTDECK_PROFILE")
        or ""
    ).strip()
    return explicit or DEFAULT_AGENT_DECK_PROFILE


def agent_deck_command() -> list[str]:
    explicit = (os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD") or "").strip()
    if explicit:
        return shlex.split(explicit)

    runner = source_root() / "scripts" / "agent-deck-workstation-v2.sh"
    if runner.is_file():
        return [str(runner)]

    return ["agent-deck"]


def agent_deck_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("PIXEL_FORGE_AGENT_DECK_PROFILE", agent_deck_profile())
    env.setdefault("AGENTDECK_PROFILE", env["PIXEL_FORGE_AGENT_DECK_PROFILE"])
    env.setdefault("PIXEL_FORGE_DB_PATH", str(shared_db_path()))
    home_dir = str(agent_deck_home_dir())
    env.setdefault("PIXEL_FORGE_AGENT_DECK_HOME", home_dir)
    env.setdefault("AGENTDECK_DIR", home_dir)
    env.setdefault("AGENT_DECK_DIR", home_dir)
    return env
