# Agent Deck

## Custom Branch Policy (Mandatory)

- This repo is operated as a custom fork lane. Do not develop or commit on `main` or `master`.
- Canonical custom branch: `custom/samuel-agent-deck`.
- Before any edit, verify branch: `git branch --show-current`. If on `main`/`master`, switch to the custom branch first.
- `main`/`master` are reserved for upstream sync only.
- Commit guards are enforced by `git-hooks/pre-commit` and `scripts/committer`.
- Install hooks once per clone: `./scripts/install-hooks.sh`.
- If a `main`/`master` commit is intentionally required, set `AGENTDECK_ALLOW_MAIN_COMMIT=1` for that command only.

## Versioning

- Version source: `cmd/agent-deck/main.go` (`const Version`).
- Version format: `<upstream-version>-fork` (example: `0.20.2-fork`).
- On each upstream sync, set `<upstream-version>` to the latest synced upstream tag.

## Stock Baseline Workflow

- Keep upstream baseline testing side-by-side with the fork runtime. Do not repoint `~/.local/bin/agent-deck` at upstream.
- Canonical stock source repo: `~/repos/agent-deck-base-source`.
- Canonical stock publish flow: `agent-deck-layers sync-upstream-stock-source`, then `agent-deck-layers publish-upstream-stock`, then launch with `agent-deck-stock`.
- Full workflow and sandbox details: `docs/upstream-stock-runtime.md`.
