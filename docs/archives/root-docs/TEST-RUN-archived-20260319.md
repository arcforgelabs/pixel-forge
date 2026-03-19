# Test Run: Invoice Status Card

## Test Subject: Test 2 - Invoice Status Card

**Mockup**: `examples/test-2-invoice-card.html`
**Screenshot**: `examples/test-2-invoice-card.png` (17KB, 1280x720)

### Visual Specifications
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

**Components**:
- Card container (white, shadow-lg, rounded-xl, padding)
- Invoice number (gray-500, text-sm)
- Amount (gray-900, text-2xl, font-bold)
- Due date (gray-600, text-sm)
- Paid badge (green-100 bg, green-800 text, rounded-full, with checkmark icon)
- View Details button (blue-600 bg, white text, rounded-lg, with arrow icon)

---

## Phase 1: screenshot-to-code Test

### Setup Backend

```bash
cd ~/repos/visual-to-code/screenshot-to-code/backend

# Create .env with your Anthropic API key
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-xxxxx
EOF

# Install dependencies (one-time)
poetry install

# Run backend
poetry run uvicorn main:app --reload --port 7001
```

**Backend ready at**: http://localhost:7001

### Setup Frontend

```bash
# In a new terminal
cd ~/repos/visual-to-code/screenshot-to-code/frontend

# Install dependencies (one-time)
yarn install

# Run frontend
yarn dev
```

**Frontend ready at**: http://localhost:5173

### Run Test

1. Open http://localhost:5173
2. Click "Upload Image" or drag-and-drop
3. Select: `~/repos/visual-to-code/examples/test-2-invoice-card.png`
4. **Model**: Select "Claude Sonnet 3.7"
5. **Stack**: Select "React + Tailwind"
6. Click "Generate Code"
7. Wait for generation (~10-30 seconds)
8. Review output code

### Evaluation Criteria

**Visual Accuracy** (0-100%):
- [ ] Card has shadow-lg, rounded-xl, padding
- [ ] Invoice number styling (gray-500, text-sm)
- [ ] Amount styling (gray-900, text-2xl, bold)
- [ ] Due date styling (gray-600, text-sm)
- [ ] Paid badge (green pill shape with checkmark)
- [ ] Button (blue, rounded, with arrow icon)
- [ ] Spacing between elements matches

**Code Quality**:
- [ ] Uses Tailwind utility classes
- [ ] Component is reusable (props?)
- [ ] Icons are properly implemented (SVG or icon library)
- [ ] Hover states on button
- [ ] Clean, readable code structure

**Performance**:
- Generation time: ___ seconds
- Token usage: ___ tokens
- API cost: $___.____

### Save Output

```bash
# Copy generated code to:
mkdir -p ~/repos/visual-to-code/results/phase1
```

Save as: `results/phase1/test-2-screenshot-to-code-output.tsx`

---

## Phase 2: Claude Structured Outputs Test

### Setup Python Environment

```bash
cd ~/repos/visual-to-code

# Create venv (one-time)
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies (one-time)
pip install anthropic pydantic pillow
```

### Create Test Script

```bash
cat > tools/extract_structured_spec.py << 'EOF'
import anthropic
import base64
import json
from pydantic import BaseModel

class Component(BaseModel):
    type: str
    props: dict

class DesignTokens(BaseModel):
    colors: dict[str, str]
    spacing: dict[str, str]
    typography: dict[str, dict]

class Layout(BaseModel):
    type: str
    properties: dict

class DesignSpec(BaseModel):
    layout: Layout
    components: list[Component]
    tokens: DesignTokens

def extract_spec(image_path: str, api_key: str) -> DesignSpec:
    client = anthropic.Anthropic(api_key=api_key)

    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode()

    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=4000,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": image_data
                    }
                },
                {
                    "type": "text",
                    "text": """Extract complete design specifications from this UI mockup.

For each component, identify:
- Component type (Card, Button, Badge, Text, etc.)
- Props (text content, variant, size, etc.)

For design tokens, extract:
- Colors used (with hex codes)
- Spacing values (padding, margins, gaps)
- Typography (font sizes, weights, families)

For layout, specify:
- Container type (flex, grid, etc.)
- Arrangement properties (direction, gap, alignment)"""
                }
            ]
        }],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "design_spec",
                "schema": DesignSpec.model_json_schema()
            }
        },
        headers={"anthropic-beta": "structured-outputs-2025-11-13"}
    )

    spec_json = json.loads(response.content[0].text)
    return DesignSpec(**spec_json)

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python extract_structured_spec.py <image-path> <api-key>")
        sys.exit(1)

    spec = extract_spec(sys.argv[1], sys.argv[2])
    print(json.dumps(spec.model_dump(), indent=2))
EOF
```

### Run Structured Extraction

```bash
source .venv/bin/activate
python tools/extract_structured_spec.py \
  examples/test-2-invoice-card.png \
  sk-ant-xxxxx > results/phase2/test-2-structured-spec.json
```

### Evaluation Criteria

**Spec Accuracy**:
- [ ] Correctly identified all components (Card, Text, Badge, Button)
- [ ] Extracted accurate color values
- [ ] Captured spacing relationships
- [ ] Typography specs match (font sizes, weights)
- [ ] Layout structure is correct

**Completeness**:
- [ ] All visible elements represented
- [ ] Props are comprehensive
- [ ] Design tokens are complete

### Generate Code from Spec

```bash
# TODO: Create code generator that reads JSON spec and outputs React component
python tools/generate_code_from_spec.py \
  results/phase2/test-2-structured-spec.json \
  > results/phase2/test-2-generated-code.tsx
```

---

## Comparison: Phase 1 vs Phase 2

### Visual Accuracy
| Aspect | Phase 1 (screenshot-to-code) | Phase 2 (Structured) |
|--------|------------------------------|----------------------|
| Layout | __% | __% |
| Colors | __% | __% |
| Typography | __% | __% |
| Spacing | __% | __% |
| **Average** | __% | __% |

### Code Quality
| Aspect | Phase 1 | Phase 2 |
|--------|---------|---------|
| Reusable | Y/N | Y/N |
| Clean | Y/N | Y/N |
| Accessible | Y/N | Y/N |

### Performance
| Metric | Phase 1 | Phase 2 |
|--------|---------|---------|
| Time | __s | __s |
| Tokens | ___ | ___ |
| Cost | $__.__ | $__.__ |

---

## Next Steps

1. **Run both phases** on Test 2
2. **Document findings** in `results/COMPARISON.md`
3. **Iterate on Phase 2** if needed (improve schema, prompts)
4. **Test on Pip screenshots** for real-world validation
5. **Build code generator** for Phase 2 (JSON spec → React component)

---

## Notes

- Phase 1 is faster but less controllable
- Phase 2 gives structured data for advanced workflows
- Both use Claude Sonnet (Phase 1: 3.7, Phase 2: 4.5)
- Structured outputs (Phase 2) are in beta
