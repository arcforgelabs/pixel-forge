from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
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
AGENT_DECK_HELP_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True, slots=True)
class _AgentDeckResolution:
    command: list[str]
    reason: str | None = None


def agent_deck_profile() -> str:
    explicit = (
        os.environ.get("PIXEL_FORGE_AGENT_DECK_PROFILE")
        or os.environ.get("AGENTDECK_PROFILE")
        or ""
    ).strip()
    return explicit or DEFAULT_AGENT_DECK_PROFILE


def _configured_command_exists(command: list[str], *, allow_missing: bool = False) -> bool:
    executable = command[0] if command else ""
    if not executable:
        return False
    return bool(
        shutil.which(executable)
        or Path(executable).expanduser().is_file()
        or allow_missing
    )


def _bundled_agent_deck_runner() -> Path:
    return source_root() / "scripts" / "agent-deck.sh"


def _bundled_agent_deck_binary_candidates() -> list[Path]:
    foundation_root = source_root() / "foundations" / "agent-deck"
    return [
        foundation_root / "build" / "agent-deck",
        foundation_root / "agent-deck",
    ]


def _bundled_agent_deck_commands() -> list[list[str]]:
    commands: list[list[str]] = []
    runner = _bundled_agent_deck_runner()
    if runner.is_file():
        commands.append([str(runner)])
    for binary_path in _bundled_agent_deck_binary_candidates():
        if binary_path.is_file():
            commands.append([str(binary_path)])
    return commands


@lru_cache(maxsize=32)
def _agent_deck_launch_help_supports_yolo(command: tuple[str, ...]) -> bool:
    env = dict(os.environ)
    for key in ("TMUX", "TMUX_PANE"):
        env.pop(key, None)
    try:
        result = subprocess.run(
            [*command, "launch", "--help"],
            check=False,
            capture_output=True,
            text=True,
            timeout=AGENT_DECK_HELP_TIMEOUT_SECONDS,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    output = f"{result.stdout}\n{result.stderr}"
    return "--yolo" in output


def _resolve_agent_deck_command(*, require_launch_yolo: bool = False) -> _AgentDeckResolution:
    if agent_deck_provider_mode() == "0":
        return _AgentDeckResolution([])

    mode = agent_deck_provider_mode()
    explicit = (os.environ.get("PIXEL_FORGE_AGENT_DECK_CMD") or "").strip()
    skipped_incompatible: list[str] = []
    missing_explicit: str | None = None
    candidates: list[list[str]] = []
    if explicit:
        explicit_args = shlex.split(explicit)
        if _configured_command_exists(explicit_args, allow_missing=mode == "1"):
            candidates.append(explicit_args)
        elif explicit_args:
            missing_explicit = explicit_args[0]

    standalone = shutil.which("agent-deck-standalone")
    if standalone:
        candidates.append([standalone])

    installed = shutil.which("agent-deck")
    if installed:
        candidates.append([installed])

    candidates.extend(_bundled_agent_deck_commands())

    for candidate in candidates:
        if require_launch_yolo and not _agent_deck_launch_help_supports_yolo(
            tuple(candidate)
        ):
            skipped_incompatible.append(" ".join(shlex.quote(part) for part in candidate))
            continue
        return _AgentDeckResolution(candidate)

    if skipped_incompatible:
        return _AgentDeckResolution(
            [],
            (
                "Agent Deck executable does not support the required "
                "`launch --yolo` contract: "
                + "; ".join(skipped_incompatible)
                + ". Update Agent Deck, use Pixel Forge's bundled Agent Deck runtime, "
                "or choose a direct provider such as codex-cli."
            ),
        )

    if missing_explicit:
        return _AgentDeckResolution(
            [],
            f"Agent Deck executable is missing: {missing_explicit}",
        )

    if require_launch_yolo:
        return _AgentDeckResolution(
            [],
            "No Agent Deck command with required `launch --yolo` support is configured",
        )

    return _AgentDeckResolution(["agent-deck"])


def agent_deck_command(*, require_launch_yolo: bool = False) -> list[str]:
    return _resolve_agent_deck_command(
        require_launch_yolo=require_launch_yolo
    ).command


def agent_deck_available(*, require_launch_yolo: bool = False) -> tuple[bool, str | None]:
    if not agent_deck_provider_enabled():
        return False, "Agent Deck provider is disabled by PIXEL_FORGE_WITH_AGENT_DECK=0"
    resolution = _resolve_agent_deck_command(require_launch_yolo=require_launch_yolo)
    command = resolution.command
    executable = command[0] if command else ""
    if not executable:
        return False, resolution.reason or "Agent Deck command is not configured"
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
    for key in ("TMUX", "TMUX_PANE", "npm_config_prefix", "NPM_CONFIG_PREFIX"):
        env.pop(key, None)
    return env
