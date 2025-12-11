# Test 3: Styled Invoice Card (Matrix Theme)

## Overview

**File**: `test-3-styled-invoice-card.png` (330KB, higher complexity)
**Source**: User-provided screenshot
**Complexity**: Higher than Test 2 - includes background styling, gradient effects

---

## Visual Description

### Layout
- Card component on left side
- Decorative Matrix-style green "rain" background
- Card appears to float over background

### Card Specifications

**Container**:
- Dark background (appears black or very dark gray)
- Strong shadow/glow effect
- Rounded corners
- Semi-transparent or overlaid on background

**Content Layout**:
```
Invoice #1234
$1,245.50
Due: Jan 15, 2025

[✓ Paid] [View Details →]
```

**Typography**:
- "Invoice #1234": Light gray/white, small text
- "$1,245.50": White, large, bold
- "Due: Jan 15, 2025": Light gray, small text

**Buttons/Badges**:
- **Paid badge**: Green pill shape with checkmark icon
  - Similar to Test 2 but potentially different shade of green to match Matrix theme
- **View Details button**: Dark/transparent button with light text and arrow
  - May have border or subtle background

**Background**:
- Matrix-style "digital rain" effect
- Green (#00FF00 or similar) vertical lines
- Animated effect (static in screenshot)
- Creates dramatic, tech-themed aesthetic

---

## Complexity Differences vs Test 2

| Aspect | Test 2 (Simple) | Test 3 (Styled) |
|--------|----------------|-----------------|
| Background | Plain gray (#F3F4F6) | Matrix green rain |
| Card style | Clean, minimal | Dark, dramatic |
| Shadows | Standard shadow-lg | Strong glow/shadow |
| Color scheme | Standard Tailwind | Custom dark + green theme |
| Visual effects | None | Gradient, glow, rain |
| Difficulty | 2/5 | 4/5 |

---

## Testing Challenges

### For screenshot-to-code (Phase 1):
- **Background replication**: Will it generate CSS for Matrix rain effect?
- **Custom colors**: Non-standard green theme
- **Shadow/glow effects**: Complex shadow layering
- **Contrast**: Dark card on decorative background

### For Structured Extraction (Phase 2):
- **Background pattern**: How to represent animated effect in JSON?
- **Custom theme tokens**: Extract Matrix green (#00FF00-ish)
- **Visual effects**: Glow, shadow layers in structured format
- **Decorative elements**: Separate card from background

---

## Expected Challenges

1. **Background Generation**:
   - Phase 1 might generate static green background
   - Unlikely to replicate animated "rain" effect
   - May need manual CSS animation layer

2. **Theme Colors**:
   - Matrix green is non-standard Tailwind color
   - May need custom color definitions
   - Card darkness may not match exactly

3. **Shadow/Glow**:
   - Complex shadow layering
   - Potential use of `box-shadow` with multiple layers
   - Glow effect may require custom CSS

4. **Layout Extraction**:
   - Card position (left-aligned, not centered)
   - Background vs. foreground separation
   - Z-index layering

---

## Success Criteria

### Visual Accuracy (0-100%)

**Critical (must match)**:
- [ ] Card has dark background (black/dark gray)
- [ ] Text is light colored (white/light gray)
- [ ] Paid badge is green (any shade)
- [ ] Button has arrow icon
- [ ] Layout matches Test 2 structure

**Important (should match)**:
- [ ] Background has green color theme
- [ ] Card has strong shadow/glow
- [ ] Green shade approximates Matrix theme
- [ ] Card positioning (left side)

**Nice-to-have**:
- [ ] Matrix rain effect (animated or static)
- [ ] Exact green shade (#00FF00)
- [ ] Glow effect matches screenshot
- [ ] Background pattern complexity

### Code Quality

**Must have**:
- [ ] Card component is reusable
- [ ] Dark theme colors are defined
- [ ] Background is separate from card
- [ ] Responsive layout

**Should have**:
- [ ] Theme colors as CSS variables
- [ ] Background can be toggled/replaced
- [ ] Clean separation of concerns
- [ ] Accessible contrast ratios

---

## Test Sequence

**Order**: Test 3 runs AFTER Test 2

**Why**: Test 2 establishes baseline accuracy on simple card. Test 3 evaluates how well the tools handle:
- Custom styling
- Complex backgrounds
- Theme variations
- Visual effects

**Comparison Points**:
- Does accuracy drop with complexity?
- How does it handle non-standard colors?
- Does background interfere with extraction?
- Are decorative elements handled correctly?

---

## Recommended Approach

### Phase 1: screenshot-to-code

1. Run with same settings as Test 2
2. Model: Claude Sonnet 3.7
3. Stack: React + Tailwind
4. Expect: May struggle with background, focus on card structure

### Phase 2: Structured Extraction

1. Extract card component specs separately
2. Extract background theme separately
3. Define custom color tokens (Matrix green)
4. Generate two components:
   - `InvoiceCard` (dark theme variant)
   - `MatrixBackground` (decorative layer)

### Phase 3: Manual Refinement

1. Review generated code
2. Add Matrix rain effect (CSS animation or SVG)
3. Tune shadow/glow effects
4. Adjust green color to match

---

## Matrix Rain Effect (Reference)

If tools don't generate the background effect, here's a starting point:

```css
.matrix-rain {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(to bottom, #001a00, #000);
  overflow: hidden;
  z-index: -1;
}

.matrix-rain::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-image:
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0, 255, 0, 0.03) 2px,
      rgba(0, 255, 0, 0.03) 4px
    );
  animation: rain 20s linear infinite;
}

@keyframes rain {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100%); }
}
```

---

## Documentation

After running both tests, document:

1. **Accuracy comparison**: Test 2 vs Test 3
2. **Complexity handling**: Simple vs Styled
3. **Limitations found**: What tools struggled with
4. **Manual effort required**: What needed tweaking
5. **Cost difference**: Token usage for complex design

---

**Status**: Ready to test after Test 2 completes
