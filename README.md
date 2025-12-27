# Visual to Code

**Convert design images to HTML/Tailwind code using Claude**

Unified toolkit with SDK, CLI, web app, and automation tools. Uses exact screenshot-to-code parameters for 85-90% visual accuracy.

---

## 🚀 Quick Start

### Install (Recommended)

```bash
./install.sh        # Install to ~/.local/bin/pixel-forge
pixel-forge         # Start server on port 7001
```

Then open: http://localhost:7001/test-harness.html

### Visual Editor Mode

Point at elements in your running app, tell Claude what to change:

1. Start `pixel-forge`
2. Open the test harness
3. Enter your dev app URL (e.g., `http://localhost:3000`)
4. Enter your project path (e.g., `/home/user/my-app`)
5. Click **Select Mode**, click an element
6. Type instruction, click **Send to Claude**

Claude finds the source file and makes the edit.

### Manual Setup (Development)

```bash
# Terminal 1: Start the Claude CLI proxy
cd claude-proxy
pip install -r requirements.txt
python main.py  # Runs on port 7001

# Terminal 2: Start the frontend (optional, for screenshot-to-code UI)
cd screenshot-to-code/frontend
yarn install
yarn dev  # Opens http://localhost:5173
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
