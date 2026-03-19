# Ready to Test: screenshot-to-code Phase 1

**Date**: 2025-12-12
**Status**: ✅ All systems ready

---

## Services Running

### Backend
- **URL**: http://api.screenshot-to-code.localhost:7001
- **Status**: ✅ Running (background task `bdd48b2`)
- **Models**: Claude Sonnet 3.7 + 4.5

### Frontend
- **URL**: http://screenshot-to-code.localhost:5173
- **Status**: ✅ Running (background task `bcba831`)
- **Dropdown**: ✅ Both models available

---

## Testing Plan

### 4 Test Runs (2 images × 2 models)

1. **Test 2 + Sonnet 3.7** → `results/phase1/sonnet-3.7/test-2-output.tsx`
2. **Test 2 + Sonnet 4.5** → `results/phase1/sonnet-4.5/test-2-output.tsx`
3. **Test 3 + Sonnet 3.7** → `results/phase1/sonnet-3.7/test-3-output.tsx`
4. **Test 3 + Sonnet 4.5** → `results/phase1/sonnet-4.5/test-3-output.tsx`

---

## How to Test

1. **Open Frontend**: http://screenshot-to-code.localhost:5173

2. **Run Test 2 (Simple Card)**:
   - Upload: `~/repos/visual-to-code/examples/test-2-invoice-card.png`
   - Model: **Claude Sonnet 3.7**
   - Stack: **React + Tailwind**
   - Generate code
   - Save output to `results/phase1/sonnet-3.7/test-2-output.tsx`

3. **Repeat Test 2 with Sonnet 4.5**:
   - Same image
   - Model: **Claude Sonnet 4.5**
   - Save output to `results/phase1/sonnet-4.5/test-2-output.tsx`

4. **Run Test 3 (Styled Matrix Card)**:
   - Upload: `~/repos/visual-to-code/examples/test-3-styled-invoice-card.png`
   - Test with **both models** (3.7 and 4.5)
   - Save to respective directories

---

## What to Look For

### Visual Accuracy
- Layout match (spacing, alignment)
- Color accuracy (especially Test 3 Matrix green)
- Typography (font sizes, weights)
- Shadows and effects (especially Test 3 glow)

### Code Quality
- Tailwind utilities usage
- Component reusability
- Icon implementation
- Hover states

### Model Comparison
- Which handles simple designs better? (Test 2)
- Which handles complex styling better? (Test 3)
- Which generates cleaner code?
- Performance differences (time, tokens, cost)

---

## Results Template

Fill in: `results/phase1/COMPARISON-TEMPLATE.md`

---

## Changes Made

1. ✅ Added Claude Sonnet 3.7 to frontend model dropdown
2. ✅ Created results directory structure
3. ✅ Created comparison template
4. ✅ Updated documentation with both models

---

## Next Step

**Start testing in browser!** Open http://screenshot-to-code.localhost:5173 and begin with Test 2 + Sonnet 3.7.

If you see any warnings in the browser console or backend logs, let me know and I'll investigate.
