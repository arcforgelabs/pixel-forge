# Upstream Stock Runtime

## Intent

Keep a clean upstream Agent Deck runtime installable side-by-side with the custom overlay so behavior can be compared without overwriting the live fork runtime.

## Runtime Topology

- Overlay source repo: `~/repos/agent-deck` on `custom/samuel-agent-deck`
- Overlay runtime lanes: `workstation`, `client-approved`, `active`
- Overlay launcher: `~/.local/bin/agent-deck`
- Stock source repo: `~/repos/agent-deck-base-source`
- Stock runtime lane: `upstream-stock`
- Stock launcher: `~/.local/bin/agent-deck-stock`
- Stock sandbox root: `~/.local/share/agent-deck/sandboxes/upstream-stock`
- Stock tmux socket: `agentdeck-stock`
- Stock profile: `upstream-stock`
- Stock default web listen: `127.0.0.1:8421`

## Canonical Workflow

Refresh the clean upstream checkout:

```bash
agent-deck-layers sync-upstream-stock-source
```

Build and publish the stock lane:

```bash
agent-deck-layers publish-upstream-stock
```

Launch the stock TUI:

```bash
agent-deck-stock
```

Launch stock web mode:

```bash
agent-deck-stock web
```

Inspect both overlay and stock runtime lanes:

```bash
agent-deck-layers status
```

## Isolation Rules

- Do not repoint `~/.local/bin/agent-deck` to upstream. Overlay and stock must remain separate launchers.
- The stock launcher overrides `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` into the stock sandbox.
- The stock launcher prepends a sandbox `tmux` wrapper that executes `tmux -L agentdeck-stock`, isolating the tmux server/socket from the overlay runtime.
- Stock config defaults are generated inside the sandbox on first launch:
  - `[conductor] enabled = false`
  - `[updates] check_enabled = false`
  - `[mcp_pool] pool_all = false`
- The upstream stock source repo is expected to stay clean and disposable. `sync-upstream-stock-source` fast-forwards it to `origin/main` and hard-resets that mirror checkout.

## How To Tell Which Interface You Launched

- Overlay launcher: `agent-deck`
- Stock launcher: `agent-deck-stock`
- Stock TUI runs under profile `upstream-stock`, so the header shows the profile badge and uses isolated state
- `agent-deck-stock version` prints `Agent Deck [UPSTREAM STOCK] v...`
- `agent-deck-stock help` prints the same labeled runtime name and stock launcher usage
- `agent-deck-stock web` defaults to `127.0.0.1:8421`, so the alternate port is another quick visual cue

## When To Use It

- Compare upstream behavior before deleting or refactoring overlay patches
- Reproduce a bug against a clean upstream baseline
- Check whether a fork-only integration changed UI/CLI behavior
- Review upstream UX changes side-by-side before syncing them into the custom branch
