# ARCHITECTURE.md

**Last Updated**: 2025-12-28

---

## Current Architecture (v1)

```
┌─────────────────┐     WebSocket      ┌─────────────────┐     subprocess     ┌─────────────────┐
│  screenshot-    │ ◄──────────────► │  claude-proxy   │ ◄──────────────► │  claude CLI     │
│  to-code        │   /generate-code   │  (FastAPI)      │   per-request      │  (ephemeral)    │
│  frontend       │                    │  port 7001      │                    │                 │
└─────────────────┘                    └─────────────────┘                    └─────────────────┘
     port 5173                                                                 subscription billing
```

**Components:**
- `screenshot-to-code/` - Forked frontend (React + Vite)
- `claude-proxy/main.py` - WebSocket server that intercepts API calls
- `claude` CLI - Spawned per-request, uses subscription billing

**Limitations:**
- Each request spawns fresh Claude process (no context persistence)
- Only previews generated HTML (not actual running apps)
- Can't modify real source files

---

## Target Architecture (v2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  pixel-forge UI (modified screenshot-to-code frontend)                      │
│  ┌─────────────────────────┐    ┌───────────────────────────────────────┐  │
│  │  App Viewer             │    │  Feedback Panel                       │  │
│  │  (embedded dev app)     │    │  - Chat history                       │  │
│  │                         │    │  - File changes                       │  │
│  │  [Select & Edit Mode]   │    │  - "Apply to codebase" button         │  │
│  └───────────┬─────────────┘    └───────────────────────────────────────┘  │
└──────────────┼──────────────────────────────────────────────────────────────┘
               │ element + instruction
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  claude-proxy (WebSocket server)                                            │
│  - Session manager (one Claude session per project)                         │
│  - App proxy (optional, for injection)                                      │
│  - File watcher (detect changes, trigger reload)                            │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ --session-id + --resume
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Claude Code Session (PERSISTENT)                                           │
│  - Working directory: user's project                                        │
│  - Full codebase context                                                    │
│  - Remembers previous changes                                               │
│  - Modifies real source files                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ADR-001: Dev App Embedding Strategy

**Date:** 2025-12-23
**Status:** Implemented (Option 2 - Proxy with Script Injection)

### Context

We need to embed a user's running dev app (e.g., `localhost:3000`) into the pixel-forge UI so users can:
1. See their actual app (not generated HTML)
2. Use select-and-edit to point at real elements
3. Send feedback to Claude with element context

### Options Evaluated

#### Option 1: Direct iframe Embedding

```html
<iframe src="http://localhost:3000" />
```

**How it works:**
- User starts their dev server (`npm run dev`)
- pixel-forge embeds `localhost:3000` directly in an iframe
- Select-and-edit uses `postMessage` to communicate with iframe

**Pros:**
| Benefit | Impact |
|---------|--------|
| Zero setup | User just enters their dev URL |
| Fast | No proxy overhead |
| Real app | 100% fidelity - it's the actual app |
| HMR works | Changes reflect instantly via existing HMR |
| Framework agnostic | Works with any framework |

**Cons:**
| Issue | Severity | Mitigation |
|-------|----------|------------|
| Same-origin policy blocks DOM access | **Critical** | Can't inspect elements in cross-origin iframe |
| CORS headers required | Medium | Dev servers need permissive CORS |
| Cookie/auth issues | Medium | Some auth flows may break in iframe |
| X-Frame-Options blocking | Medium | Some apps explicitly block iframe embedding |
| postMessage security | Low | Need to validate message origins |

**Verdict:** Won't work for element selection without workarounds. Same-origin policy prevents accessing iframe DOM.

---

#### Option 2: Proxy with Script Injection

```
User's browser ──► pixel-forge proxy (7001) ──► User's dev server (3000)
                         │
                         └── Injects selection script into HTML responses
```

**How it works:**
- pixel-forge runs a reverse proxy in front of the dev server
- Proxy intercepts HTML responses and injects a selection script
- Selection script communicates with pixel-forge via WebSocket
- User's app runs "inside" our proxy, bypassing same-origin issues

**Pros:**
| Benefit | Impact |
|---------|--------|
| Full DOM access | Selection script runs in same origin as proxy |
| Element inspection | Can read outerHTML, computed styles, XPath |
| No browser extension | Pure server-side solution |
| Control over responses | Can modify any response if needed |
| Works with any framework | Just needs to serve HTML |

**Cons:**
| Issue | Severity | Mitigation |
|-------|----------|------------|
| WebSocket/SSE complexity | Medium | Need to proxy WS connections for HMR |
| Path rewriting | Medium | Relative URLs may need adjustment |
| Authentication passthrough | Medium | Need to forward cookies/headers |
| Performance overhead | Low | Minimal - just passing through |
| Setup complexity | Low | User needs to configure target URL |
| HTTPS apps | Medium | Need to handle SSL termination |

**Implementation sketch:**

```python
# claude-proxy/app_proxy.py
from fastapi import FastAPI, Request, Response
import httpx

TARGET_APP = "http://localhost:3000"

INJECTION_SCRIPT = """
<script>
(function() {
  const ws = new WebSocket('ws://localhost:7001/selection');

  document.addEventListener('click', (e) => {
    if (window.__pixelForgeSelectMode) {
      e.preventDefault();
      e.stopPropagation();
      ws.send(JSON.stringify({
        type: 'element-selected',
        outerHTML: e.target.outerHTML,
        xpath: getXPath(e.target),
        tagName: e.target.tagName,
        classList: [...e.target.classList],
        computedStyle: getComputedStyle(e.target)
      }));
    }
  }, true);

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'toggle-select-mode') {
      window.__pixelForgeSelectMode = data.enabled;
    }
  };
})();
</script>
"""

@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy(request: Request, path: str):
    async with httpx.AsyncClient() as client:
        resp = await client.request(
            method=request.method,
            url=f"{TARGET_APP}/{path}",
            headers=request.headers,
            content=await request.body()
        )

        content = resp.content
        if "text/html" in resp.headers.get("content-type", ""):
            # Inject selection script before </body>
            content = content.replace(b"</body>", INJECTION_SCRIPT.encode() + b"</body>")

        return Response(
            content=content,
            status_code=resp.status_code,
            headers=dict(resp.headers)
        )
```

**Verdict:** Most powerful option. Full control, works everywhere, but requires careful implementation for WebSocket passthrough.

---

#### Option 3: Browser Extension Companion

```
┌─────────────────┐     WebSocket     ┌─────────────────┐
│  Browser ext    │ ◄──────────────► │  pixel-forge    │
│  (content.js)   │   element data    │  backend        │
│  on user's tab  │                   │                 │
└─────────────────┘                   └─────────────────┘
```

**How it works:**
- User installs pixel-forge browser extension
- Extension injects content script into dev app tab
- Content script handles element selection
- Communicates with pixel-forge backend via WebSocket

**Pros:**
| Benefit | Impact |
|---------|--------|
| No proxy needed | Simpler backend architecture |
| Full DOM access | Content scripts have same-origin privileges |
| Works with any URL | Even production sites, not just localhost |
| HTTPS native | No SSL termination needed |
| Tab agnostic | Can work on any tab, not just embedded |
| DevTools integration | Could integrate with browser DevTools |

**Cons:**
| Issue | Severity | Mitigation |
|-------|----------|------------|
| Requires extension install | **High** | Friction, app store approval |
| Browser-specific | High | Need Chrome + Firefox + Safari versions |
| Review process | High | Chrome Web Store review can take weeks |
| User trust | Medium | Users wary of extensions |
| Maintenance burden | Medium | Need to update for browser API changes |
| Not embedded | Low | App in separate tab, not in pixel-forge UI |

**Verdict:** Most flexible technically, but installation friction and maintenance burden make it less attractive.

---

### Decision

**Recommended: Option 2 (Proxy with Script Injection)**

**Rationale:**
1. Zero installation friction (no extension)
2. Full DOM access (same-origin after proxy)
3. Works with any framework
4. Keeps app embedded in pixel-forge UI
5. Implementation complexity is manageable

**Trade-offs accepted:**
- WebSocket passthrough for HMR - implemented in `app_proxy.py`
- Authentication edge cases - basic header forwarding works
- Path rewriting complexity - handled with regex in `inject_script()` and `rewrite_js_imports()`

### Implementation Plan

1. **Phase 1:** Basic HTTP proxy with script injection - **Done**
2. **Phase 2:** WebSocket passthrough for HMR - **Done**
3. **Phase 3:** Authentication header forwarding - **Done** (X-Forwarded headers)
4. **Phase 4:** HTTPS support (optional) - Not implemented

---

## ADR-002: Session Persistence Strategy

**Date:** 2025-12-23
**Status:** Implemented (2025-12-27)

### Context

Currently, each request spawns a fresh Claude CLI process. Claude has no memory of previous interactions. For effective code editing, Claude needs:
- Knowledge of previous changes made
- Understanding of the codebase structure
- Conversation context for follow-up requests

### Decision

Use Claude CLI's `--session-id` and `--resume` flags:

```python
# First request for a project
cmd = [
    "claude", "-p", prompt,
    "--session-id", project_session_id,  # UUID tied to project path
    "--dangerously-skip-permissions",
    "--output-format", "json",
    # Remove --no-session-persistence
]

# Subsequent requests
cmd = [
    "claude", "-p", prompt,
    "--resume", project_session_id,
    "--dangerously-skip-permissions",
    "--output-format", "json",
]
```

**Session ID generation:**
```python
import hashlib
import uuid

def get_session_id(project_path: str) -> str:
    """Generate deterministic session ID from project path."""
    hash_input = f"pixel-forge:{project_path}"
    hash_bytes = hashlib.sha256(hash_input.encode()).digest()[:16]
    return str(uuid.UUID(bytes=hash_bytes))
```

### Consequences

**Benefits:**
- Claude remembers previous changes
- Can reference earlier conversation
- Builds understanding of codebase over time

**Risks:**
- Session files accumulate on disk
- Need to handle session expiration/cleanup
- Large sessions may slow down

---

## Tech Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Frontend | React + Vite (screenshot-to-code fork) | Existing UI, select-and-edit works |
| Backend | FastAPI + Python | WebSocket support, easy async |
| Claude Integration | Claude CLI | Subscription billing, session persistence |
| App Proxy | httpx + FastAPI | Async HTTP client |

---

## File Structure

```
pixel-forge/
├── VISION.md              # Philosophical north star
├── ARCHITECTURE.md        # This file
├── PROGRESS.md            # Project tracking
├── ISSUES.md              # Bug/improvement tracking
├── README.md              # Quick start (needs update)
│
├── claude-proxy/          # Backend
│   ├── main.py            # WebSocket server + code generation
│   ├── app_proxy.py       # Dev app proxy with script injection
│   ├── session_manager.py # [Future] Claude session management
│   └── requirements.txt
│
├── screenshot-to-code/    # Frontend (git submodule)
│   └── frontend/          # React app
│
└── specs/                 # [Future] Archived blueprints
    └── archive/
```

---

## Open Questions

1. ~~**HMR passthrough:** How to proxy WebSocket connections for hot module reload?~~ **Resolved** - see `app_proxy.py:proxy_websocket()`
2. **Session cleanup:** When to expire old Claude sessions?
3. **Multi-project:** Support multiple projects in one pixel-forge instance?
4. **File watching:** Notify frontend when Claude modifies files?
