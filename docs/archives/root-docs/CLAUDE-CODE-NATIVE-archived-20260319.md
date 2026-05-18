# Claude Code Native Visual-to-Code

**Vision**: Run visual-to-code without consuming user API keys by using Claude Code's agent delegation system.

---

## Architecture Options

### Option 1: Direct Agent Delegation (Simplest)

**Flow**:
```
User uploads image
  ↓
Main Agent receives image
  ↓
Delegates to Explore/General agent with prompt:
  "Analyze this design and generate HTML + Tailwind code"
  ↓
Agent returns generated code
  ↓
Save to output file
```

**Implementation**:
```javascript
// Pseudo-code for Node.js wrapper
const { uploadImage, delegateToAgent } = require('./claude-code-bridge');

async function generateCode(imagePath) {
  const imageBase64 = fs.readFileSync(imagePath, 'base64');

  const result = await delegateToAgent({
    type: 'general-purpose',
    prompt: `
Analyze this UI design image and generate production-ready code.

Requirements:
- Use HTML + Tailwind CSS
- Create semantic, accessible markup
- Include inline SVG for icons
- Make it responsive
- Generate complete, working code

Image: [base64 data or file path]
`,
    attachments: [{ type: 'image', data: imageBase64 }]
  });

  return result.code;
}
```

**Pros**:
- No API keys needed (uses Claude Code's session)
- Leverages existing infrastructure
- Simple to implement

**Cons**:
- Requires Claude Code running
- May be slower than direct API calls
- Limited to Claude models

---

### Option 2: MCP Server (Most Flexible)

**Architecture**:
```
screenshot-to-code MCP Server
  ├── Tools:
  │   ├── generate_code_from_image
  │   │   ├── Input: image path/URL, settings
  │   │   └── Output: generated code
  │   ├── analyze_design
  │   │   ├── Input: image path/URL
  │   │   └── Output: design analysis (colors, layout, components)
  │   └── compare_outputs
  │       ├── Input: image, original code, generated code
  │       └── Output: accuracy metrics
  └── Resources:
      ├── examples/ (reference designs)
      └── templates/ (output templates)
```

**MCP Server Implementation**:

File: `~/repos/visual-to-code/mcp-server/server.py`

```python
from anthropic import Anthropic
from mcp.server import Server
from mcp.types import Tool, TextContent, ImageContent
import base64
import os

server = Server("visual-to-code")
client = Anthropic()  # Uses ANTHROPIC_API_KEY from env

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="generate_code_from_image",
            description="Generate HTML/React code from a UI design image",
            inputSchema={
                "type": "object",
                "properties": {
                    "image_path": {
                        "type": "string",
                        "description": "Path to the UI design image"
                    },
                    "framework": {
                        "type": "string",
                        "enum": ["html_tailwind", "react_tailwind", "vue_tailwind"],
                        "default": "html_tailwind"
                    },
                    "model": {
                        "type": "string",
                        "enum": ["claude-sonnet-4-5", "claude-sonnet-3-7"],
                        "default": "claude-sonnet-4-5"
                    }
                },
                "required": ["image_path"]
            }
        ),
        Tool(
            name="analyze_design",
            description="Analyze a UI design to extract colors, layout, components",
            inputSchema={
                "type": "object",
                "properties": {
                    "image_path": {
                        "type": "string",
                        "description": "Path to the UI design image"
                    }
                },
                "required": ["image_path"]
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "generate_code_from_image":
        image_path = arguments["image_path"]
        framework = arguments.get("framework", "html_tailwind")
        model = arguments.get("model", "claude-sonnet-4-5")

        # Read image
        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        # Call Claude API
        response = client.messages.create(
            model=model,
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
                        "text": f"""Generate production-ready {framework} code for this UI design.

Requirements:
- Use Tailwind CSS utility classes
- Create semantic, accessible HTML
- Include inline SVG for icons where needed
- Make it responsive (mobile-first)
- Use flexbox/grid for layouts
- Add appropriate hover/focus states
- Generate complete, working code

Output only the code, no explanations."""
                    }
                ]
            }]
        )

        code = response.content[0].text

        return [TextContent(
            type="text",
            text=code
        )]

    elif name == "analyze_design":
        image_path = arguments["image_path"]

        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2000,
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
                        "text": """Analyze this UI design and extract:

1. Color palette (hex codes)
2. Typography (font sizes, weights)
3. Layout structure (grid/flex, spacing)
4. Component list (buttons, cards, inputs, etc.)
5. Visual effects (shadows, borders, animations)

Format as JSON."""
                    }
                ]
            }]
        )

        analysis = response.content[0].text

        return [TextContent(
            type="text",
            text=analysis
        )]

if __name__ == "__main__":
    server.run()
```

**MCP Server Configuration** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "visual-to-code": {
      "command": "python",
      "args": ["~/repos/visual-to-code/mcp-server/server.py"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

**Usage in Claude Code**:
```
User: "Generate code from this invoice design"
Claude: [Uses visual-to-code MCP server]
  → Calls generate_code_from_image tool
  → Returns generated HTML + Tailwind
  → Saves to file
```

**Pros**:
- Works from any Claude Code session
- Reusable across projects
- Can add more tools (compare, optimize, etc.)
- Supports multiple models

**Cons**:
- Still uses API key (but centralized)
- Requires MCP server setup
- More complex than direct delegation

---

### Option 3: Hybrid (Best of Both)

**Architecture**:
```
MCP Server for API-based generation (when API key available)
  +
Agent Delegation for API-free generation (when in Claude Code)
  +
Automatic fallback detection
```

**Implementation**:
```javascript
async function generateCode(imagePath, options = {}) {
  // Try MCP server first (if available)
  if (hasMCPServer('visual-to-code')) {
    return await useMCPTool('visual-to-code', 'generate_code_from_image', {
      image_path: imagePath,
      ...options
    });
  }

  // Fallback to agent delegation (Claude Code native)
  if (isClaudeCodeSession()) {
    return await delegateToAgent({
      type: 'general-purpose',
      prompt: buildPrompt(imagePath, options)
    });
  }

  // Last resort: require API key
  throw new Error('Either MCP server or Claude Code session required');
}
```

---

## Recommended Approach

**Phase 1** (Immediate): Build MCP server
- Easiest to test and validate
- Works standalone or in Claude Code
- Provides foundation for Phase 2

**Phase 2** (After validation): Add agent delegation fallback
- Make it work without API keys in Claude Code
- Automatic detection and fallback

**Phase 3** (Polish): Add advanced features
- Batch processing
- Design comparison
- Accuracy scoring
- Model A/B testing

---

## MCP Server Directory Structure

```
visual-to-code/
├── mcp-server/
│   ├── server.py (main MCP server)
│   ├── requirements.txt
│   ├── README.md
│   └── tools/
│       ├── generate.py
│       ├── analyze.py
│       └── compare.py
├── examples/ (test images)
└── results/ (outputs)
```

---

## Next Steps

1. **Build MCP server**:
   - Create `mcp-server/` directory
   - Implement `generate_code_from_image` tool
   - Add to `~/.claude.json`
   - Test with existing images

2. **Test with Claude Code**:
   - Load project in Claude Code
   - Use MCP tool: "Generate code from test-2-invoice-card.png"
   - Validate output matches browser automation results

3. **Add agent delegation** (optional):
   - Detect when MCP unavailable
   - Delegate to general-purpose agent
   - Compare quality vs MCP approach

4. **Document patterns**:
   - Update `testing-visual-to-code` skill
   - Add MCP usage examples
   - Document API key management

---

## Benefits

**API Key Management**:
- Centralized in `~/.claude.json`
- Not exposed in project files
- Easy to rotate/update

**Reusability**:
- Use from any Claude Code session
- Works in multiple projects
- CLI tool potential

**Testing**:
- Compare models easily
- Batch process designs
- Automated quality checks

**Cost Control**:
- Track usage per tool call
- Optimize prompts centrally
- Easy to add caching

---

**Status**: Ready to implement
**Complexity**: Medium (MCP server basics are straightforward)
**Time Estimate**: 2-3 hours for basic MCP server
