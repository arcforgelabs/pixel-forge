# Pixel Forge - Agent Instructions

## What This Is

Pixel Forge is a visual app editor. Screenshot bootstrap and Live Editor are two modes of the same product.

## Starting the Full UI

Preferred dev path:

```bash
./start-dev.sh
```

That starts the API, the Vite frontend, and auto-opens the desktop shell when a GUI display is available.

Manual fallback:

```bash
# Terminal 1
cd apps/api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py

# Terminal 2
cd apps/web
pnpm install
pnpm dev
```

If `pixel-forge` command is not installed yet, run `./install.sh` first.

Visible browser verification must use a maximized browser window sized to the current display. `./start-dev.sh` auto-opens the desktop shell when it can. Set `PIXEL_FORGE_USE_DESKTOP_SHELL=0` to force the raw browser path for debugging, or `PIXEL_FORGE_NO_BROWSER=1` if you only want the services.

## Verification

Run this after changes to the install/update lane, staged controller updates, or launcher behavior:

```bash
pnpm verify
```

That is the canonical proof lane for version sync, shell syntax, API/desktop/web checks, isolated install smoke, and staged controller-update apply/rollback smoke.

`SPECS.md` is the repo constitution. Live Editor now runs through Agent Deck-backed persistent sessions. Each request is written to `.pixel-forge/requests/<request-id>/...` inside the target project before Pixel Forge dispatches a short prompt into the corresponding Agent Deck session.

## Project Setup (Live Editor Mode)

On first load, a modal asks for:
- **Project Path**: Absolute path to target project (e.g., `/home/user/repos/my-app`)
- **Dev Server URL**: Running dev server (e.g., `http://localhost:3000`)

Both are required for Live Editor. Screenshot mode works without them.

## Two Modes

| Tab | Purpose |
|-----|---------|
| **Screenshot** | Bootstrap UI from images/screenshots |
| **Live Editor** | Select elements in running app, describe changes |

## Live Editor Workflow

1. Start your target app's dev server (e.g., `pnpm dev`)
2. Enter its URL in the project selector
3. Click **Live Editor** tab
4. Click **Select** button in toolbar
5. Click any element in the embedded app
6. Describe the change in the chat input
7. Claude finds the source file and edits it

## Architecture

```
pixel-forge (port 7001)         # FastAPI backend, Claude CLI wrapper
  └── /app/*                    # Proxies target app with selection script injection
  └── /ws/live-editor           # WebSocket for Claude streaming
  └── /generate-code            # Screenshot bootstrap endpoint

apps/web                        # React frontend
  └── Screenshot tab            # Image upload, code generation
  └── Live Editor tab           # Embedded app, element selection, chat
```

## Common Issues

**"Cannot connect to target app"**: Start the target app's dev server first.

**Element selection not working**: Make sure Select mode is ON (green) in the toolbar.

**No response from Claude**: Check that `pixel-forge` backend is running on port 7001.

**Stale controller update won't apply**: If the install/update lane changed since the snapshot was staged, clear the pending update and stage a fresh one from the current repo instead of applying the stale snapshot.
