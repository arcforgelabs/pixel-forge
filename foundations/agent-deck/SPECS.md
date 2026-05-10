# Agent Deck Fork Specs

## Intent

Agent Deck is the session control plane for multiple coding agents.  
This fork keeps Agent Deck as reliable execution rails while external orchestration intelligence lives in OpenClaw/Cato.

## Goals

1. Unified session management across tools in one CLI/TUI.
2. Strong Claude Code integration (MCP, hooks, fork/resume workflow).
3. Conductor path is transport-only: receive -> envelope -> forward -> relay.
4. Keep a clean seam for protocol-native ACP backends (`acpx` is the current reference fit) when structured headless control is materially useful.

## Requirement Review (2026-03-05)

Removed:
- Ambiguous, non-testable requirement language (example: "balance perfectly").

Changed:
- "Reliability over features" -> explicit guardrail/test gate requirement.
- "Legacy conductor must stay dumb" -> strict code-level prohibition on local conductor policy engines and compatibility wrappers.

Added:
- Runtime install independence requirement for OpenClaw (no repo-coupled runtime shim).
- Dead code policy for conductor scope (delete unused operator/convenience surfaces instead of preserving stubs).
- Layered local runtime requirement for Agent Deck fork installs (published lane + active wrapper).

## Requirement Review (2026-03-19)

Changed:
- Codex "yolo" config/docs now describe the real bypass flag instead of preserving a stale alias.
- Disabled conductor config now means "no conductor inventory" rather than surfacing stale conductor rows/groups.

Added:
- Isolation parity for reference clone sessions across create, persist, preview, finish, and delete flows.
- ACP delegation boundary for structured headless control paths.

## Hard Requirements (Repo-Enforceable)

R1. Agent-first operation:
- All critical workflows remain runnable headless through stable CLI paths.

R2. Conductor transport-only boundary:
- Agent Deck conductor runtime owns only transport plumbing.
- No local heartbeat triage, escalation lifecycle engine, parked ownership state machine, or conductor operator UX surface.
- No compatibility wrapper paths for removed conductor command modes.

R3. Single-path bridge runtime:
- Bridge is single-channel Telegram input only, wraps `[SIGNAL]` envelope, forwards to conductor target, relays response/error.
- No Slack or multi-platform/channel fan-out.

R4. No dormant conductor scaffolding:
- No dead runtime adapter package.
- No legacy bootstrap shell/plist surfaces.
- No detached ownership engine file.
- No heartbeat daemon/script generation layer in Agent Deck runtime source.

R5. Canonical policy ownership:
- OpenClaw workspace is policy brain.
- Agent Deck docs/templates are adapter context only and must not be treated as canonical decision source.

R6. Guardrail gate is mandatory:
- `go test ./internal/session ./internal/update ./cmd/agent-deck` must pass.
- `./resources/specs/audit-conductor-control-plane-minimal.sh` must pass.

R7. Dead-code default:
- If a conductor-side path is not required for active transport/bootstrap compatibility, remove it.

R8. Ownership handshake for heartbeat:
- Session ownership is explicit and persisted as `ownership: user|cato`.
- `agent-deck ... list --json` and `session show/current --json` expose:
  - `ownership` (string)
  - `managed` (bool; true only when `ownership=cato`)
- Heartbeat candidate lanes are `managed + waiting` only.
- `t` in TUI toggles ownership and must visibly indicate current owner.

R9. Layered local runtime install:
- Local fork installs publish into `~/.local/share/agent-deck/layers/<lane>/releases/<release-id>/`.
- `~/.local/bin/agent-deck` executes the active published runtime via `~/.local/share/agent-deck/layers/active/bin/agent-deck`.
- `~/.local/bin/agent-deck-stock` executes the published `upstream-stock` lane via an isolated sandbox home and tmux socket.
- Runtime asset sync into `~/.agent-deck/` must source from the active release, not directly from the repo checkout.
- Upstream stock baseline source lives in `~/repos/agent-deck-base-source`, not in the custom overlay repo.

R10. Sync and deploy are separate:
- Branch sync/rebase alone must not silently change the live runtime.
- `./dev-install.sh` publishes the `workstation` lane and activates it.
- `./scripts/fork-sync-publish.sh --custom-branch <branch>` is the canonical sync/test/publish/activate flow.
- `client-approved` promotion must reuse a published workstation release, not rebuild from an unrelated checkout.
- `agent-deck-layers sync-upstream-stock-source` plus `agent-deck-layers publish-upstream-stock` is the canonical stock baseline flow.

R11. ACP delegation boundary:
- Agent Deck must not grow an in-repo ACP runtime that owns ACP session persistence, queue ownership, or stream normalization.
- If structured headless control is added for ACP-capable tools, it must go through an external backend contract instead of PTY heuristics by default.
- Agent Deck may persist lightweight capability/config metadata for ACP-backed sessions, but the protocol/runtime source of truth stays outside this repo.

R12. Isolation parity:
- Sessions may run in the base repo, a git worktree, or a reference clone.
- Reference clone creation/removal must be available through both stable CLI paths and the TUI new-session flow.
- Session storage, preview, finish, and delete flows must preserve the correct isolation type instead of collapsing clones into generic worktrees.
- Reference clone names must remain single-directory `.agents/<name>` paths so list/cleanup semantics stay deterministic.

R13. Disabled conductor means absent inventory:
- When `[conductor].enabled = false`, stale conductor sessions/groups must be pruned from persisted inventory instead of resurfacing dead rows in TUI/CLI state.
- `required` and `auto_recover` defaults must evaluate to `false` when conductor is disabled.

## External Runtime Requirements (Not Fully Enforceable In This Repo)

E1. Proper OpenClaw runtime install:
- `openclaw` in `PATH` must resolve to an installed runtime, not a missing repo build path.

E2. Completion signal path:
- `openclaw system event ...` should succeed directly without manual fallback to `node <repo>/dist/entry.js`.

E3. Upgrade flow:
- Keep customizations on a dedicated branch.
- Canonical custom branch name is `custom/samuel-agent-deck`.
- Keep `main` as fast-forward mirror of `upstream/main`.
- Use `./scripts/fork-sync-publish.sh --custom-branch <branch>` as canonical sync/test/install flow.
- Use `--deploy-main` only when a local main-branch deployment merge is explicitly desired.

## Guardrail Sources

- Minimal conductor contract: `resources/specs/conductor-control-plane-minimal.v1.yaml`
- Regression audit runner: `resources/specs/audit-conductor-control-plane-minimal.sh`
- Operator checklist: `resources/specs/conductor-dumb-pass-through-checklist.md`

## Proof Status (2026-03-19)

Validated:
- Layered workstation publish/activate flow behind `~/.local/bin/agent-deck`.
- Reference clone sessions through CLI + TUI creation flows, including delete cleanup parity.
- Disabled-conductor inventory pruning at storage load.

Unvalidated:
- Pi restart semantics in longer-lived real usage beyond targeted tests.
- External ACP backend contract beyond the current research/architecture direction.

Question:
- How much of the remaining tool-specific PTY/tmux control should move behind external structured backends without weakening Agent Deck's operator UX?

## Current Limiting Factor (2026-03-19)

Structured headless control for ACP-capable tools is only a documented seam today. The runtime still depends on tmux/PTY heuristics and tool-specific adapters for most execution paths.
