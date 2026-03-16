# Pixel Forge - Agent Instructions

## What This Is

Pixel Forge is a visual app editor. Screenshot bootstrap and Live Editor are two modes of the same product.

## Starting the Full UI

**Required**: Two processes must be running.

```bash
# Terminal 1: Backend (Claude CLI proxy)
pixel-forge                     # Runs on port 7001

# Terminal 2: Web app
cd apps/web
pnpm dev                        # Runs on port 5173
```

**Open**: http://pixel-forge.localhost:5173

If `pixel-forge` command not found, run `./install.sh` first.

Visible browser verification must use a maximized browser window sized to the current display. `./start-dev.sh` now auto-opens one when a GUI display is available. Set `PIXEL_FORGE_NO_BROWSER=1` if you only want the services.

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
