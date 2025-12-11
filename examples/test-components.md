# Test Components for Visual-to-Code Pipeline

## Test Strategy

1. **Baseline Test** (Option 3) - Dashboard Metric Card
2. **Medium Complexity** (Option 1) - Invoice Status Card
3. **Higher Complexity** (Option 2) - Settings Panel
4. **Real-World Test** - Pip Screenshots

---

## Test 1: Dashboard Metric Card (BASELINE)

### Visual Design
```
┌──────────────────────────┐
│ Revenue                  │
│                          │
│ $12,450                  │
│ ↑ 23% this month         │
└──────────────────────────┘
```

### Specifications
- **Card**: white bg, shadow-md, rounded-lg, p-6
- **Title**: "Revenue" - gray-600, text-sm, font-medium
- **Value**: "$12,450" - gray-900, text-3xl, font-bold
- **Trend**: "↑ 23% this month" - green-600, text-sm
- **Icon**: Up arrow (↑) inline with trend text

### Expected Output
React + Tailwind component matching visual design

### Success Criteria
- ✅ Card has correct padding, shadow, rounded corners
- ✅ Typography hierarchy matches (sm → 3xl → sm)
- ✅ Colors match (gray-600, gray-900, green-600)
- ✅ Layout is vertically stacked with proper spacing

---

## Test 2: Invoice Status Card (MEDIUM)

### Visual Design
```
┌───────────────────────────────────┐
│ Invoice #1234                     │
│                                   │
│ $1,245.50                         │
│ Due: Jan 15, 2025                 │
│                                   │
│ [✓ Paid] [View Details →]        │
└───────────────────────────────────┘
```

### Specifications
- **Card**: white bg, shadow-lg, rounded-xl, p-6
- **Invoice #**: gray-500, text-sm
- **Amount**: gray-900, text-2xl, font-bold
- **Due Date**: gray-600, text-sm
- **Paid Badge**: green-100 bg, green-800 text, rounded-full, px-3 py-1
- **Button**: blue-600 bg, white text, rounded-lg, px-4 py-2

### Expected Output
React + Tailwind component with badge + button

### Success Criteria
- ✅ Badge has pill shape with correct colors
- ✅ Button has hover state
- ✅ Spacing between elements is consistent
- ✅ Layout is responsive-friendly

---

## Test 3: Settings Panel (COMPLEX)

### Visual Design
```
┌────────────────────────────────────┐
│ Settings                           │
│ ────────────────────────────────   │
│                                    │
│ ○ Dark Mode                        │
│ ○ Email Notifications              │
│ ○ Two-Factor Auth                  │
│                                    │
│ [Save Changes]                     │
└────────────────────────────────────┘
```

### Specifications
- **Panel**: white bg, shadow-xl, rounded-2xl, p-8
- **Heading**: "Settings" - gray-900, text-xl, font-semibold
- **Divider**: gray-200, 2px
- **Toggles**: gray-400 (off), blue-600 (on), rounded-full
- **Labels**: gray-700, text-base
- **Button**: blue-600 bg, white text, rounded-lg, px-6 py-3, font-medium

### Expected Output
React + Tailwind component with toggle switches + button

### Success Criteria
- ✅ Toggle switches are functional (state management)
- ✅ Hover states work correctly
- ✅ Divider separates header from content
- ✅ Button is full-width or centered

---

## Test 4: Real-World (PIP)

### Source
Take screenshots of:
1. Pip chat interface
2. Invoice card component
3. Settings page section

### Expected Output
Working React + Tailwind code matching Pip's design

### Success Criteria
- ✅ Matches Pip's color scheme
- ✅ Typography matches (fonts, sizes, weights)
- ✅ Spacing is consistent with Pip's design system
- ✅ Components are reusable

---

## Testing Workflow

### Phase 1: screenshot-to-code (Baseline)
```
1. Create simple mockup image for Test 1
2. Upload to screenshot-to-code
3. Generate React + Tailwind code
4. Evaluate output quality
5. Document what works / what doesn't
```

### Phase 2: Claude Sonnet 4.5 (Structured Data)
```
1. Take same mockup from Test 1
2. Send to Claude Vision API with structured output schema
3. Extract JSON spec (layout, components, tokens)
4. Compare spec accuracy to mockup
5. Generate code from JSON spec
6. Compare quality: screenshot-to-code vs. structured pipeline
```

### Phase 3: Integration Test
```
1. Run both approaches on Pip screenshots
2. Measure:
   - Accuracy (visual match %)
   - Token usage
   - Generation time
   - Code quality
3. Document findings
```

---

## Evaluation Metrics

### Visual Accuracy
- Layout match: 0-100%
- Color accuracy: 0-100%
- Typography match: 0-100%
- Spacing consistency: 0-100%

### Code Quality
- Uses design system patterns: Y/N
- Reusable components: Y/N
- Accessible markup: Y/N
- Clean code (no bloat): Y/N

### Performance
- Generation time: seconds
- Token usage: count
- API cost: dollars

---

## Next Steps

1. **Create Test 1 mockup** - Simple PNG/SVG of dashboard metric card
2. **Set up screenshot-to-code** - Install, configure with Anthropic API key
3. **Run baseline test** - Generate code from Test 1
4. **Document results** - Create comparison doc
5. **Build Phase 2** - Claude structured outputs pipeline
