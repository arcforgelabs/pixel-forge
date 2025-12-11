# Quick Start: Visual-to-Code Testing

## What's Ready

✅ **Test mockup created**: Invoice Status Card
✅ **Screenshot captured**: `examples/test-2-invoice-card.png` (17KB)
✅ **screenshot-to-code cloned**: Ready for Phase 1
✅ **Test workflow documented**: `TEST-RUN.md`
✅ **Screenshot tool**: Playwright-based (in `tools/screenshot.js`)

---

## Run Phase 1: screenshot-to-code (Fast Track)

### 1. Install Backend Dependencies

```bash
cd ~/repos/visual-to-code/screenshot-to-code/backend
poetry install
```

### 2. Configure API Key

```bash
# Add your Anthropic API key
cat > .env << 'EOF'
ANTHROPIC_API_KEY=your-key-here
EOF
```

### 3. Start Backend (Terminal 1)

```bash
poetry run uvicorn main:app --reload --port 7001
```

Keep this running. Backend at: http://localhost:7001

### 4. Start Frontend (Terminal 2)

```bash
cd ~/repos/visual-to-code/screenshot-to-code/frontend
yarn install  # First time only
yarn dev
```

Keep this running. Frontend at: http://localhost:5173

### 5. Test the Tool

1. Open browser: http://localhost:5173
2. Upload image: `~/repos/visual-to-code/examples/test-2-invoice-card.png`
3. Select model: **Claude Sonnet 3.7**
4. Select stack: **React + Tailwind**
5. Click **Generate Code**
6. Wait ~10-30 seconds
7. Review generated code

### 6. Save Results

Copy generated code to:
```bash
mkdir -p ~/repos/visual-to-code/results/phase1
# Paste code into: results/phase1/test-2-output.tsx
```

---

## Expected Output

The tool should generate a React component like:

```tsx
export default function InvoiceCard() {
  return (
    <div className="bg-white shadow-lg rounded-xl p-6 w-96">
      <div className="text-gray-500 text-sm mb-4">Invoice #1234</div>
      <div className="text-gray-900 text-2xl font-bold mb-2">$1,245.50</div>
      <div className="text-gray-600 text-sm mb-6">Due: Jan 15, 2025</div>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1 bg-green-100 text-green-800 text-sm px-3 py-1 rounded-full">
          ✓ Paid
        </span>
        <button className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded-lg">
          View Details →
        </button>
      </div>
    </div>
  );
}
```

---

## Run Phase 2: Structured Outputs (Next Step)

### 1. Set Up Python Environment

```bash
cd ~/repos/visual-to-code
python3 -m venv .venv
source .venv/bin/activate
pip install anthropic pydantic pillow
```

### 2. Create Extraction Script

```bash
# Copy from TEST-RUN.md or create:
nano tools/extract_structured_spec.py
# Paste the Python script from TEST-RUN.md
```

### 3. Run Extraction

```bash
python tools/extract_structured_spec.py \
  examples/test-2-invoice-card.png \
  your-anthropic-api-key > results/phase2/test-2-spec.json
```

### 4. Review Structured Output

```bash
cat results/phase2/test-2-spec.json | jq .
```

Expected format:
```json
{
  "layout": {
    "type": "flex",
    "properties": {"direction": "column", "gap": "16px"}
  },
  "components": [
    {"type": "Text", "props": {"text": "Invoice #1234", ...}},
    {"type": "Text", "props": {"text": "$1,245.50", ...}},
    {"type": "Badge", "props": {"text": "Paid", ...}},
    {"type": "Button", "props": {"text": "View Details", ...}}
  ],
  "tokens": {
    "colors": {"primary": "#3B82F6", ...},
    "spacing": {"md": "16px", ...}
  }
}
```

---

## Next: Build Code Generator

Phase 2 step 2: Create `tools/generate_code_from_spec.py` to convert JSON → React code.

---

## Troubleshooting

**Backend won't start**:
```bash
cd ~/repos/visual-to-code/screenshot-to-code/backend
poetry shell
poetry install --no-root
```

**Frontend won't start**:
```bash
cd ~/repos/visual-to-code/screenshot-to-code/frontend
rm -rf node_modules
yarn install
```

**Screenshot tool error**:
```bash
cd ~/repos/visual-to-code
npx playwright install chromium
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `examples/test-2-invoice-card.html` | Reference mockup (HTML) |
| `examples/test-2-invoice-card.png` | Screenshot for testing |
| `examples/test-components.md` | All test component specs |
| `TEST-RUN.md` | Detailed test workflow |
| `SETUP.md` | Full setup instructions |
| `research/VISUAL_TO_CODE_RESEARCH.md` | Tool research (15+ tools) |

---

## The Vision

**Design Tool** → Image → **Our Tool** → Structured Data → Code

Current status:
- ✅ Phase 1 ready: screenshot-to-code (image → code)
- 🚧 Phase 2 in progress: structured outputs (image → JSON → code)
- ⏳ Phase 3 planned: code generator (JSON → React/Vue/HTML)

---

**Ready to test? Start Phase 1 now!**
