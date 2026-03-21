#!/usr/bin/env python3
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
