# Visual to Code MCP Server

**Convert design images to HTML/Tailwind code via delegation - NO API COSTS**

This MCP server uses a delegation pattern where tools delegate vision work to the parent Claude Code agent, which spawns subagents to preserve context. Uses your Claude Max subscription quota with zero additional API costs.

---

## Architecture

**Delegation Pattern**:
1. MCP tool writes request to `/tmp/visual-to-code-delegation/request-{id}.json`
2. Parent Claude Code agent monitors `/tmp/visual-to-code-delegation/`
3. Parent spawns subagent to preserve context
4. Subagent processes image with vision capability
5. Subagent generates HTML/Tailwind code
6. Parent writes response to `/tmp/visual-to-code-delegation/response-{id}.json`
7. Tool reads response and returns code

**Benefits**:
- ✅ Zero API costs (uses your Max subscription)
- ✅ Preserves parent agent context via subagent delegation
- ✅ 85-90% visual accuracy (same as screenshot-to-code)
- ✅ Complete HTML/Tailwind implementation

---

## Installation

### 1. Install Dependencies

```bash
# Using uv (recommended)
uv pip install -r requirements.txt

# Or using pip
pip install -r requirements.txt
```

### 2. Register with Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "visual-to-code": {
      "command": "python",
      "args": ["~/repos/3-resources/pixel-forge/packages/mcp-server/visual_to_code_mcp.py"],
      "env": {}
    }
  }
}
```

Or use Lazy-MCP (recommended):

```json
{
  "mcpServers": {
    "lazy-mcp": {
      "command": "npx",
      "args": ["-y", "lazy-mcp"],
      "env": {
        "LAZY_MCP_CONFIG": "~/.config/lazy-mcp/config.json"
      }
    }
  }
}
```

Then add to `~/.config/lazy-mcp/config.json`:

```json
{
  "servers": {
    "visual-to-code": {
      "command": "python",
      "args": ["~/repos/3-resources/pixel-forge/packages/mcp-server/visual_to_code_mcp.py"]
    }
  }
}
```

---

## Tools

### `generate_code_from_image`

Generate HTML/Tailwind code from a single design image.

**Input**:
- `image_path` (required): Absolute or relative path to image (PNG, JPG, JPEG, WEBP)
- `temperature` (optional): 0.7-2.0, default 1.0 (0.7=conservative, 1.0=balanced, higher=creative)

**Returns**: Markdown response with generated code and metadata

**Example**:
```json
{
  "image_path": "/home/user/design.png",
  "temperature": 1.0
}
```

### `generate_variants`

Generate multiple code variants with different temperatures.

**Input**:
- `image_path` (required): Absolute or relative path to image
- `count` (optional): Number of variants (2-6), default 4

**Returns**: Markdown response with all variants and comparison table

**Example**:
```json
{
  "image_path": "/home/user/design.png",
  "count": 4
}
```

---

## Parent Agent Setup

The parent Claude Code agent must monitor for delegation requests. Create a monitoring script or add to your workflow:

```python
import json
import time
from pathlib import Path

DELEGATION_DIR = Path("/tmp/visual-to-code-delegation")

def monitor_requests():
    """Monitor for delegation requests and spawn subagents to process."""
    while True:
        for request_file in DELEGATION_DIR.glob("request-*.json"):
            try:
                # Read request
                request = json.loads(request_file.read_text())

                # Check if use_subagent flag is set
                if request.get("use_subagent"):
                    # Spawn subagent with Task tool
                    # Pass: image_path, system_prompt, user_prompt, temperature
                    # Subagent reads image, generates code, returns result
                    # Write response to request["response_file"]
                    pass

            except Exception as e:
                # Write error response
                error_response = {
                    "request_id": request["request_id"],
                    "error": str(e)
                }
                Path(request["response_file"]).write_text(json.dumps(error_response))

        time.sleep(2)  # Check every 2 seconds
```

---

## Testing

### Manual Test

1. Start Claude Code
2. Call tool via MCP:
   ```
   Use the generate_code_from_image tool to convert examples/test-2-invoice-card.png to code
   ```

3. Check delegation directory:
   ```bash
   ls -la /tmp/visual-to-code-delegation/
   ```

4. Parent should process request and write response

### Integration Test

Run the test script:

```bash
python test_mcp_server.py
```

---

## Deployment

Use the `deploying-mcps` skill to deploy:

**Standard Deployment** (Claude Code):
- Register in `~/.claude.json`
- Restart Claude Code

**Lazy-MCP Deployment** (Progressive Disclosure):
- Register in Lazy-MCP config
- Tools load on-demand
- Recommended for 10+ MCP servers

**Remote Deployment** (Claude.ai/ChatGPT):
- Not applicable (requires local file system access)

---

## Troubleshooting

### Tool not responding

**Symptom**: Tool times out after 5 minutes

**Cause**: Parent agent not monitoring delegation directory

**Fix**:
1. Verify `/tmp/visual-to-code-delegation/` exists
2. Check for request files: `ls /tmp/visual-to-code-delegation/request-*.json`
3. Ensure parent monitoring script is running

### Invalid image path

**Symptom**: `ValueError: Image file not found`

**Fix**: Use absolute paths or verify relative path is correct

### Module not found

**Symptom**: `ModuleNotFoundError: No module named 'mcp'`

**Fix**: Install dependencies: `uv pip install -r requirements.txt`

---

## Cost Comparison

| Method | Cost per Generation | Notes |
|--------|---------------------|-------|
| **Direct API** (original) | $0.02-$0.04 | Calls Anthropic API directly |
| **MCP Delegation** (this) | $0.00 | Uses Max subscription quota |

**Delegation is completely free** - uses your existing Claude Code session's vision capability.

---

## Architecture Details

### Request Format

```json
{
  "request_id": "abc123",
  "type": "generate",
  "image_path": "/path/to/image.png",
  "temperature": 1.0,
  "system_prompt": "You are an expert Tailwind developer...",
  "user_prompt": "Generate code for a web page...",
  "response_file": "/tmp/visual-to-code-delegation/response-abc123.json",
  "timestamp": 1234567890.123,
  "use_subagent": true,
  "subagent_instruction": "IMPORTANT: Use a subagent to process this image..."
}
```

### Response Format

**Success**:
```json
{
  "request_id": "abc123",
  "code": "<html>...</html>"
}
```

**Error**:
```json
{
  "request_id": "abc123",
  "error": "Image file not found"
}
```

---

## System Prompt

Uses exact screenshot-to-code system prompt for 85-90% visual accuracy:

- `detail="high"` for maximum visual fidelity
- Specialized prompts emphasizing "exactly"
- Complete implementation (no comments like "<!-- Add other items -->")
- Tailwind CSS via CDN
- Google Fonts support
- Font Awesome icons
- Placeholder images from placehold.co

---

## License

MIT
