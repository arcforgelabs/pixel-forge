# Visual to Code

**Convert design images to HTML/Tailwind code using Claude**

Unified toolkit with SDK, CLI, web app, and automation tools. Uses exact screenshot-to-code parameters for 85-90% visual accuracy.

---

## 🚀 Quick Start

### CLI (Recommended for Automation)

```bash
# Set API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Generate code from image
./cli/visual-to-code design.png

# Output: design.html
```

### Web App (Recommended for Interactive Use)

```bash
cd app
npm install
npm start

# Open http://localhost:3000
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
visual-to-code/
├── sdk/node/              # Core SDK
├── cli/                   # CLI tool
├── app/                   # Web app
├── tools/                 # Python automation
└── examples/              # Test images
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
