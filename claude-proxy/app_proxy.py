"""
App Proxy Module

Proxies requests to a user's dev server and injects selection script
into HTML responses for element inspection.
"""

import asyncio
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Request, Response, WebSocket, WebSocketDisconnect
import websockets

router = APIRouter()

# Configuration - will be set from main.py
TARGET_APP_URL = "http://localhost:3000"

# The selection script that gets injected into HTML responses
SELECTION_SCRIPT = """
<script data-pixel-forge-injected="true">
(function() {
  'use strict';

  // State
  let selectMode = false;
  let hoverOverlay = null;
  let hoverLabel = null;
  let currentTarget = null;
  let selectedElements = [];  // Array of {element, xpath, overlay, badge}
  const MAX_SELECTIONS = 10;

  // Create hover overlay (follows mouse)
  function createHoverOverlay() {
    if (hoverOverlay) return;
    hoverOverlay = document.createElement('div');
    hoverOverlay.id = 'pixel-forge-hover-overlay';
    hoverOverlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px dashed #3b82f6;
      background: rgba(59, 130, 246, 0.1);
      z-index: 2147483646;
      transition: all 0.05s ease-out;
      display: none;
      border-radius: 2px;
    `;
    document.body.appendChild(hoverOverlay);

    hoverLabel = document.createElement('div');
    hoverLabel.id = 'pixel-forge-hover-label';
    hoverLabel.style.cssText = `
      position: fixed;
      background: #3b82f6;
      color: white;
      font-size: 11px;
      font-family: ui-monospace, monospace;
      padding: 2px 6px;
      border-radius: 2px;
      z-index: 2147483646;
      pointer-events: none;
      display: none;
      white-space: nowrap;
    `;
    document.body.appendChild(hoverLabel);
  }

  // Create persistent selection overlay with badge
  function createSelectionOverlay(element, index) {
    const overlay = document.createElement('div');
    overlay.className = 'pixel-forge-selection';
    overlay.setAttribute('data-pixel-forge-injected', 'true');
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px solid #22c55e;
      background: rgba(34, 197, 94, 0.15);
      z-index: 2147483645;
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.3);
    `;
    document.body.appendChild(overlay);

    const badge = document.createElement('div');
    badge.className = 'pixel-forge-badge';
    badge.setAttribute('data-pixel-forge-injected', 'true');
    badge.textContent = String(index + 1);
    badge.style.cssText = `
      position: fixed;
      background: #22c55e;
      color: white;
      font-size: 10px;
      font-family: ui-monospace, monospace;
      font-weight: bold;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(badge);

    updateSelectionPosition(element, overlay, badge);
    return { overlay, badge };
  }

  // Update position of a selection overlay
  function updateSelectionPosition(element, overlay, badge) {
    const rect = element.getBoundingClientRect();
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    badge.style.top = (rect.top - 9) + 'px';
    badge.style.left = (rect.right - 9) + 'px';
  }

  // Update all selection positions (for scroll/resize)
  function updateAllPositions() {
    selectedElements.forEach(sel => {
      if (sel.element.isConnected) {
        updateSelectionPosition(sel.element, sel.overlay, sel.badge);
      }
    });
  }

  // Get XPath for element
  function getXPath(element) {
    if (!element) return '';
    if (element.id) return `//*[@id="${element.id}"]`;
    if (element === document.body) return '/html/body';

    let ix = 0;
    const siblings = element.parentNode ? element.parentNode.childNodes : [];
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        const parentPath = getXPath(element.parentNode);
        const tagName = element.tagName.toLowerCase();
        return `${parentPath}/${tagName}[${ix + 1}]`;
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix++;
      }
    }
    return '';
  }

  // Get element description for label
  function getElementLabel(el) {
    let label = el.tagName.toLowerCase();
    if (el.id) label += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(' ').filter(c => c).slice(0, 2);
      if (classes.length) label += '.' + classes.join('.');
    }
    return label;
  }

  // Check if element is already selected
  function isSelected(element) {
    const xpath = getXPath(element);
    return selectedElements.findIndex(sel => sel.xpath === xpath);
  }

  // Get element data for messaging
  function getElementData(element) {
    return {
      outerHTML: element.outerHTML,
      innerHTML: element.innerHTML,
      tagName: element.tagName.toLowerCase(),
      elementId: element.id || null,
      classList: [...element.classList],
      xpath: getXPath(element),
      textContent: element.textContent?.slice(0, 200) || '',
      attributes: Array.from(element.attributes).map(a => ({
        name: a.name,
        value: a.value
      })),
      rect: element.getBoundingClientRect()
    };
  }

  // Position hover overlay over element
  function highlightElement(el) {
    if (!hoverOverlay) createHoverOverlay();
    const rect = el.getBoundingClientRect();

    // If element is selected, show different style
    const selectedIndex = isSelected(el);
    if (selectedIndex >= 0) {
      hoverOverlay.style.borderColor = '#ef4444';
      hoverOverlay.style.background = 'rgba(239, 68, 68, 0.1)';
      hoverLabel.style.background = '#ef4444';
      hoverLabel.textContent = 'Click to deselect';
    } else {
      hoverOverlay.style.borderColor = '#3b82f6';
      hoverOverlay.style.background = 'rgba(59, 130, 246, 0.1)';
      hoverLabel.style.background = '#3b82f6';
      hoverLabel.textContent = getElementLabel(el);
    }

    hoverOverlay.style.top = rect.top + 'px';
    hoverOverlay.style.left = rect.left + 'px';
    hoverOverlay.style.width = rect.width + 'px';
    hoverOverlay.style.height = rect.height + 'px';
    hoverOverlay.style.display = 'block';

    hoverLabel.style.top = Math.max(0, rect.top - 20) + 'px';
    hoverLabel.style.left = rect.left + 'px';
    hoverLabel.style.display = 'block';

    currentTarget = el;
  }

  // Hide hover overlay
  function hideHoverOverlay() {
    if (hoverOverlay) hoverOverlay.style.display = 'none';
    if (hoverLabel) hoverLabel.style.display = 'none';
    currentTarget = null;
  }

  // Add element to selection
  function selectElement(element) {
    if (selectedElements.length >= MAX_SELECTIONS) {
      console.warn('[pixel-forge] Max selections reached');
      return;
    }

    const xpath = getXPath(element);
    const index = selectedElements.length;
    const { overlay, badge } = createSelectionOverlay(element, index);

    selectedElements.push({ element, xpath, overlay, badge });

    // Notify parent of selection
    window.parent.postMessage({
      type: 'pixel-forge-element-selected',
      data: getElementData(element)
    }, '*');

    // Also send updated selection array
    notifySelectionChange();
  }

  // Remove element from selection
  function deselectElement(index) {
    const sel = selectedElements[index];
    sel.overlay.remove();
    sel.badge.remove();
    selectedElements.splice(index, 1);

    // Renumber remaining badges
    selectedElements.forEach((s, i) => {
      s.badge.textContent = String(i + 1);
    });

    // Notify parent of deselection
    window.parent.postMessage({
      type: 'pixel-forge-element-deselected',
      data: { xpath: sel.xpath, index }
    }, '*');

    notifySelectionChange();
  }

  // Clear all selections
  function clearSelections() {
    selectedElements.forEach(sel => {
      sel.overlay.remove();
      sel.badge.remove();
    });
    selectedElements = [];
    notifySelectionChange();
  }

  // Notify parent of current selection state
  function notifySelectionChange() {
    window.parent.postMessage({
      type: 'pixel-forge-selection-changed',
      data: {
        count: selectedElements.length,
        elements: selectedElements.map(sel => getElementData(sel.element))
      }
    }, '*');
  }

  // Handle mouse movement
  function handleMouseMove(e) {
    if (!selectMode) return;

    // Skip our own elements
    if (e.target.hasAttribute('data-pixel-forge-injected') ||
        e.target.id?.startsWith('pixel-forge-')) {
      return;
    }

    highlightElement(e.target);
  }

  // Handle click
  function handleClick(e) {
    if (!selectMode) return;

    // Skip our own elements
    if (e.target.hasAttribute('data-pixel-forge-injected') ||
        e.target.id?.startsWith('pixel-forge-')) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const element = currentTarget || e.target;
    const selectedIndex = isSelected(element);

    if (selectedIndex >= 0) {
      // Deselect
      deselectElement(selectedIndex);
    } else {
      // Select
      selectElement(element);
    }

    return false;
  }

  // Handle keydown
  function handleKeyDown(e) {
    if (e.key === 'Escape' && selectMode) {
      window.parent.postMessage({
        type: 'pixel-forge-cancel-select'
      }, '*');
    }
  }

  // Listen for messages from parent
  window.addEventListener('message', (e) => {
    if (e.data.type === 'pixel-forge-toggle-select') {
      selectMode = e.data.enabled;
      if (selectMode) {
        createHoverOverlay();
        document.body.style.cursor = 'crosshair';
      } else {
        hideHoverOverlay();
        document.body.style.cursor = '';
      }
    } else if (e.data.type === 'pixel-forge-clear-selections') {
      clearSelections();
    } else if (e.data.type === 'pixel-forge-deselect') {
      const xpath = e.data.xpath;
      const index = selectedElements.findIndex(sel => sel.xpath === xpath);
      if (index >= 0) deselectElement(index);
    }
  });

  // Add event listeners
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);

  // Update positions on scroll/resize
  window.addEventListener('scroll', updateAllPositions, true);
  window.addEventListener('resize', updateAllPositions);

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    if (hoverOverlay) hoverOverlay.remove();
    if (hoverLabel) hoverLabel.remove();
    selectedElements.forEach(sel => {
      sel.overlay.remove();
      sel.badge.remove();
    });
  });

  console.log('[pixel-forge] Selection script v2 loaded (multi-select enabled)');
})();
</script>
"""


def set_target_url(url: str):
    """Set the target app URL to proxy to."""
    global TARGET_APP_URL
    TARGET_APP_URL = url.rstrip('/')
    print(f"[app-proxy] Target URL set to: {TARGET_APP_URL}")


def rewrite_js_imports(js_content: bytes) -> bytes:
    """Rewrite absolute import paths in JavaScript to go through /app/ prefix."""
    import re
    js_str = js_content.decode('utf-8', errors='replace')

    # Rewrite ES module imports with absolute paths
    # IMPORTANT: Use negative lookahead (?!app/) to avoid double-rewriting

    # Bare imports (side-effect only): import "/@fs/..." or import "/src/..."
    js_str = re.sub(r'import\s+"(/@[^"]+)"', r'import "/app\1"', js_str)
    js_str = re.sub(r'import\s+"(/(?!app/)[^/"@][^"]*)"', r'import "/app\1"', js_str)
    js_str = re.sub(r"import\s+'(/@[^']+)'", r"import '/app\1'", js_str)
    js_str = re.sub(r"import\s+'(/(?!app/)[^/'@][^']*)'", r"import '/app\1'", js_str)

    # Named imports: import ... from "/@vite/..." or from "/src/..."
    js_str = re.sub(r'from\s*"(/@[^"]+)"', r'from "/app\1"', js_str)
    js_str = re.sub(r'from\s*"(/(?!app/)[^/"@][^"]*)"', r'from "/app\1"', js_str)

    # Rewrite dynamic imports: import("/@vite/...")
    js_str = re.sub(r'import\s*\(\s*"(/@[^"]+)"\s*\)', r'import("/app\1")', js_str)
    js_str = re.sub(r'import\s*\(\s*"(/(?!app/)[^/"@][^"]*)"\s*\)', r'import("/app\1")', js_str)

    # Rewrite single-quoted named imports and dynamic imports
    js_str = re.sub(r"from\s*'(/@[^']+)'", r"from '/app\1'", js_str)
    js_str = re.sub(r"from\s*'(/(?!app/)[^/'@][^']*)'", r"from '/app\1'", js_str)
    js_str = re.sub(r"import\s*\(\s*'(/@[^']+)'\s*\)", r"import('/app\1')", js_str)
    js_str = re.sub(r"import\s*\(\s*'(/(?!app/)[^/'@][^']*)'\s*\)", r"import('/app\1')", js_str)

    # Rewrite fetch/XHR URLs that use absolute paths
    # new URL("/src/...", import.meta.url) - but not /app/ paths
    js_str = re.sub(r'new\s+URL\s*\(\s*"(/(?!app/)[^"]+)"', r'new URL("/app\1"', js_str)
    js_str = re.sub(r"new\s+URL\s*\(\s*'(/(?!app/)[^']+)'", r"new URL('/app\1'", js_str)

    return js_str.encode('utf-8')


def inject_script(html_content: bytes) -> bytes:
    """Inject selection script into HTML content and rewrite absolute paths."""
    import re
    html_str = html_content.decode('utf-8', errors='replace')

    # Rewrite absolute paths to go through /app/ prefix
    # This handles Vite/Webpack style imports like /@vite/client, /src/main.tsx
    # IMPORTANT: Use negative lookahead (?!/app/) to avoid double-rewriting

    # 1. Handle src="/" and href="/" attributes (but not protocol-relative // or already /app/)
    html_str = re.sub(r'(src|href)="(/(?!app/)[^/"@][^"]*)"', r'\1="/app\2"', html_str)

    # 2. Handle @-prefixed paths in attributes like /@vite/client, /@react-refresh
    html_str = re.sub(r'(src|href)="(/@[^"]*)"', r'\1="/app\2"', html_str)

    # 3. Handle ES module imports: import ... from "/@vite/..." or from "/src/..."
    # Note: @-prefixed must come first, then regular paths with negative lookahead for /app/
    html_str = re.sub(r'from\s+"(/@[^"]+)"', r'from "/app\1"', html_str)
    html_str = re.sub(r'from\s+"(/(?!app/)[^/"@][^"]*)"', r'from "/app\1"', html_str)

    # 4. Handle dynamic imports: import("/@vite/...")
    html_str = re.sub(r'import\s*\(\s*"(/@[^"]+)"\s*\)', r'import("/app\1")', html_str)
    html_str = re.sub(r'import\s*\(\s*"(/(?!app/)[^/"@][^"]*)"\s*\)', r'import("/app\1")', html_str)

    # Try to inject before </head> first, then </body>, then end of file
    if '</head>' in html_str:
        html_str = html_str.replace('</head>', SELECTION_SCRIPT + '</head>', 1)
    elif '</body>' in html_str:
        html_str = html_str.replace('</body>', SELECTION_SCRIPT + '</body>', 1)
    elif '</html>' in html_str:
        html_str = html_str.replace('</html>', SELECTION_SCRIPT + '</html>', 1)
    else:
        html_str += SELECTION_SCRIPT

    return html_str.encode('utf-8')


@router.api_route("/app/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_http(request: Request, path: str = ""):
    """Proxy HTTP requests to target app and inject selection script."""

    target_url = f"{TARGET_APP_URL}/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    # Build headers, removing host
    headers = dict(request.headers)
    headers.pop('host', None)
    headers.pop('Host', None)

    # Add forwarding headers
    headers['X-Forwarded-For'] = request.client.host if request.client else '127.0.0.1'
    headers['X-Forwarded-Proto'] = request.url.scheme

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=await request.body() if request.method in ["POST", "PUT", "PATCH"] else None,
            )

            content = response.content
            response_headers = dict(response.headers)

            # Remove headers that would break the proxy
            for header in ['content-encoding', 'content-length', 'transfer-encoding']:
                response_headers.pop(header, None)
                response_headers.pop(header.title(), None)

            # Inject script into HTML responses, rewrite paths in JS
            content_type = response_headers.get('content-type', response_headers.get('Content-Type', ''))
            if 'text/html' in content_type:
                content = inject_script(content)
            elif 'javascript' in content_type or 'application/json' in content_type:
                content = rewrite_js_imports(content)

            # Update content length
            response_headers['Content-Length'] = str(len(content))

            return Response(
                content=content,
                status_code=response.status_code,
                headers=response_headers,
            )

    except httpx.ConnectError:
        return Response(
            content=f"<html><body><h1>Cannot connect to {TARGET_APP_URL}</h1><p>Make sure your dev server is running.</p></body></html>",
            status_code=502,
            media_type="text/html"
        )
    except Exception as e:
        return Response(
            content=f"<html><body><h1>Proxy Error</h1><p>{str(e)}</p></body></html>",
            status_code=500,
            media_type="text/html"
        )


@router.websocket("/app/{path:path}")
async def proxy_websocket(websocket: WebSocket, path: str = ""):
    """Proxy WebSocket connections for HMR support."""

    await websocket.accept()

    # Parse target WebSocket URL
    target_parsed = urlparse(TARGET_APP_URL)
    ws_scheme = 'wss' if target_parsed.scheme == 'https' else 'ws'
    target_ws_url = f"{ws_scheme}://{target_parsed.netloc}/{path}"

    print(f"[app-proxy] WebSocket connecting to: {target_ws_url}")

    target_ws = None
    try:
        target_ws = await websockets.connect(
            target_ws_url,
            additional_headers={},
            ping_interval=None,  # Let the target handle pings
        )

        async def forward_to_target():
            """Forward messages from client to target."""
            try:
                while True:
                    data = await websocket.receive()
                    if 'text' in data:
                        await target_ws.send(data['text'])
                    elif 'bytes' in data:
                        await target_ws.send(data['bytes'])
            except WebSocketDisconnect:
                pass
            except Exception as e:
                print(f"[app-proxy] Error forwarding to target: {e}")

        async def forward_to_client():
            """Forward messages from target to client."""
            try:
                async for message in target_ws:
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    else:
                        await websocket.send_bytes(message)
            except Exception as e:
                print(f"[app-proxy] Error forwarding to client: {e}")

        # Run both directions concurrently
        await asyncio.gather(
            forward_to_target(),
            forward_to_client(),
            return_exceptions=True
        )

    except Exception as e:
        print(f"[app-proxy] WebSocket error: {e}")
    finally:
        if target_ws:
            await target_ws.close()
        try:
            await websocket.close()
        except:
            pass


# Root path handler
@router.get("/app")
@router.get("/app/")
async def proxy_root(request: Request):
    """Handle root path."""
    return await proxy_http(request, "")


# Note: Individual routes removed in favor of catch-all proxy below


async def proxy_http_to_target(request: Request, path: str):
    """Proxy HTTP request to target app without script injection."""
    target_url = f"{TARGET_APP_URL}/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    headers = dict(request.headers)
    headers.pop('host', None)
    headers.pop('Host', None)
    headers['X-Forwarded-For'] = request.client.host if request.client else '127.0.0.1'
    headers['X-Forwarded-Proto'] = request.url.scheme

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=await request.body() if request.method in ["POST", "PUT", "PATCH"] else None,
            )

            response_headers = dict(response.headers)
            for header in ['content-encoding', 'content-length', 'transfer-encoding']:
                response_headers.pop(header, None)
                response_headers.pop(header.title(), None)

            response_headers['Content-Length'] = str(len(response.content))

            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=response_headers,
            )

    except httpx.ConnectError:
        return Response(content="Cannot connect to target app", status_code=502)
    except Exception as e:
        return Response(content=str(e), status_code=500)


@router.websocket("/")
async def proxy_root_websocket(websocket: WebSocket):
    """
    Proxy root WebSocket connections for Vite HMR support.

    Vite's HMR client connects to ws://host/?token=... at the root level,
    even when the app is served through /app/. This handler intercepts
    those connections and proxies them to the target dev server.
    """
    await websocket.accept()

    # Parse target WebSocket URL
    target_parsed = urlparse(TARGET_APP_URL)
    ws_scheme = 'wss' if target_parsed.scheme == 'https' else 'ws'
    target_ws_url = f"{ws_scheme}://{target_parsed.netloc}/"

    print(f"[app-proxy] HMR WebSocket connecting to: {target_ws_url}")

    target_ws = None
    try:
        target_ws = await websockets.connect(
            target_ws_url,
            additional_headers={},
            ping_interval=None,
        )

        async def forward_to_target():
            """Forward messages from client to target."""
            try:
                while True:
                    data = await websocket.receive()
                    if 'text' in data:
                        await target_ws.send(data['text'])
                    elif 'bytes' in data:
                        await target_ws.send(data['bytes'])
            except WebSocketDisconnect:
                pass
            except Exception as e:
                print(f"[app-proxy] HMR Error forwarding to target: {e}")

        async def forward_to_client():
            """Forward messages from target to client."""
            try:
                async for message in target_ws:
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    else:
                        await websocket.send_bytes(message)
            except Exception as e:
                print(f"[app-proxy] HMR Error forwarding to client: {e}")

        # Run both directions concurrently
        await asyncio.gather(
            forward_to_target(),
            forward_to_client(),
            return_exceptions=True
        )

    except Exception as e:
        print(f"[app-proxy] HMR WebSocket error: {e}")
    finally:
        if target_ws:
            await target_ws.close()
        try:
            await websocket.close()
        except:
            pass


# =============================================================================
# CATCH-ALL PROXY - Must be last! Forwards any unhandled request to target app
# =============================================================================

@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def catch_all_proxy(request: Request, path: str = ""):
    """
    Catch-all proxy for any path not handled by specific routes.

    This enables the proxy to work with ANY app without needing to
    configure specific routes for /auth, /api, /src, /@vite, etc.
    """
    # Skip paths that are handled by explicit routes
    if path.startswith("app/") or path == "app":
        # Let the /app/* routes handle this
        return await proxy_http(request, path[4:] if path.startswith("app/") else "")

    # Proxy everything else directly to target
    return await proxy_http_to_target(request, path)
