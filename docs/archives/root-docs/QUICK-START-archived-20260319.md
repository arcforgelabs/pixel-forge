# Quick Start

## Fast Path

```bash
./start-dev.sh
```

When a GUI display is available, that also auto-opens the Pixel Forge desktop shell. The raw web UI remains at `http://pixel-forge.localhost:5173`.

## Verify Changes

```bash
pnpm verify
```

Use this after touching the install/update lane, the launcher, or staged controller-update flow.

## Install the Local App

```bash
./install.sh
pixel-forge open
```

If a pending controller update was staged before an updater/install change, clear it and restage from the current repo instead of loading the stale snapshot.

## Manual Start

Terminal 1:

```bash
cd apps/api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

Terminal 2:

```bash
cd apps/web
pnpm install
pnpm dev
```

## First Run

1. Set `Project Path` to the codebase you want Claude to edit.
2. Set `Dev Server URL` to the running target app.
3. Use `Screenshot` when you need a fresh visual bootstrap.
4. Use `Live Editor` when you want to click a real element and change the real app.

## Test Harness

If you want the minimal backend-only harness:

```bash
open http://127.0.0.1:7001/test-harness.html
```
