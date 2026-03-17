"""
App Proxy Module

Proxies requests to a target app or website and injects selection script
into HTML responses for element inspection.
"""

import asyncio
import json
import secrets
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlparse

import httpx
from fastapi import APIRouter, Request, Response, WebSocket, WebSocketDisconnect
import websockets

router = APIRouter()

# Optional fallback target. The live editor should normally use an explicit
# browser-scoped proxy session instead of relying on a global target.
TARGET_APP_URL: str | None = None
PROXY_SESSION_COOKIE = "pixel_forge_proxy_session"
PROXY_SESSION_TTL_SECONDS = 60 * 60 * 8


@dataclass
class ProxySession:
    session_id: str
    target_url: str
    client: httpx.AsyncClient
    created_at: float
    updated_at: float


PROXY_SESSIONS: dict[str, ProxySession] = {}
PROXY_SESSIONS_LOCK = asyncio.Lock()

# The selection script that gets injected into HTML responses
SELECTION_SCRIPT_TEMPLATE = """
<script data-pixel-forge-injected="true">
(function() {
  'use strict';

  const pixelForgeTargetUrl = "__PIXEL_FORGE_TARGET_URL__";
  const pixelForgeProxyPrefix = "__PIXEL_FORGE_PROXY_PREFIX__";

  // State
  let selectMode = false;
  let hoverOverlay = null;
  let hoverLabel = null;
  let currentTarget = null;
  let selectedElements = [];  // Array of {element, xpath, overlay, badge}
  let desiredSelections = [];
  let reconcileFrame = null;
  let domObserver = null;
  let authFailureSeen = false;

  function notifyAuthFailure(status, url) {
    if (authFailureSeen) return;
    authFailureSeen = true;
    window.parent.postMessage({
      type: 'pixel-forge-auth-required',
      data: { status, url }
    }, '*');
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = async function(...args) {
      const response = await originalFetch(...args);
      if (response && (response.status === 401 || response.status === 403)) {
        notifyAuthFailure(response.status, response.url || String(args[0] || ''));
      }
      return response;
    };
  }

  function getTargetLocationHref() {
    try {
      const currentUrl = new URL(window.location.href);
      if (!pixelForgeTargetUrl || !pixelForgeProxyPrefix) {
        return currentUrl.href;
      }

      if (!currentUrl.pathname.startsWith(pixelForgeProxyPrefix)) {
        return currentUrl.href;
      }

      const initialTargetUrl = new URL(pixelForgeTargetUrl);
      const relativePath = currentUrl.pathname.slice(pixelForgeProxyPrefix.length);
      const hasNonProxyQuery = Array.from(currentUrl.searchParams.keys())
        .some((key) => !key.startsWith('_pf_'));

      if ((!relativePath || relativePath === '/') && !hasNonProxyQuery && !currentUrl.hash) {
        return initialTargetUrl.href;
      }

      const resolvedUrl = new URL(initialTargetUrl.origin);
      resolvedUrl.pathname = relativePath || initialTargetUrl.pathname || '/';
      resolvedUrl.search = currentUrl.search;
      resolvedUrl.hash = currentUrl.hash;
      return resolvedUrl.href;
    } catch (error) {
      console.warn('[pixel-forge] Failed to resolve target location', error);
      return window.location.href;
    }
  }

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__pixelForgeUrl = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
      if (this.status === 401 || this.status === 403) {
        notifyAuthFailure(this.status, this.responseURL || String(this.__pixelForgeUrl || ''));
      }
    });
    return originalXHRSend.call(this, ...args);
  };

  // Create hover overlay (follows mouse)
  function createHoverOverlay() {
    if (hoverOverlay) return;
    hoverOverlay = document.createElement('div');
    hoverOverlay.id = 'pixel-forge-hover-overlay';
    hoverOverlay.setAttribute('data-pixel-forge-injected', 'true');
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
    hoverLabel.setAttribute('data-pixel-forge-injected', 'true');
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

  function normalizeGlobalIndex(value, fallbackIndex) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return Math.round(numericValue);
    }
    return fallbackIndex;
  }

  function normalizeAppliedSelections(selections) {
    return (selections || []).flatMap((entry, index) => {
      if (typeof entry === 'string') {
        return [{
          id: entry,
          xpath: entry,
          globalIndex: index + 1,
          tagName: '',
          elementId: null,
          classList: [],
          textSample: ''
        }];
      }

      if (!entry || typeof entry !== 'object' || typeof entry.xpath !== 'string') {
        return [];
      }

      return [{
        id: typeof entry.id === 'string' ? entry.id : entry.xpath,
        xpath: entry.xpath,
        globalIndex: normalizeGlobalIndex(entry.globalIndex, index + 1),
        tagName: typeof entry.tagName === 'string' ? entry.tagName : '',
        elementId: typeof entry.elementId === 'string' ? entry.elementId : null,
        classList: Array.isArray(entry.classList)
          ? entry.classList.filter((value) => typeof value === 'string')
          : [],
        textSample: typeof entry.textSample === 'string'
          ? entry.textSample.replace(/\\s+/g, ' ').trim().slice(0, 120)
          : ''
      }];
    });
  }

  function normalizeTextSample(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  }

  function selectionKey(selection) {
    return String(selection?.id || selection?.xpath || '');
  }

  function isElementVisiblyRenderable(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function matchesSelectionFingerprint(element, selection) {
    if (!(element instanceof Element)) {
      return false;
    }

    if (selection.tagName && element.tagName.toLowerCase() !== selection.tagName) {
      return false;
    }

    if (selection.elementId && element.id !== selection.elementId) {
      return false;
    }

    if (selection.classList.length > 0) {
      const matchedClasses = selection.classList.filter((className) => element.classList.contains(className)).length;
      if (!selection.elementId && matchedClasses === 0) {
        return false;
      }
    }

    const expectedText = normalizeTextSample(selection.textSample);
    if (expectedText) {
      const actualText = normalizeTextSample(element.textContent);
      const expectedPrefix = expectedText.slice(0, 48);
      if (!actualText || !actualText.includes(expectedPrefix)) {
        return false;
      }
    }

    return isElementVisiblyRenderable(element);
  }

  function resolveSelectionElement(selection) {
    const element = findElementByXPath(selection.xpath);
    if (!element) {
      return null;
    }

    return matchesSelectionFingerprint(element, selection) ? element : null;
  }

  function removeRenderedSelection(entry) {
    entry.overlay.remove();
    entry.badge.remove();
  }

  function shouldIgnoreMutationNode(node) {
    return node instanceof Element && node.hasAttribute('data-pixel-forge-injected');
  }

  // Create persistent selection overlay with badge
  function createSelectionOverlay(element, globalIndex) {
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
    badge.textContent = String(globalIndex);
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

  function scheduleSelectionReconcile() {
    if (reconcileFrame !== null) {
      return;
    }

    reconcileFrame = window.requestAnimationFrame(() => {
      reconcileFrame = null;
      reconcileDesiredSelections();
    });
  }

  function reconcileDesiredSelections() {
    const desiredByKey = new Map(desiredSelections.map((selection) => [selectionKey(selection), selection]));
    const nextRenderedSelections = [];

    for (const entry of selectedElements) {
      const desiredSelection = desiredByKey.get(entry.selectionKey);
      if (!desiredSelection) {
        removeRenderedSelection(entry);
        continue;
      }

      const resolvedElement = resolveSelectionElement(desiredSelection);
      if (!resolvedElement) {
        removeRenderedSelection(entry);
        continue;
      }

      if (entry.element !== resolvedElement) {
        removeRenderedSelection(entry);
        continue;
      }

      entry.globalIndex = normalizeGlobalIndex(desiredSelection.globalIndex, entry.globalIndex);
      entry.badge.textContent = String(entry.globalIndex);
      updateSelectionPosition(entry.element, entry.overlay, entry.badge);
      nextRenderedSelections.push(entry);
    }

    selectedElements = nextRenderedSelections;

    for (const desiredSelection of desiredSelections) {
      const key = selectionKey(desiredSelection);
      if (selectedElements.some((entry) => entry.selectionKey === key)) {
        continue;
      }

      const resolvedElement = resolveSelectionElement(desiredSelection);
      if (!resolvedElement) {
        continue;
      }

      const globalIndex = normalizeGlobalIndex(desiredSelection.globalIndex, selectedElements.length + 1);
      const { overlay, badge } = createSelectionOverlay(resolvedElement, globalIndex);
      selectedElements.push({
        selectionKey: key,
        element: resolvedElement,
        xpath: desiredSelection.xpath,
        overlay,
        badge,
        globalIndex,
      });
    }
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
      textContent: normalizeTextSample(element.textContent).slice(0, 200),
      attributes: Array.from(element.attributes).map(a => ({
        name: a.name,
        value: a.value
      })),
      rect: element.getBoundingClientRect(),
      pageUrl: getTargetLocationHref(),
      pageTitle: document.title || null
    };
  }

  function findElementByXPath(xpath) {
    if (!xpath) return null;
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    } catch (error) {
      console.warn('[pixel-forge] Failed to evaluate xpath', xpath, error);
      return null;
    }
  }

  function notifyLocationChange() {
    window.parent.postMessage({
      type: 'pixel-forge-location-changed',
      data: {
        url: getTargetLocationHref(),
        title: document.title || null
      }
    }, '*');
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
  function selectElement(element, notifyParent = true, selection = null) {
    const xpath = getXPath(element);
    const resolvedGlobalIndex = normalizeGlobalIndex(selection?.globalIndex, selectedElements.length + 1);
    const { overlay, badge } = createSelectionOverlay(element, resolvedGlobalIndex);

    selectedElements.push({
      selectionKey: selectionKey(selection || { xpath }),
      element,
      xpath,
      overlay,
      badge,
      globalIndex: resolvedGlobalIndex,
    });

    // Notify parent of selection
    if (notifyParent) {
      window.parent.postMessage({
        type: 'pixel-forge-element-selected',
        data: getElementData(element)
      }, '*');

      // Also send updated selection array
      notifySelectionChange();
    }
  }

  // Remove element from selection
  function deselectElement(index, notifyParent = true) {
    const sel = selectedElements[index];
    sel.overlay.remove();
    sel.badge.remove();
    selectedElements.splice(index, 1);

    // Notify parent of deselection
    if (notifyParent) {
      window.parent.postMessage({
        type: 'pixel-forge-element-deselected',
        data: {
          xpath: sel.xpath,
          index,
          pageUrl: getTargetLocationHref(),
          pageTitle: document.title || null
        }
      }, '*');

      notifySelectionChange();
    }
  }

  // Clear all selections
  function clearSelections(notifyParent = true) {
    desiredSelections = [];
    selectedElements.forEach(sel => {
      removeRenderedSelection(sel);
    });
    selectedElements = [];
    if (notifyParent) {
      notifySelectionChange();
    }
  }

  function applySelections(selections) {
    desiredSelections = normalizeAppliedSelections(selections);
    reconcileDesiredSelections();
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
      desiredSelections = desiredSelections.filter((selection) => selection.xpath !== xpath);
      const index = selectedElements.findIndex(sel => sel.xpath === xpath);
      if (index >= 0) deselectElement(index);
      scheduleSelectionReconcile();
    } else if (e.data.type === 'pixel-forge-apply-selections') {
      applySelections(
        Array.isArray(e.data.selections)
          ? e.data.selections
          : Array.isArray(e.data.xpaths)
            ? e.data.xpaths
            : []
      );
    }
  });

  const originalPushState = history.pushState.bind(history);
  history.pushState = function(...args) {
    const result = originalPushState(...args);
    queueMicrotask(() => {
      notifyLocationChange();
      scheduleSelectionReconcile();
    });
    return result;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function(...args) {
    const result = originalReplaceState(...args);
    queueMicrotask(() => {
      notifyLocationChange();
      scheduleSelectionReconcile();
    });
    return result;
  };

  // Add event listeners
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mouseleave', hideHoverOverlay);
  window.addEventListener('hashchange', () => {
    notifyLocationChange();
    scheduleSelectionReconcile();
  });
  window.addEventListener('popstate', () => {
    notifyLocationChange();
    scheduleSelectionReconcile();
  });
  window.addEventListener('load', () => {
    notifyLocationChange();
    scheduleSelectionReconcile();
  });

  // Update positions on scroll/resize
  window.addEventListener('scroll', updateAllPositions, true);
  window.addEventListener('resize', () => {
    updateAllPositions();
    scheduleSelectionReconcile();
  });

  if (!domObserver && document.documentElement) {
    domObserver = new MutationObserver((mutations) => {
      const shouldReconcile = mutations.some((mutation) => {
        if (mutation.type === 'attributes') {
          return !shouldIgnoreMutationNode(mutation.target);
        }

        if (shouldIgnoreMutationNode(mutation.target)) {
          return false;
        }

        return [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) => !shouldIgnoreMutationNode(node)
        );
      });

      if (shouldReconcile) {
        scheduleSelectionReconcile();
      }
    });
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  const titleElement = document.querySelector('title');
  if (titleElement) {
    const titleObserver = new MutationObserver(() => notifyLocationChange());
    titleObserver.observe(titleElement, { childList: true, subtree: true, characterData: true });
  }

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
  notifyLocationChange();
  scheduleSelectionReconcile();
})();
</script>
"""


def _normalize_target_url(url: str) -> str:
    normalized = url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Target URL must be a valid http or https URL")
    return normalized.rstrip("/")


def _target_origin(target_url: str) -> str:
    parsed = urlparse(target_url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _same_origin(left: str, right: str) -> bool:
    left_parsed = urlparse(left)
    right_parsed = urlparse(right)
    return (
        left_parsed.scheme == right_parsed.scheme
        and left_parsed.netloc == right_parsed.netloc
    )


def _create_proxy_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=True, timeout=30.0)


async def _cleanup_proxy_sessions() -> None:
    stale_sessions: list[ProxySession] = []
    now = time.time()

    async with PROXY_SESSIONS_LOCK:
        for session_id, session in list(PROXY_SESSIONS.items()):
            if now - session.updated_at > PROXY_SESSION_TTL_SECONDS:
                stale_sessions.append(PROXY_SESSIONS.pop(session_id))

    for session in stale_sessions:
        await session.client.aclose()


async def configure_proxy_target(
    target_url: str,
    session_id: str | None = None,
) -> ProxySession:
    normalized_target_url = _normalize_target_url(target_url)
    await _cleanup_proxy_sessions()

    replaced_client: httpx.AsyncClient | None = None

    async with PROXY_SESSIONS_LOCK:
        resolved_session_id = session_id or secrets.token_urlsafe(24)
        existing = PROXY_SESSIONS.get(resolved_session_id)

        if existing:
            if _same_origin(existing.target_url, normalized_target_url):
                existing.target_url = normalized_target_url
                existing.updated_at = time.time()
                print(
                    f"[app-proxy] Target URL updated for session {resolved_session_id}: {normalized_target_url}"
                )
                return existing

            replaced_client = existing.client

        session = ProxySession(
            session_id=resolved_session_id,
            target_url=normalized_target_url,
            client=_create_proxy_client(),
            created_at=time.time(),
            updated_at=time.time(),
        )
        PROXY_SESSIONS[resolved_session_id] = session

    if replaced_client is not None:
        await replaced_client.aclose()

    print(
        f"[app-proxy] Target URL set for session {session.session_id}: {session.target_url}"
    )
    return session


async def get_proxy_target_url(session_id: str | None = None) -> str | None:
    if session_id:
        session = await get_proxy_session(session_id)
        if session:
            return session.target_url
    return TARGET_APP_URL


async def clear_proxy_session(session_id: str | None) -> None:
    if not session_id:
        return

    await _cleanup_proxy_sessions()
    session: ProxySession | None = None
    async with PROXY_SESSIONS_LOCK:
        session = PROXY_SESSIONS.pop(session_id, None)

    if session is not None:
        await session.client.aclose()


def _missing_target_response() -> Response:
    return Response(
        content=(
            "<html><body><h1>No target configured</h1>"
            "<p>Load a preview URL in Pixel Forge before opening the proxy.</p>"
            "</body></html>"
        ),
        status_code=409,
        media_type="text/html",
    )


async def get_proxy_session(session_id: str | None) -> ProxySession | None:
    if not session_id:
        return None

    await _cleanup_proxy_sessions()
    async with PROXY_SESSIONS_LOCK:
        session = PROXY_SESSIONS.get(session_id)
        if session:
            session.updated_at = time.time()
        return session


def _build_target_url(target_url: str, path: str, query: str = "") -> str:
    # Resolve against the origin, not the full target path.
    # The incoming path (after /app/ prefix stripping) is already the full
    # upstream path the server expects — urljoin against a path-bearing target
    # URL would double the path component (e.g. /lab/lab/app.css).
    origin = _target_origin(target_url)
    upstream_url = f"{origin}/{path.lstrip('/')}" if path else target_url
    if query:
        return f"{upstream_url}?{query}"
    return upstream_url


def _request_origin(request: Request) -> str:
    return f"{request.url.scheme}://{request.url.netloc}"


def _rewrite_origin_header(origin: str, request: Request, target_url: str) -> str:
    if origin.startswith(_request_origin(request)):
        return _target_origin(target_url)
    return origin


def _rewrite_referer_header(referer: str, request: Request, target_url: str) -> str:
    request_origin = _request_origin(request)
    if not referer.startswith(request_origin):
        return referer

    parsed = urlparse(referer)
    path = parsed.path
    if path == "/app":
        rewritten_path = ""
    elif path.startswith("/app/"):
        rewritten_path = path[len("/app/") :]
    else:
        rewritten_path = path.lstrip("/")

    return _build_target_url(target_url, rewritten_path, parsed.query)


def _build_forward_headers(request: Request, target_url: str) -> dict[str, str]:
    headers: dict[str, str] = {}

    for key, value in request.headers.items():
        lower = key.lower()
        if lower in {
            "host",
            "cookie",
            "content-length",
            "content-encoding",
            "connection",
            "accept-encoding",
        }:
            continue
        if lower == "origin":
            headers[key] = _rewrite_origin_header(value, request, target_url)
            continue
        if lower == "referer":
            headers[key] = _rewrite_referer_header(value, request, target_url)
            continue
        headers[key] = value

    headers["X-Forwarded-For"] = (
        request.client.host if request.client else "127.0.0.1"
    )
    headers["X-Forwarded-Proto"] = request.url.scheme
    headers["X-Forwarded-Host"] = request.url.netloc
    headers["Accept-Encoding"] = "identity"
    return headers


def _sync_browser_cookies(request: Request, session: ProxySession) -> None:
    parsed = urlparse(session.target_url)
    if not parsed.hostname:
        return

    for name, value in request.cookies.items():
        if name == PROXY_SESSION_COOKIE:
            continue
        session.client.cookies.set(name, value, domain=parsed.hostname, path="/")


def _cookie_header_for_target(session: ProxySession, target_url: str) -> str:
    parsed = urlparse(target_url)
    request_path = parsed.path or "/"
    cookie_pairs: list[str] = []

    for cookie in session.client.cookies.jar:
        if cookie.is_expired():
            continue
        if cookie.secure and parsed.scheme not in {"https", "wss"}:
            continue
        if cookie.domain_specified:
            if not parsed.hostname:
                continue
            domain = cookie.domain.lstrip(".")
            if parsed.hostname != domain and not parsed.hostname.endswith(f".{domain}"):
                continue
        if cookie.path and cookie.path != "/" and not request_path.startswith(cookie.path):
            continue
        cookie_pairs.append(f"{cookie.name}={cookie.value}")

    return "; ".join(cookie_pairs)


def _proxy_prefix(session_id: str | None) -> str:
    return f"/app/s/{session_id}" if session_id else "/app"


def _extract_session_path(path: str) -> tuple[str | None, str]:
    normalized = path.lstrip("/")
    if not normalized.startswith("s/"):
        return None, path

    parts = normalized.split("/", 2)
    if len(parts) < 2 or not parts[1]:
        return None, path

    upstream_path = parts[2] if len(parts) > 2 else ""
    return parts[1], upstream_path


def _filter_proxy_query(query: str) -> str:
    if not query:
        return ""

    kept_params = [
        (key, value)
        for key, value in parse_qsl(query, keep_blank_values=True)
        if not key.startswith("_pf_")
    ]
    return urlencode(kept_params, doseq=True)


def rewrite_js_imports(js_content: bytes, proxy_prefix: str) -> bytes:
    """Rewrite absolute import paths in JavaScript to go through /app/ prefix."""
    import re
    js_str = js_content.decode('utf-8', errors='replace')

    # Rewrite ES module imports with absolute paths
    # IMPORTANT: Use negative lookahead (?!app/) to avoid double-rewriting

    # Bare imports (side-effect only): import "/@fs/..." or import "/src/..."
    js_str = re.sub(r'import\s+"(/@[^"]+)"', rf'import "{proxy_prefix}\1"', js_str)
    js_str = re.sub(
        r'import\s+"(/(?!app/)[^/"@][^"]*)"',
        rf'import "{proxy_prefix}\1"',
        js_str,
    )
    js_str = re.sub(r"import\s+'(/@[^']+)'", rf"import '{proxy_prefix}\1'", js_str)
    js_str = re.sub(
        r"import\s+'(/(?!app/)[^/'@][^']*)'",
        rf"import '{proxy_prefix}\1'",
        js_str,
    )

    # Named imports: import ... from "/@vite/..." or from "/src/..."
    js_str = re.sub(r'from\s*"(/@[^"]+)"', rf'from "{proxy_prefix}\1"', js_str)
    js_str = re.sub(
        r'from\s*"(/(?!app/)[^/"@][^"]*)"',
        rf'from "{proxy_prefix}\1"',
        js_str,
    )

    # Rewrite dynamic imports: import("/@vite/...")
    js_str = re.sub(
        r'import\s*\(\s*"(/@[^"]+)"\s*\)',
        rf'import("{proxy_prefix}\1")',
        js_str,
    )
    js_str = re.sub(
        r'import\s*\(\s*"(/(?!app/)[^/"@][^"]*)"\s*\)',
        rf'import("{proxy_prefix}\1")',
        js_str,
    )

    # Rewrite single-quoted named imports and dynamic imports
    js_str = re.sub(r"from\s*'(/@[^']+)'", rf"from '{proxy_prefix}\1'", js_str)
    js_str = re.sub(
        r"from\s*'(/(?!app/)[^/'@][^']*)'",
        rf"from '{proxy_prefix}\1'",
        js_str,
    )
    js_str = re.sub(
        r"import\s*\(\s*'(/@[^']+)'\s*\)",
        rf"import('{proxy_prefix}\1')",
        js_str,
    )
    js_str = re.sub(
        r"import\s*\(\s*'(/(?!app/)[^/'@][^']*)'\s*\)",
        rf"import('{proxy_prefix}\1')",
        js_str,
    )

    # Rewrite fetch/XHR URLs that use absolute paths
    # new URL("/src/...", import.meta.url) - but not /app/ paths
    js_str = re.sub(
        r'new\s+URL\s*\(\s*"(/(?!app/)[^"]+)"',
        rf'new URL("{proxy_prefix}\1"',
        js_str,
    )
    js_str = re.sub(
        r"new\s+URL\s*\(\s*'(/(?!app/)[^']+)'",
        rf"new URL('{proxy_prefix}\1'",
        js_str,
    )

    return js_str.encode('utf-8')


def inject_script(html_content: bytes, proxy_prefix: str, target_url: str) -> bytes:
    """Inject selection script into HTML content and rewrite absolute paths."""
    import re
    html_str = html_content.decode('utf-8', errors='replace')

    html_str = re.sub(
        r"<meta[^>]+http-equiv=['\"]Content-Security-Policy(?:-Report-Only)?['\"][^>]*>\s*",
        "",
        html_str,
        flags=re.IGNORECASE,
    )

    # Rewrite absolute paths to go through /app/ prefix
    # This handles Vite/Webpack style imports like /@vite/client, /src/main.tsx
    # IMPORTANT: Use negative lookahead (?!/app/) to avoid double-rewriting

    # 1. Handle src="/" and href="/" attributes (but not protocol-relative // or already /app/)
    html_str = re.sub(
        r'(src|href)="(/(?!app/)[^/"@][^"]*)"',
        rf'\1="{proxy_prefix}\2"',
        html_str,
    )

    # 2. Handle @-prefixed paths in attributes like /@vite/client, /@react-refresh
    html_str = re.sub(
        r'(src|href)="(/@[^"]*)"',
        rf'\1="{proxy_prefix}\2"',
        html_str,
    )

    # 3. Handle ES module imports: import ... from "/@vite/..." or from "/src/..."
    # Note: @-prefixed must come first, then regular paths with negative lookahead for /app/
    html_str = re.sub(r'from\s+"(/@[^"]+)"', rf'from "{proxy_prefix}\1"', html_str)
    html_str = re.sub(
        r'from\s+"(/(?!app/)[^/"@][^"]*)"',
        rf'from "{proxy_prefix}\1"',
        html_str,
    )

    # 4. Handle dynamic imports: import("/@vite/...")
    html_str = re.sub(
        r'import\s*\(\s*"(/@[^"]+)"\s*\)',
        rf'import("{proxy_prefix}\1")',
        html_str,
    )
    html_str = re.sub(
        r'import\s*\(\s*"(/(?!app/)[^/"@][^"]*)"\s*\)',
        rf'import("{proxy_prefix}\1")',
        html_str,
    )

    selection_script = (
        SELECTION_SCRIPT_TEMPLATE
        .replace('"__PIXEL_FORGE_TARGET_URL__"', json.dumps(target_url))
        .replace('"__PIXEL_FORGE_PROXY_PREFIX__"', json.dumps(proxy_prefix))
    )

    # Try to inject before </head> first, then </body>, then end of file
    if '</head>' in html_str:
        html_str = html_str.replace('</head>', selection_script + '</head>', 1)
    elif '</body>' in html_str:
        html_str = html_str.replace('</body>', selection_script + '</body>', 1)
    elif '</html>' in html_str:
        html_str = html_str.replace('</html>', selection_script + '</html>', 1)
    else:
        html_str += selection_script

    return html_str.encode('utf-8')


@router.api_route("/app/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_http(request: Request, path: str = ""):
    """Proxy HTTP requests to target app and inject selection script."""
    path_session_id, upstream_path = _extract_session_path(path)
    session = await get_proxy_session(path_session_id or request.cookies.get(PROXY_SESSION_COOKIE))
    target_base_url = session.target_url if session else TARGET_APP_URL
    if not target_base_url:
        return _missing_target_response()
    target_url = _build_target_url(
        target_base_url,
        upstream_path,
        _filter_proxy_query(request.url.query),
    )
    client = session.client if session else _create_proxy_client()
    proxy_prefix = _proxy_prefix(path_session_id)

    try:
        if session:
            _sync_browser_cookies(request, session)

        response = await client.request(
            method=request.method,
            url=target_url,
            headers=_build_forward_headers(request, target_base_url),
            content=await request.body()
            if request.method in ["POST", "PUT", "PATCH"]
            else None,
        )

        content = response.content
        response_headers = dict(response.headers)

        # Remove headers that would break the proxy
        for header in [
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "set-cookie",
            "content-security-policy",
            "content-security-policy-report-only",
            "cross-origin-opener-policy",
            "cross-origin-embedder-policy",
            "cross-origin-resource-policy",
            "x-frame-options",
            "frame-options",
            "report-to",
            "nel",
        ]:
            response_headers.pop(header, None)
            response_headers.pop(header.title(), None)

        # Inject script into HTML responses, rewrite paths in JS
        content_type = response_headers.get(
            "content-type", response_headers.get("Content-Type", "")
        )
        if "text/html" in content_type:
            content = inject_script(content, proxy_prefix, target_url)
        elif "javascript" in content_type or "ecmascript" in content_type:
            content = rewrite_js_imports(content, proxy_prefix)

        # Update content length
        response_headers["Content-Length"] = str(len(content))

        return Response(
            content=content,
            status_code=response.status_code,
            headers=response_headers,
        )

    except httpx.ConnectError:
        return Response(
            content=f"<html><body><h1>Cannot connect to {target_base_url}</h1><p>Make sure the target app or website is reachable.</p></body></html>",
            status_code=502,
            media_type="text/html",
        )
    except Exception as e:
        return Response(
            content=f"<html><body><h1>Proxy Error</h1><p>{str(e)}</p></body></html>",
            status_code=500,
            media_type="text/html",
        )
    finally:
        if session is None:
            await client.aclose()


@router.websocket("/app/{path:path}")
async def proxy_websocket(websocket: WebSocket, path: str = ""):
    """Proxy WebSocket connections for HMR support."""

    await websocket.accept()

    path_session_id, upstream_path = _extract_session_path(path)
    session = await get_proxy_session(path_session_id or websocket.cookies.get(PROXY_SESSION_COOKIE))
    target_base_url = session.target_url if session else TARGET_APP_URL
    if not target_base_url:
        await websocket.close(code=1011, reason="No proxy target configured")
        return

    # Parse target WebSocket URL
    target_parsed = urlparse(target_base_url)
    ws_scheme = 'wss' if target_parsed.scheme == 'https' else 'ws'
    target_ws_url = f"{ws_scheme}://{target_parsed.netloc}/{upstream_path}"

    print(f"[app-proxy] WebSocket connecting to: {target_ws_url}")

    target_ws = None
    try:
        headers: dict[str, str] = {}
        if session:
            cookie_header = _cookie_header_for_target(session, target_ws_url)
            if cookie_header:
                headers["Cookie"] = cookie_header
        origin = websocket.headers.get("origin")
        if origin:
            headers["Origin"] = _target_origin(target_base_url)

        target_ws = await websockets.connect(
            target_ws_url,
            additional_headers=headers,
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
    path_session_id, upstream_path = _extract_session_path(path)
    session = await get_proxy_session(path_session_id or request.cookies.get(PROXY_SESSION_COOKIE))
    target_base_url = session.target_url if session else TARGET_APP_URL
    if not target_base_url:
        return Response(content="No proxy target configured", status_code=409)
    target_url = _build_target_url(
        target_base_url,
        upstream_path,
        _filter_proxy_query(request.url.query),
    )
    client = session.client if session else _create_proxy_client()

    try:
        if session:
            _sync_browser_cookies(request, session)

        response = await client.request(
            method=request.method,
            url=target_url,
            headers=_build_forward_headers(request, target_base_url),
            content=await request.body()
            if request.method in ["POST", "PUT", "PATCH"]
            else None,
        )

        response_headers = dict(response.headers)
        for header in [
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "set-cookie",
            "content-security-policy",
            "content-security-policy-report-only",
            "cross-origin-opener-policy",
            "cross-origin-embedder-policy",
            "cross-origin-resource-policy",
            "x-frame-options",
            "frame-options",
            "report-to",
            "nel",
        ]:
            response_headers.pop(header, None)
            response_headers.pop(header.title(), None)

        response_headers["Content-Length"] = str(len(response.content))

        return Response(
            content=response.content,
            status_code=response.status_code,
            headers=response_headers,
        )

    except httpx.ConnectError:
        return Response(content="Cannot connect to target app", status_code=502)
    except Exception as e:
        return Response(content=str(e), status_code=500)
    finally:
        if session is None:
            await client.aclose()


@router.websocket("/")
async def proxy_root_websocket(websocket: WebSocket):
    """
    Proxy root WebSocket connections for Vite HMR support.

    Vite's HMR client connects to ws://host/?token=... at the root level,
    even when the app is served through /app/. This handler intercepts
    those connections and proxies them to the target app.
    """
    await websocket.accept()

    session = await get_proxy_session(websocket.cookies.get(PROXY_SESSION_COOKIE))
    target_base_url = session.target_url if session else TARGET_APP_URL
    if not target_base_url:
        await websocket.close(code=1011, reason="No proxy target configured")
        return

    # Parse target WebSocket URL
    target_parsed = urlparse(target_base_url)
    ws_scheme = 'wss' if target_parsed.scheme == 'https' else 'ws'
    target_ws_url = f"{ws_scheme}://{target_parsed.netloc}/"

    print(f"[app-proxy] HMR WebSocket connecting to: {target_ws_url}")

    target_ws = None
    try:
        headers: dict[str, str] = {}
        if session:
            cookie_header = _cookie_header_for_target(session, target_ws_url)
            if cookie_header:
                headers["Cookie"] = cookie_header
        origin = websocket.headers.get("origin")
        if origin:
            headers["Origin"] = _target_origin(target_base_url)

        target_ws = await websockets.connect(
            target_ws_url,
            additional_headers=headers,
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

# Paths served by the built frontend — the catch-all must not proxy these.
_FRONTEND_PATHS = {"assets", "favicon", "brand"}


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

    # Skip frontend asset paths — let StaticFiles mounts handle them
    first_segment = path.split("/", 1)[0] if path else ""
    if first_segment in _FRONTEND_PATHS:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Not found"}, status_code=404)

    # Proxy everything else directly to target
    return await proxy_http_to_target(request, path)
