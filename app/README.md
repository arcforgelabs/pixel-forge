# Visual to Code - Claude Code Edition

**Subagent Delegation Version** - No direct API calls, uses Claude Code subagent

---

## Architecture

### Master Branch (API Version)
- Button click → Direct Anthropic API call
- Requires ANTHROPIC_API_KEY
- Costs per generation

### Claude-Code Branch (This Branch)
- Button click → Backend server → Claude Code subagent delegation
- No API key in frontend
- Uses Claude Code session's context/budget

---

## How It Works

1. **User uploads image** → Frontend displays preview
2. **User clicks "Generate Code"** → Frontend sends image to backend
3. **Backend receives request** → Saves image to temp file
4. **Backend delegates to subagent** → Spawns Python script with image path
5. **Subagent generates code** → Uses Claude API (from Claude Code session)
6. **Backend returns code** → Frontend displays result

**Key Difference**: The API call happens within a Claude Code subagent, so it's part of the session's usage, not a separate API cost.

---

## Setup

```bash
cd app
npm install
```

---

## Usage

### Start Server

```bash
npm start
```

Server runs on http://localhost:3000

### Upload Image

1. Open http://localhost:3000
2. Drag & drop or click to upload design image
3. Click "Generate Code"
4. Wait for subagent to generate code (~5-15s)
5. Copy generated code

---

## Implementation Notes

### Current Implementation (Temporary)

The server currently uses `generate_with_claude.py` which still makes direct API calls. This is a **temporary implementation** for testing.

### Ideal Implementation (TODO)

Replace Python subprocess with actual Claude Code subagent delegation:

```javascript
// Instead of:
spawn('python3', ['../tools/generate_with_claude.py', imagePath]);

// Use Claude Agent SDK or Claude Code CLI:
spawn('claude-code', ['subagent', '--prompt', promptPath, '--image', imagePath]);
```

**Why not implemented yet**: Claude Code doesn't currently expose a CLI for subagent delegation. This would require either:
1. Claude Agent SDK integration
2. Claude Code CLI extension
3. MCP server approach

---

## Comparison: Master vs Claude-Code Branch

| Feature | Master (API) | Claude-Code (Subagent) |
|---------|--------------|------------------------|
| **API Key** | Required in env | Not required |
| **API Costs** | Direct charge | Part of session usage |
| **Button Action** | Calls API directly | Delegates to subagent |
| **Backend** | Optional | Required |
| **Setup** | Simpler | More complex |
| **Use Case** | Standalone tool | Claude Code integration |

---

## Development

### Watch Mode

```bash
npm run dev
```

Automatically restarts server on file changes.

### Testing

```bash
# Test health check
curl http://localhost:3000/health

# Test generation (with base64 image)
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{"image":"<base64>","mediaType":"image/png"}'
```

---

## Next Steps

1. **Replace Python subprocess** with actual Claude Code subagent delegation
2. **Add error handling** for failed subagent spawns
3. **Add progress streaming** to show real-time generation status
4. **Add retry logic** for transient failures
5. **Add caching** for repeated images

---

## Git Branches

- **master**: API version (direct Anthropic API calls)
- **claude-code**: Subagent version (delegation to Claude Code)

Both branches maintained via git worktrees:
- `/home/x-forge/repos/visual-to-code` → master
- `/home/x-forge/repos/visual-to-code--claude-code` → claude-code
