"""
Managed browser preview adapter for remote/auth-heavy targets.

This launches a real Chrome session with a persistent profile, injects the
Pixel Forge selection bridge directly into pages, and forwards page events
back to the FastAPI runtime.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from urllib.request import urlopen

from playwright.async_api import (
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)
from runtime_config import managed_browser_dir

PreviewMode = Literal["proxy", "browser"]

SNAPSHOT_QUALITY = 65
SNAPSHOT_WIDTH = 1440
CDP_READY_TIMEOUT_SECONDS = 15.0
PIXEL_FORGE_PROFILE_DIR = managed_browser_dir()

REAL_BROWSER_SELECTION_SCRIPT = f"""
(() => {{
  if (window.__pixelForgeSelectionBridgeLoaded) {{
    return;
  }}
  window.__pixelForgeSelectionBridgeLoaded = true;

  let selectMode = false;
  let hoverOverlay = null;
  let hoverLabel = null;
  let currentTarget = null;
  let hoverTargets = [];
  let hoverTargetIndex = 0;
  let selectedElements = [];
  let desiredSelections = [];
  let reconcileFrame = null;
  let domObserver = null;
  async function emit(type, data = {{}}) {{
    try {{
      if (typeof window.__pixelForgeEmit !== 'function') {{
        return;
      }}
      await window.__pixelForgeEmit({{ type, data }});
    }} catch (error) {{
      console.warn('[pixel-forge] Failed to emit browser event', error);
    }}
  }}

  function getXPath(element) {{
    if (!element) return '';
    if (element.id) return `//*[@id="${{element.id}}"]`;
    if (element === document.body) return '/html/body';

    let ix = 0;
    const siblings = element.parentNode ? element.parentNode.childNodes : [];
    for (let i = 0; i < siblings.length; i++) {{
      const sibling = siblings[i];
      if (sibling === element) {{
        const parentPath = getXPath(element.parentNode);
        const tagName = element.tagName.toLowerCase();
        return `${{parentPath}}/${{tagName}}[${{ix + 1}}]`;
      }}
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {{
        ix++;
      }}
    }}
    return '';
  }}

  function findElementByXPath(xpath) {{
    if (!xpath) return null;
    try {{
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    }} catch (error) {{
      console.warn('[pixel-forge] Failed to evaluate xpath', xpath, error);
      return null;
    }}
  }}

  function getElementLabel(el) {{
    let label = el.tagName.toLowerCase();
    if (el.id) label += '#' + el.id;
    if (el.className && typeof el.className === 'string') {{
      const classes = el.className.split(' ').filter(Boolean).slice(0, 2);
      if (classes.length) label += '.' + classes.join('.');
    }}
    return label;
  }}

  function getElementParent(element) {{
    if (!(element instanceof Element)) {{
      return null;
    }}

    if (element.parentElement instanceof Element) {{
      return element.parentElement;
    }}

    const root = typeof element.getRootNode === 'function'
      ? element.getRootNode()
      : null;
    if (root instanceof ShadowRoot && root.host instanceof Element) {{
      return root.host;
    }}

    return null;
  }}

  function getAncestorTargets(element) {{
    const targets = [];
    let current = element;

    while (current instanceof Element) {{
      if (
        !current.hasAttribute('data-pixel-forge-injected')
        && isElementVisiblyRenderable(current)
      ) {{
        targets.push(current);
      }}
      current = getElementParent(current);
    }}

    return targets;
  }}

  function buildHoverLabel(label) {{
    if (hoverTargets.length <= 1) {{
      return label;
    }}
    return `${{label}} ${{hoverTargetIndex + 1}}/${{hoverTargets.length}}`;
  }}

  function setCurrentHoverTarget(element) {{
    if (!(element instanceof Element)) {{
      hideHoverOverlay();
      return;
    }}

    highlightElement(element);
  }}

  function setHoverTarget(element) {{
    hoverTargets = getAncestorTargets(element);
    hoverTargetIndex = 0;
    setCurrentHoverTarget(hoverTargets[0] || element);
  }}

  function cycleHoverTarget() {{
    if (hoverTargets.length <= 1) {{
      return false;
    }}

    const nextIndex = Math.min(hoverTargetIndex + 1, hoverTargets.length - 1);
    if (nextIndex === hoverTargetIndex) {{
      return false;
    }}

    hoverTargetIndex = nextIndex;
    setCurrentHoverTarget(hoverTargets[hoverTargetIndex]);
    return true;
  }}

  function createHoverOverlay() {{
    if (hoverOverlay) return;
    hoverOverlay = document.createElement('div');
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
  }}

  function updateSelectionPosition(element, overlay, badge) {{
    const rect = element.getBoundingClientRect();
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    badge.style.top = (rect.top - 9) + 'px';
    badge.style.left = (rect.right - 9) + 'px';
  }}

  function updateAllPositions() {{
    selectedElements.forEach((sel) => {{
      if (sel.element.isConnected) {{
        updateSelectionPosition(sel.element, sel.overlay, sel.badge);
      }}
    }});
  }}

  function normalizeGlobalIndex(value, fallbackIndex) {{
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {{
      return Math.round(numericValue);
    }}
    return fallbackIndex;
  }}

  function normalizeAppliedSelections(selections) {{
    return (selections || []).flatMap((entry, index) => {{
      if (typeof entry === 'string') {{
        return [{{
          id: entry,
          xpath: entry,
          globalIndex: index + 1,
          tagName: '',
          elementId: null,
          classList: [],
          textSample: ''
        }}];
      }}

      if (!entry || typeof entry !== 'object' || typeof entry.xpath !== 'string') {{
        return [];
      }}

      return [{{
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
      }}];
    }});
  }}

  function normalizeTextSample(value) {{
    return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  }}

  function selectionKey(selection) {{
    return String(selection?.id || selection?.xpath || '');
  }}

  function isElementVisiblyRenderable(element) {{
    if (!(element instanceof Element) || !element.isConnected) {{
      return false;
    }}

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {{
      return false;
    }}

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }}

  function matchesSelectionFingerprint(element, selection) {{
    if (!(element instanceof Element)) {{
      return false;
    }}

    if (selection.tagName && element.tagName.toLowerCase() !== selection.tagName) {{
      return false;
    }}

    if (selection.elementId && element.id !== selection.elementId) {{
      return false;
    }}

    if (selection.classList.length > 0) {{
      const matchedClasses = selection.classList.filter((className) => element.classList.contains(className)).length;
      if (!selection.elementId && matchedClasses === 0) {{
        return false;
      }}
    }}

    const expectedText = normalizeTextSample(selection.textSample);
    if (expectedText) {{
      const actualText = normalizeTextSample(element.textContent);
      const expectedPrefix = expectedText.slice(0, 48);
      if (!actualText || !actualText.includes(expectedPrefix)) {{
        return false;
      }}
    }}

    return isElementVisiblyRenderable(element);
  }}

  function resolveSelectionElement(selection) {{
    const element = findElementByXPath(selection.xpath);
    if (!element) {{
      return null;
    }}

    return matchesSelectionFingerprint(element, selection) ? element : null;
  }}

  function removeRenderedSelection(entry) {{
    entry.overlay.remove();
    entry.badge.remove();
  }}

  function shouldIgnoreMutationNode(node) {{
    return node instanceof Element && node.hasAttribute('data-pixel-forge-injected');
  }}

  function createSelectionOverlay(element, globalIndex) {{
    const overlay = document.createElement('div');
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
    return {{ overlay, badge }};
  }}

  function hideHoverOverlay() {{
    if (hoverOverlay) hoverOverlay.style.display = 'none';
    if (hoverLabel) hoverLabel.style.display = 'none';
    currentTarget = null;
    hoverTargets = [];
    hoverTargetIndex = 0;
  }}

  function getElementData(element) {{
    return {{
      outerHTML: element.outerHTML,
      innerHTML: element.innerHTML,
      tagName: element.tagName.toLowerCase(),
      elementId: element.id || null,
      classList: [...element.classList],
      xpath: getXPath(element),
      textContent: normalizeTextSample(element.textContent).slice(0, 200),
      attributes: Array.from(element.attributes).map((attribute) => ({{
        name: attribute.name,
        value: attribute.value
      }})),
      rect: element.getBoundingClientRect(),
      pageUrl: window.location.href,
      pageTitle: document.title || null
    }};
  }}

  function isSelected(element) {{
    const xpath = getXPath(element);
    return selectedElements.findIndex((sel) => sel.xpath === xpath);
  }}

  function scheduleSelectionReconcile() {{
    if (reconcileFrame !== null) {{
      return;
    }}

    reconcileFrame = window.requestAnimationFrame(() => {{
      reconcileFrame = null;
      reconcileDesiredSelections();
    }});
  }}

  function reconcileDesiredSelections() {{
    const desiredByKey = new Map(desiredSelections.map((selection) => [selectionKey(selection), selection]));
    const nextRenderedSelections = [];

    for (const entry of selectedElements) {{
      const desiredSelection = desiredByKey.get(entry.selectionKey);
      if (!desiredSelection) {{
        removeRenderedSelection(entry);
        continue;
      }}

      const resolvedElement = resolveSelectionElement(desiredSelection);
      if (!resolvedElement) {{
        removeRenderedSelection(entry);
        continue;
      }}

      if (entry.element !== resolvedElement) {{
        removeRenderedSelection(entry);
        continue;
      }}

      entry.globalIndex = normalizeGlobalIndex(desiredSelection.globalIndex, entry.globalIndex);
      entry.badge.textContent = String(entry.globalIndex);
      updateSelectionPosition(entry.element, entry.overlay, entry.badge);
      nextRenderedSelections.push(entry);
    }}

    selectedElements = nextRenderedSelections;

    for (const desiredSelection of desiredSelections) {{
      const key = selectionKey(desiredSelection);
      if (selectedElements.some((entry) => entry.selectionKey === key)) {{
        continue;
      }}

      const resolvedElement = resolveSelectionElement(desiredSelection);
      if (!resolvedElement) {{
        continue;
      }}

      const globalIndex = normalizeGlobalIndex(desiredSelection.globalIndex, selectedElements.length + 1);
      const {{ overlay, badge }} = createSelectionOverlay(resolvedElement, globalIndex);
      selectedElements.push({{
        selectionKey: key,
        element: resolvedElement,
        xpath: desiredSelection.xpath,
        overlay,
        badge,
        globalIndex,
      }});
    }}
  }}

  function highlightElement(element) {{
    if (!hoverOverlay) createHoverOverlay();
    const rect = element.getBoundingClientRect();
    const selectedIndex = isSelected(element);
    if (selectedIndex >= 0) {{
      hoverOverlay.style.borderColor = '#ef4444';
      hoverOverlay.style.background = 'rgba(239, 68, 68, 0.1)';
      hoverLabel.style.background = '#ef4444';
      hoverLabel.textContent = 'Click to deselect';
    }} else {{
      hoverOverlay.style.borderColor = '#3b82f6';
      hoverOverlay.style.background = 'rgba(59, 130, 246, 0.1)';
      hoverLabel.style.background = '#3b82f6';
      hoverLabel.textContent = buildHoverLabel(getElementLabel(element));
    }}

    hoverOverlay.style.top = rect.top + 'px';
    hoverOverlay.style.left = rect.left + 'px';
    hoverOverlay.style.width = rect.width + 'px';
    hoverOverlay.style.height = rect.height + 'px';
    hoverOverlay.style.display = 'block';

    hoverLabel.style.top = Math.max(0, rect.top - 20) + 'px';
    hoverLabel.style.left = rect.left + 'px';
    hoverLabel.style.display = 'block';
    currentTarget = element;
  }}

  async function notifyLocationChange() {{
    await emit('browser-location-changed', {{
      url: window.location.href,
      title: document.title || null
    }});
  }}

  async function selectElement(element, notifyParent = true, selection = null) {{
    const xpath = getXPath(element);
    const resolvedGlobalIndex = normalizeGlobalIndex(selection?.globalIndex, selectedElements.length + 1);
    const {{ overlay, badge }} = createSelectionOverlay(element, resolvedGlobalIndex);
    selectedElements.push({{
      selectionKey: selectionKey(selection || {{ xpath }}),
      element,
      xpath,
      overlay,
      badge,
      globalIndex: resolvedGlobalIndex,
    }});

    if (notifyParent) {{
      await emit('browser-element-selected', getElementData(element));
    }}
  }}

  async function deselectElement(index, notifyParent = true) {{
    const selected = selectedElements[index];
    if (!selected) return;

    selected.overlay.remove();
    selected.badge.remove();
    selectedElements.splice(index, 1);

    if (notifyParent) {{
      await emit('browser-element-deselected', {{
        xpath: selected.xpath,
        index,
        pageUrl: window.location.href,
        pageTitle: document.title || null
      }});
    }}
  }}

  async function clearSelections(notifyParent = true) {{
    desiredSelections = [];
    selectedElements.forEach((selected) => {{
      removeRenderedSelection(selected);
    }});
    selectedElements = [];
    if (notifyParent) {{
      await emit('browser-selection-cleared', {{
        pageUrl: window.location.href,
        pageTitle: document.title || null
      }});
    }}
  }}

  async function applySelections(payload) {{
    const selections = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.selections)
        ? payload.selections
        : [];
    desiredSelections = normalizeAppliedSelections(selections);
    reconcileDesiredSelections();
  }}

  async function handleClick(event) {{
    if (!selectMode) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const element = currentTarget || event.target;
    if (!(element instanceof Element)) {{
      return false;
    }}

    const selectedIndex = isSelected(element);
    if (selectedIndex >= 0) {{
      await deselectElement(selectedIndex);
    }} else {{
      await selectElement(element);
    }}

    return false;
  }}

  function handleMouseMove(event) {{
    if (!selectMode) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.hasAttribute('data-pixel-forge-injected')) return;
    setHoverTarget(event.target);
  }}

  function handleKeyDown(event) {{
    if (
      event.code === 'ControlLeft'
      && selectMode
      && !event.repeat
      && currentTarget
    ) {{
      event.preventDefault();
      event.stopPropagation();
      cycleHoverTarget();
      return;
    }}

    if (event.key === 'Escape' && selectMode) {{
      selectMode = false;
      document.body.style.cursor = '';
      hideHoverOverlay();
      emit('browser-select-cancelled', {{
        pageUrl: window.location.href,
        pageTitle: document.title || null
      }});
    }}
  }}

  const originalPushState = history.pushState.bind(history);
  history.pushState = function(...args) {{
    const result = originalPushState(...args);
    queueMicrotask(() => {{
      notifyLocationChange();
      scheduleSelectionReconcile();
    }});
    return result;
  }};

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function(...args) {{
    const result = originalReplaceState(...args);
    queueMicrotask(() => {{
      notifyLocationChange();
      scheduleSelectionReconcile();
    }});
    return result;
  }};

  window.__pixelForgeSelectionBridge = {{
    async setSelectMode(enabled) {{
      selectMode = !!enabled;
      if (selectMode) {{
        createHoverOverlay();
        document.body.style.cursor = 'crosshair';
      }} else {{
        document.body.style.cursor = '';
        hideHoverOverlay();
      }}
      return true;
    }},
    async clearSelections() {{
      await clearSelections(false);
      return true;
    }},
    async deselect(xpath) {{
      desiredSelections = desiredSelections.filter((selection) => selection.xpath !== xpath);
      const index = selectedElements.findIndex((entry) => entry.xpath === xpath);
      if (index >= 0) {{
        await deselectElement(index, false);
      }}
      scheduleSelectionReconcile();
      return true;
    }},
    async applySelections(payload) {{
      await applySelections(payload);
      return true;
    }},
    async ping() {{
      return {{
        url: window.location.href,
        title: document.title || null
      }};
    }}
  }};

  // Intercept new-tab navigations (window.open and target="_blank" links)
  function shouldOpenInPreviewTab(target) {{
    const normalizedTarget = String(target || '').trim().toLowerCase();
    return !normalizedTarget || normalizedTarget === '_blank' || normalizedTarget === 'new';
  }}

  const _origOpen = window.open.bind(window);
  window.open = function(url, target, features) {{
    if (url && shouldOpenInPreviewTab(target)) {{
      try {{
        const resolved = new URL(String(url), window.location.href).href;
        emit('browser-new-tab-requested', {{ url: resolved }});
      }} catch(e) {{}}
      return null;
    }}
    return _origOpen(url, target, features);
  }};

  document.addEventListener('click', function(event) {{
    if (selectMode) return;
    const anchor = event.target instanceof Element
      ? event.target.closest('a[target="_blank"], a[target="new"]')
      : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    event.preventDefault();
    event.stopPropagation();
    try {{
      const resolved = new URL(href, window.location.href).href;
      emit('browser-new-tab-requested', {{ url: resolved }});
    }} catch(e) {{}}
  }}, true);

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mouseleave', hideHoverOverlay);
  window.addEventListener('hashchange', () => {{
    notifyLocationChange();
    scheduleSelectionReconcile();
  }});
  window.addEventListener('popstate', () => {{
    notifyLocationChange();
    scheduleSelectionReconcile();
  }});
  window.addEventListener('load', () => {{
    notifyLocationChange();
    scheduleSelectionReconcile();
  }});
  window.addEventListener('scroll', updateAllPositions, true);
  window.addEventListener('resize', () => {{
    updateAllPositions();
    scheduleSelectionReconcile();
  }});

  if (!domObserver && document.documentElement) {{
    domObserver = new MutationObserver((mutations) => {{
      const shouldReconcile = mutations.some((mutation) => {{
        if (mutation.type === 'attributes') {{
          return !shouldIgnoreMutationNode(mutation.target);
        }}

        if (shouldIgnoreMutationNode(mutation.target)) {{
          return false;
        }}

        return [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) => !shouldIgnoreMutationNode(node)
        );
      }});

      if (shouldReconcile) {{
        scheduleSelectionReconcile();
      }}
    }});
    domObserver.observe(document.documentElement, {{
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    }});
  }}

  const titleElement = document.querySelector('title');
  if (titleElement) {{
    const titleObserver = new MutationObserver(() => notifyLocationChange());
    titleObserver.observe(titleElement, {{ childList: true, subtree: true, characterData: true }});
  }}

  notifyLocationChange();
  scheduleSelectionReconcile();
}})();
"""


def _is_local_hostname(hostname: str | None) -> bool:
    if not hostname:
        return False

    normalized = hostname.lower()
    if normalized in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        return True
    if normalized.endswith(".localhost"):
        return True

    try:
        ip = ipaddress.ip_address(normalized)
    except ValueError:
        return False

    return ip.is_loopback or ip.is_private or ip.is_link_local


def resolve_preview_mode(url: str, preferred_mode: Literal["auto", "proxy", "browser"] = "auto") -> PreviewMode:
    if preferred_mode == "proxy":
        return "proxy"
    if preferred_mode == "browser":
        return "browser"

    parsed = urlparse(url.strip())
    return "proxy" if _is_local_hostname(parsed.hostname) else "browser"


@dataclass
class ManagedBrowserTab:
    id: str
    page: Page
    url: str
    title: str
    select_mode: bool = False
    last_snapshot_data_url: str | None = None
    snapshot_task: asyncio.Task[Any] | None = None


class ManagedBrowserPreviewManager:
    def __init__(self) -> None:
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._chrome_process: subprocess.Popen[bytes] | None = None
        self._cdp_port: int | None = None
        self._tabs: dict[str, ManagedBrowserTab] = {}
        self._lock = asyncio.Lock()
        self._subscriber_queues: set[asyncio.Queue[dict[str, Any]]] = set()

    async def ensure_context(self) -> BrowserContext:
        async with self._lock:
            if (
                self._context is not None
                and self._browser is not None
                and self._browser.is_connected()
            ):
                return self._context
            await self._reset_browser_state()

            chrome_path = self._find_chrome_executable()
            if not chrome_path:
                raise RuntimeError("Google Chrome or Chromium is required for browser preview mode")
            PIXEL_FORGE_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

            await asyncio.to_thread(self._terminate_stale_managed_browsers, chrome_path)
            self._playwright = await async_playwright().start()
            cdp_port = self._reserve_cdp_port()
            chrome_process = self._launch_chrome(chrome_path, cdp_port)
            await asyncio.to_thread(self._wait_for_cdp, cdp_port, chrome_process)

            try:
                browser = await self._playwright.chromium.connect_over_cdp(
                    f"http://127.0.0.1:{cdp_port}"
                )
            except Exception:
                chrome_process.terminate()
                chrome_process.wait(timeout=5)
                raise

            browser.on(
                "disconnected",
                lambda: asyncio.create_task(self._handle_browser_disconnect()),
            )

            contexts = browser.contexts
            if not contexts:
                await browser.close()
                chrome_process.terminate()
                chrome_process.wait(timeout=5)
                raise RuntimeError("Managed Chrome did not expose a debuggable browser context")

            context = contexts[0]
            await context.expose_binding("__pixelForgeEmit", self._handle_page_event)
            await context.add_init_script(REAL_BROWSER_SELECTION_SCRIPT)
            for page in context.pages:
                await self._ensure_page_bridge(page)

            self._browser = browser
            self._context = context
            self._chrome_process = chrome_process
            self._cdp_port = cdp_port
            return context

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscriber_queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscriber_queues.discard(queue)

    async def broadcast(self, event: dict[str, Any]) -> None:
        stale_queues: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._subscriber_queues:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stale_queues.append(queue)
        for queue in stale_queues:
            self._subscriber_queues.discard(queue)

    async def load_tab(self, url: str, browser_tab_id: str | None = None) -> ManagedBrowserTab:
        context = await self.ensure_context()

        if browser_tab_id and browser_tab_id in self._tabs:
            tab = self._tabs[browser_tab_id]
            page = tab.page
        else:
            page = await self._claim_page(context)
            browser_tab_id = browser_tab_id or secrets.token_urlsafe(18)
            tab = ManagedBrowserTab(
                id=browser_tab_id,
                page=page,
                url=url,
                title=url,
            )
            self._tabs[tab.id] = tab
            page.on("close", lambda _: asyncio.create_task(self._handle_page_close(tab.id)))

        await page.goto(url, wait_until="domcontentloaded")
        await page.bring_to_front()

        tab.url = page.url or url
        tab.title = await self._safe_page_title(page, fallback=url)
        await self._set_page_select_mode(tab, tab.select_mode)
        await self._schedule_snapshot(tab.id)
        return tab

    async def focus_tab(self, browser_tab_id: str) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        await tab.page.bring_to_front()
        return tab

    async def refresh_tab(self, browser_tab_id: str) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        await tab.page.reload(wait_until="domcontentloaded")
        tab.url = tab.page.url or tab.url
        tab.title = await self._safe_page_title(tab.page, fallback=tab.title)
        await self._set_page_select_mode(tab, tab.select_mode)
        await self._schedule_snapshot(tab.id)
        return tab

    async def set_select_mode(self, browser_tab_id: str, enabled: bool) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        tab.select_mode = enabled
        await self._set_page_select_mode(tab, enabled)
        if enabled:
            await tab.page.bring_to_front()
        return tab

    async def clear_selections(self, browser_tab_id: str) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        await self._invoke_bridge(tab.page, "clearSelections")
        return tab

    async def deselect_xpath(self, browser_tab_id: str, xpath: str) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        await self._invoke_bridge(tab.page, "deselect", xpath)
        return tab

    async def apply_selections(
        self,
        browser_tab_id: str,
        selections: list[Any],
        *,
        reveal: bool = False,
    ) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        await self._invoke_bridge(
            tab.page,
            "applySelections",
            {"selections": selections, "reveal": reveal},
        )
        return tab

    async def close_tab(self, browser_tab_id: str) -> None:
        tab = self._tabs.pop(browser_tab_id, None)
        if tab is None:
            return

        if tab.snapshot_task and not tab.snapshot_task.done():
            tab.snapshot_task.cancel()

        try:
            await tab.page.close()
        except PlaywrightError:
            pass

    async def shutdown(self) -> None:
        async with self._lock:
            await self._reset_browser_state()

    async def tab_payload(self, browser_tab_id: str) -> dict[str, Any]:
        tab = self._get_tab(browser_tab_id)
        return self._serialize_tab(tab)

    async def inspect_tab(
        self,
        browser_tab_id: str,
        *,
        selection_hints: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        tab = self._get_tab(browser_tab_id)
        current_url = tab.page.url or tab.url
        current_title = await self._safe_page_title(tab.page, fallback=tab.title or current_url)
        tab.url = current_url
        tab.title = current_title

        page_state = await self._inspect_page_state(tab.page)
        snapshot_data_url = await self._capture_snapshot_data_url(tab)
        if snapshot_data_url:
            tab.last_snapshot_data_url = snapshot_data_url

        selection_matches = await self._inspect_selection_hints(
            tab.page,
            selection_hints or [],
        )
        devtools_target = await self._inspect_devtools_target(tab.page)
        return {
            "current_url": current_url,
            "current_title": current_title,
            "snapshot_data_url": tab.last_snapshot_data_url,
            "ready_state": page_state.get("readyState"),
            "viewport": page_state.get("viewport"),
            "selection_matches": selection_matches,
            "devtools_browser_url": self._devtools_browser_url(),
            **devtools_target,
        }

    def _serialize_tab(self, tab: ManagedBrowserTab) -> dict[str, Any]:
        return {
            "browser_tab_id": tab.id,
            "target_url": tab.url,
            "title": tab.title,
            "snapshot_data_url": tab.last_snapshot_data_url,
            "mode": "browser",
        }

    def _get_tab(self, browser_tab_id: str) -> ManagedBrowserTab:
        tab = self._tabs.get(browser_tab_id)
        if tab is None:
            raise RuntimeError(f"Unknown browser preview tab: {browser_tab_id}")
        return tab

    def _find_chrome_executable(self) -> str | None:
        candidates = [
            os.environ.get("PIXEL_FORGE_CHROME_BIN"),
            shutil.which("google-chrome-stable"),
            shutil.which("google-chrome"),
            shutil.which("chromium"),
            shutil.which("chromium-browser"),
        ]

        for candidate in candidates:
            if candidate:
                return candidate
        return None

    def _reserve_cdp_port(self) -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(1)
            return int(sock.getsockname()[1])

    def _launch_chrome(self, chrome_path: str, cdp_port: int) -> subprocess.Popen[bytes]:
        command = [
            chrome_path,
            "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={cdp_port}",
            f"--user-data-dir={PIXEL_FORGE_PROFILE_DIR}",
            "--start-maximized",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ]
        return subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    def _wait_for_cdp(self, cdp_port: int, chrome_process: subprocess.Popen[bytes]) -> None:
        deadline = time.monotonic() + CDP_READY_TIMEOUT_SECONDS
        version_url = f"http://127.0.0.1:{cdp_port}/json/version"
        last_error: Exception | None = None

        while time.monotonic() < deadline:
            if chrome_process.poll() is not None:
                raise RuntimeError("Managed Chrome exited before the DevTools endpoint was ready")
            try:
                with urlopen(version_url, timeout=1) as response:
                    payload = json.load(response)
                if payload.get("webSocketDebuggerUrl"):
                    return
            except Exception as exc:
                last_error = exc
            time.sleep(0.2)

        raise RuntimeError(
            f"Timed out waiting for managed Chrome DevTools endpoint on port {cdp_port}: {last_error}"
        )

    def _terminate_stale_managed_browsers(self, chrome_path: str) -> None:
        result = subprocess.run(
            ["pgrep", "-f", "--", f"--user-data-dir={PIXEL_FORGE_PROFILE_DIR}"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode not in {0, 1}:
            return

        current_pid = os.getpid()
        for raw_pid in result.stdout.splitlines():
            raw_pid = raw_pid.strip()
            if not raw_pid:
                continue
            pid = int(raw_pid)
            if pid == current_pid:
                continue
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                continue

    async def _claim_page(self, context: BrowserContext) -> Page:
        claimed_pages = {tab.page for tab in self._tabs.values()}
        for page in context.pages:
            if page not in claimed_pages:
                return page
        return await context.new_page()

    async def _safe_page_title(self, page: Page, fallback: str) -> str:
        try:
            title = await page.title()
        except PlaywrightError:
            title = ""
        return title.strip() or fallback

    async def _invoke_bridge(self, page: Page, method: str, *args: Any) -> Any:
        return await page.evaluate(
            """async ({ method, args }) => {
                if (!window.__pixelForgeSelectionBridge || typeof window.__pixelForgeSelectionBridge[method] !== 'function') {
                  return null;
                }
                return await window.__pixelForgeSelectionBridge[method](...args);
            }""",
            {"method": method, "args": list(args)},
        )

    async def _ensure_page_bridge(self, page: Page) -> None:
        try:
            await page.evaluate(REAL_BROWSER_SELECTION_SCRIPT)
        except PlaywrightError:
            return

    async def _set_page_select_mode(self, tab: ManagedBrowserTab, enabled: bool) -> None:
        tab.select_mode = enabled
        await self._invoke_bridge(tab.page, "setSelectMode", enabled)

    async def _schedule_snapshot(self, browser_tab_id: str) -> None:
        tab = self._get_tab(browser_tab_id)
        if tab.snapshot_task and not tab.snapshot_task.done():
            return

        async def runner() -> None:
            snapshot_data_url = await self._capture_snapshot_data_url(tab)
            if not snapshot_data_url:
                return

            tab.last_snapshot_data_url = snapshot_data_url
            await self.broadcast(
                {
                    "type": "browser-tab-snapshot",
                    "browser_tab_id": tab.id,
                    "snapshot_data_url": tab.last_snapshot_data_url,
                }
            )

        tab.snapshot_task = asyncio.create_task(runner())

    async def _handle_page_event(self, source: Any, payload: dict[str, Any]) -> None:
        page = getattr(source, "page", None)
        if page is None:
            return

        tab = next((entry for entry in self._tabs.values() if entry.page == page), None)
        if tab is None:
            return

        event_type = payload.get("type")
        event_data = payload.get("data") or {}

        if event_type == "browser-location-changed":
            tab.url = event_data.get("url") or tab.url
            tab.title = event_data.get("title") or tab.title or tab.url
            await self.broadcast(
                {
                    "type": "browser-location-changed",
                    "browser_tab_id": tab.id,
                    "url": tab.url,
                    "title": tab.title,
                }
            )
            await self._schedule_snapshot(tab.id)
            return

        if event_type == "browser-element-selected":
            await self.broadcast(
                {
                    "type": "browser-element-selected",
                    "browser_tab_id": tab.id,
                    "data": event_data,
                }
            )
            return

        if event_type == "browser-element-deselected":
            await self.broadcast(
                {
                    "type": "browser-element-deselected",
                    "browser_tab_id": tab.id,
                    "data": event_data,
                }
            )
            return

        if event_type == "browser-selection-cleared":
            await self.broadcast(
                {
                    "type": "browser-selection-cleared",
                    "browser_tab_id": tab.id,
                    "data": event_data,
                }
            )
            return

        if event_type == "browser-select-cancelled":
            tab.select_mode = False
            await self.broadcast(
                {
                    "type": "browser-select-cancelled",
                    "browser_tab_id": tab.id,
                    "data": event_data,
                }
            )

        if event_type == "browser-new-tab-requested":
            new_url = event_data.get("url") or ""
            if new_url:
                await self.broadcast(
                    {
                        "type": "browser-new-tab-requested",
                        "browser_tab_id": tab.id,
                        "url": new_url,
                    }
                )
            return

    def _devtools_browser_url(self) -> str | None:
        if self._cdp_port is None:
            return None
        return f"http://127.0.0.1:{self._cdp_port}"

    def _read_devtools_targets(self) -> list[dict[str, Any]]:
        browser_url = self._devtools_browser_url()
        if not browser_url:
            return []

        with urlopen(f"{browser_url}/json/list", timeout=2) as response:
            payload = json.load(response)
        return payload if isinstance(payload, list) else []

    async def _inspect_devtools_target(self, page: Page) -> dict[str, Any]:
        if self._context is None:
            return {}

        try:
            cdp_session = await self._context.new_cdp_session(page)
        except PlaywrightError:
            return {}

        try:
            payload = await cdp_session.send("Target.getTargetInfo")
        except PlaywrightError:
            return {}
        finally:
            detach = getattr(cdp_session, "detach", None)
            if callable(detach):
                try:
                    await detach()
                except Exception:
                    pass

        target_info = payload.get("targetInfo") if isinstance(payload, dict) else None
        if not isinstance(target_info, dict):
            return {}

        target_id = target_info.get("targetId")
        if not isinstance(target_id, str) or not target_id:
            return {}

        try:
            targets = await asyncio.to_thread(self._read_devtools_targets)
        except Exception:
            targets = []

        matched_target = next(
            (
                entry
                for entry in targets
                if isinstance(entry, dict) and entry.get("id") == target_id
            ),
            None,
        )
        return {
            "devtools_target_id": target_id,
            "devtools_target_type": target_info.get("type"),
            "devtools_target_url": (
                matched_target.get("url")
                if isinstance(matched_target, dict) and isinstance(matched_target.get("url"), str)
                else target_info.get("url")
            ),
            "devtools_target_title": (
                matched_target.get("title")
                if isinstance(matched_target, dict) and isinstance(matched_target.get("title"), str)
                else target_info.get("title")
            ),
            "devtools_page_websocket_url": (
                matched_target.get("webSocketDebuggerUrl")
                if isinstance(matched_target, dict)
                else None
            ),
            "devtools_frontend_url": (
                matched_target.get("devtoolsFrontendUrl")
                if isinstance(matched_target, dict)
                else None
            ),
        }

    async def _capture_snapshot_data_url(self, tab: ManagedBrowserTab) -> str | None:
        try:
            screenshot = await tab.page.screenshot(
                type="jpeg",
                quality=SNAPSHOT_QUALITY,
                scale="css",
                timeout=15_000,
            )
        except (PlaywrightError, PlaywrightTimeoutError):
            return tab.last_snapshot_data_url

        return "data:image/jpeg;base64," + base64.b64encode(screenshot).decode("ascii")

    async def _inspect_page_state(self, page: Page) -> dict[str, Any]:
        try:
            payload = await page.evaluate(
                """() => ({
                    url: window.location.href,
                    title: document.title,
                    readyState: document.readyState,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight,
                    },
                })"""
            )
        except PlaywrightError:
            return {}
        return payload if isinstance(payload, dict) else {}

    async def _inspect_selection_hints(
        self,
        page: Page,
        selection_hints: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not selection_hints:
            return []

        try:
            payload = await page.evaluate(
                """(selectionHints) => {
                    const locateElement = (selection) => {
                        const candidates = [selection.xpath, selection.root_xpath].filter(Boolean);
                        for (const xpath of candidates) {
                            try {
                                const result = document.evaluate(
                                    xpath,
                                    document,
                                    null,
                                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                                    null
                                );
                                const element = result.singleNodeValue;
                                if (element instanceof Element) {
                                    return { element, xpath };
                                }
                            } catch (error) {
                                // Ignore invalid XPath and keep searching.
                            }
                        }
                        return { element: null, xpath: candidates[0] || null };
                    };

                    return (selectionHints || []).map((selection) => {
                        const located = locateElement(selection);
                        const element = located.element;
                        if (!(element instanceof Element)) {
                            return {
                                selection_id: selection.id || null,
                                selector_kind: selection.selector_kind || 'dom',
                                surface_kind: selection.surface_kind || 'dom',
                                xpath: located.xpath,
                                found: false,
                                visible: false,
                                tag_name: null,
                                element_id: null,
                                class_list: [],
                                text_excerpt: null,
                                current_outer_html_excerpt: null,
                                bounds: null,
                            };
                        }

                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        const textContent = (element.innerText || element.textContent || '')
                            .replace(/\\s+/g, ' ')
                            .trim()
                            .slice(0, 240);

                        return {
                            selection_id: selection.id || null,
                            selector_kind: selection.selector_kind || 'dom',
                            surface_kind: selection.surface_kind || 'dom',
                            xpath: located.xpath,
                            found: true,
                            visible:
                                rect.width > 0
                                && rect.height > 0
                                && style.display !== 'none'
                                && style.visibility !== 'hidden',
                            tag_name: element.tagName.toLowerCase(),
                            element_id: element.id || null,
                            class_list: Array.from(element.classList || []).slice(0, 8),
                            text_excerpt: textContent || null,
                            current_outer_html_excerpt: (element.outerHTML || '').slice(0, 1200) || null,
                            bounds: {
                                x: rect.x,
                                y: rect.y,
                                width: rect.width,
                                height: rect.height,
                            },
                        };
                    });
                }""",
                selection_hints,
            )
        except PlaywrightError:
            return []

        return payload if isinstance(payload, list) else []

    async def _handle_page_close(self, browser_tab_id: str) -> None:
        tab = self._tabs.pop(browser_tab_id, None)
        if tab is None:
            return
        await self.broadcast(
            {
                "type": "browser-tab-closed",
                "browser_tab_id": browser_tab_id,
            }
        )

    async def _handle_browser_disconnect(self) -> None:
        async with self._lock:
            await self._reset_browser_state()

    async def _reset_browser_state(self) -> None:
        tabs = list(self._tabs.values())
        self._tabs.clear()
        for tab in tabs:
            if tab.snapshot_task and not tab.snapshot_task.done():
                tab.snapshot_task.cancel()
            try:
                if not tab.page.is_closed():
                    await tab.page.close()
            except PlaywrightError:
                pass

        if self._browser is not None and self._browser.is_connected():
            try:
                await self._browser.close()
            except PlaywrightError:
                pass
        self._browser = None

        self._context = None

        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

        if self._chrome_process is not None and self._chrome_process.poll() is None:
            self._chrome_process.terminate()
            try:
                self._chrome_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._chrome_process.kill()
                self._chrome_process.wait(timeout=5)
        self._chrome_process = None
        self._cdp_port = None


MANAGED_BROWSER_PREVIEW = ManagedBrowserPreviewManager()
