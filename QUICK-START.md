# Quick Start

## Fast Path

```bash
./start-dev.sh
```

Open `http://pixel-forge.localhost:5173`.

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
