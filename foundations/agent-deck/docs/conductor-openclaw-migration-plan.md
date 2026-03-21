# Conductor OpenClaw Control-Plane Migration Plan

Date: 2026-03-03
Owner: Agent Deck Conductor lane
Status: Phase 0 stabilized, Phase 1 implemented (dedicated OpenClaw agent bootstrap)

## Why this exists

The conductor must run as a first-class OpenClaw-backed control-plane agent, not as a generic shell/Claude session. The current architecture had drifted into stale tmux sessions, stale wrappers, and OpenClaw profile isolation without gateway auth.

This plan is structured so another agent can resume at any phase without rediscovery.

## Findings from OpenClaw runtime/docs

1. `openclaw tui` does not accept Claude flags like `--model` or `--dangerously-skip-permissions`.
2. Running conductor with `--profile agentdeck-conductor-*` creates isolated state under `~/.openclaw-<profile>`.
3. Those isolated profile dirs were not bootstrapped with gateway auth/config, causing `gateway token missing` and failed starts.
4. The working route today is using the primary OpenClaw state at `~/.openclaw` plus a dedicated session key:
   - `openclaw tui --session agent:<agent-id>:conductor-<name>`

## Current stabilization implemented (Phase 0)

1. Conductor OpenClaw runtime now defaults to `~/.openclaw` context (no forced isolated profile).
2. Legacy runtime commands are migrated away from `--profile agentdeck-conductor-*`.
3. Historical bad command contamination (`--model`, `--dangerously-skip-permissions`) is auto-normalized for OpenClaw runtime.
4. Conductor control-plane normalization now clears stale per-session `Wrapper` values.
5. Conductor bootstrap can prune duplicate stale conductor tmux sessions by `AGENTDECK_INSTANCE_ID`.
6. Auto-recovery uses direct `tmux has-session` checks to avoid stale cache false-positives.
7. `session restart` now reapplies conductor control-plane shape before restart.

## Target architecture (Phase 1-3)

### Phase 1: Dedicated OpenClaw conductor agent

1. Create OpenClaw agent id `conductor` (or chosen fixed id) via `openclaw agents add`.
2. Create dedicated workspace `~/.openclaw/workspace-conductor`.
3. Install conductor identity pack there:
   - `SOUL.md`
   - `IDENTITY.md`
   - `MEMORY.md`
   - `TOOLS.md`
   - optional skill overlays specific to operations management.
4. Route Agent Deck conductor session key to:
   - `agent:conductor:conductor-ops` (or `agent:conductor:main` if simplified).
5. Keep fallback env override for test routing:
   - `AGENT_DECK_CONDUCTOR_OPENCLAW_AGENT=main` (current Arc test mode).

Acceptance criteria:

1. `agent-deck session show conductor-ops` reports `tool=openclaw` and conductor command with no Claude flags.
2. `openclaw tui` header shows agent `conductor` and session `conductor-ops`.
3. Conductor receives/handles Agent Deck event signals without dropping to shell.

Implementation notes (completed):

1. Default OpenClaw conductor routing now targets `agent:conductor:conductor-<name>`.
2. Legacy `agent:main:conductor-*` runtime commands are auto-migrated unless `AGENT_DECK_CONDUCTOR_OPENCLAW_AGENT` is explicitly set.
3. Agent Deck now bootstraps a dedicated OpenClaw conductor agent (`conductor`) on setup/ensure/reconfigure/runtime-cycle paths.
4. OpenClaw workspace seeding is automated at `~/.openclaw/workspace-conductor` with conductor-specific `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, and support files.
5. Agent identity is set to `Cato` (`🧭`) during bootstrap when missing or still generic.
6. New-agent bootstrap does not pin provider/model/fallbacks; those remain OpenClaw operator settings.
7. Existing conductor agent model/provider settings are operator-owned and not mutated by Agent Deck at any point.
8. New-agent bootstrap sets a heartbeat default (`1h`) for conductor wakeups.

### Phase 2: Agent Deck runtime hardening

1. Add explicit `openclaw` built-in handling paths in start/restart decision logic (parallel to claude/gemini/codex/opencode), so behavior is not dependent on generic/shell fallback.
2. Persist and enforce one tmux session per `Instance.ID` invariant.
3. Add startup janitor for stale `agentdeck_conductor-*` tmux sessions not referenced in DB.
4. Add a deterministic conductor health check command:
   - verifies tmux pane process is `openclaw`
   - verifies gateway connectivity
   - verifies signal ingestion.

Acceptance criteria:

1. No duplicate conductor tmux sessions after repeated restarts.
2. `session restart conductor-ops` is idempotent and does not mutate command/wrapper unexpectedly.
3. Health check returns machine-readable pass/fail.

### Phase 3: UI and product semantics

1. Keep conductor as a protected singleton control-plane row.
2. Use dedicated styling and controls distinct from normal sessions.
3. Expose runtime swap only during transition period; remove once OpenClaw runtime is locked.
4. Add explicit action to restart/reseed conductor without delete semantics.

Acceptance criteria:

1. Conductor cannot be deleted from normal delete flow.
2. Runtime swap (if enabled) performs clean terminate + relaunch and keeps identity/state.
3. When locked, conductor runtime is always OpenClaw and not user-switchable.

## Open questions before Phase 1 execution

1. Fixed agent id: `conductor` vs `ops`?
2. Should conductor use Arc model defaults or a dedicated model policy?
3. Should conductor use the same OpenClaw workspace skill set as Arc/Sentinel, or a strict minimal ops set?
4. Should Agent Deck auto-provision the OpenClaw agent if missing, or fail with a deterministic actionable error?

## Safe rollback

1. Reconfigure conductor runtime to `claude` via `agent-deck conductor reconfigure ops -runtime claude`.
2. Keep control-plane path/group protections intact.
3. No state migration is destructive; runtime metadata can be switched back at any time.

## Handoff checklist for next agent

1. Verify current live state:
   - `agent-deck session show conductor-ops`
   - `agent-deck ls --json`
   - `tmux list-sessions | rg conductor-ops`
2. Confirm no stale wrapper on conductor instance.
3. Implement Phase 1 agent provisioning and session routing.
4. Add integration tests for OpenClaw conductor restart/health.
5. Publish the workstation runtime with `./dev-install.sh` and validate in TUI + CLI.
