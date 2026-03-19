# Visual-to-Code Setup Guide

## Phase 1: screenshot-to-code Setup

### Prerequisites
- Python 3.10+ with Poetry
- Node.js 18+ with yarn
- Anthropic API key (for Claude Sonnet 3.7)

### Backend Setup

```bash
cd ~/repos/visual-to-code/screenshot-to-code/backend

# Create .env file
cat > .env << 'EOF'
ANTHROPIC_API_KEY=your-key-here
OPENAI_API_KEY=optional-for-gpt4o-comparison
EOF

# Install dependencies
poetry install

# Run backend
poetry shell
poetry run uvicorn main:app --reload --port 7001
```

Backend will be available at: `http://localhost:7001`

### Frontend Setup

```bash
cd ~/repos/visual-to-code/screenshot-to-code/frontend

# Install dependencies
yarn install

# Configure backend URL (if needed)
cat > .env.local << 'EOF'
VITE_WS_BACKEND_URL=ws://localhost:7001
VITE_HTTP_BACKEND_URL=http://localhost:7001
EOF

# Run frontend
yarn dev
```

Frontend will be available at: `http://localhost:5173`

### Test the Setup

1. Open `http://localhost:5173`
2. Upload test image (or use URL)
3. Select "Claude Sonnet 3.7" as model
4. Choose "React + Tailwind" as stack
5. Click "Generate Code"

---

## Phase 2: Claude Structured Outputs Setup

### Install Dependencies

```bash
cd ~/repos/visual-to-code

# Create Python environment for structured outputs pipeline
python3 -m venv .venv
source .venv/bin/activate

# Install Anthropic SDK
pip install anthropic pydantic
```

### Test Structured Outputs

```python
# test_structured_outputs.py
import anthropic
import base64
from pydantic import BaseModel

class DesignSpec(BaseModel):
    layout: dict
    components: list[dict]
    tokens: dict

client = anthropic.Anthropic(api_key="your-key")

with open("test-image.png", "rb") as f:
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
                "text": "Extract design specifications from this UI mockup."
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
    # Beta header for structured outputs
    headers={"anthropic-beta": "structured-outputs-2025-11-13"}
)

print(response.content[0].text)
```

---

## Testing Workflow

### 1. Create Test Mockup

Use any design tool or create simple PNG:
- Figma
- Sketch
- Canva
- Draw.io
- Or just screenshot an existing design

Save as: `~/repos/visual-to-code/examples/test-1-metric-card.png`

### 2. Test with screenshot-to-code

```bash
# Backend running in terminal 1
cd ~/repos/visual-to-code/screenshot-to-code/backend
poetry run uvicorn main:app --reload --port 7001

# Frontend running in terminal 2
cd ~/repos/visual-to-code/screenshot-to-code/frontend
yarn dev
```

Upload `test-1-metric-card.png` → Generate code → Save output

### 3. Test with Structured Pipeline (Phase 2)

```bash
cd ~/repos/visual-to-code
source .venv/bin/activate
python test_structured_outputs.py
```

Compare output quality between both approaches.

---

## Troubleshooting

### Poetry Not Found
```bash
pip install --upgrade poetry
```

### Yarn Not Found
```bash
npm install -g yarn
```

### Backend Port Already in Use
```bash
# Change port in backend command
poetry run uvicorn main:app --reload --port 7002

# Update frontend .env.local
VITE_WS_BACKEND_URL=ws://localhost:7002
VITE_HTTP_BACKEND_URL=http://localhost:7002
```

### API Key Issues
- Anthropic: Get key from https://console.anthropic.com/
- OpenAI (optional): Get key from https://platform.openai.com/

---

## Next Steps

1. Complete Phase 1 setup
2. Run Test 1 (Dashboard Metric Card)
3. Document results
4. Build Phase 2 (structured outputs pipeline)
5. Compare both approaches
