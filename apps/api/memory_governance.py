from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


GIB = 1024**3
MIB = 1024**2


@dataclass(frozen=True, slots=True)
class AgentDeckMemoryBudget:
    effective_memory_bytes: int
    reserve_bytes: int
    agent_pool_bytes: int
    memory_high_bytes: int
    memory_max_bytes: int
    memory_swap_max_bytes: int
    max_warm_sessions: int
    source: str


@dataclass(frozen=True, slots=True)
class AdmissionDecision:
    allowed: bool
    reason: str | None
    stop_idle_session_ids: tuple[str, ...]
    budget: AgentDeckMemoryBudget


_SIZE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?i?b?|bytes?)?\s*$", re.IGNORECASE)


def _falsy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"0", "false", "no", "off"}


def parse_size_bytes(value: str | int | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None

    text = str(value).strip()
    if not text or text == "max":
        return None
    match = _SIZE_RE.match(text)
    if not match:
        return None

    amount = float(match.group(1))
    unit = (match.group(2) or "").lower()
    multiplier = 1
    if unit in {"k", "kb", "kib"}:
        multiplier = 1024
    elif unit in {"m", "mb", "mib"}:
        multiplier = MIB
    elif unit in {"g", "gb", "gib"}:
        multiplier = GIB
    elif unit in {"t", "tb", "tib"}:
        multiplier = 1024 * GIB
    elif unit in {"p", "pb", "pib"}:
        multiplier = 1024 * 1024 * GIB
    return int(amount * multiplier)


def _read_int(path: Path) -> int | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return parse_size_bytes(raw)


def _memtotal_bytes(meminfo_path: Path = Path("/proc/meminfo")) -> int | None:
    try:
        lines = meminfo_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    for line in lines:
        if not line.startswith("MemTotal:"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            try:
                return int(parts[1]) * 1024
            except ValueError:
                return None
    return None


def _cgroup_memory_limit_bytes(cgroup_memory_max_path: Path = Path("/sys/fs/cgroup/memory.max")) -> int | None:
    limit = _read_int(cgroup_memory_max_path)
    if limit is None or limit <= 0:
        return None
    return limit


def effective_memory_bytes(
    *,
    cgroup_memory_max_path: Path = Path("/sys/fs/cgroup/memory.max"),
    meminfo_path: Path = Path("/proc/meminfo"),
) -> tuple[int, str]:
    env_override = parse_size_bytes(os.environ.get("PIXEL_FORGE_EFFECTIVE_RAM_BYTES"))
    if env_override:
        return env_override, "env"

    candidates: list[tuple[int, str]] = []
    cgroup_limit = _cgroup_memory_limit_bytes(cgroup_memory_max_path)
    if cgroup_limit:
        candidates.append((cgroup_limit, "cgroup"))
    memtotal = _memtotal_bytes(meminfo_path)
    if memtotal:
        candidates.append((memtotal, "meminfo"))

    if not candidates:
        return 8 * GIB, "fallback"

    value, source = min(candidates, key=lambda item: item[0])
    return value, source


def derive_agent_deck_memory_budget(effective_bytes: int | None = None) -> AgentDeckMemoryBudget:
    if effective_bytes is None:
        effective_bytes, source = effective_memory_bytes()
    else:
        source = "explicit"

    effective_bytes = max(int(effective_bytes), 2 * GIB)
    reserve_bytes = max(2 * GIB, effective_bytes // 5)
    pool_bytes = max(GIB, effective_bytes - reserve_bytes)

    high_default = max(2 * GIB, (pool_bytes * 75) // 100)
    max_default = max(high_default, (pool_bytes * 90) // 100)
    max_default = min(pool_bytes, max_default)
    high_default = min(high_default, max_default)
    swap_default = min(2 * GIB, max(512 * MIB, effective_bytes // 10))
    session_default = max(2, min(12, pool_bytes // (2 * GIB)))

    memory_high = parse_size_bytes(os.environ.get("PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH")) or high_default
    memory_max = parse_size_bytes(os.environ.get("PIXEL_FORGE_AGENT_DECK_MEMORY_MAX")) or max_default
    memory_swap_max = (
        parse_size_bytes(os.environ.get("PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX"))
        or swap_default
    )
    try:
        max_warm_sessions = int(
            os.environ.get("PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS")
            or session_default
        )
    except ValueError:
        max_warm_sessions = int(session_default)

    memory_max = max(memory_max, memory_high)
    return AgentDeckMemoryBudget(
        effective_memory_bytes=effective_bytes,
        reserve_bytes=reserve_bytes,
        agent_pool_bytes=pool_bytes,
        memory_high_bytes=memory_high,
        memory_max_bytes=memory_max,
        memory_swap_max_bytes=memory_swap_max,
        max_warm_sessions=max(1, max_warm_sessions),
        source=source,
    )


def agent_deck_tmux_tmpdir(agent_deck_home: Path) -> Path:
    override = (os.environ.get("PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR") or "").strip()
    return Path(override).expanduser() if override else agent_deck_home / "tmux"


def agent_deck_governance_env(agent_deck_home: Path) -> dict[str, str]:
    budget = derive_agent_deck_memory_budget()
    tmux_tmpdir = agent_deck_tmux_tmpdir(agent_deck_home)
    return {
        "PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR": str(tmux_tmpdir),
        "TMUX_TMPDIR": str(tmux_tmpdir),
        "PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH_BYTES": str(budget.memory_high_bytes),
        "PIXEL_FORGE_AGENT_DECK_MEMORY_MAX_BYTES": str(budget.memory_max_bytes),
        "PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX_BYTES": str(budget.memory_swap_max_bytes),
        "PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS": str(budget.max_warm_sessions),
    }


def agent_deck_governance_status(agent_deck_home: Path) -> dict[str, object]:
    budget = derive_agent_deck_memory_budget()
    return {
        "enabled": not _falsy(os.environ.get("PIXEL_FORGE_AGENT_DECK_GOVERNANCE")),
        "memoryScopeEnabled": not _falsy(os.environ.get("PIXEL_FORGE_AGENT_DECK_MEMORY_SCOPE")),
        "tmuxTmpdir": str(agent_deck_tmux_tmpdir(agent_deck_home)),
        "effectiveMemoryBytes": budget.effective_memory_bytes,
        "reserveBytes": budget.reserve_bytes,
        "agentPoolBytes": budget.agent_pool_bytes,
        "memoryHighBytes": budget.memory_high_bytes,
        "memoryMaxBytes": budget.memory_max_bytes,
        "memorySwapMaxBytes": budget.memory_swap_max_bytes,
        "maxWarmSessions": budget.max_warm_sessions,
        "source": budget.source,
    }


def _session_text(session: Mapping[str, object], key: str) -> str:
    value = session.get(key)
    return value.strip() if isinstance(value, str) else ""


def plan_agent_deck_launch_admission(
    sessions: Sequence[Mapping[str, object]],
    *,
    budget: AgentDeckMemoryBudget | None = None,
) -> AdmissionDecision:
    budget = budget or derive_agent_deck_memory_budget()
    if _falsy(os.environ.get("PIXEL_FORGE_AGENT_DECK_ADMISSION_CONTROL")):
        return AdmissionDecision(True, None, (), budget)

    active_statuses = {"running", "waiting", "starting"}
    inactive_statuses = {"stopped", "error"}
    warm_sessions: list[Mapping[str, object]] = []
    active_sessions: list[Mapping[str, object]] = []
    idle_sessions: list[Mapping[str, object]] = []

    for session in sessions:
        status = _session_text(session, "status").lower()
        if status in inactive_statuses:
            continue
        warm_sessions.append(session)
        if status in active_statuses or not status:
            active_sessions.append(session)
        elif status == "idle":
            idle_sessions.append(session)

    max_warm = max(1, budget.max_warm_sessions)
    needed_slots = len(warm_sessions) + 1 - max_warm
    stop_ids: list[str] = []
    if needed_slots > 0:
        idle_sessions = sorted(
            idle_sessions,
            key=lambda entry: (_session_text(entry, "created_at"), _session_text(entry, "id")),
        )
        for entry in idle_sessions[:needed_slots]:
            session_id = _session_text(entry, "id")
            if session_id:
                stop_ids.append(session_id)

    remaining_warm = len(warm_sessions) - len(stop_ids) + 1
    if remaining_warm > max_warm and len(active_sessions) >= max_warm:
        return AdmissionDecision(
            False,
            (
                "Agent Deck is at the Pixel Forge memory budget "
                f"({len(active_sessions)} active sessions, max {max_warm}). "
                "Stop or park an idle session before launching another."
            ),
            tuple(stop_ids),
            budget,
        )

    return AdmissionDecision(True, None, tuple(stop_ids), budget)
