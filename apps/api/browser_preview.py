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

MAX_SELECTIONS = 10
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
  let selectedElements = [];
  const MAX_SELECTIONS = {MAX_SELECTIONS};

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

  function createHoverOverlay() {{
    if (hoverOverlay) return;
    hoverOverlay = document.createElement('div');
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

  function createSelectionOverlay(element, index) {{
    const overlay = document.createElement('div');
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
    return {{ overlay, badge }};
  }}

  function hideHoverOverlay() {{
    if (hoverOverlay) hoverOverlay.style.display = 'none';
    if (hoverLabel) hoverLabel.style.display = 'none';
    currentTarget = null;
  }}

  function getElementData(element) {{
    return {{
      outerHTML: element.outerHTML,
      innerHTML: element.innerHTML,
      tagName: element.tagName.toLowerCase(),
      elementId: element.id || null,
      classList: [...element.classList],
      xpath: getXPath(element),
      textContent: element.textContent?.slice(0, 200) || '',
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
      hoverLabel.textContent = getElementLabel(element);
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

  async function selectElement(element, notifyParent = true) {{
    if (selectedElements.length >= MAX_SELECTIONS) {{
      console.warn('[pixel-forge] Max selections reached');
      return;
    }}

    const xpath = getXPath(element);
    const index = selectedElements.length;
    const {{ overlay, badge }} = createSelectionOverlay(element, index);
    selectedElements.push({{ element, xpath, overlay, badge }});

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

    selectedElements.forEach((entry, entryIndex) => {{
      entry.badge.textContent = String(entryIndex + 1);
    }});

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
    selectedElements.forEach((selected) => {{
      selected.overlay.remove();
      selected.badge.remove();
    }});
    selectedElements = [];
    if (notifyParent) {{
      await emit('browser-selection-cleared', {{
        pageUrl: window.location.href,
        pageTitle: document.title || null
      }});
    }}
  }}

  async function applySelections(xpaths) {{
    await clearSelections(false);
    for (const xpath of xpaths || []) {{
      const element = findElementByXPath(xpath);
      if (element) {{
        await selectElement(element, false);
      }}
    }}
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
    highlightElement(event.target);
  }}

  function handleKeyDown(event) {{
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
    queueMicrotask(notifyLocationChange);
    return result;
  }};

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function(...args) {{
    const result = originalReplaceState(...args);
    queueMicrotask(notifyLocationChange);
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
      const index = selectedElements.findIndex((entry) => entry.xpath === xpath);
      if (index >= 0) {{
        await deselectElement(index, false);
      }}
      return true;
    }},
    async applySelections(xpaths) {{
      await applySelections(Array.isArray(xpaths) ? xpaths : []);
      return true;
    }},
    async ping() {{
      return {{
        url: window.location.href,
        title: document.title || null
      }};
    }}
  }};

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mouseleave', hideHoverOverlay);
  window.addEventListener('hashchange', notifyLocationChange);
  window.addEventListener('popstate', notifyLocationChange);
  window.addEventListener('load', notifyLocationChange);
  window.addEventListener('scroll', updateAllPositions, true);
  window.addEventListener('resize', updateAllPositions);

  const titleElement = document.querySelector('title');
  if (titleElement) {{
    const titleObserver = new MutationObserver(() => notifyLocationChange());
    titleObserver.observe(titleElement, {{ childList: true, subtree: true, characterData: true }});
  }}

  notifyLocationChange();
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

    async def apply_selections(self, browser_tab_id: str, xpaths: list[str]) -> ManagedBrowserTab:
        tab = self._get_tab(browser_tab_id)
        await self._invoke_bridge(tab.page, "applySelections", xpaths)
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
            try:
                screenshot = await tab.page.screenshot(
                    type="jpeg",
                    quality=SNAPSHOT_QUALITY,
                    scale="css",
                    timeout=15_000,
                )
            except (PlaywrightError, PlaywrightTimeoutError):
                return

            tab.last_snapshot_data_url = (
                "data:image/jpeg;base64,"
                + base64.b64encode(screenshot).decode("ascii")
            )
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
