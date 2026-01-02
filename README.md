# Visual to Code

**Convert design images to HTML/Tailwind code using Claude**

Unified toolkit with SDK, CLI, web app, and automation tools. Uses exact screenshot-to-code parameters for 85-90% visual accuracy.

---

## 🚀 Quick Start

### Full UI (Recommended)

The full UI provides both Screenshot-to-Code and Live Editor modes with chat interface, streaming, and tool visualization.

```bash
# Terminal 1: Start the backend proxy
./install.sh                    # First time only - installs to ~/.local/bin/
pixel-forge                     # Start backend on port 7001

# Terminal 2: Start the frontend
cd screenshot-to-code/frontend
pnpm install                    # First time only
pnpm dev --port 5174            # Start frontend on port 5174
```

Then open: **http://localhost:5174**

On first load, you'll see a project selector modal:
1. **Project Path**: Full path to your project (e.g., `/home/user/my-app`)
2. **Dev Server URL**: Your running dev server (e.g., `http://localhost:3000`)
3. Click **Select Project** to enable Live Editor mode

### Two Modes

| Mode | Purpose | How to Use |
|------|---------|------------|
| **Screenshot to Code** | Generate code from images | Drag/drop screenshot or paste from clipboard |
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
# Backend (from repo root)
cd claude-proxy
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py                  # Port 7001

# Frontend (separate terminal)
cd screenshot-to-code/frontend
pnpm install
pnpm dev --port 5174            # Port 5174
```

### SDK (For Programmatic Use)

```javascript
import { generateFromFile } from './sdk/node/index.js';

const result = await generateFromFile('design.png');
console.log(result.code);  // Generated HTML
```

---

## 📦 What's Inside

### 1. **SDK** (`sdk/node/`)

Reusable library for design→code conversion.

**Features**:
- `generateFromFile()` - Generate from image file
- `generateFromBase64()` - Generate from base64 data
- `generateVariants()` - Generate multiple variants
- Uses exact screenshot-to-code parameters

[📚 SDK Documentation](sdk/node/README.md)

### 2. **CLI** (`cli/`)

Command-line tool for automation.

```bash
./cli/visual-to-code design.png
```

[📚 CLI Documentation](cli/README.md)

### 3. **Web App** (`app/`)

Interactive web interface.

```bash
cd app && npm start
```

[📚 Web App Documentation](app/README.md)

### 4. **Automation Tools** (`tools/`)

Python scripts for advanced workflows:
- `batch_generate.py` - Batch processing
- `generate_variants.py` - Multi-variant generation
- `auto_iterate.py` - Automated iteration
- `auto_iterate_reflex.py` - Iteration with objective evals

[📚 Tools Documentation](TOOLS-SUMMARY.md)

---

## 🎯 Vision Parameters

Uses exact parameters from screenshot-to-code:
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
├── claude-proxy/          # Main server (FastAPI + Claude CLI)
│   ├── main.py            # WebSocket endpoints
│   ├── app_proxy.py       # Dev app proxy with element selection
│   └── test-harness.html  # Visual editor UI
├── screenshot-to-code/    # Forked frontend (optional)
├── sdk/node/              # Core SDK
├── cli/                   # CLI tool
├── tools/                 # Python automation
└── install.sh             # Install script
```

---

## 📖 Documentation

- [SDK Documentation](sdk/node/README.md)
- [CLI Documentation](cli/README.md)
- [Web App Documentation](app/README.md)
- [Tools Documentation](TOOLS-SUMMARY.md)
- [Testing Results](TESTING-RESULTS.md)
- [Final Summary](FINAL-SUMMARY.md)

---

## 📄 License

MIT
