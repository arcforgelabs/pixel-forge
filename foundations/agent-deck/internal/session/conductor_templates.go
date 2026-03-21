package session

// conductorSharedClaudeMDTemplate is the shared CLAUDE.md written to ~/.agent-deck/conductor/CLAUDE.md.
// It is intentionally adapter-only and must never define conductor policy logic.
const conductorSharedClaudeMDTemplate = `# Conductor Adapter (Agent Deck)

Agent Deck is transport plumbing only.
Canonical conductor policy and heartbeat logic live in OpenClaw workspace files.

## Relay Contract

1. Receive inbound Telegram text.
2. Wrap with [SIGNAL] JSON envelope metadata.
3. Forward to one conductor session via agent-deck CLI.
4. Relay raw response text or delivery error.

## Minimal CLI Reference

- agent-deck -p <PROFILE> status --json
- agent-deck -p <PROFILE> list --json
- agent-deck -p <PROFILE> session show --json <id_or_title>
- agent-deck -p <PROFILE> session output <id_or_title> -q
- agent-deck -p <PROFILE> session send <id_or_title> "<message>" --wait -q --timeout 300s
- agent-deck -p <PROFILE> session restart <id_or_title>

## Boundary

Do not store or define heartbeat triage, escalation lifecycle, or parked ownership policy in this directory.
Those rules are canonical in ~/.openclaw/workspace-conductor/.
`

// conductorLearningsTemplate is a non-authoritative local notes file.
// It is retained only as a lightweight adapter note surface.
const conductorLearningsTemplate = `# Conductor Adapter Notes

This file is optional local notes for adapter runtime context.
Canonical policy and heartbeat decision logic are owned by OpenClaw.

Authoritative source: ~/.openclaw/workspace-conductor/
`

// conductorSoulTemplate is a placeholder pointer to canonical OpenClaw identity.
const conductorSoulTemplate = `# Adapter Identity Stub

This file is not the canonical identity source for Cato.
Use ~/.openclaw/workspace-conductor/IDENTITY.md and SOUL.md as authority.
`

// conductorKnowledgeTemplate is a placeholder pointer to canonical OpenClaw knowledge.
const conductorKnowledgeTemplate = `# Adapter Knowledge Stub

Agent Deck does not own conductor operating knowledge.
Use ~/.openclaw/workspace-conductor/ for canonical policy, heartbeat, and triage behavior.
`

// conductorOpenClawWorkspaceAgentsTemplate seeds ~/.openclaw/workspace-conductor/AGENTS.md.
// It is purpose-built for the dedicated conductor OpenClaw agent.
const conductorOpenClawWorkspaceAgentsTemplate = `# AGENTS.md - Conductor Workspace

This workspace is the canonical control-plane home for Cato.
Agent Deck is execution rails only and does not own heartbeat or triage policy.

Use local workspace files here as the source of truth for operational behavior.
`

const conductorOpenClawWorkspaceIdentityTemplate = `# IDENTITY.md

- **Code Name:** Conductor
- **Name:** Cato
- **Role:** Operations conductor (round-table operator)
- **Emoji:** 🧭
- **Vibe:** organized, decisive, truth-seeking

## Name Evolution

Previously named Conductor during bootstrap. Renamed to Cato by Samuel.
`

const conductorOpenClawWorkspaceSoulTemplate = `# SOUL.md

Canonical identity file for Cato in OpenClaw workspace.
Keep behavioral authority in this workspace, not in Agent Deck templates.
`

const conductorOpenClawWorkspaceUserTemplate = `# USER.md

- **Primary user:** Samuel
- **Preferred style:** concise, direct, decision-first
- **Priority:** keep the work moving without unnecessary escalations
`

const conductorOpenClawWorkspaceToolsTemplate = `# TOOLS.md

## Core Commands

- ` + "`" + `agent-deck -p default status --json` + "`" + `
- ` + "`" + `agent-deck -p default list --json` + "`" + `
- ` + "`" + `agent-deck -p default session show --json <session>` + "`" + `
- ` + "`" + `agent-deck -p default session output <session> -q` + "`" + `
- ` + "`" + `agent-deck -p default session send <session> \"<message>\"` + "`" + `
- ` + "`" + `agent-deck -p default session restart <session>` + "`" + `
`

const conductorOpenClawWorkspaceHeartbeatTemplate = `Canonical heartbeat policy is defined in this OpenClaw workspace.
Use AUTO/PARK/NEED + HEARTBEAT_OK rules from OpenClaw policy files only.
Treat candidate lanes as managed+waiting only (` + "`" + `managed=true` + "`" + ` / ` + "`" + `ownership=\"cato\"` + "`" + ` from ` + "`" + `agent-deck -p default list --json` + "`" + `).
For Cato-owned waiting lanes: keep the project moving (answer pending questions, clear reversible blockers) within boundaries.
Boundary: act directly only when reversible and inside explicit user intent; otherwise PARK or NEED.
Do not source heartbeat behavior from ~/.agent-deck/conductor/.
`

const conductorOpenClawWorkspaceMemoryTemplate = `# MEMORY.md

Long-term Cato operating notes.
This file lives in the canonical OpenClaw workspace.
`

// conductorPolicyTemplate is a non-authoritative stub retained for compatibility with existing file layout.
const conductorPolicyTemplate = `# Agent Deck Policy Stub

Agent Deck is not the policy source for conductor behavior.
Canonical policy location: ~/.openclaw/workspace-conductor/
`

// conductorPerNameClaudeMDTemplate is the per-conductor CLAUDE.md written to ~/.agent-deck/conductor/<name>/CLAUDE.md.
// It contains only the conductor's identity. Shared knowledge is inherited from the parent directory's CLAUDE.md.
// {NAME} and {PROFILE} placeholders are replaced at setup time.
const conductorPerNameClaudeMDTemplate = `# Conductor: {NAME} ({PROFILE} profile)

You are **{NAME}**, a conductor for the **{PROFILE}** profile.

## Adapter Contract

- Session title: conductor-{NAME}
- Scope: profile {PROFILE}
- Use agent-deck -p {PROFILE} for session commands.
- Bridge sends [SIGNAL] envelopes and relays your response.

## Source Of Truth

Agent Deck files in ~/.agent-deck/conductor/{NAME}/ are adapter-local context only.
Canonical policy and heartbeat logic live in ~/.openclaw/workspace-conductor/.
`

// conductorPerNameClaudeMDPreLearningsTemplate is the post-policy-split but pre-learnings per-conductor CLAUDE.md template.
// It is kept only for migration matching and should not be used for new writes.
const conductorPerNameClaudeMDPreLearningsTemplate = `# Conductor: {NAME} ({PROFILE} profile)

You are **{NAME}**, a conductor for the **{PROFILE}** profile.

Adapter-only placeholder template.
`

// conductorPerNameClaudeMDLegacyTemplate is the pre-policy-split per-conductor CLAUDE.md template.
// It is kept only for migration matching and should not be used for new writes.
const conductorPerNameClaudeMDLegacyTemplate = `# Conductor: {NAME} ({PROFILE} profile)

You are **{NAME}**, a conductor for the **{PROFILE}** profile.

Legacy adapter placeholder template.
`

// conductorBridgePy is the Python bridge script that connects Telegram to conductor sessions.
// This embedded template is intentionally transport-only and single-path.
const conductorBridgePy = `#!/usr/bin/env python3
"""
Conductor Bridge: Telegram -> Agent-Deck conductor session (transport-only).

Minimal relay contract:
  1) receive Telegram text signal
  2) wrap signal envelope
  3) forward to conductor session via agent-deck CLI
  4) relay raw response or delivery error back to Telegram

No local orchestration UX/state machine exists here.
"""

import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import toml
from aiogram import Bot, Dispatcher, types
from aiogram.filters import CommandStart


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def resolve_agent_deck_dir() -> Path:
    for key in ("AGENTDECK_DIR", "AGENT_DECK_DIR", "PIXEL_FORGE_AGENT_DECK_HOME"):
        value = os.environ.get(key, "").strip()
        if value:
            return Path(value).expanduser()
    return Path.home() / ".agent-deck"


AGENT_DECK_DIR = resolve_agent_deck_dir()
CONFIG_PATH = AGENT_DECK_DIR / "config.toml"
CONDUCTOR_DIR = AGENT_DECK_DIR / "conductor"
LOG_PATH = CONDUCTOR_DIR / "bridge.log"
CONDUCTOR_DIR.mkdir(parents=True, exist_ok=True)

TG_MAX_LENGTH = 4096
RESPONSE_TIMEOUT = 300
ALLOWED_SIGNAL_SOURCES = {"user.telegram"}


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("conductor-bridge")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def split_message(text: str, max_len: int = TG_MAX_LENGTH) -> list[str]:
    if len(text) <= max_len:
        return [text]

    chunks = []
    remaining = text
    while remaining:
        if len(remaining) <= max_len:
            chunks.append(remaining)
            break
        split_at = remaining.rfind("\n", 0, max_len)
        if split_at <= 0:
            split_at = max_len
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip("\n")
    return chunks


def run_cli(*args: str, profile: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
    cmd = ["agent-deck"]
    if profile:
        cmd += ["-p", profile]
    cmd += list(args)
    log.debug("CLI: %s", " ".join(cmd))
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 1, "", "timeout")
    except FileNotFoundError:
        return subprocess.CompletedProcess(cmd, 1, "", "agent-deck not found")


# ---------------------------------------------------------------------------
# Config + conductor discovery
# ---------------------------------------------------------------------------


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        log.error("Config not found: %s", CONFIG_PATH)
        sys.exit(1)

    config = toml.load(CONFIG_PATH)
    conductor_cfg = config.get("conductor", {})
    if not conductor_cfg.get("enabled", False):
        log.error("[conductor] section missing or not enabled in config.toml")
        sys.exit(1)

    tg = conductor_cfg.get("telegram", {})
    token = str(tg.get("token", "") or "").strip()
    user_id = int(tg.get("user_id", 0) or 0)
    if not token or not user_id:
        log.error("conductor.telegram.token and conductor.telegram.user_id are required")
        sys.exit(1)

    default_name = str(conductor_cfg.get("default_name", "ops") or "ops").strip() or "ops"
    return {
        "telegram_token": token,
        "telegram_user_id": user_id,
        "default_name": default_name,
    }


def discover_conductors() -> list[dict]:
    conductors = []
    if not CONDUCTOR_DIR.exists():
        return conductors

    for entry in CONDUCTOR_DIR.iterdir():
        if not entry.is_dir():
            continue
        meta_path = entry / "meta.json"
        if not meta_path.exists():
            continue
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
            if not isinstance(meta, dict):
                continue
            meta["name"] = str(meta.get("name") or entry.name).strip()
            meta["profile"] = str(meta.get("profile") or "default").strip() or "default"
            if meta["name"]:
                conductors.append(meta)
        except Exception as err:
            log.warning("Failed to read %s: %s", meta_path, err)

    conductors.sort(key=lambda c: (str(c.get("created_at") or ""), str(c.get("name") or "")))
    return conductors


def resolve_target_conductor(default_name: str) -> dict | None:
    conductors = discover_conductors()
    if not conductors:
        return None
    for meta in conductors:
        if str(meta.get("name") or "") == default_name:
            return meta
    return conductors[0]


def conductor_session_title(name: str) -> str:
    return f"conductor-{name}"


def get_session_status(session: str, profile: str) -> str:
    result = run_cli("session", "show", session, "--json", profile=profile, timeout=30)
    if result.returncode != 0:
        return "error"
    try:
        payload = json.loads(result.stdout)
        return str(payload.get("status", "error"))
    except Exception:
        return "error"


def ensure_conductor_running(name: str, profile: str) -> bool:
    session_title = conductor_session_title(name)
    if get_session_status(session_title, profile) != "error":
        return True

    result = run_cli("session", "start", session_title, profile=profile, timeout=60)
    if result.returncode != 0:
        log.error("Failed to start conductor %s: %s", name, result.stderr.strip())
        return False

    time.sleep(2)
    return get_session_status(session_title, profile) != "error"


# ---------------------------------------------------------------------------
# Transport relay
# ---------------------------------------------------------------------------


def make_idempotency_key(source: str, target: str, body: str) -> str:
    digest = hashlib.sha1(body.strip().encode("utf-8")).hexdigest()[:12]
    return f"relay-{source}-{target}-{int(time.time())}-{digest}"


def build_signal_payload(body: str, source: str, conductor_name: str, profile: str) -> tuple[str, dict]:
    envelope = {
        "version": 1,
        "type": "user_message",
        "source": source,
        "idempotency_key": make_idempotency_key(source, conductor_name, body),
        "profile": profile,
        "session": conductor_name,
        "ts": utc_now_iso(),
        "actor": "agent-deck.bridge",
        "action": "relay",
        "reason": "user_signal_forward",
        "target": f"conductor:{conductor_name}",
    }
    return f"[SIGNAL] {json.dumps(envelope, sort_keys=True)}\n{body}", envelope


def send_to_conductor(session: str, message: str, profile: str, conductor_name: str, source: str) -> tuple[bool, str]:
    if source not in ALLOWED_SIGNAL_SOURCES:
        return False, f"unsupported_signal_source:{source}"

    signal_payload, _ = build_signal_payload(message, source, conductor_name, profile)
    result = run_cli(
        "session",
        "send",
        session,
        signal_payload,
        "--wait",
        "--timeout",
        f"{RESPONSE_TIMEOUT}s",
        "-q",
        profile=profile,
        timeout=max(RESPONSE_TIMEOUT + 30, 60),
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "send_failed"
        return False, detail
    return True, result.stdout.strip()


def relay_user_text(config: dict, text: str) -> tuple[bool, str]:
    target = resolve_target_conductor(config["default_name"])
    if target is None:
        return False, "No conductors found."

    name = str(target.get("name") or "").strip()
    profile = str(target.get("profile") or "default").strip() or "default"
    if not name:
        return False, "Target conductor metadata is invalid."

    if not ensure_conductor_running(name, profile):
        return False, f"Conductor {name} is not running."

    ok, response = send_to_conductor(
        session=conductor_session_title(name),
        message=text,
        profile=profile,
        conductor_name=name,
        source="user.telegram",
    )
    if not ok:
        return False, f"Delivery failed: {response}"
    if not response.strip():
        return True, "[No response from conductor]"
    return True, response


# ---------------------------------------------------------------------------
# Telegram bridge
# ---------------------------------------------------------------------------


def create_bot(config: dict) -> tuple[Bot, Dispatcher]:
    bot = Bot(token=config["telegram_token"])
    dp = Dispatcher()
    authorized_user = int(config["telegram_user_id"])

    def is_authorized(message: types.Message) -> bool:
        if not message.from_user:
            return False
        if int(message.from_user.id) != authorized_user:
            log.warning("Unauthorized Telegram message from user %s", message.from_user.id)
            return False
        return True

    @dp.message(CommandStart())
    async def cmd_start(message: types.Message):
        if not is_authorized(message):
            return
        target = resolve_target_conductor(config["default_name"])
        target_name = str(target.get("name") or "none") if target else "none"
        await message.answer(
            "Conductor relay active (transport-only).\n"
            f"Default target: {target_name}\n"
            "Send any text to relay it to the conductor."
        )

    @dp.message()
    async def handle_message(message: types.Message):
        if not is_authorized(message):
            return
        text = (message.text or "").strip()
        if not text:
            return

        ok, response = relay_user_text(config, text)
        if not ok:
            await message.answer(response)
            return

        for chunk in split_message(response):
            await message.answer(chunk)

    return bot, dp


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def run_bridge_daemon():
    config = load_config()
    log.info(
        "Starting conductor bridge (transport-only, platform=Telegram, default_name=%s)",
        config["default_name"],
    )

    bot, dp = create_bot(config)
    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_bridge_daemon())

`
