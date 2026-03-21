# Agent Deck Fork Architecture

Status: current-state architecture plus target direction for the custom fork.

## Intent Link

Agent Deck is the execution rail and session control plane.  
OpenClaw/Cato own higher-level orchestration and policy.  
This repo should stay strong at session lifecycle, isolation, operator UX, and transport glue without growing into a second orchestration brain.

## Current Architecture

### Published runtime (`validated`)

- Development happens in the repo checkout.
- Live usage runs from a published layered runtime, not directly from the checkout.
- `./dev-install.sh` builds the repo, publishes a `workstation` release under `~/.local/share/agent-deck/layers/`, and activates it behind `~/.local/bin/agent-deck`.
- Runtime assets synced into `~/.agent-deck/` come from the active release.

Why:
- keeps sync/deploy separate
- allows side-by-side upstream stock runtime
- makes the live wrapper reflect an explicit publish step

### Session control plane (`validated`)

- CLI and Bubble Tea TUI both operate on the same session model.
- Session state is persisted per profile in `~/.agent-deck/profiles/<profile>/state.db`.
- Runtime execution is still tmux-first for interactive agents.
- Persisted session metadata includes:
  - tool/command/wrapper
  - group and ownership
  - sandbox/remote metadata
  - tool-specific options
  - isolation metadata (`worktree` vs `clone`)

Why:
- one operational truth for TUI + CLI
- headless-safe control paths
- restart/recovery can happen without rediscovery

### Tool adapter layer (`validated`, with some paths still heuristic)

Built-in adapter paths currently include:
- `claude`
- `gemini`
- `codex`
- `opencode`
- `pi`
- `openclaw`
- generic shell/custom tools

The adapter layer owns:
- command construction
- restart behavior
- tool-specific defaults from config
- session ID detection where available

Current noteworthy adapter truths:
- Codex "yolo" maps to `--dangerously-bypass-approvals-and-sandbox`, not a legacy `--yolo` alias.
- Pi now has an explicit adapter path with configured defaults and restart via `--continue`, instead of falling through generic shell behavior.

Why:
- interactive tools do not share a uniform CLI/resume contract
- Agent Deck still needs deterministic operator behavior while structured backends remain external

### Workspace isolation (`validated`)

Supported execution shapes:
- base repo / no isolation
- git worktree
- reference clone

Reference clone behavior:
- clone root lives at `.agents/<name>/`
- clone branch is `agent/<name>`
- isolation type is persisted explicitly
- delete/finish flows now clean up the correct workspace type

Why:
- worktrees are fast but still share `.git`
- reference clones provide stronger git/process isolation without abandoning local repo locality

### Conductor lane (`validated` for current fork boundary)

- conductor is transport-only in this repo
- no local policy engine, parked ownership state machine, or operator workflow brain
- conductor runtime is OpenClaw-backed
- when conductor is disabled in config, stale conductor inventory is pruned rather than kept as dead UI/DB state

Why:
- keeps Agent Deck focused on execution rails
- avoids preserving dead control-plane scaffolding

### External structured-control seam (`planned`)

For ACP-capable tools, Agent Deck should not become the ACP runtime.

Current direction:
- Agent Deck may keep lightweight capability/config metadata
- ACP session persistence, queue ownership, stream normalization, and backend health should live outside this repo
- the current reference fit is OpenClaw ACP plus `acpx`

Why:
- structured headless control belongs in a protocol-native backend
- this repo should not duplicate an ACP control plane beside tmux heuristics

## What Must Stay In Agent Deck

- tmux lifecycle and attach UX
- TUI and CLI session management
- group and ownership semantics
- worktree/clone isolation management
- publish/runtime layer workflow
- operator-facing recovery and inspection paths

## What Should Stay External

- ACP session persistence
- ACP queue ownership
- ACP stream/event normalization
- backend health projection for ACP runtimes
- OpenClaw-specific plugin/runtime behavior that is not inherently Agent Deck UX

## Target Long-Term Architecture

### Target shape (`planned`)

1. Agent Deck remains the UI/session rail product.
2. Interactive agent sessions still use tmux where tmux adds real operator value.
3. ACP-capable structured control goes through an external backend contract by default.
4. Tool adapters inside this repo get thinner over time as real backend contracts exist.
5. Conductor remains an integration/transport lane, not a local orchestration brain.
6. Published layered runtime remains the only live deployment path for the fork.

### Ideal split

- Agent Deck:
  session UX, local execution rails, isolation workspaces, operator flows
- OpenClaw/plugins/backend:
  structured ACP runtime, protocol-native status/control, plugin-first extensibility

## Current Limiting Factor

Most structured control is still a direction rather than the default runtime path. That means tool-specific tmux/PTY heuristics still carry more responsibility than the long-term architecture wants.

## Related Docs

- [SPECS.md](../SPECS.md)
- [docs/conductor-openclaw-migration-plan.md](./conductor-openclaw-migration-plan.md)
- [docs/research/2026-03-19-openclaw-plugin-integration-strategy.md](./research/2026-03-19-openclaw-plugin-integration-strategy.md)
