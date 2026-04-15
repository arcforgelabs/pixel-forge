"""Read/write helpers for ~/.agent-deck/config.toml.

Surgical in-place edits to avoid rewriting the whole file — agent-deck is the
primary writer and we don't want to clobber fields we don't know about or
fight formatting quirks from the Go toml library.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from typing import Any

CONFIG_PATH = Path.home() / ".agent-deck" / "config.toml"


def _read() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open("rb") as f:
        return tomllib.load(f)


def get_claude_1m_settings() -> dict[str, bool]:
    """Return current Opus/Sonnet 1M toggles with their effective defaults."""
    data = _read()
    claude = data.get("claude", {}) if isinstance(data.get("claude"), dict) else {}
    return {
        "use_1m_context_opus": bool(claude.get("use_1m_context_opus", True)),
        "use_1m_context_sonnet": bool(claude.get("use_1m_context_sonnet", False)),
    }


_SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*$")


def _set_claude_key(text: str, key: str, value: bool) -> str:
    """Set `[claude].<key> = <value>` inside the TOML text, preserving format.

    Finds the [claude] section, scans until the next section header, replaces
    the key's value line if present, or inserts it just before the next
    section header (or at end of file). Values are emitted as `true`/`false`.
    """
    lines = text.splitlines(keepends=True)
    toml_value = "true" if value else "false"

    section_start = -1
    section_end = len(lines)
    for i, line in enumerate(lines):
        match = _SECTION_RE.match(line)
        if not match:
            continue
        name = match.group(1).strip()
        if section_start == -1 and name == "claude":
            section_start = i
            continue
        if section_start != -1:
            section_end = i
            break

    key_pattern = re.compile(rf"^(\s*){re.escape(key)}\s*=\s*(?:true|false)\s*$")

    if section_start == -1:
        # No [claude] section — append one.
        suffix = "" if text.endswith("\n") or text == "" else "\n"
        block = f"{suffix}\n[claude]\n  {key} = {toml_value}\n"
        return text + block

    # Look for an existing key line in the section body.
    for i in range(section_start + 1, section_end):
        m = key_pattern.match(lines[i].rstrip("\n"))
        if m:
            indent = m.group(1)
            newline = "\n" if lines[i].endswith("\n") else ""
            lines[i] = f"{indent}{key} = {toml_value}{newline}"
            return "".join(lines)

    # Not present — insert right before section_end (or before trailing blank
    # lines so the file stays tidy).
    insert_at = section_end
    while insert_at > section_start + 1 and lines[insert_at - 1].strip() == "":
        insert_at -= 1
    new_line = f"  {key} = {toml_value}\n"
    # Ensure previous line ends with newline.
    if insert_at > 0 and not lines[insert_at - 1].endswith("\n"):
        lines[insert_at - 1] = lines[insert_at - 1] + "\n"
    lines.insert(insert_at, new_line)
    return "".join(lines)


def set_claude_1m_settings(
    *, use_1m_context_opus: bool | None = None, use_1m_context_sonnet: bool | None = None
) -> dict[str, bool]:
    """Persist the given toggles. Unspecified keys are left alone."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = CONFIG_PATH.read_text() if CONFIG_PATH.exists() else ""

    if use_1m_context_opus is not None:
        text = _set_claude_key(text, "use_1m_context_opus", use_1m_context_opus)
    if use_1m_context_sonnet is not None:
        text = _set_claude_key(text, "use_1m_context_sonnet", use_1m_context_sonnet)

    CONFIG_PATH.write_text(text)
    return get_claude_1m_settings()
