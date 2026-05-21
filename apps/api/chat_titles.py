from __future__ import annotations

import re
from pathlib import Path


MAX_CHAT_TITLE_LENGTH = 56
_CHAT_ID_TITLE_RE = re.compile(r"^chat\s+chat-[0-9a-f]{3,}(?:[0-9a-f-]*)?$", re.IGNORECASE)
_THREAD_ID_RE = re.compile(r"^(?:chat|draft|thread)-[0-9a-f]{3,}(?:[0-9a-f-]*)?$", re.IGNORECASE)
_LEGACY_PIXEL_FORGE_RE = re.compile(r"^pixel-forge-[a-z0-9-]+-[0-9a-f]{3,}$", re.IGNORECASE)
_SPACE_RE = re.compile(r"\s+")


def project_display_name(project_path: str) -> str:
    name = Path(project_path).expanduser().name.strip()
    return name or "project"


def agent_display_name(agent_id: str | None) -> str:
    normalized = agent_id.strip().lower() if isinstance(agent_id, str) else ""
    names = {
        "claude": "Claude",
        "claude-cli": "Claude",
        "codex": "Codex",
        "codex-cli": "Codex",
        "gemini": "Gemini",
        "gemini-cli": "Gemini",
        "pi": "Pi",
        "pi-cli": "Pi",
        "openclaw": "OpenClaw",
        "openclaw-cli": "OpenClaw",
    }
    return names.get(normalized, normalized.replace("-", " ").title() if normalized else "Agent")


def default_chat_title(agent_id: str | None = None) -> str:
    del agent_id
    return "New chat"


def fallback_project_chat_title(project_path: str) -> str:
    return f"New {project_display_name(project_path)} chat"


def is_placeholder_chat_title(title: str | None, *, thread_id: str | None = None) -> bool:
    normalized = _normalize_title_text(title)
    if not normalized:
        return True
    normalized_lower = normalized.lower()
    normalized_thread = thread_id.strip().lower() if isinstance(thread_id, str) else ""
    if normalized_thread and normalized_lower in {
        normalized_thread,
        f"chat {normalized_thread}",
    }:
        return True
    if _CHAT_ID_TITLE_RE.fullmatch(normalized):
        return True
    if _THREAD_ID_RE.fullmatch(normalized):
        return True
    if _LEGACY_PIXEL_FORGE_RE.fullmatch(normalized):
        return True
    if normalized_lower.startswith("new ") and normalized_lower.endswith(" chat"):
        return True
    return False


def title_from_prompt(prompt: str | None) -> str | None:
    if not isinstance(prompt, str):
        return None
    for raw_line in prompt.splitlines():
        line = _normalize_title_text(raw_line)
        if not line:
            continue
        line = re.sub(r"^[#>*`\-\s]+", "", line).strip()
        line = re.sub(r"^/(?:ask|edit|fix|change|update|review)\s+", "", line, flags=re.IGNORECASE)
        line = _normalize_title_text(line)
        if not line:
            continue
        line = _trim_title(line)
        if line.islower() or (line[:1].islower() and line[1:] == line[1:].lower()):
            line = line[:1].upper() + line[1:]
        return line
    return None


def unique_chat_title(preferred_title: str, existing_titles: list[str | None]) -> str:
    preferred = _normalize_title_text(preferred_title) or "New chat"
    existing = {
        normalized.lower()
        for title in existing_titles
        if (normalized := _normalize_title_text(title))
    }
    if preferred.lower() not in existing:
        return preferred
    counter = 2
    while True:
        suffix = f" {counter}"
        base = preferred[: max(1, MAX_CHAT_TITLE_LENGTH - len(suffix))].rstrip()
        candidate = f"{base}{suffix}"
        if candidate.lower() not in existing:
            return candidate
        counter += 1


def _normalize_title_text(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = _SPACE_RE.sub(" ", value.strip())
    return normalized or None


def _trim_title(title: str) -> str:
    normalized = _normalize_title_text(title) or ""
    if len(normalized) <= MAX_CHAT_TITLE_LENGTH:
        return normalized
    trimmed = normalized[:MAX_CHAT_TITLE_LENGTH].rstrip()
    if " " in trimmed:
        trimmed = trimmed.rsplit(" ", 1)[0].rstrip()
    return trimmed or normalized[:MAX_CHAT_TITLE_LENGTH].rstrip()
