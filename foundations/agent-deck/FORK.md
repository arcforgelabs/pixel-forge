# Agent Deck Fork Workflow

## Remotes

- `origin`: `IAMSamuelRodda/agent-deck`
- `upstream`: `asheshgoplani/agent-deck`

## Branch Contract

- `main` is an upstream mirror branch.
  - Update with fast-forward only from `upstream/main`.
  - Do not keep fork-only commits on `main`.
- A dedicated custom branch holds all local behavior changes.
  - Canonical branch: `custom/samuel-agent-deck`.
  - Keep all custom implementation commits here.
- Published local runtime is separate from git branch state.
  - Source-of-truth branches live in this repo.
  - Installed runtime lanes live under `~/.local/share/agent-deck/layers/`.
  - `~/.local/bin/agent-deck` is a wrapper that executes the active lane.
- Optional local deployment flow can merge custom branch into `main` after sync.

## Canonical Sync Command

```bash
./scripts/fork-sync-publish.sh --custom-branch custom/samuel-agent-deck
```

This command does:
1. `git fetch` from remotes.
2. `main <- upstream/main` (fast-forward only).
3. `custom <- main` (merge).
4. Validation gates:
   - `go test ./internal/session ./internal/update ./cmd/agent-deck`
   - `./resources/specs/audit-conductor-control-plane-minimal.sh`
5. Build, publish the `workstation` runtime lane, and activate it via `./dev-install.sh`.

Optional local deployment merge:

```bash
./scripts/fork-sync-publish.sh --custom-branch custom/samuel-agent-deck --deploy-main
```

## Commit Hygiene

- Prefix fork-only implementation commits with `custom(<scope>): ...`.
- Keep commits small and reviewable.
- If an upstream change makes a fork patch unnecessary, delete the fork patch instead of preserving dead compatibility code.

## Local Runtime Lanes

- `workstation`: default lane for the current custom branch build.
- `client-approved`: optional promoted lane for a known-good local release.
- `upstream-stock`: clean upstream build published from `~/repos/agent-deck-base-source`.
- `active`: symlink used by the `agent-deck` wrapper.

Inspection + promotion:

```bash
agent-deck-layers status
agent-deck-layers promote-client-approved --activate
```

## Upstream Stock Baseline

Use the stock runtime side-by-side when you need to see upstream behavior without the overlay:

```bash
agent-deck-layers sync-upstream-stock-source
agent-deck-layers publish-upstream-stock
agent-deck-stock
```

Stock runtime rules:
- `agent-deck-stock` runs from the `upstream-stock` lane, not the `active` overlay lane.
- Stock state lives in `~/.local/share/agent-deck/sandboxes/upstream-stock/`.
- Stock tmux uses socket `agentdeck-stock`, so it does not join the overlay tmux server.
- Stock web defaults to `127.0.0.1:8421`.
- The stock launcher stamps CLI `version`/`help` as `Agent Deck [UPSTREAM STOCK]` and forces profile `upstream-stock` so the TUI header is visibly different.

Operational details live in `docs/upstream-stock-runtime.md`.

## Rollout Timing

- Commit and push to `origin/custom/samuel-agent-deck` during work hours when needed.
- Defer live workstation lane activation/re-activation when active coding sessions should not be disturbed.
- Use `agent-deck-stock` during work hours to validate upstream behavior without touching the overlay runtime path.
- Use after-hours or session closeout windows for explicit live runtime rollout checks when a fresh `./dev-install.sh` or lane switch is required.

## Conflict Rule

- Resolve conflicts in favor of minimal custom surface.
- If custom behavior is no longer required, remove it.
- Re-run validation gates before pushing.
