# Pixel Forge

**Visual app editing with screenshot bootstrap and live editing for real running apps**

Pixel Forge is one product now: a web app plus API that let you bootstrap UI from screenshots, then refine the real app by selecting elements and editing the source with Claude context.

---

## 🚀 Quick Start

### Full App

The main product provides both Screenshot and Live Editor modes with chat interface, streaming, and tool visualization.

```bash
# Terminal 1: Start the backend proxy
./install.sh                    # First time only - installs to ~/.local/bin/
pixel-forge                     # Start backend on port 7001

# Terminal 2: Start the web app
cd apps/web
pnpm install                    # First time only
pnpm dev --port 5173            # Start web app on port 5173
```

Then open: **http://localhost:5173**

On first load, you'll see a project selector modal:
1. **Project Path**: Full path to your project (e.g., `/home/user/my-app`)
2. **Dev Server URL**: Your running dev server (e.g., `http://localhost:3000`)
3. Click **Select Project** to enable Live Editor mode

### Two Modes

| Mode | Purpose | How to Use |
|------|---------|------------|
| **Screenshot** | Bootstrap from images | Drag/drop screenshot or paste from clipboard |
| **Live Editor** | Edit your running app | Click Select, click element, describe change |

### Minimal Test Harness (Alternative)

For quick testing without the full UI:

```bash
pixel-forge                     # Start backend
open http://localhost:7001/test-harness.html
```

This provides basic element selection and Claude integration without the full chat UI.

### Development Setup

```bash
# API (from repo root)
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py                  # Port 7001

# Web app (separate terminal)
cd apps/web
pnpm install
pnpm dev --port 5173            # Port 5173
```

---

## 📦 What's Inside

### 1. **Apps**

- `apps/web` - React + Vite product UI
- `apps/api` - FastAPI + Claude CLI backend

### 2. **Packages**

- `packages/cli` - optional CLI adapter
- `packages/sdk-node` - optional Node SDK adapter
- `packages/mcp-server` - optional MCP adapter

### 3. **Automation Tools** (`tools/`)

Python scripts for advanced workflows:
- `batch_generate.py` - Batch processing
- `generate_variants.py` - Multi-variant generation
- `auto_iterate.py` - Automated iteration
- `auto_iterate_reflex.py` - Iteration with objective evals

[📚 Tools Documentation](TOOLS-SUMMARY.md)

---

## 🎯 Vision Parameters

Uses the screenshot bootstrap prompt strategy that originally came from screenshot-to-code:
- `detail: "high"` for maximum visual fidelity
- Specialized system prompts emphasizing "exactly"
- **Result**: 85-90% visual accuracy

[📚 Full Analysis](FINAL-SUMMARY.md)

---

## 💰 Cost Tracking

**Per-generation costs** (Sonnet 4.5):
- Simple: ~$0.02
- Complex: ~$0.04

---

## 🏗️ Architecture

```
pixel-forge/
├── apps/
│   ├── api/               # FastAPI + Claude CLI
│   └── web/               # React + Vite UI
├── packages/
│   ├── cli/               # Optional CLI adapter
│   ├── mcp-server/        # Optional MCP adapter
│   └── sdk-node/          # Optional Node SDK adapter
├── tools/                 # Offline automation and evals
└── install.sh             # Installs the API launcher
```

---

## 📖 Documentation

- [CLI Documentation](packages/cli/README.md)
- [SDK Documentation](packages/sdk-node/README.md)
- [MCP Server Documentation](packages/mcp-server/README.md)
- [Tools Documentation](TOOLS-SUMMARY.md)
- [Testing Results](TESTING-RESULTS.md)
- [Final Summary](FINAL-SUMMARY.md)

---

## 📄 License

MIT
