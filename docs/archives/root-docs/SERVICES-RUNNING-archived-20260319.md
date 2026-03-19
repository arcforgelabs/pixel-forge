# Services Running: screenshot-to-code

## ✅ Status: READY TO TEST

### Backend (API)
- **URL**: http://api.screenshot-to-code.localhost:7001
- **Status**: ✅ Running
- **API Key**: Configured (sk-ant-api03-...lFYx1AAA)
- **Models**: Claude Sonnet 3.7 + 4.5 (via Anthropic)
- **Process**: Background task `bdd48b2`

### Frontend (UI)
- **URL**: http://screenshot-to-code.localhost:5173
- **Status**: ✅ Running
- **Backend**: Configured to connect to api.screenshot-to-code.localhost:7001
- **Models**: ✅ Claude Sonnet 3.7 and 4.5 added to dropdown
- **Process**: Background task `bcba831`

---

## Test Files Ready

### Test 2: Simple Invoice Card
- **File**: `examples/test-2-invoice-card.png` (17KB)
- **Description**: Clean white card, standard Tailwind colors
- **Purpose**: Baseline test

### Test 3: Styled Invoice Card
- **File**: `examples/test-3-styled-invoice-card.png` (330KB)
- **Description**: Dark card with Matrix theme background
- **Purpose**: Complex styling test

---

## How to Test

### Open the Frontend

Open in your browser: **http://screenshot-to-code.localhost:5173**

### Run Test 2 (Simple) - Sonnet 3.7

1. Click "Upload Image" or drag-and-drop
2. Select file: `~/repos/visual-to-code/examples/test-2-invoice-card.png`
3. Settings:
   - **Model**: Claude Sonnet 3.7
   - **Stack**: React + Tailwind
4. Click "Generate Code"
5. Wait ~10-30 seconds for generation
6. Review output code
7. Save to: `~/repos/visual-to-code/results/phase1/test-2-sonnet-3.7-output.tsx`

### Run Test 2 (Simple) - Sonnet 4.5

1. Same image: `~/repos/visual-to-code/examples/test-2-invoice-card.png`
2. Settings:
   - **Model**: Claude Sonnet 4.5 (if available)
   - **Stack**: React + Tailwind
3. Click "Generate Code"
4. Compare output vs Sonnet 3.7
5. Save to: `~/repos/visual-to-code/results/phase1/test-2-sonnet-4.5-output.tsx`

### Run Test 3 (Styled) - Both Models

1. Test with Sonnet 3.7 first:
   - File: `~/repos/visual-to-code/examples/test-3-styled-invoice-card.png`
   - Save to: `~/repos/visual-to-code/results/phase1/test-3-sonnet-3.7-output.tsx`
2. Test with Sonnet 4.5:
   - Same file
   - Save to: `~/repos/visual-to-code/results/phase1/test-3-sonnet-4.5-output.tsx`
3. Compare both outputs against the complex Matrix theme design

---

## Expected Output Format

Generated code should look like:

```tsx
export default function InvoiceCard() {
  return (
    <div className="bg-white shadow-lg rounded-xl p-6 w-96">
      {/* ... component code ... */}
    </div>
  );
}
```

---

## Evaluation

After running all tests (2 images × 2 models = 4 test runs), evaluate:

### Visual Accuracy (0-100%)
- Layout match
- Color accuracy
- Typography
- Spacing consistency

### Code Quality
- Uses Tailwind utilities
- Component is reusable
- Clean structure
- Icons properly implemented

### Model Comparison (Sonnet 3.7 vs 4.5)
- Which model produces more accurate output?
- Which handles complex styling better (Test 3)?
- Which generates cleaner code?
- Performance differences (time, tokens, cost)

### Performance
- Generation time per model
- Token usage per model
- API cost per model

---

## Stop Services

When done testing:

```bash
# List running tasks
/tasks

# Kill services
pkill -f "uvicorn main:app"
pkill -f "vite"
```

Or use Claude Code task management to kill background tasks.

---

## Next: Phase 2 (Structured Outputs)

After Phase 1 testing, proceed to:
1. Build structured extraction pipeline
2. Claude Sonnet 4.5 + JSON schema
3. Compare results with Phase 1

See `TEST-RUN.md` for Phase 2 instructions.

---

**Status**: Services running, ready to test!
**Started**: 2025-12-12 00:00 UTC
