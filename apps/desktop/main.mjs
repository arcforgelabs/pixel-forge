import { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, webContents as electronWebContents } from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fsPromises, watchFile, unwatchFile } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildInternalPdfViewerUrl,
  detectPdfPreviewTarget,
  isInternalPdfViewerUrl,
  looksLikePdfUrl,
  readInternalPdfViewerState,
  readPdfDocumentSource,
} from './pdf-preview.mjs'
import { readControllerVersion, readProjectVersion } from './version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INSTANCE_SLUG = process.env.PIXEL_FORGE_INSTANCE_SLUG || 'pixel-forge'
const SHELL_HOST = process.env.PIXEL_FORGE_URL_HOST || process.env.PIXEL_FORGE_WEB_HOST || `${INSTANCE_SLUG}.localhost`
const SHELL_PORT = process.env.PIXEL_FORGE_API_PORT || process.env.PIXEL_FORGE_PORT || '7001'
const SHELL_URL = process.env.PIXEL_FORGE_SHELL_URL || `http://${SHELL_HOST}:${SHELL_PORT}`
const DEFAULT_CONTROLLER_CDP_PORT = (() => {
  const numericShellPort = Number.parseInt(String(SHELL_PORT), 10)
  return Number.isFinite(numericShellPort) ? String(numericShellPort + 100) : '9223'
})()
const CONTROLLER_CDP_HOST = process.env.PIXEL_FORGE_CONTROLLER_CDP_HOST || '127.0.0.1'
const CONTROLLER_CDP_PORT = process.env.PIXEL_FORGE_CONTROLLER_CDP_PORT || DEFAULT_CONTROLLER_CDP_PORT
const PREVIEW_PARTITION = process.env.PIXEL_FORGE_PREVIEW_PARTITION || `persist:${INSTANCE_SLUG}-preview`
const MAX_RESIDENT_PREVIEW_VIEWS = Math.max(
  2,
  Number.parseInt(process.env.PIXEL_FORGE_MAX_RESIDENT_PREVIEW_VIEWS || '12', 10) || 12,
)
const APP_STATE_DIR = path.resolve(
  process.env.PIXEL_FORGE_STATE_DIR
  || process.env.PIXEL_FORGE_SHARED_STATE_DIR
  || path.join(os.homedir(), `.${INSTANCE_SLUG}`),
)
const CONTROLLER_UPDATE_SNAPSHOTS_DIR = path.join(APP_STATE_DIR, 'controller-updates')
const PENDING_CONTROLLER_UPDATE_PATH = path.join(APP_STATE_DIR, 'pending-controller-update.json')
const CONTROLLER_UPDATE_APPLY_STATE_PATH = path.join(
  APP_STATE_DIR,
  'controller-update-apply-state.json',
)
const DISMISSED_CONTROLLER_UPDATE_ID_PATH = path.join(
  APP_STATE_DIR,
  'dismissed-controller-update-id.txt',
)
const BOOTSTRAP_STATE_PATH = path.join(APP_STATE_DIR, 'controller-bootstrap-state.json')
const BROWSER_BROKER_MANIFEST_PATH = path.join(APP_STATE_DIR, 'browser-broker.json')
const IS_UPDATER_UI_MODE = process.argv.includes('--pixel-forge-updater-ui')
const VERSION_FILE_RELATIVE_PATH = 'VERSION'
const VERSION_PACKAGE_RELATIVE_PATHS = [
  'package.json',
  path.join('apps', 'web', 'package.json'),
  path.join('apps', 'desktop', 'package.json'),
  path.join('packages', 'sdk-node', 'package.json'),
]
const STABLE_OR_RELEASE_VERSION_REGEX = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)(?:-([1-9]\d*))?$/
const BETA_VERSION_REGEX = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-beta\.([1-9]\d*)$/
const APP_DISPLAY_NAME = process.env.PIXEL_FORGE_DESKTOP_ENTRY_NAME || 'Pixel Forge'
const DESKTOP_WM_CLASS = process.env.PIXEL_FORGE_DESKTOP_WM_CLASS || `${INSTANCE_SLUG}-desktop`
const DESKTOP_ICON_PATH = [
  process.env.PIXEL_FORGE_DESKTOP_ICON_PATH,
  process.env.PIXEL_FORGE_INSTALL_DIR
    ? path.join(process.env.PIXEL_FORGE_INSTALL_DIR, 'frontend', 'favicon', 'app.png')
    : null,
  path.join(__dirname, '..', 'frontend', 'favicon', 'app.png'),
  path.join(__dirname, '..', 'web', 'public', 'favicon', 'app.png'),
].find((candidate) => candidate && existsSync(candidate))

function desktopWindowOptions(options = {}) {
  const baseOptions = {
    title: APP_DISPLAY_NAME,
  }
  if (DESKTOP_ICON_PATH) {
    baseOptions.icon = DESKTOP_ICON_PATH
  }
  return {
    ...baseOptions,
    ...options,
  }
}

app.setName(APP_DISPLAY_NAME)
app.commandLine.appendSwitch('class', DESKTOP_WM_CLASS)
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-webgl')
app.commandLine.appendSwitch('enable-gpu-rasterization')
const PREVIEW_WEBGL_BACKEND = (
  process.env.PIXEL_FORGE_WEBGL_BACKEND
  || (process.env.PIXEL_FORGE_FORCE_SWIFTSHADER_WEBGL === '1' ? 'swiftshader-webgl' : 'system')
).trim()
if (PREVIEW_WEBGL_BACKEND && PREVIEW_WEBGL_BACKEND !== 'system') {
  app.commandLine.appendSwitch('use-angle', PREVIEW_WEBGL_BACKEND)
  if (PREVIEW_WEBGL_BACKEND.toLowerCase().includes('swiftshader')) {
    app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  }
}
app.commandLine.appendSwitch('remote-debugging-address', CONTROLLER_CDP_HOST)
app.commandLine.appendSwitch('remote-debugging-port', CONTROLLER_CDP_PORT)

const SHOULD_RUN_APP = IS_UPDATER_UI_MODE || app.requestSingleInstanceLock()

if (!SHOULD_RUN_APP) {
  app.exit(0)
}

let mainWindow = null
let agentDeckSurfaceWindow = null
let updaterWindow = null
let pickerOverlayWindow = null
let pickerOverlayResolver = null
let pickerOverlaySettling = false
let pickerOverlayOwnerContextId = null
let browserBrokerServer = null
let browserBrokerToken = null
let browserBrokerUrl = null
let pendingUpdateSnapshot = null
let controllerUpdateApplyState = {
  status: 'idle',
  updateId: null,
  phase: 'idle',
  progress: 0,
  message: '',
  error: null,
  startedAt: null,
  updatedAt: null,
}

const previewViews = new Map()
const previewContexts = new Map()
const previewKeyByWebContentsId = new Map()
const suspendedPreviewKeys = new Set()

function getMainPreviewContextId() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null
  }
  return mainWindow.webContents.id
}

function makePreviewKey(ownerContextId, tabId) {
  return `${ownerContextId}::${tabId}`
}

function ensurePreviewContext(ownerContextId) {
  const existing = previewContexts.get(ownerContextId)
  if (existing) {
    return existing
  }

  const context = {
    activeTabId: null,
    visible: false,
    focusedSurface: 'shell',
    armedTool: null,
    bounds: { x: 0, y: 0, width: 0, height: 0, borderRadius: 0 },
    attachedView: null,
  }
  previewContexts.set(ownerContextId, context)
  return context
}

function getPreviewRecord(ownerContextId, tabId) {
  return previewViews.get(makePreviewKey(ownerContextId, tabId)) ?? null
}

function getPreviewRecordForWebContentsId(webContentsId) {
  const previewKey = previewKeyByWebContentsId.get(webContentsId)
  return previewKey ? previewViews.get(previewKey) ?? null : null
}

function getPreviewRecordForTabId(tabId) {
  const normalizedTabId = normalizeText(tabId)
  if (!normalizedTabId) {
    return null
  }

  for (const previewRecord of previewViews.values()) {
    if (previewRecord.tabId === normalizedTabId) {
      return previewRecord
    }
  }

  return null
}

function currentView(ownerContextId) {
  const context = previewContexts.get(ownerContextId)
  if (!context?.activeTabId) {
    return null
  }
  return getPreviewRecord(ownerContextId, context.activeTabId)?.view ?? null
}

function previewContextDepth(ownerContextId) {
  const mainContextId = getMainPreviewContextId()
  if (ownerContextId === mainContextId) {
    return 0
  }

  const ownerPreviewKey = previewKeyByWebContentsId.get(ownerContextId)
  if (!ownerPreviewKey) {
    return 1
  }

  const ownerRecord = previewViews.get(ownerPreviewKey)
  if (!ownerRecord) {
    return 1
  }

  return 1 + previewContextDepth(ownerRecord.ownerContextId)
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function controllerDevtoolsBrowserUrl() {
  const port = normalizeText(CONTROLLER_CDP_PORT)
  if (!port) {
    return null
  }
  return `http://${CONTROLLER_CDP_HOST}:${port}`
}

async function readControllerDevtoolsTargetSnapshot() {
  const browserUrl = controllerDevtoolsBrowserUrl()
  if (!browserUrl) {
    return { available: false, targets: [], error: 'Controller CDP port is disabled.' }
  }

  try {
    const response = await fetch(new URL('/json/list', browserUrl), { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const payload = await response.json()
    return { available: true, targets: Array.isArray(payload) ? payload : [], error: null }
  } catch (error) {
    console.warn('[desktop] Failed to read controller DevTools targets:', error)
    return {
      available: false,
      targets: [],
      error: `Controller CDP endpoint ${browserUrl} is not reachable.`,
    }
  }
}

function sendBrokerJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}

async function readBrokerRequestJson(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) {
    return {}
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    return {}
  }
  return JSON.parse(raw)
}

function brokerRequestAuthorized(request, url) {
  if (!browserBrokerToken) {
    return false
  }
  const authorization = request.headers.authorization || ''
  if (authorization === `Bearer ${browserBrokerToken}`) {
    return true
  }
  return url.searchParams.get('token') === browserBrokerToken
}

function brokerScopeFromUrl(url) {
  return {
    projectPath: normalizeText(url.searchParams.get('project_path')),
    chatId: normalizeText(url.searchParams.get('chat_id')),
  }
}

function brokerScopeFromPayload(payload = {}) {
  return {
    projectPath: normalizeText(payload.project_path) || normalizeText(payload.projectPath),
    chatId:
      normalizeText(payload.chat_id)
      || normalizeText(payload.chatId)
      || normalizeText(payload.thread_id)
      || normalizeText(payload.threadId),
  }
}

function brokerMainOwnerContextId() {
  const ownerContextId = getMainPreviewContextId()
  if (ownerContextId === null) {
    throw new Error('Pixel Forge desktop shell is not ready.')
  }
  return ownerContextId
}

function brokerNewTabId(chatId) {
  const chatPrefix = normalizeText(chatId)?.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 28) || 'agent'
  return `broker-${chatPrefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

async function openBrokerTab(payload = {}) {
  const ownerContextId = brokerMainOwnerContextId()
  const metadata = sanitizeBrowserBrokerMetadata({
    ...payload,
    ownerKind: normalizeText(payload.owner_kind) || normalizeText(payload.ownerKind) || 'agent',
  })
  const tabId = normalizeText(payload.tab_id) || normalizeText(payload.tabId) || brokerNewTabId(metadata.chatId)
  const url = normalizeText(payload.url) || 'about:blank'
  const activate = payload.activate !== false
  const response = await loadPreviewUrl(ownerContextId, tabId, url, metadata)
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  if (!previewRecord) {
    throw new Error(`Failed to create broker tab: ${tabId}`)
  }
  if (activate) {
    const context = ensurePreviewContext(ownerContextId)
    context.activeTabId = tabId
    context.visible = true
    applyAllPreviewViews()
  }
  const tab = brokerTabPayload(previewRecord)
  sendPreviewEvent(ownerContextId, {
    type: 'browser-broker-tab-opened',
    browser_tab_id: tabId,
    tab_id: tabId,
    project_path: metadata.projectPath,
    chat_id: metadata.chatId,
    owner_kind: metadata.ownerKind,
    url: response.target_url,
    title: response.title,
    can_go_back: response.can_go_back,
    can_go_forward: response.can_go_forward,
    activate,
  })
  return { ok: true, tab }
}

async function brokerEvaluate(previewRecord, expression) {
  if (!previewRecord?.view || previewRecord.view.webContents.isDestroyed()) {
    throw new Error('Preview tab is not resident.')
  }
  touchPreviewRecord(previewRecord)
  const result = await previewRecord.view.webContents.executeJavaScript(String(expression || ''), true)
  return { ok: true, result }
}

async function brokerClick(previewRecord, selector) {
  if (!previewRecord?.view || previewRecord.view.webContents.isDestroyed()) {
    throw new Error('Preview tab is not resident.')
  }
  const normalizedSelector = normalizeText(selector)
  if (!normalizedSelector) {
    throw new Error('selector is required')
  }
  touchPreviewRecord(previewRecord)
  const target = await previewRecord.view.webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector(${JSON.stringify(normalizedSelector)});
      if (!target) {
        return { ok: false, error: 'selector-not-found' };
      }
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = target.getBoundingClientRect();
      return {
        ok: true,
        tagName: target.tagName,
        text: (target.innerText || target.textContent || '').trim().slice(0, 300),
        x: Math.max(0, Math.round(rect.left + rect.width / 2)),
        y: Math.max(0, Math.round(rect.top + rect.height / 2)),
        width: rect.width,
        height: rect.height,
      };
    })()
  `, true)
  if (!target?.ok) {
    return { ok: false, error: target?.error || 'selector-not-clickable' }
  }
  previewRecord.view.webContents.focus()
  previewRecord.view.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
  previewRecord.view.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(30)
  previewRecord.view.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  return { ok: true, target }
}

async function brokerType(previewRecord, selector, text, options = {}) {
  if (!previewRecord?.view || previewRecord.view.webContents.isDestroyed()) {
    throw new Error('Preview tab is not resident.')
  }
  const normalizedSelector = normalizeText(selector)
  if (!normalizedSelector) {
    throw new Error('selector is required')
  }
  const normalizedText = typeof text === 'string' ? text : ''
  touchPreviewRecord(previewRecord)
  const focused = await previewRecord.view.webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector(${JSON.stringify(normalizedSelector)});
      if (!target) {
        return { ok: false, error: 'selector-not-found' };
      }
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      target.focus();
      if (${options.clear === false ? 'false' : 'true'} && 'value' in target) {
        target.value = '';
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
      return {
        ok: true,
        tagName: target.tagName,
        text: (target.innerText || target.textContent || '').trim().slice(0, 300),
      };
    })()
  `, true)
  if (!focused?.ok) {
    return { ok: false, error: focused?.error || 'selector-not-typable' }
  }
  previewRecord.view.webContents.focus()
  await previewRecord.view.webContents.insertText(normalizedText)
  await previewRecord.view.webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector(${JSON.stringify(normalizedSelector)});
      if (!target) return;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(normalizedText)} }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `, true)
  return { ok: true, target: focused }
}

async function brokerScreenshot(previewRecord, selector = null) {
  if (!previewRecord?.view || previewRecord.view.webContents.isDestroyed()) {
    throw new Error('Preview tab is not resident.')
  }
  touchPreviewRecord(previewRecord)
  let rect = undefined
  const normalizedSelector = normalizeText(selector)
  if (normalizedSelector) {
    const targetRect = await previewRecord.view.webContents.executeJavaScript(`
      (() => {
        const target = document.querySelector(${JSON.stringify(normalizedSelector)});
        if (!target) {
          return null;
        }
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = target.getBoundingClientRect();
        return {
          x: Math.max(0, Math.floor(rect.left)),
          y: Math.max(0, Math.floor(rect.top)),
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height)),
        };
      })()
    `, true)
    if (!targetRect) {
      return { ok: false, error: 'selector-not-found' }
    }
    rect = targetRect
  }
  const image = await previewRecord.view.webContents.capturePage(rect)
  const png = image.toPNG()
  return {
    ok: true,
    mime_type: 'image/png',
    data_url: `data:image/png;base64,${png.toString('base64')}`,
    size_bytes: png.length,
    rect: rect ?? null,
  }
}

async function handleBrowserBrokerRequest(request, response) {
  const url = new URL(request.url || '/', browserBrokerUrl || 'http://127.0.0.1')
  if (!brokerRequestAuthorized(request, url)) {
    sendBrokerJson(response, 401, { error: 'unauthorized' })
    return
  }

  try {
    if (request.method === 'GET' && url.pathname === '/status') {
      sendBrokerJson(response, 200, {
        ok: true,
        pid: process.pid,
        base_url: browserBrokerUrl,
        controller_cdp_url: controllerDevtoolsBrowserUrl(),
        tab_count: previewViews.size,
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/tabs') {
      sendBrokerJson(response, 200, { tabs: listBrokerTabs(brokerScopeFromUrl(url)) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/tabs') {
      const payload = await readBrokerRequestJson(request)
      sendBrokerJson(response, 200, await openBrokerTab(payload))
      return
    }

    const tabMatch = url.pathname.match(/^\/tabs\/([^/]+)(?:\/([^/]+))?$/)
    if (tabMatch) {
      const tabId = decodeURIComponent(tabMatch[1])
      const action = tabMatch[2] || ''
      const scope = brokerScopeFromUrl(url)
      const previewRecord = getBrokerPreviewRecord(tabId, scope)
      if (!previewRecord) {
        sendBrokerJson(response, 404, { error: 'tab-not-found', tab_id: tabId })
        return
      }

      if (request.method === 'GET' && !action) {
        sendBrokerJson(response, 200, { tab: brokerTabPayload(previewRecord) })
        return
      }

      if (request.method === 'POST' && action === 'navigate') {
        const payload = await readBrokerRequestJson(request)
        const targetUrl = normalizeText(payload.url)
        if (!targetUrl) {
          throw new Error('url is required')
        }
        const loadResponse = await loadPreviewUrl(previewRecord.ownerContextId, previewRecord.tabId, targetUrl, {
          ...brokerScopeFromPayload(payload),
          ownerKind: payload.owner_kind || payload.ownerKind || previewRecord.ownerKind,
        })
        sendBrokerJson(response, 200, { ok: true, response: loadResponse, tab: brokerTabPayload(previewRecord) })
        return
      }

      if (request.method === 'GET' && action === 'inspect') {
        const inspection = await inspectPreviewView(previewRecord.ownerContextId, previewRecord.tabId, [])
        sendBrokerJson(response, 200, { ok: true, inspection })
        return
      }

      if (request.method === 'GET' && action === 'devtools') {
        const devtools = await inspectPreviewDevtoolsTarget(previewRecord.view)
        sendBrokerJson(response, 200, { ok: true, ...devtools })
        return
      }

      if (request.method === 'POST' && action === 'evaluate') {
        const payload = await readBrokerRequestJson(request)
        sendBrokerJson(response, 200, await brokerEvaluate(previewRecord, payload.expression || payload.script || payload.code))
        return
      }

      if (request.method === 'POST' && action === 'click') {
        const payload = await readBrokerRequestJson(request)
        sendBrokerJson(response, 200, await brokerClick(previewRecord, payload.selector))
        return
      }

      if (request.method === 'POST' && action === 'type') {
        const payload = await readBrokerRequestJson(request)
        sendBrokerJson(response, 200, await brokerType(previewRecord, payload.selector, payload.text, payload))
        return
      }

      if (request.method === 'POST' && action === 'screenshot') {
        const payload = await readBrokerRequestJson(request)
        sendBrokerJson(response, 200, await brokerScreenshot(previewRecord, payload.selector))
        return
      }
    }

    sendBrokerJson(response, 404, { error: 'not-found' })
  } catch (error) {
    sendBrokerJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function writeBrowserBrokerManifest() {
  if (!browserBrokerUrl || !browserBrokerToken) {
    return
  }
  await ensureAppStateDir()
  await fsPromises.writeFile(
    BROWSER_BROKER_MANIFEST_PATH,
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      baseUrl: browserBrokerUrl,
      token: browserBrokerToken,
      controllerCdpUrl: controllerDevtoolsBrowserUrl(),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  )
}

function startBrowserBroker() {
  if (browserBrokerServer) {
    return
  }
  browserBrokerToken = randomBytes(24).toString('hex')
  browserBrokerServer = createServer((request, response) => {
    void handleBrowserBrokerRequest(request, response)
  })
  browserBrokerServer.listen(0, '127.0.0.1', () => {
    const address = browserBrokerServer?.address()
    if (address && typeof address === 'object') {
      browserBrokerUrl = `http://127.0.0.1:${address.port}`
      void writeBrowserBrokerManifest()
      console.log(`[pixel-forge] Browser broker listening on ${browserBrokerUrl}`)
    }
  })
}

function stopBrowserBroker() {
  if (browserBrokerServer) {
    browserBrokerServer.close()
    browserBrokerServer = null
  }
  browserBrokerUrl = null
  browserBrokerToken = null
  void fsPromises.rm(BROWSER_BROKER_MANIFEST_PATH, { force: true }).catch(() => {})
}

function getContextWebContents(ownerContextId) {
  const mainContextId = getMainPreviewContextId()
  if (mainContextId === null) {
    return null
  }

  return (
    ownerContextId === mainContextId
      ? mainWindow?.webContents ?? null
      : electronWebContents.fromId(ownerContextId)
  )
}

function normalizeFocusedSurface(value) {
  return value === 'preview' || value === 'overlay' ? value : 'shell'
}

function normalizePreviewTool(value) {
  return value === 'select' ? 'select' : null
}

function readPreviewInputState(ownerContextId) {
  const context = ensurePreviewContext(ownerContextId)
  return {
    activePreviewTabId: context.activeTabId,
    previewVisible: Boolean(context.visible && context.activeTabId),
    focusedSurface: normalizeFocusedSurface(context.focusedSurface),
    armedTool: normalizePreviewTool(context.armedTool),
  }
}

function sendAppEventToContext(ownerContextId, event) {
  const targetContents = getContextWebContents(ownerContextId)
  if (!targetContents || targetContents.isDestroyed()) {
    return
  }
  targetContents.send('pixel-forge-app:event', event)
}

function emitPreviewInputState(ownerContextId, changedFields = []) {
  sendAppEventToContext(ownerContextId, {
    type: 'preview-input-state-changed',
    inputState: readPreviewInputState(ownerContextId),
    changedFields: Array.isArray(changedFields) ? changedFields : [],
  })
}

function updatePreviewInputState(ownerContextId, updates = {}) {
  const context = ensurePreviewContext(ownerContextId)
  const changedFields = []

  if (Object.prototype.hasOwnProperty.call(updates, 'focusedSurface')) {
    const nextFocusedSurface = normalizeFocusedSurface(updates.focusedSurface)
    if (context.focusedSurface !== nextFocusedSurface) {
      context.focusedSurface = nextFocusedSurface
      changedFields.push('focusedSurface')
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'armedTool')) {
    const nextArmedTool = normalizePreviewTool(updates.armedTool)
    if (context.armedTool !== nextArmedTool) {
      context.armedTool = nextArmedTool
      changedFields.push('armedTool')
    }
  }

  if (changedFields.length > 0) {
    emitPreviewInputState(ownerContextId, changedFields)
  }

  return readPreviewInputState(ownerContextId)
}

function reflectPreviewToolForActiveTab(ownerContextId, tabId, tool) {
  const context = ensurePreviewContext(ownerContextId)
  if (tabId && context.activeTabId && context.activeTabId !== tabId) {
    return readPreviewInputState(ownerContextId)
  }
  return updatePreviewInputState(ownerContextId, { armedTool: tool })
}

function sendPreviewEvent(ownerContextId, event) {
  const targetContents = getContextWebContents(ownerContextId)
  if (!targetContents || targetContents.isDestroyed()) {
    return
  }
  targetContents.send('pixel-forge-preview:event', event)
}

function touchPreviewRecord(previewRecord) {
  if (previewRecord) {
    previewRecord.lastUsedAt = Date.now()
  }
}

function sanitizeBrowserBrokerMetadata(payload = {}) {
  return {
    projectPath:
      normalizeText(payload?.projectPath)
      || normalizeText(payload?.project_path)
      || null,
    chatId:
      normalizeText(payload?.chatId)
      || normalizeText(payload?.chat_id)
      || normalizeText(payload?.threadId)
      || normalizeText(payload?.thread_id)
      || null,
    ownerKind:
      normalizeText(payload?.ownerKind)
      || normalizeText(payload?.owner_kind)
      || null,
  }
}

function updatePreviewRecordOwnership(previewRecord, metadata = {}) {
  if (!previewRecord) {
    return
  }
  const sanitized = sanitizeBrowserBrokerMetadata(metadata)
  if (sanitized.projectPath) {
    previewRecord.projectPath = sanitized.projectPath
  }
  if (sanitized.chatId) {
    previewRecord.chatId = sanitized.chatId
  }
  if (sanitized.ownerKind) {
    previewRecord.ownerKind = sanitized.ownerKind
  }
}

function previewRecordMatchesBrokerScope(previewRecord, filters = {}) {
  const projectPath = normalizeText(filters.projectPath) || normalizeText(filters.project_path)
  const chatId =
    normalizeText(filters.chatId)
    || normalizeText(filters.chat_id)
    || normalizeText(filters.threadId)
    || normalizeText(filters.thread_id)
  if (projectPath && previewRecord?.projectPath !== projectPath) {
    return false
  }
  if (chatId && previewRecord?.chatId !== chatId) {
    return false
  }
  return true
}

function brokerTabPayload(previewRecord) {
  const view = previewRecord?.view
  const targetUrl = currentPreviewUrl(previewRecord, view?.webContents.getURL() || '')
  return {
    tab_id: previewRecord?.tabId || '',
    browser_tab_id: previewRecord?.tabId || '',
    project_path: previewRecord?.projectPath ?? null,
    chat_id: previewRecord?.chatId ?? null,
    owner_kind: previewRecord?.ownerKind ?? null,
    url: targetUrl,
    title: currentPreviewTitle(previewRecord, targetUrl),
    can_go_back: previewCanGoBack(view),
    can_go_forward: previewCanGoForward(view),
    web_contents_id: previewRecord?.webContentsId ?? null,
    active:
      Boolean(previewRecord)
      && previewContexts.get(previewRecord.ownerContextId)?.activeTabId === previewRecord.tabId,
    resident: Boolean(view && !view.webContents.isDestroyed()),
    last_used_at: previewRecord?.lastUsedAt ?? null,
  }
}

function browserBrokerContextPayload(previewRecord) {
  if (!previewRecord || !browserBrokerUrl) {
    return {
      browser_broker_available: false,
    }
  }
  const projectFlag = previewRecord.projectPath
    ? ` --project ${JSON.stringify(previewRecord.projectPath)}`
    : ''
  const chatFlag = previewRecord.chatId
    ? ` --chat ${JSON.stringify(previewRecord.chatId)}`
    : ''
  return {
    browser_broker_available: true,
    browser_broker_tab_id: previewRecord.tabId,
    browser_broker_project_path: previewRecord.projectPath ?? null,
    browser_broker_chat_id: previewRecord.chatId ?? null,
    browser_broker_open_command:
      `pixel-forge browser open <url>${projectFlag}${chatFlag}`,
    browser_broker_inspect_command:
      `pixel-forge browser inspect ${previewRecord.tabId}${projectFlag}${chatFlag}`,
    browser_broker_screenshot_command:
      `pixel-forge browser screenshot ${previewRecord.tabId}${projectFlag}${chatFlag} --out /tmp/pixel-forge-preview.png`,
    browser_broker_devtools_command:
      `pixel-forge browser devtools ${previewRecord.tabId}${projectFlag}${chatFlag}`,
  }
}

function listBrokerTabs(filters = {}) {
  return Array.from(previewViews.values())
    .filter((previewRecord) => previewRecordMatchesBrokerScope(previewRecord, filters))
    .sort((left, right) => (right.lastUsedAt || 0) - (left.lastUsedAt || 0))
    .map((previewRecord) => brokerTabPayload(previewRecord))
}

function getBrokerPreviewRecord(tabId, filters = {}) {
  const normalizedTabId = normalizeText(tabId)
  if (!normalizedTabId) {
    return null
  }
  const previewRecord = getPreviewRecordForTabId(normalizedTabId)
  if (!previewRecord || !previewRecordMatchesBrokerScope(previewRecord, filters)) {
    return null
  }
  return previewRecord
}

function broadcastAppEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('pixel-forge-app:event', event)
}

function sanitizeControllerUpdateApplyState(payload) {
  const allowedPhases = new Set([
    'idle',
    'preparing',
    'installing',
    'restarting',
    'waiting',
    'finalizing',
    'relaunching',
    'done',
    'error',
  ])
  const status =
    payload?.status === 'running' || payload?.status === 'error' || payload?.status === 'done'
      ? payload.status
      : 'idle'
  const phase = allowedPhases.has(payload?.phase)
    ? payload.phase
    : status === 'error'
      ? 'error'
      : status === 'done'
        ? 'done'
        : 'idle'
  const progress = Math.max(0, Math.min(100, Math.round(Number(payload?.progress) || 0)))
  const startedAt = normalizeText(payload?.startedAt)
  const updatedAt = normalizeText(payload?.updatedAt) || new Date().toISOString()
  return {
    status,
    updateId: normalizeText(payload?.updateId),
    phase,
    progress,
    message: normalizeText(payload?.message) || '',
    error: normalizeText(payload?.error),
    startedAt,
    updatedAt,
  }
}

function setControllerUpdateApplyState(payload) {
  const nextPayload = { ...(payload ?? {}) }
  const status = normalizeText(nextPayload.status)
  if (
    (status === 'running' || status === 'done' || status === 'error')
    && !normalizeText(nextPayload.startedAt)
  ) {
    const previousStartedAt = normalizeText(controllerUpdateApplyState?.startedAt)
    const previousUpdateId = normalizeText(controllerUpdateApplyState?.updateId)
    const nextUpdateId = normalizeText(nextPayload.updateId)
    nextPayload.startedAt =
      previousStartedAt && (!nextUpdateId || previousUpdateId === nextUpdateId)
        ? previousStartedAt
        : new Date().toISOString()
  }
  controllerUpdateApplyState = sanitizeControllerUpdateApplyState(nextPayload)
  void persistControllerUpdateApplyState(controllerUpdateApplyState)
  broadcastAppEvent({
    type: 'controller-update-apply-state-changed',
    state: controllerUpdateApplyState,
  })
  return controllerUpdateApplyState
}

async function ensureAppStateDir() {
  await fsPromises.mkdir(APP_STATE_DIR, { recursive: true })
}

function shouldIgnoreSnapshotEntry(relativePath) {
  const normalized = relativePath.split(path.sep).filter(Boolean)
  if (normalized.length === 0) {
    return false
  }

  if (normalized.includes('.git') || normalized.includes('.venv') || normalized.includes('node_modules')) {
    return true
  }

  return (
    normalized[0] === '.pixel-forge'
    && (normalized[1] === 'instances' || normalized[1] === 'requests')
  )
}

async function copyControllerSnapshotTree(sourceRoot, destinationRoot, relativePath = '') {
  const sourcePath = relativePath ? path.join(sourceRoot, relativePath) : sourceRoot
  const destinationPath = relativePath ? path.join(destinationRoot, relativePath) : destinationRoot
  const stat = await fsPromises.lstat(sourcePath)

  if (stat.isSymbolicLink()) {
    const linkTarget = await fsPromises.readlink(sourcePath)
    await fsPromises.symlink(linkTarget, destinationPath)
    return
  }

  if (stat.isDirectory()) {
    await fsPromises.mkdir(destinationPath, { recursive: true })
    await fsPromises.chmod(destinationPath, stat.mode)
    const entries = await fsPromises.readdir(sourcePath, { withFileTypes: true })
    for (const entry of entries) {
      const entryRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name
      if (shouldIgnoreSnapshotEntry(entryRelativePath)) {
        continue
      }
      await copyControllerSnapshotTree(sourceRoot, destinationRoot, entryRelativePath)
    }
    return
  }

  await fsPromises.copyFile(sourcePath, destinationPath)
  await fsPromises.chmod(destinationPath, stat.mode)
}

function releaseDatePrefix(date = new Date()) {
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`
}

function normalizeVersionText(value) {
  return normalizeText(value)?.replace(/^v/, '') ?? null
}

function isSupportedCalverVersion(value) {
  const normalized = normalizeVersionText(value)
  return Boolean(
    normalized
    && (
      STABLE_OR_RELEASE_VERSION_REGEX.test(normalized)
      || BETA_VERSION_REGEX.test(normalized)
    )
  )
}

function releaseOrdinalForDate(value, datePrefix) {
  const normalized = normalizeVersionText(value)
  if (!normalized) {
    return null
  }
  const match = STABLE_OR_RELEASE_VERSION_REGEX.exec(normalized)
  if (!match) {
    return null
  }
  const prefix = `${match[1]}.${Number(match[2])}.${Number(match[3])}`
  if (prefix !== datePrefix) {
    return null
  }
  return match[4] ? Number(match[4]) : 0
}

async function resolveControllerReleaseVersion(projectPath) {
  const sourceVersion = await readProjectVersion(projectPath)
  if (sourceVersion && !isSupportedCalverVersion(sourceVersion)) {
    return sourceVersion
  }

  const datePrefix = releaseDatePrefix()
  const currentPending = await readPendingControllerUpdate()
  const candidateOrdinals = [
    await readControllerVersion(),
    currentPending?.version,
  ]
    .map((version) => releaseOrdinalForDate(version, datePrefix))
    .filter((ordinal) => typeof ordinal === 'number')
  const maxExistingOrdinal = Math.max(0, ...candidateOrdinals)
  const sourceOrdinal = releaseOrdinalForDate(sourceVersion, datePrefix)

  if (typeof sourceOrdinal === 'number' && sourceOrdinal > maxExistingOrdinal) {
    return normalizeVersionText(sourceVersion)
  }

  return `${datePrefix}-${maxExistingOrdinal + 1}`
}

async function writeControllerSnapshotVersion(snapshotPath, version) {
  const normalizedVersion = normalizeText(version)
  if (!normalizedVersion) {
    return
  }

  await fsPromises.writeFile(
    path.join(snapshotPath, VERSION_FILE_RELATIVE_PATH),
    `${normalizedVersion}\n`,
    'utf-8',
  )

  for (const relativePath of VERSION_PACKAGE_RELATIVE_PATHS) {
    const packagePath = path.join(snapshotPath, relativePath)
    if (!existsSync(packagePath)) {
      continue
    }
    const payload = JSON.parse(await fsPromises.readFile(packagePath, 'utf-8'))
    payload.version = normalizedVersion
    await fsPromises.writeFile(packagePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  }
}

function isInstallableProjectRoot(candidatePath) {
  if (!candidatePath) {
    return false
  }

  const resolvedPath = path.resolve(candidatePath)
  return (
    path.basename(resolvedPath) !== 'node_modules'
    && requireInstallLayout(resolvedPath)
  )
}

function requireInstallLayout(candidatePath) {
  return (
    path.isAbsolute(candidatePath)
    && existsSync(path.join(candidatePath, 'install.sh'))
    && existsSync(path.join(candidatePath, 'apps', 'api', 'main.py'))
  )
}

function getOwnerBaseBounds(ownerContextId) {
  const mainContextId = getMainPreviewContextId()
  if (mainContextId === null) {
    return null
  }

  if (ownerContextId === mainContextId) {
    return { x: 0, y: 0 }
  }

  const ownerPreviewKey = previewKeyByWebContentsId.get(ownerContextId)
  if (!ownerPreviewKey) {
    return null
  }

  const ownerRecord = previewViews.get(ownerPreviewKey)
  if (!ownerRecord) {
    return null
  }

  const parentContext = previewContexts.get(ownerRecord.ownerContextId)
  if (!parentContext?.visible || parentContext.attachedView !== ownerRecord.view) {
    return null
  }

  const ownerBounds = ownerRecord.view.getBounds()
  return {
    x: ownerBounds.x,
    y: ownerBounds.y,
  }
}

async function createControllerUpdateSnapshot(projectPath, updateId) {
  const sourcePath = path.resolve(projectPath)
  if (!isInstallableProjectRoot(sourcePath)) {
    throw new Error(`Cannot stage controller update from non-installable root: ${sourcePath}`)
  }

  const normalizedUpdateId = normalizeText(updateId) || Math.random().toString(36).slice(2, 14)
  let snapshotPath = path.join(CONTROLLER_UPDATE_SNAPSHOTS_DIR, normalizedUpdateId)
  await fsPromises.mkdir(CONTROLLER_UPDATE_SNAPSHOTS_DIR, { recursive: true })
  await deleteControllerUpdateSnapshot(snapshotPath)

  if (existsSync(snapshotPath)) {
    snapshotPath = path.join(
      CONTROLLER_UPDATE_SNAPSHOTS_DIR,
      `${normalizedUpdateId}-${Date.now().toString(36)}`,
    )
    await deleteControllerUpdateSnapshot(snapshotPath)
  }

  await copyControllerSnapshotTree(sourcePath, snapshotPath)
  if (!isInstallableProjectRoot(snapshotPath)) {
    throw new Error(`Staged controller update snapshot is incomplete: ${snapshotPath}`)
  }
  return snapshotPath
}

async function deleteControllerUpdateSnapshot(snapshotPath) {
  if (!snapshotPath) {
    return true
  }
  const resolvedPath = path.resolve(snapshotPath)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsPromises.rm(resolvedPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150,
      })
      return true
    } catch (error) {
      const code = typeof error === 'object' && error ? error.code : ''
      if (attempt === 3) {
        console.warn(
          `[pixel-forge] Failed to delete controller update snapshot ${resolvedPath}:`,
          error,
        )
        return false
      }
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        console.warn(
          `[pixel-forge] Unexpected snapshot cleanup error for ${resolvedPath}:`,
          error,
        )
        return false
      }
      await sleep(250 * (attempt + 1))
    }
  }

  return !existsSync(resolvedPath)
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    console.warn(`[pixel-forge] Failed to read ${filePath}:`, error)
    return null
  }
}

async function writeJsonFile(filePath, payload) {
  await ensureAppStateDir()
  await fsPromises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

async function deleteFileIfPresent(filePath) {
  try {
    await fsPromises.unlink(filePath)
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
      throw error
    }
  }
}

async function readDismissedControllerUpdateId() {
  try {
    const raw = await fsPromises.readFile(DISMISSED_CONTROLLER_UPDATE_ID_PATH, 'utf-8')
    return normalizeText(raw)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writeDismissedControllerUpdateId(updateId) {
  const normalized = normalizeText(updateId)
  if (!normalized) {
    await deleteFileIfPresent(DISMISSED_CONTROLLER_UPDATE_ID_PATH)
    return null
  }
  await fsPromises.writeFile(DISMISSED_CONTROLLER_UPDATE_ID_PATH, `${normalized}\n`, 'utf-8')
  return normalized
}

async function readControllerUpdateApplyState() {
  const payload = await readJsonFile(CONTROLLER_UPDATE_APPLY_STATE_PATH)
  if (!payload || typeof payload !== 'object') {
    return null
  }
  return sanitizeControllerUpdateApplyState(payload)
}

async function persistControllerUpdateApplyState(state) {
  const normalized = sanitizeControllerUpdateApplyState(state)
  if (normalized.status === 'idle') {
    await deleteFileIfPresent(CONTROLLER_UPDATE_APPLY_STATE_PATH)
    return
  }
  await writeJsonFile(CONTROLLER_UPDATE_APPLY_STATE_PATH, normalized)
}

async function syncControllerUpdateApplyStateFromDisk() {
  const persisted = await readControllerUpdateApplyState()
  controllerUpdateApplyState = persisted ?? sanitizeControllerUpdateApplyState({
    status: 'idle',
    phase: 'idle',
    progress: 0,
    message: '',
    error: null,
  })
  return controllerUpdateApplyState
}

function sanitizePendingControllerUpdate(payload) {
  const projectPath = normalizeText(payload?.projectPath)
  if (!projectPath) {
    throw new Error('projectPath is required')
  }

  const activeMode =
    payload?.activeMode === 'live-editor' || payload?.activeMode === 'screenshot'
      ? payload.activeMode
      : null

  return {
    id: normalizeText(payload?.id) || Math.random().toString(36).slice(2, 14),
    projectPath,
    snapshotPath: normalizeText(payload?.snapshotPath),
    version: normalizeText(payload?.version),
    previewUrl: normalizeText(payload?.previewUrl),
    activeMode,
    summary: normalizeText(payload?.summary) || 'Update ready to load.',
    source: normalizeText(payload?.source) || 'manual',
    requestId: normalizeText(payload?.requestId),
    commitHash: normalizeText(payload?.commitHash),
    createdAt: normalizeText(payload?.createdAt) || new Date().toISOString(),
    canRollback: payload?.canRollback !== false,
  }
}

async function withPendingControllerUpdateVersion(update) {
  if (!update || update.version) {
    return update
  }

  const resolvedVersion = await readProjectVersion(update.snapshotPath || update.projectPath)
  if (!resolvedVersion) {
    return update
  }

  return {
    ...update,
    version: resolvedVersion,
  }
}

async function readPendingControllerUpdate() {
  const payload = await readJsonFile(PENDING_CONTROLLER_UPDATE_PATH)
  if (!payload || typeof payload !== 'object') {
    return null
  }

  try {
    return withPendingControllerUpdateVersion(sanitizePendingControllerUpdate(payload))
  } catch {
    return null
  }
}

async function syncPendingControllerUpdate() {
  const update = await readPendingControllerUpdate()
  const dismissedId = await readDismissedControllerUpdateId()
  if (update && dismissedId && dismissedId !== update.id) {
    await writeDismissedControllerUpdateId(null)
  }
  const serialized = JSON.stringify(update)
  if (serialized === pendingUpdateSnapshot) {
    return update
  }
  pendingUpdateSnapshot = serialized
  broadcastAppEvent({
    type: 'pending-controller-update-changed',
    update,
  })
  return update
}

async function stagePendingControllerUpdate(payload) {
  const normalized = sanitizePendingControllerUpdate(payload)
  const releaseVersion = await resolveControllerReleaseVersion(normalized.projectPath)
  normalized.snapshotPath = await createControllerUpdateSnapshot(
    normalized.projectPath,
    normalized.id,
  )
  normalized.version = releaseVersion
  await writeControllerSnapshotVersion(normalized.snapshotPath, normalized.version)
  await writeJsonFile(PENDING_CONTROLLER_UPDATE_PATH, normalized)
  await writeDismissedControllerUpdateId(null)
  pendingUpdateSnapshot = null
  await syncPendingControllerUpdate()
  return normalized
}

async function rewritePendingControllerUpdate(update) {
  const normalized = sanitizePendingControllerUpdate(update)
  if (!normalized.version) {
    normalized.version = await readProjectVersion(
      normalized.snapshotPath || normalized.projectPath,
    )
  }
  await writeJsonFile(PENDING_CONTROLLER_UPDATE_PATH, normalized)
  pendingUpdateSnapshot = null
  await syncPendingControllerUpdate()
  return normalized
}

async function readRuntimeInfo() {
  try {
    const runtimeInfoUrl = new URL('/api/runtime-info', SHELL_URL).toString()
    const response = await fetch(runtimeInfoUrl, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const payload = await response.json()
    return {
      controllerVersion:
        typeof payload?.controllerVersion === 'string'
          ? payload.controllerVersion
          : await readControllerVersion(),
      runtimeRoot:
        typeof payload?.runtimeRoot === 'string' ? payload.runtimeRoot : null,
      runtimeLayout:
        typeof payload?.runtimeLayout === 'string' ? payload.runtimeLayout : null,
      acpxBridgeAvailable: payload?.acpxBridgeAvailable === true,
      installedAt:
        typeof payload?.installedAt === 'string' ? payload.installedAt : null,
    }
  } catch (error) {
    console.error('[desktop] Failed to load controller runtime info:', error)
    return {
      controllerVersion: await readControllerVersion(),
      runtimeRoot: null,
      runtimeLayout: null,
      acpxBridgeAvailable: false,
      installedAt: null,
    }
  }
}

async function isShellReady(timeoutMs = 2500) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(SHELL_URL, {
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function ensurePendingControllerUpdateSnapshot(pendingUpdate) {
  if (!pendingUpdate) {
    throw new Error('No staged Pixel Forge update is ready to load.')
  }

  const snapshotPath = normalizeText(pendingUpdate.snapshotPath)
  if (snapshotPath && isInstallableProjectRoot(snapshotPath)) {
    return pendingUpdate
  }

  const projectPath = normalizeText(pendingUpdate.projectPath)
  if (!projectPath || !isInstallableProjectRoot(projectPath)) {
    throw new Error('Staged Pixel Forge update has no installable source root.')
  }

  const repairedSnapshotPath = await createControllerUpdateSnapshot(projectPath, pendingUpdate.id)
  return rewritePendingControllerUpdate({
    ...pendingUpdate,
    snapshotPath: repairedSnapshotPath,
  })
}

async function clearPendingControllerUpdate() {
  const existing = await readPendingControllerUpdate()
  await deleteControllerUpdateSnapshot(existing?.snapshotPath)
  await deleteFileIfPresent(PENDING_CONTROLLER_UPDATE_PATH)
  await writeDismissedControllerUpdateId(null)
  pendingUpdateSnapshot = null
  await syncPendingControllerUpdate()
}

async function recoverControllerUpdateApplyState() {
  await syncControllerUpdateApplyStateFromDisk()
  if (controllerUpdateApplyState.status !== 'running') {
    return controllerUpdateApplyState
  }

  const pendingUpdate = await readPendingControllerUpdate()
  const ageMs = Math.max(
    0,
    Date.now() - Date.parse(controllerUpdateApplyState.updatedAt || new Date().toISOString()),
  )
  const shellReady = await isShellReady(2500)

  if (
    pendingUpdate
    && shellReady
    && (controllerUpdateApplyState.phase === 'waiting'
      || controllerUpdateApplyState.phase === 'finalizing'
      || controllerUpdateApplyState.phase === 'relaunching')
  ) {
    try {
      await clearPendingControllerUpdate()
    } catch (error) {
      console.warn('[pixel-forge] Failed to clear recovered pending controller update:', error)
    }
    controllerUpdateApplyState = sanitizeControllerUpdateApplyState({
      status: 'idle',
      phase: 'idle',
      progress: 0,
      message: '',
      error: null,
    })
    await persistControllerUpdateApplyState(controllerUpdateApplyState)
    return controllerUpdateApplyState
  }

  if (ageMs > 180000) {
    controllerUpdateApplyState = sanitizeControllerUpdateApplyState({
      status: 'error',
      updateId: controllerUpdateApplyState.updateId,
      phase: 'error',
      progress: 100,
      message: 'The previous Pixel Forge update got stuck and needs recovery.',
      error: shellReady
        ? 'The app came back online but the shell never finished the update flow.'
        : 'Pixel Forge did not come back online after the previous update.',
    })
    await persistControllerUpdateApplyState(controllerUpdateApplyState)
  }

  return controllerUpdateApplyState
}

function launchDetachedControllerUpdateUi() {
  const relaunchArgs = process.argv
    .slice(1)
    .filter((arg) => arg !== '--pixel-forge-updater-ui')
  const proc = spawn(process.execPath, [...relaunchArgs, '--pixel-forge-updater-ui'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  proc.unref()
}

function pixelForgeCommand(binaryName) {
  const binDir = normalizeText(process.env.PIXEL_FORGE_BIN_DIR)
  if (binDir) {
    return path.join(path.resolve(binDir), binaryName)
  }
  return binaryName
}

function launchControllerUpdateViaCli(bootstrapState, updateId = null) {
  const sanitizedState = sanitizeBootstrapState(bootstrapState)
  if (!sanitizedState.projectPath) {
    throw new Error('bootstrap projectPath is required')
  }

  const args = [
    'controller-update',
    'apply',
    '--project',
    sanitizedState.projectPath,
    '--detach',
    '--show-ui',
  ]
  if (sanitizedState.previewUrl) {
    args.push('--preview-url', sanitizedState.previewUrl)
  }
  if (sanitizedState.activeMode) {
    args.push('--mode', sanitizedState.activeMode)
  }

  const proc = spawn(pixelForgeCommand('pixel-forge'), args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  proc.unref()

  setControllerUpdateApplyState({
    status: 'running',
    updateId,
    phase: 'installing',
    progress: 16,
    message: 'Closing Pixel Forge and handing off to the canonical updater…',
    error: null,
  })
}

function exitCurrentShellForControllerUpdate() {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) {
        window.hide()
      }
    } catch {
      // Ignore teardown race.
    }
  }

  setTimeout(() => {
    try {
      app.quit()
    } catch {
      // Fall through to forced exit.
    }
  }, 30)

  setTimeout(() => {
    try {
      app.exit(0)
    } catch {
      // Nothing left to do.
    }
  }, 180)
}

async function writeBootstrapState(payload) {
  await writeJsonFile(BOOTSTRAP_STATE_PATH, sanitizeBootstrapState(payload))
}

async function consumeBootstrapStateFile() {
  const payload = await readJsonFile(BOOTSTRAP_STATE_PATH)
  await deleteFileIfPresent(BOOTSTRAP_STATE_PATH)
  if (!payload || typeof payload !== 'object') {
    return null
  }
  return sanitizeBootstrapState(payload)
}

function scheduleShellRelaunch() {
  setTimeout(() => {
    app.relaunch({
      execPath: process.execPath,
      args: process.argv.slice(1),
    })
    app.exit(0)
  }, 150)
}

function sanitizeBounds(bounds) {
  return {
    x: Math.max(0, Math.round(Number(bounds?.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds?.y) || 0)),
    width: Math.max(0, Math.round(Number(bounds?.width) || 0)),
    height: Math.max(0, Math.round(Number(bounds?.height) || 0)),
    borderRadius: Math.max(0, Math.round(Number(bounds?.borderRadius) || 0)),
  }
}

function closePickerOverlay(result = null) {
  pickerOverlaySettling = true
  const ownerContextId = pickerOverlayOwnerContextId
  pickerOverlayOwnerContextId = null
  if (pickerOverlayResolver) {
    pickerOverlayResolver(result)
    pickerOverlayResolver = null
  }
  if (pickerOverlayWindow && !pickerOverlayWindow.isDestroyed()) {
    const closingWindow = pickerOverlayWindow
    pickerOverlayWindow = null
    closingWindow.destroy()
    return
  }
  pickerOverlayWindow = null
  if (ownerContextId !== null) {
    updatePreviewInputState(ownerContextId, { focusedSurface: 'shell' })
  }
  queueMicrotask(() => {
    pickerOverlaySettling = false
  })
}

function applyPreviewView(ownerContextId) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  const context = ensurePreviewContext(ownerContextId)
  const view = currentView(ownerContextId)
  const attached = context.attachedView
  const baseBounds = getOwnerBaseBounds(ownerContextId)

  if (
    !context.visible
    || !view
    || context.bounds.width === 0
    || context.bounds.height === 0
    || !baseBounds
  ) {
    if (attached) {
      mainWindow.contentView.removeChildView(attached)
      context.attachedView = null
    }
    return
  }

  if (attached && attached !== view) {
    mainWindow.contentView.removeChildView(attached)
    context.attachedView = null
  }
  if (context.attachedView !== view) {
    mainWindow.contentView.addChildView(view)
    context.attachedView = view
  }
  if (typeof view.setBorderRadius === 'function') {
    view.setBorderRadius(Math.max(0, Math.round(Number(context.bounds.borderRadius) || 0)))
  }
  view.setBounds({
    x: baseBounds.x + context.bounds.x,
    y: baseBounds.y + context.bounds.y,
    width: context.bounds.width,
    height: context.bounds.height,
  })
}

function applyAllPreviewViews() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  const orderedContextIds = Array.from(previewContexts.keys()).sort(
    (left, right) => previewContextDepth(left) - previewContextDepth(right),
  )
  for (const ownerContextId of orderedContextIds) {
    applyPreviewView(ownerContextId)
  }
}

function removePreviewRecord(previewRecord) {
  if (!previewRecord) {
    return
  }
  const context = previewContexts.get(previewRecord.ownerContextId)
  let inputStateChanged = false
  if (context?.attachedView === previewRecord.view) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(previewRecord.view)
    }
    context.attachedView = null
  }
  if (context?.activeTabId === previewRecord.tabId) {
    context.activeTabId = null
    context.visible = false
    context.focusedSurface = 'shell'
    inputStateChanged = true
  }
  if (typeof previewRecord.webContentsId === 'number') {
    previewKeyByWebContentsId.delete(previewRecord.webContentsId)
  }
  previewViews.delete(previewRecord.key)
  if (inputStateChanged) {
    emitPreviewInputState(previewRecord.ownerContextId)
  }
}

function destroyOwnedPreviewContexts(ownerContextId) {
  const childRecords = Array.from(previewViews.values()).filter(
    (record) => record.ownerContextId === ownerContextId,
  )
  for (const childRecord of childRecords) {
    if (typeof childRecord.webContentsId === 'number') {
      destroyOwnedPreviewContexts(childRecord.webContentsId)
    }
    removePreviewRecord(childRecord)
    if (childRecord.view && !childRecord.view.webContents.isDestroyed()) {
      childRecord.view.webContents.destroy()
    }
  }
  previewContexts.delete(ownerContextId)
}

function destroyAllPreviewSurfaces() {
  for (const previewRecord of Array.from(previewViews.values())) {
    try {
      if (!previewRecord.view.webContents.isDestroyed()) {
        previewRecord.view.webContents.destroy()
      }
    } catch {
      // Ignore teardown races while Electron is quitting.
    }
  }
  previewViews.clear()
  previewKeyByWebContentsId.clear()
  previewContexts.clear()
}

function registerViewEvents(ownerContextId, tabId, view) {
  const previewKey = makePreviewKey(ownerContextId, tabId)
  const webContentsId = view.webContents.id

  view.webContents.setWindowOpenHandler(({ url }) => {
    void loadPreviewUrl(ownerContextId, tabId, url)
    return { action: 'deny' }
  })

  view.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!looksLikePdfUrl(navigationUrl) || isInternalPdfViewerUrl(navigationUrl, SHELL_URL)) {
      return
    }
    event.preventDefault()
    void loadPreviewUrl(ownerContextId, tabId, navigationUrl)
  })

  view.webContents.on('did-navigate', () => {
    const previewRecord = previewViews.get(previewKey)
    if (!previewRecord) {
      return
    }
    emitPreviewBrowserLocationChanged(ownerContextId, previewRecord)
  })

  view.webContents.on('did-navigate-in-page', () => {
    const previewRecord = previewViews.get(previewKey)
    if (!previewRecord) {
      return
    }
    emitPreviewBrowserLocationChanged(ownerContextId, previewRecord)
  })

  view.webContents.on('page-title-updated', () => {
    const previewRecord = previewViews.get(previewKey)
    if (!previewRecord) {
      return
    }
    emitPreviewBrowserLocationChanged(ownerContextId, previewRecord)
  })

  view.webContents.on('focus', () => {
    updatePreviewInputState(ownerContextId, { focusedSurface: 'preview' })
  })

  view.webContents.on('blur', () => {
    const context = previewContexts.get(ownerContextId)
    if (context?.focusedSurface === 'preview') {
      updatePreviewInputState(ownerContextId, {
        focusedSurface: pickerOverlayOwnerContextId === ownerContextId ? 'overlay' : 'shell',
      })
    }
  })

  view.webContents.on('destroyed', () => {
    if (suspendedPreviewKeys.delete(previewKey)) {
      previewKeyByWebContentsId.delete(webContentsId)
      applyAllPreviewViews()
      return
    }
    destroyOwnedPreviewContexts(webContentsId)
    const previewRecord = previewViews.get(previewKey)
    if (previewRecord) {
      removePreviewRecord(previewRecord)
    } else {
      previewKeyByWebContentsId.delete(webContentsId)
    }
    applyAllPreviewViews()
    sendPreviewEvent(ownerContextId, {
      type: 'browser-tab-closed',
      browser_tab_id: tabId,
    })
  })

  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return
    }
    sendPreviewEvent(ownerContextId, {
      type: 'browser-load-failed',
      browser_tab_id: tabId,
      data: {
        errorCode,
        errorDescription,
        url: validatedUrl,
      },
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isTransientPreviewUrl(value) {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return true
  }

  try {
    const parsed = new URL(normalizedValue)
    return (
      parsed.protocol === 'chrome-error:'
      || (parsed.protocol === 'chrome:' && parsed.hostname === 'chromewebdata')
      || normalizedValue === 'about:blank'
    )
  } catch {
    return false
  }
}

function sanitizeBootstrapState(payload) {
  return {
    projectPath:
      typeof payload?.projectPath === 'string' && payload.projectPath.trim()
        ? payload.projectPath.trim()
        : null,
    previewUrl:
      typeof payload?.previewUrl === 'string' && payload.previewUrl.trim()
        ? payload.previewUrl.trim()
        : null,
    activeMode:
      payload?.activeMode === 'live-editor' || payload?.activeMode === 'screenshot'
        ? payload.activeMode
        : null,
  }
}

async function normalizeDirectoryDialogPath(initialPath) {
  const normalizedPath = normalizeText(initialPath)
  if (!normalizedPath) {
    return os.homedir()
  }

  const resolvedPath = path.resolve(normalizedPath)
  try {
    const stats = await fsPromises.stat(resolvedPath)
    return stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath)
  } catch {
    const parentPath = path.dirname(resolvedPath)
    try {
      const parentStats = await fsPromises.stat(parentPath)
      return parentStats.isDirectory() ? parentPath : os.homedir()
    } catch {
      return os.homedir()
    }
  }
}

function runShellCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`))
    })
  })
}

async function applyControllerUpdate(bootstrapState) {
  const sanitizedState = sanitizeBootstrapState(bootstrapState)
  const updateId = normalizeText(bootstrapState?.updateId)
  if (!sanitizedState.projectPath) {
    throw new Error('bootstrap projectPath is required')
  }

  try {
    setControllerUpdateApplyState({
      status: 'running',
      updateId,
      phase: 'preparing',
      progress: 10,
      message: 'Preparing staged Pixel Forge update…',
      error: null,
    })

    launchControllerUpdateViaCli(sanitizedState, updateId)
    exitCurrentShellForControllerUpdate()
    return { ok: true }
  } catch (error) {
    setControllerUpdateApplyState({
      status: 'error',
      updateId,
      phase: 'error',
      progress: 100,
      message: 'Failed to apply the staged Pixel Forge update.',
      error: error instanceof Error ? error.message : String(error || 'Unknown error'),
    })
    throw error
  }
}

async function startPendingControllerUpdate(payload) {
  const existingPendingUpdate = await readPendingControllerUpdate()
  if (!existingPendingUpdate) {
    throw new Error('No staged Pixel Forge update is ready to load.')
  }
  return applyControllerUpdate({
    ...payload,
    updateId: existingPendingUpdate.id,
    projectPath:
      typeof payload?.projectPath === 'string' && payload.projectPath.trim()
        ? payload.projectPath
        : existingPendingUpdate.projectPath,
    previewUrl:
      typeof payload?.previewUrl === 'string' && payload.previewUrl.trim()
        ? payload.previewUrl
        : existingPendingUpdate.previewUrl,
    activeMode:
      payload?.activeMode === 'live-editor' || payload?.activeMode === 'screenshot'
        ? payload.activeMode
        : existingPendingUpdate.activeMode,
  })
}

function reportControllerUpdateStartError(error, updateId = null) {
  const state = {
    status: 'error',
    updateId,
    phase: 'error',
    progress: 100,
    message: 'Failed to start the staged Pixel Forge update.',
    error: error instanceof Error ? error.message : String(error || 'Unknown error'),
  }
  setControllerUpdateApplyState(state)
}

function browserWindowFromIpcEvent(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

function registerWindowControlHandlers() {
  ipcMain.handle('pixel-forge-window:minimize', async (event) => {
    const window = browserWindowFromIpcEvent(event)
    if (window && !window.isDestroyed()) {
      window.minimize()
    }
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-window:toggle-maximize', async (event) => {
    const window = browserWindowFromIpcEvent(event)
    if (window && !window.isDestroyed() && window.isMaximizable()) {
      if (window.isMaximized()) {
        window.unmaximize()
      } else {
        window.maximize()
      }
    }
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-window:close', async (event) => {
    const window = browserWindowFromIpcEvent(event)
    if (window && !window.isDestroyed()) {
      window.close()
    }
    return { ok: true }
  })
}

function createUpdaterWindow() {
  updaterWindow = new BrowserWindow(desktopWindowOptions({
    width: 620,
    height: 280,
    minWidth: 520,
    minHeight: 240,
    resizable: true,
    minimizable: true,
    maximizable: true,
    frame: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    alwaysOnTop: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'updater-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }))

  updaterWindow.loadFile(path.join(__dirname, 'updater.html'))
  updaterWindow.on('closed', () => {
    updaterWindow = null
  })
}

async function settleAbortedNavigation(view, fallbackUrl) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (view.webContents.isDestroyed()) {
      break
    }
    if (!view.webContents.isLoadingMainFrame()) {
      break
    }
    await sleep(100)
  }

  const currentUrl = view.webContents.isDestroyed()
    ? ''
    : (view.webContents.getURL() || '')
  if (!currentUrl || currentUrl === 'about:blank') {
    throw new Error(`ERR_ABORTED (-3) loading '${fallbackUrl}'`)
  }
}

function getOrCreatePreviewView(ownerContextId, tabId, metadata = {}) {
  const previewKey = makePreviewKey(ownerContextId, tabId)
  const existing = previewViews.get(previewKey)
  if (existing) {
    updatePreviewRecordOwnership(existing, metadata)
    touchPreviewRecord(existing)
    return existing.view
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.mjs'),
      partition: PREVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
      backgroundThrottling: false,
    },
  })
  previewViews.set(previewKey, {
    key: previewKey,
    ownerContextId,
    tabId,
    view,
    webContentsId: view.webContents.id,
    reportedUrl: null,
    reportedTitle: null,
    surfaceKind: 'dom',
    pdfContext: null,
    projectPath: null,
    chatId: null,
    ownerKind: null,
    lastUsedAt: Date.now(),
  })
  updatePreviewRecordOwnership(previewViews.get(previewKey), metadata)
  previewKeyByWebContentsId.set(view.webContents.id, previewKey)
  registerViewEvents(ownerContextId, tabId, view)
  return view
}

function updatePreviewReportedLocation(previewRecord, url, title) {
  if (!previewRecord) {
    return
  }

  const normalizedUrl = normalizeText(url)
  if (!normalizedUrl) {
    previewRecord.reportedUrl = null
    previewRecord.reportedTitle = normalizeText(title) || null
    return
  }

  if (isTransientPreviewUrl(normalizedUrl)) {
    return
  }

  previewRecord.reportedUrl = normalizedUrl
  previewRecord.reportedTitle = normalizeText(title) || null
}

function currentPreviewUrl(previewRecord, fallbackUrl = '') {
  const embeddedPdfState = readInternalPdfViewerState(
    previewRecord?.view?.webContents.getURL(),
    SHELL_URL,
  )
  const currentViewUrl = normalizeText(previewRecord?.view?.webContents.getURL())
  const safeViewUrl = isTransientPreviewUrl(currentViewUrl) ? '' : currentViewUrl
  const safeFallbackUrl = isTransientPreviewUrl(fallbackUrl) ? '' : fallbackUrl
  const reportedUrl = normalizeText(previewRecord?.reportedUrl)
  if (previewRecord?.surfaceKind === 'pdf' || embeddedPdfState?.sourceUrl) {
    return reportedUrl
      || embeddedPdfState?.sourceUrl
      || safeViewUrl
      || safeFallbackUrl
  }

  return safeViewUrl
    || reportedUrl
    || safeFallbackUrl
}

function currentPreviewTitle(previewRecord, fallbackTitle = '') {
  const embeddedPdfState = readInternalPdfViewerState(
    previewRecord?.view?.webContents.getURL(),
    SHELL_URL,
  )
  return previewRecord?.reportedTitle
    || embeddedPdfState?.title
    || previewRecord?.view?.webContents.getTitle()
    || currentPreviewUrl(previewRecord, fallbackTitle)
    || fallbackTitle
}

function previewNavigationHistory(view) {
  return view?.webContents?.navigationHistory || null
}

function previewCanGoBack(view) {
  const history = previewNavigationHistory(view)
  if (history?.canGoBack) {
    return history.canGoBack()
  }
  return view?.webContents?.canGoBack?.() || false
}

function previewCanGoForward(view) {
  const history = previewNavigationHistory(view)
  if (history?.canGoForward) {
    return history.canGoForward()
  }
  return view?.webContents?.canGoForward?.() || false
}

function previewGoBack(view) {
  const history = previewNavigationHistory(view)
  if (history?.goBack) {
    history.goBack()
    return
  }
  view?.webContents?.goBack?.()
}

function previewGoForward(view) {
  const history = previewNavigationHistory(view)
  if (history?.goForward) {
    history.goForward()
    return
  }
  view?.webContents?.goForward?.()
}

function emitPreviewBrowserLocationChanged(ownerContextId, previewRecord) {
  const view = previewRecord?.view
  if (!previewRecord || !view || view.webContents.isDestroyed()) {
    return
  }
  touchPreviewRecord(previewRecord)

  sendPreviewEvent(ownerContextId, {
    type: 'browser-location-changed',
    browser_tab_id: previewRecord.tabId,
    url: currentPreviewUrl(previewRecord, view.webContents.getURL()),
    title: currentPreviewTitle(previewRecord, view.webContents.getURL()),
    can_go_back: previewCanGoBack(view),
    can_go_forward: previewCanGoForward(view),
  })
}

function buildPreviewLoadResponse(previewRecord, fallbackUrl = '') {
  const targetUrl = currentPreviewUrl(previewRecord, fallbackUrl)
  const view = previewRecord?.view
  return {
    mode: 'browser',
    browser_tab_id: previewRecord?.tabId || '',
    target_url: targetUrl,
    title: currentPreviewTitle(previewRecord, targetUrl),
    snapshot_data_url: null,
    did_navigate: true,
    can_go_back: previewCanGoBack(view),
    can_go_forward: previewCanGoForward(view),
  }
}

function suspendPreviewRecord(previewRecord) {
  if (!previewRecord?.view || previewRecord.view.webContents.isDestroyed()) {
    return false
  }

  const context = previewContexts.get(previewRecord.ownerContextId)
  if (context?.activeTabId === previewRecord.tabId || context?.attachedView === previewRecord.view) {
    return false
  }

  const fallbackUrl = previewRecord.view.webContents.getURL() || previewRecord.reportedUrl || ''
  const url = currentPreviewUrl(previewRecord, fallbackUrl)
  const title = currentPreviewTitle(previewRecord, url)
  const webContentsId = previewRecord.webContentsId

  destroyOwnedPreviewContexts(webContentsId)
  if (context?.attachedView === previewRecord.view && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(previewRecord.view)
    context.attachedView = null
  }

  previewViews.delete(previewRecord.key)
  previewKeyByWebContentsId.delete(webContentsId)
  suspendedPreviewKeys.add(previewRecord.key)
  previewRecord.view.webContents.destroy()
  sendPreviewEvent(previewRecord.ownerContextId, {
    type: 'browser-tab-suspended',
    browser_tab_id: previewRecord.tabId,
    url,
    title,
    can_go_back: false,
    can_go_forward: false,
  })
  return true
}

function enforcePreviewViewBudget() {
  if (previewViews.size <= MAX_RESIDENT_PREVIEW_VIEWS) {
    return
  }

  const candidates = Array.from(previewViews.values())
    .filter((previewRecord) => {
      const context = previewContexts.get(previewRecord.ownerContextId)
      return context?.activeTabId !== previewRecord.tabId && context?.attachedView !== previewRecord.view
    })
    .sort((left, right) => (left.lastUsedAt || 0) - (right.lastUsedAt || 0))

  for (const previewRecord of candidates) {
    if (previewViews.size <= MAX_RESIDENT_PREVIEW_VIEWS) {
      break
    }
    suspendPreviewRecord(previewRecord)
  }
}

function resetPreviewSurface(previewRecord) {
  if (!previewRecord) {
    return
  }

  previewRecord.surfaceKind = 'dom'
  previewRecord.pdfContext = null
  updatePreviewReportedLocation(previewRecord, null, null)
}

async function resolvePreviewTarget(previewRecord, url) {
  if (!previewRecord) {
    throw new Error('Preview record is required')
  }

  if (isInternalPdfViewerUrl(url, SHELL_URL)) {
    const embeddedPdfState = readInternalPdfViewerState(url, SHELL_URL)
    const sourceUrl = (
      embeddedPdfState?.sourceUrl
      || normalizeText(previewRecord?.pdfContext?.sourceUrl)
      || normalizeText(previewRecord?.reportedUrl)
    )
    if (!sourceUrl) {
      return url
    }

    const title =
      embeddedPdfState?.title
      || normalizeText(previewRecord?.pdfContext?.title)
      || normalizeText(previewRecord?.reportedTitle)
      || null
    const contentType =
      embeddedPdfState?.contentType
      || normalizeText(previewRecord?.pdfContext?.contentType)
      || null

    previewRecord.surfaceKind = 'pdf'
    previewRecord.pdfContext = {
      sourceUrl,
      title,
      contentType,
    }
    updatePreviewReportedLocation(previewRecord, sourceUrl, title)
    return buildInternalPdfViewerUrl(SHELL_URL, {
      tabId: previewRecord.tabId,
      sourceUrl,
      title,
      contentType,
    })
  }

  const pdfTarget = await detectPdfPreviewTarget(previewRecord.view.webContents.session, url)
  if (!pdfTarget) {
    resetPreviewSurface(previewRecord)
    return url
  }

  previewRecord.surfaceKind = 'pdf'
  previewRecord.pdfContext = {
    sourceUrl: pdfTarget.sourceUrl,
    title: pdfTarget.title,
    contentType: pdfTarget.contentType,
  }
  updatePreviewReportedLocation(previewRecord, pdfTarget.sourceUrl, pdfTarget.title)
  return buildInternalPdfViewerUrl(SHELL_URL, {
    tabId: previewRecord.tabId,
    sourceUrl: pdfTarget.sourceUrl,
    title: pdfTarget.title,
    contentType: pdfTarget.contentType,
  })
}

async function readPreviewPdfDocument(previewRecord, options = {}) {
  const sourceUrl = (
    normalizeText(previewRecord?.pdfContext?.sourceUrl)
    || normalizeText(options?.sourceUrl)
  )
  const previewSession = previewRecord?.view?.webContents?.session || options?.previewSession || null
  if (!sourceUrl) {
    throw new Error('No PDF preview document is available for this tab')
  }

  const pdfSource = await readPdfDocumentSource({
    previewSession,
    sourceUrl,
    title: previewRecord?.pdfContext?.title || normalizeText(options?.title),
    contentType: previewRecord?.pdfContext?.contentType || normalizeText(options?.contentType),
  })
  if (previewRecord) {
    previewRecord.pdfContext = {
      sourceUrl: pdfSource.sourceUrl,
      title: pdfSource.title,
      contentType: pdfSource.contentType,
    }
    updatePreviewReportedLocation(previewRecord, pdfSource.sourceUrl, pdfSource.title)
  }

  return {
    source_url: currentPreviewUrl(previewRecord, pdfSource.sourceUrl),
    title: currentPreviewTitle(previewRecord, pdfSource.title || pdfSource.sourceUrl),
    content_type: previewRecord?.pdfContext?.contentType || pdfSource.contentType || 'application/pdf',
    bytes: pdfSource.bytes,
  }
}

async function loadPreviewUrl(ownerContextId, tabId, url, metadata = {}) {
  const view = getOrCreatePreviewView(ownerContextId, tabId, metadata)
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  updatePreviewRecordOwnership(previewRecord, metadata)
  const context = ensurePreviewContext(ownerContextId)
  context.activeTabId = tabId
  context.visible = true
  touchPreviewRecord(previewRecord)
  applyAllPreviewViews()
  try {
    const resolvedTargetUrl = await resolvePreviewTarget(previewRecord, url)
    await view.webContents.loadURL(resolvedTargetUrl)
  } catch (error) {
    const message = String(error?.message || error || '')
    if (!message.includes('ERR_ABORTED (-3)')) {
      throw error
    }
    await settleAbortedNavigation(view, url)
  }
  enforcePreviewViewBudget()
  return buildPreviewLoadResponse(previewRecord, url)
}

function navigatePreviewHistory(ownerContextId, tabId, direction) {
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  if (!previewRecord) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }

  const view = previewRecord.view
  const canNavigate = direction === 'back'
    ? previewCanGoBack(view)
    : previewCanGoForward(view)
  if (canNavigate) {
    if (direction === 'back') {
      previewGoBack(view)
    } else {
      previewGoForward(view)
    }
  }
  return {
    ...buildPreviewLoadResponse(previewRecord, view.webContents.getURL()),
    did_navigate: canNavigate,
  }
}

function sendPreviewCommand(ownerContextId, tabId, command) {
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  if (!previewRecord) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }
  touchPreviewRecord(previewRecord)
  const view = previewRecord.view
  view.webContents.send('pixel-forge-preview:command', command)
  return buildPreviewLoadResponse(previewRecord, view.webContents.getURL())
}

async function inspectPreviewDevtoolsTarget(view) {
  if (!view || view.webContents.isDestroyed()) {
    return {}
  }

  const browserUrl = controllerDevtoolsBrowserUrl()
  if (!browserUrl) {
    return {}
  }

  let targetInfo = null
  let attachedHere = false
  try {
    const debuggerApi = view.webContents.debugger
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3')
      attachedHere = true
    }
    const payload = await debuggerApi.sendCommand('Target.getTargetInfo')
    targetInfo = payload?.targetInfo && typeof payload.targetInfo === 'object'
      ? payload.targetInfo
      : null
  } catch (error) {
    console.warn('[desktop] Failed to inspect preview DevTools target:', error)
  } finally {
    if (attachedHere) {
      try {
        view.webContents.debugger.detach()
      } catch {
        // Ignore detach failures.
      }
    }
  }

  const targetId = normalizeText(targetInfo?.targetId)
  if (!targetId) {
    return {}
  }

  const targetSnapshot = await readControllerDevtoolsTargetSnapshot()
  const matchedTarget = targetSnapshot.targets.find(
    (entry) => entry && typeof entry === 'object' && entry.id === targetId
  ) || null
  const pageWebsocketUrl =
    typeof matchedTarget?.webSocketDebuggerUrl === 'string'
      ? matchedTarget.webSocketDebuggerUrl
      : null
  const devtoolsAttachAvailable = targetSnapshot.available && Boolean(pageWebsocketUrl)

  return {
    ...(devtoolsAttachAvailable ? { devtools_browser_url: browserUrl } : {}),
    devtools_attach_available: devtoolsAttachAvailable,
    ...(devtoolsAttachAvailable
      ? {}
      : {
          devtools_attach_unavailable_reason:
            targetSnapshot.error || 'Controller CDP endpoint did not expose a websocket for this preview target.',
        }),
    devtools_target_id: targetId,
    devtools_target_type: normalizeText(targetInfo?.type),
    devtools_target_url:
      typeof matchedTarget?.url === 'string'
        ? matchedTarget.url
        : normalizeText(targetInfo?.url),
    devtools_target_title:
      typeof matchedTarget?.title === 'string'
        ? matchedTarget.title
        : normalizeText(targetInfo?.title),
    devtools_page_websocket_url: pageWebsocketUrl,
    devtools_frontend_url:
      typeof matchedTarget?.devtoolsFrontendUrl === 'string'
        ? matchedTarget.devtoolsFrontendUrl
        : null,
  }
}

async function inspectPreviewView(ownerContextId, tabId, selectionHints = []) {
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  if (!previewRecord) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }

  const view = previewRecord.view
  let inspection = null
  try {
    const rawInspection = await view.webContents.executeJavaScript(
      `window.__pixelForgePreviewBridge?.inspectLiveContext(${JSON.stringify({
        selectionHints: Array.isArray(selectionHints) ? selectionHints : [],
      })}) ?? null`,
      true,
    )
    inspection = rawInspection && typeof rawInspection === 'object' ? rawInspection : null
  } catch (error) {
    console.warn('[desktop] Failed to inspect preview BrowserView DOM:', error)
  }

  const devtoolsInspection = await inspectPreviewDevtoolsTarget(view)
  return {
    ...buildPreviewLoadResponse(previewRecord, view.webContents.getURL()),
    inspection: inspection
      ? {
          ...inspection,
          ...devtoolsInspection,
          ...browserBrokerContextPayload(previewRecord),
        }
      : (
          Object.keys(devtoolsInspection).length > 0
            ? {
                live_inspection_available: false,
                live_inspection_mode: 'controller-browserview',
                current_url: currentPreviewUrl(previewRecord, view.webContents.getURL()),
                current_title: currentPreviewTitle(previewRecord, view.webContents.getURL()),
                ready_state: null,
                viewport: null,
                visible_interactives: [],
                selection_matches: [],
                ...devtoolsInspection,
                ...browserBrokerContextPayload(previewRecord),
              }
            : null
        ),
  }
}

async function capturePreviewRegion(tabId, rect) {
  const previewKey = previewKeyByWebContentsId.get(tabId)
  const previewRecord = previewKey ? previewViews.get(previewKey) : null
  if (!previewRecord) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }
  const view = previewRecord.view

  const bounds = sanitizeBounds(rect)
  if (bounds.width <= 0 || bounds.height <= 0) {
    return null
  }

  const image = await view.webContents.capturePage(bounds)
  let output = image
  const size = output.getSize()
  const maxDimension = 420
  if (size.width > maxDimension || size.height > maxDimension) {
    const scale = Math.min(maxDimension / size.width, maxDimension / size.height)
    output = output.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    })
  }

  const jpeg = output.toJPEG(80)
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

async function capturePreviewSnapshot(ownerContextId, tabId) {
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  if (!previewRecord) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }
  const view = previewRecord.view
  if (!view || view.webContents.isDestroyed()) {
    throw new Error(`Preview tab is not resident: ${tabId}`)
  }
  touchPreviewRecord(previewRecord)
  const image = await view.webContents.capturePage()
  return {
    ok: true,
    snapshot_data_url: `data:image/png;base64,${image.toPNG().toString('base64')}`,
  }
}

async function showPickListOverlay(ownerContextId, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not available')
  }

  const items = Array.isArray(payload?.items)
    ? payload.items
        .filter((entry) => entry && typeof entry.value === 'string' && typeof entry.label === 'string')
        .map((entry) => ({ value: entry.value, label: entry.label }))
    : []
  if (items.length === 0) {
    return null
  }

  closePickerOverlay(null)
  pickerOverlayOwnerContextId = ownerContextId

  const anchorRect = sanitizeBounds(payload?.anchorRect || {})
  const baseBounds = getOwnerBaseBounds(ownerContextId)
  if (!baseBounds) {
    pickerOverlayOwnerContextId = null
    return null
  }
  const contentBounds = mainWindow.getContentBounds()
  const width = Math.max(
    280,
    Math.round(Number(payload?.width) || anchorRect.width || 420)
  )
  const maxHeight = Math.max(160, Math.round(Number(payload?.maxHeight) || 260))
  const listHeight = Math.min(maxHeight, 12 + items.length * 38)

  const minX = contentBounds.x + 8
  const maxX = contentBounds.x + Math.max(8, contentBounds.width - width - 8)
  const minY = contentBounds.y + 8
  const maxY = contentBounds.y + Math.max(8, contentBounds.height - listHeight - 8)

  const x = Math.min(Math.max(contentBounds.x + baseBounds.x + anchorRect.x, minX), maxX)
  const y = Math.min(
    Math.max(contentBounds.y + baseBounds.y + anchorRect.y + anchorRect.height + 6, minY),
    maxY
  )

  pickerOverlayWindow = new BrowserWindow(desktopWindowOptions({
    parent: mainWindow,
    x,
    y,
    width,
    height: listHeight,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'picker-overlay-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }))

  pickerOverlayWindow.on('blur', () => {
    setTimeout(() => {
      if (!pickerOverlaySettling) {
        closePickerOverlay(null)
      }
    }, 80)
  })
  pickerOverlayWindow.on('closed', () => {
    pickerOverlayWindow = null
    if (pickerOverlayResolver) {
      pickerOverlayResolver(null)
      pickerOverlayResolver = null
    }
  })

  await pickerOverlayWindow.loadFile(path.join(__dirname, 'picker-overlay.html'))
  pickerOverlayWindow.webContents.send('pixel-forge-overlay:list-init', {
    items,
    selectedValue: typeof payload?.selectedValue === 'string' ? payload.selectedValue : null,
  })
  pickerOverlayWindow.show()
  pickerOverlayWindow.focus()
  updatePreviewInputState(ownerContextId, { focusedSurface: 'overlay' })

  return await new Promise((resolve) => {
    pickerOverlayResolver = resolve
  })
}

async function createMainWindow() {
  mainWindow = new BrowserWindow(desktopWindowOptions({
    width: 1680,
    height: 1100,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }))

  mainWindow.maximize()
  await mainWindow.webContents.session.clearCache()
  mainWindow.loadURL(SHELL_URL)
  mainWindow.webContents.on('focus', () => {
    updatePreviewInputState(mainWindow.webContents.id, { focusedSurface: 'shell' })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  ensurePreviewContext(mainWindow.webContents.id)

  mainWindow.on('resize', applyAllPreviewViews)
  mainWindow.on('move', applyAllPreviewViews)
  mainWindow.on('closed', () => {
    const mainContextId = getMainPreviewContextId()
    if (mainContextId !== null) {
      destroyOwnedPreviewContexts(mainContextId)
      previewContexts.delete(mainContextId)
    }
    mainWindow = null
  })
}

function focusOrCreateMainWindow() {
  if (IS_UPDATER_UI_MODE) {
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

if (SHOULD_RUN_APP && !IS_UPDATER_UI_MODE) {
  app.on('second-instance', () => {
    focusOrCreateMainWindow()
  })
}

function openAgentDeckSurfaceWindow(url) {
  const targetUrl = typeof url === 'string' ? url.trim() : ''
  if (!targetUrl) {
    throw new Error('Agent Deck surface URL is required')
  }

  if (agentDeckSurfaceWindow && !agentDeckSurfaceWindow.isDestroyed()) {
    if (agentDeckSurfaceWindow.webContents.getURL() !== targetUrl) {
      agentDeckSurfaceWindow.loadURL(targetUrl)
    }
    agentDeckSurfaceWindow.show()
    agentDeckSurfaceWindow.focus()
    return { ok: true }
  }

  agentDeckSurfaceWindow = new BrowserWindow(desktopWindowOptions({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 720,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    title: `${app.getName()} Agent Deck`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }))

  agentDeckSurfaceWindow.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    shell.openExternal(nextUrl)
    return { action: 'deny' }
  })

  agentDeckSurfaceWindow.on('closed', () => {
    agentDeckSurfaceWindow = null
  })

  agentDeckSurfaceWindow.loadURL(targetUrl)
  agentDeckSurfaceWindow.show()
  agentDeckSurfaceWindow.focus()
  return { ok: true }
}

if (SHOULD_RUN_APP) {
app.whenReady().then(() => {
  registerWindowControlHandlers()

  if (IS_UPDATER_UI_MODE) {
    ipcMain.handle('pixel-forge-updater:get-state', async () => {
      try {
        return (await recoverControllerUpdateApplyState())
          ?? sanitizeControllerUpdateApplyState({
            status: 'idle',
            phase: 'idle',
            progress: 0,
            message: '',
            error: null,
          })
      } catch (error) {
        console.warn('[pixel-forge] Updater state read failed:', error)
        return sanitizeControllerUpdateApplyState({
          status: 'running',
          phase: 'preparing',
          progress: 0,
          message: 'Checking updater state...',
          error: null,
        })
      }
    })
    createUpdaterWindow()
    return
  }

  void ensureAppStateDir().then(async () => {
    await syncPendingControllerUpdate()
    await recoverControllerUpdateApplyState()
  })
  watchFile(PENDING_CONTROLLER_UPDATE_PATH, { interval: 1000 }, () => {
    void syncPendingControllerUpdate()
  })
  watchFile(CONTROLLER_UPDATE_APPLY_STATE_PATH, { interval: 1000 }, () => {
    void syncControllerUpdateApplyStateFromDisk()
  })
  focusOrCreateMainWindow()
  startBrowserBroker()

  ipcMain.handle('pixel-forge-preview:load', async (event, payload) => {
    const ownerContextId = event.sender.id
    ensurePreviewContext(ownerContextId)
    const tabId = String(payload?.tabId || '')
    const url = String(payload?.url || '').trim()
    if (!tabId || !url) {
      throw new Error('tabId and url are required')
    }
    const response = await loadPreviewUrl(ownerContextId, tabId, url, {
      projectPath: payload?.projectPath,
      project_path: payload?.project_path,
      chatId: payload?.chatId,
      chat_id: payload?.chat_id,
      threadId: payload?.threadId,
      thread_id: payload?.thread_id,
      ownerKind: payload?.ownerKind,
      owner_kind: payload?.owner_kind,
    })
    emitPreviewInputState(ownerContextId)
    return response
  })

  ipcMain.handle('pixel-forge-preview:show', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    const context = ensurePreviewContext(ownerContextId)
    context.activeTabId = tabId
    context.visible = true
    touchPreviewRecord(previewRecord)
    applyAllPreviewViews()
    emitPreviewInputState(ownerContextId)
    enforcePreviewViewBudget()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:activate', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    const context = ensurePreviewContext(ownerContextId)
    context.activeTabId = tabId
    context.visible = true
    touchPreviewRecord(previewRecord)
    applyAllPreviewViews()
    emitPreviewInputState(ownerContextId)
    enforcePreviewViewBudget()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:focus', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    const context = ensurePreviewContext(ownerContextId)
    context.activeTabId = tabId
    context.visible = true
    touchPreviewRecord(previewRecord)
    applyAllPreviewViews()
    previewRecord.view.webContents.focus()
    updatePreviewInputState(ownerContextId, { focusedSurface: 'preview' })
    enforcePreviewViewBudget()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:go-back', async (event, payload) => {
    return navigatePreviewHistory(event.sender.id, String(payload?.tabId || ''), 'back')
  })

  ipcMain.handle('pixel-forge-preview:go-forward', async (event, payload) => {
    return navigatePreviewHistory(event.sender.id, String(payload?.tabId || ''), 'forward')
  })

  ipcMain.handle('pixel-forge-preview:refresh', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    const view = previewRecord.view
    touchPreviewRecord(previewRecord)
    await view.webContents.reload()
    return buildPreviewLoadResponse(previewRecord, view.webContents.getURL())
  })

  ipcMain.handle('pixel-forge-preview:inspect', async (event, payload) => {
    return inspectPreviewView(
      event.sender.id,
      String(payload?.tabId || ''),
      Array.isArray(payload?.selectionHints) ? payload.selectionHints : [],
    )
  })

  ipcMain.handle('pixel-forge-preview:capture-snapshot', async (event, payload) => {
    return capturePreviewSnapshot(event.sender.id, String(payload?.tabId || ''))
  })

  ipcMain.handle('pixel-forge-preview:set-bounds', async (event, bounds) => {
    const ownerContextId = event.sender.id
    const context = ensurePreviewContext(ownerContextId)
    context.bounds = sanitizeBounds(bounds)
    applyAllPreviewViews()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:hide', async (event) => {
    const ownerContextId = event.sender.id
    const context = ensurePreviewContext(ownerContextId)
    context.visible = false
    if (context.focusedSurface === 'preview') {
      context.focusedSurface = 'shell'
    }
    applyAllPreviewViews()
    emitPreviewInputState(ownerContextId)
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:close', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      return { ok: true }
    }
    destroyOwnedPreviewContexts(previewRecord.webContentsId)
    removePreviewRecord(previewRecord)
    if (!previewRecord.view.webContents.isDestroyed()) {
      previewRecord.view.webContents.destroy()
    }
    applyAllPreviewViews()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:set-select-mode', async (event, payload) => {
    reflectPreviewToolForActiveTab(
      event.sender.id,
      String(payload?.tabId || ''),
      Boolean(payload?.enabled) ? 'select' : null,
    )
    return sendPreviewCommand(event.sender.id, String(payload?.tabId || ''), {
      type: 'set-select-mode',
      enabled: Boolean(payload?.enabled),
    })
  })

  ipcMain.handle('pixel-forge-preview:set-tool', async (event, payload) => {
    const tool = normalizePreviewTool(payload?.tool)
    reflectPreviewToolForActiveTab(
      event.sender.id,
      String(payload?.tabId || ''),
      tool,
    )
    return sendPreviewCommand(event.sender.id, String(payload?.tabId || ''), {
      type: 'set-tool',
      tool,
    })
  })

  ipcMain.handle('pixel-forge-preview:clear-selections', async (event, payload) => {
    return sendPreviewCommand(event.sender.id, String(payload?.tabId || ''), {
      type: 'clear-selections',
    })
  })

  ipcMain.handle('pixel-forge-preview:deselect', async (event, payload) => {
    return sendPreviewCommand(event.sender.id, String(payload?.tabId || ''), {
      type: 'deselect',
      selectionId: String(payload?.selectionId || ''),
      xpath: String(payload?.xpath || ''),
    })
  })

  ipcMain.handle('pixel-forge-preview:apply-selections', async (event, payload) => {
    return sendPreviewCommand(event.sender.id, String(payload?.tabId || ''), {
      type: 'apply-selections',
      selections: Array.isArray(payload?.selections) ? payload.selections : [],
      reveal: Boolean(payload?.reveal),
    })
  })

  ipcMain.handle('pixel-forge-preview:capture-region', async (event, rect) => {
    if (!previewKeyByWebContentsId.has(event.sender.id)) {
      throw new Error('Unknown preview sender')
    }
    return capturePreviewRegion(event.sender.id, rect)
  })

  ipcMain.handle('pixel-forge-overlay:pick-list', async (event, payload) => {
    return showPickListOverlay(event.sender.id, payload)
  })

  ipcMain.handle('pixel-forge-app:apply-controller-update', async (_event, payload) => {
    return applyControllerUpdate(payload)
  })

  ipcMain.handle('pixel-forge-app:apply-pending-controller-update', async (_event, payload) => {
    return startPendingControllerUpdate(payload)
  })

  ipcMain.on('pixel-forge-app:start-controller-update', (_event, payload) => {
    void applyControllerUpdate(payload)
      .catch((error) => {
        reportControllerUpdateStartError(error, normalizeText(payload?.updateId))
      })
  })

  ipcMain.on('pixel-forge-app:start-pending-controller-update', (_event, payload) => {
    void startPendingControllerUpdate(payload)
      .catch(async (error) => {
        const pendingUpdate = await readPendingControllerUpdate()
        reportControllerUpdateStartError(error, pendingUpdate?.id || null)
      })
  })

  ipcMain.handle('pixel-forge-app:focus-shell', async (event) => {
    const ownerContextId = event.sender.id
    const targetContents = getContextWebContents(ownerContextId)
    if (ownerContextId === getMainPreviewContextId() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus()
    }
    if (targetContents && !targetContents.isDestroyed()) {
      targetContents.focus()
    }
    updatePreviewInputState(ownerContextId, { focusedSurface: 'shell' })
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-app:get-preview-input-state', async (event) => {
    return readPreviewInputState(event.sender.id)
  })

  ipcMain.handle('pixel-forge-app:browse-for-directory', async (event, payload) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const defaultPath = await normalizeDirectoryDialogPath(payload?.initialPath)
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: 'Choose Workspace',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled) {
      return null
    }
    return normalizeText(result.filePaths?.[0]) ?? null
  })

  ipcMain.handle('pixel-forge-app:open-agent-deck-surface', async (_event, payload) => {
    return openAgentDeckSurfaceWindow(payload?.url)
  })

  ipcMain.handle('pixel-forge-app:consume-bootstrap-state', async () => {
    return consumeBootstrapStateFile()
  })

  ipcMain.handle('pixel-forge-app:get-pending-controller-update', async () => {
    return readPendingControllerUpdate()
  })

  ipcMain.handle('pixel-forge-app:get-dismissed-controller-update-id', async () => {
    return readDismissedControllerUpdateId()
  })

  ipcMain.handle('pixel-forge-app:get-runtime-info', async () => {
    return readRuntimeInfo()
  })

  ipcMain.handle('pixel-forge-app:set-dismissed-controller-update-id', async (_event, payload) => {
    return writeDismissedControllerUpdateId(payload?.updateId)
  })

  ipcMain.handle('pixel-forge-app:get-controller-update-apply-state', async () => {
    await syncControllerUpdateApplyStateFromDisk()
    return controllerUpdateApplyState
  })

  ipcMain.handle('pixel-forge-preview:get-pdf-document', async (event, payload) => {
    let previewRecord = getPreviewRecordForWebContentsId(event.sender.id)
    if ((!previewRecord || !normalizeText(previewRecord?.pdfContext?.sourceUrl)) && payload?.tabId) {
      previewRecord = getPreviewRecordForTabId(payload.tabId)
    }
    return await readPreviewPdfDocument(previewRecord, {
      previewSession: event.sender.session,
      sourceUrl: payload?.sourceUrl,
      title: payload?.title,
      contentType: payload?.contentType,
    })
  })

  ipcMain.handle('pixel-forge-app:stage-controller-update', async (_event, payload) => {
    return stagePendingControllerUpdate(payload)
  })

  ipcMain.handle('pixel-forge-app:dismiss-controller-update', async () => {
    await clearPendingControllerUpdate()
    return { ok: true }
  })

  ipcMain.on('pixel-forge-overlay:list-selected', (_event, value) => {
    closePickerOverlay(typeof value === 'string' ? value : null)
  })

  ipcMain.on('pixel-forge-overlay:list-cancel', () => {
    closePickerOverlay(null)
  })

  ipcMain.on('pixel-forge-preview:event', (event, payload) => {
    const previewRecord = getPreviewRecordForWebContentsId(event.sender.id)
    if (!previewRecord) {
      return
    }
    if (payload?.type === 'browser-location-changed') {
      const locationData = payload?.data && typeof payload.data === 'object'
        ? payload.data
        : payload
      updatePreviewReportedLocation(previewRecord, locationData?.url, locationData?.title)
    }
    sendPreviewEvent(previewRecord.ownerContextId, {
      ...payload,
      browser_tab_id: previewRecord.tabId,
      ...(payload?.type === 'browser-location-changed'
        ? {
            can_go_back: previewCanGoBack(previewRecord.view),
            can_go_forward: previewCanGoForward(previewRecord.view),
          }
        : {}),
    })
  })

  app.on('activate', () => {
    if (!IS_UPDATER_UI_MODE) {
      focusOrCreateMainWindow()
    }
  })
})
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  stopBrowserBroker()
  destroyAllPreviewSurfaces()
  unwatchFile(PENDING_CONTROLLER_UPDATE_PATH)
  unwatchFile(CONTROLLER_UPDATE_APPLY_STATE_PATH)
})
