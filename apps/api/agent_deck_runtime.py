from __future__ import annotations

import os
import shlex
from pathlib import Path

from runtime_config import source_root


DEFAULT_AGENT_DECK_PROFILE = "workstation-v2"


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
    return env
