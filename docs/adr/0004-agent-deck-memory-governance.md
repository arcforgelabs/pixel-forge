# ADR 0004: Agent Deck Memory Governance

## Status

Accepted.

## Context

Pixel Forge can keep several native Agent Deck sessions, browser previews, and helper processes warm at the same time. That is good for operator speed, but unbounded growth can push smaller laptops into swap death. The failure mode is outside the Python heap, so periodic forced GC or allocator trimming is the wrong primary control.

## Decision

Pixel Forge-owned Agent Deck sessions run under a machine-adaptive budget:

- Use OS boundaries first. On Linux with user systemd, `scripts/agent-deck.sh` starts Agent Deck inside `pixel-forge-agent-deck.slice` with `MemoryAccounting`, `MemoryHigh`, `MemoryMax`, and `MemorySwapMax`.
- Derive the budget from the real effective limit: `min(cgroup memory.max, /proc/meminfo MemTotal)`.
- Reserve desktop/controller headroom: `max(2 GiB, 20% of effective RAM)`.
- Keep Agent Deck on an isolated Pixel Forge tmux socket by setting `TMUX_TMPDIR=<agent-deck-home>/tmux` and stripping inherited `TMUX` / `TMUX_PANE`.
- Apply admission control before new Pixel Forge-created Agent Deck launches. If the warm-session budget is full, Pixel Forge parks the stalest idle session first; if active sessions fill the budget, launch fails with a clear memory-budget error.
- Surface per-session RSS, swap, and process count in Agent Deck JSON and Pixel Forge session-target metadata.

## Defaults

- `MemoryHigh`: 75% of the Agent Deck pool, with a 2 GiB floor.
- `MemoryMax`: 90% of the Agent Deck pool, capped to that pool.
- `MemorySwapMax`: 10% of effective RAM, clamped to 512 MiB-2 GiB.
- Warm session cap: `floor(agent_pool / 2 GiB)`, clamped to 2-12.

## Tuning

- `PIXEL_FORGE_EFFECTIVE_RAM_BYTES`
- `PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH`
- `PIXEL_FORGE_AGENT_DECK_MEMORY_MAX`
- `PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX`
- `PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS`
- `PIXEL_FORGE_AGENT_DECK_MEMORY_SCOPE=0`
- `PIXEL_FORGE_AGENT_DECK_ADMISSION_CONTROL=0`

## Consequences

Active sessions stay fast until the explicit pool budget is reached. Idle sessions are the first reclaim target. On systems without user systemd, Pixel Forge still gets tmux/socket isolation and admission control, but not kernel-enforced memory ceilings.
