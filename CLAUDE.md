# Pixel Forge - Agent Instructions

## What This Is

Visual-to-code toolkit: convert screenshots to HTML/Tailwind, or edit running apps via Live Editor.

## Starting the Full UI

**Required**: Two processes must be running.

```bash
# Terminal 1: Backend (Claude CLI proxy)
pixel-forge                     # Runs on port 7001

# Terminal 2: Frontend
cd screenshot-to-code/frontend
pnpm dev --port 5174            # Runs on port 5174
```

**Open**: http://localhost:5174

If `pixel-forge` command not found, run `./install.sh` first.

## Project Setup (Live Editor Mode)

On first load, a modal asks for:
- **Project Path**: Absolute path to target project (e.g., `/home/user/repos/my-app`)
- **Dev Server URL**: Running dev server (e.g., `http://localhost:3000`)

Both are required for Live Editor. Screenshot-to-Code works without them.

## Two Modes

| Tab | Purpose |
|-----|---------|
| **Screenshot to Code** | Generate code from images/screenshots |
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
  └── /generate-code            # Screenshot-to-code endpoint

screenshot-to-code/frontend     # React frontend
  └── Screenshot to Code tab    # Image upload, code generation
  └── Live Editor tab           # Embedded app, element selection, chat
```

## Common Issues

**"Cannot connect to target app"**: Start the target app's dev server first.

**Element selection not working**: Make sure Select mode is ON (green) in the toolbar.

**No response from Claude**: Check that `pixel-forge` backend is running on port 7001.
