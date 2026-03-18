import { app, BrowserWindow, WebContentsView, ipcMain, shell, webContents as electronWebContents } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fsPromises, watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHELL_URL = process.env.PIXEL_FORGE_SHELL_URL || 'http://pixel-forge.localhost:7001'
const PREVIEW_PARTITION = 'persist:pixel-forge-preview'
const APP_STATE_DIR = path.resolve(
  process.env.PIXEL_FORGE_STATE_DIR || path.join(os.homedir(), '.pixel-forge'),
)
const CONTROLLER_UPDATE_SNAPSHOTS_DIR = path.join(APP_STATE_DIR, 'controller-updates')
const PENDING_CONTROLLER_UPDATE_PATH = path.join(APP_STATE_DIR, 'pending-controller-update.json')
const BOOTSTRAP_STATE_PATH = path.join(APP_STATE_DIR, 'controller-bootstrap-state.json')

app.setName('Pixel Forge')

let mainWindow = null
let pickerOverlayWindow = null
let pickerOverlayResolver = null
let pickerOverlaySettling = false
let pendingUpdateSnapshot = null

const previewViews = new Map()
const previewContexts = new Map()
const previewKeyByWebContentsId = new Map()

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
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    attachedView: null,
  }
  previewContexts.set(ownerContextId, context)
  return context
}

function getPreviewRecord(ownerContextId, tabId) {
  return previewViews.get(makePreviewKey(ownerContextId, tabId)) ?? null
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

function sendPreviewEvent(ownerContextId, event) {
  const mainContextId = getMainPreviewContextId()
  if (mainContextId === null) {
    return
  }

  const targetContents =
    ownerContextId === mainContextId
      ? mainWindow?.webContents ?? null
      : electronWebContents.fromId(ownerContextId)
  if (!targetContents || targetContents.isDestroyed()) {
    return
  }
  targetContents.send('pixel-forge-preview:event', event)
}

function broadcastAppEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('pixel-forge-app:event', event)
}

async function ensureAppStateDir() {
  await fsPromises.mkdir(APP_STATE_DIR, { recursive: true })
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

function shouldCopySnapshotPath(projectPath, sourcePath) {
  const relativePath = path.relative(projectPath, sourcePath)
  if (!relativePath) {
    return true
  }

  const segments = relativePath.split(path.sep).filter(Boolean)
  if (segments.length === 0) {
    return true
  }

  if (segments.includes('.git') || segments.includes('.venv') || segments.includes('node_modules')) {
    return false
  }

  if (segments[0] === '.pixel-forge' && (segments[1] === 'instances' || segments[1] === 'requests')) {
    return false
  }

  return true
}

async function createControllerUpdateSnapshot(projectPath, updateId) {
  const sourcePath = path.resolve(projectPath)
  const snapshotPath = path.join(CONTROLLER_UPDATE_SNAPSHOTS_DIR, updateId)
  await fsPromises.mkdir(CONTROLLER_UPDATE_SNAPSHOTS_DIR, { recursive: true })
  await fsPromises.rm(snapshotPath, { recursive: true, force: true })
  await fsPromises.cp(sourcePath, snapshotPath, {
    recursive: true,
    filter: (source) => shouldCopySnapshotPath(sourcePath, path.resolve(source)),
  })
  return snapshotPath
}

async function deleteControllerUpdateSnapshot(snapshotPath) {
  if (!snapshotPath) {
    return
  }
  await fsPromises.rm(snapshotPath, { recursive: true, force: true })
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

async function readPendingControllerUpdate() {
  const payload = await readJsonFile(PENDING_CONTROLLER_UPDATE_PATH)
  if (!payload || typeof payload !== 'object') {
    return null
  }

  try {
    return sanitizePendingControllerUpdate(payload)
  } catch {
    return null
  }
}

async function syncPendingControllerUpdate() {
  const update = await readPendingControllerUpdate()
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
  normalized.snapshotPath = await createControllerUpdateSnapshot(
    normalized.projectPath,
    normalized.id,
  )
  await writeJsonFile(PENDING_CONTROLLER_UPDATE_PATH, normalized)
  pendingUpdateSnapshot = null
  await syncPendingControllerUpdate()
  return normalized
}

async function clearPendingControllerUpdate() {
  const existing = await readPendingControllerUpdate()
  await deleteFileIfPresent(PENDING_CONTROLLER_UPDATE_PATH)
  await deleteControllerUpdateSnapshot(existing?.snapshotPath)
  pendingUpdateSnapshot = null
  await syncPendingControllerUpdate()
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
  }
}

function closePickerOverlay(result = null) {
  pickerOverlaySettling = true
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
  const context = previewContexts.get(previewRecord.ownerContextId)
  if (context?.attachedView === previewRecord.view) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(previewRecord.view)
    }
    context.attachedView = null
  }
  if (context?.activeTabId === previewRecord.tabId) {
    context.activeTabId = null
    context.visible = false
  }
  previewKeyByWebContentsId.delete(previewRecord.view.webContents.id)
  previewViews.delete(previewRecord.key)
}

function destroyOwnedPreviewContexts(ownerContextId) {
  const childRecords = Array.from(previewViews.values()).filter(
    (record) => record.ownerContextId === ownerContextId,
  )
  for (const childRecord of childRecords) {
    destroyOwnedPreviewContexts(childRecord.view.webContents.id)
    removePreviewRecord(childRecord)
    if (!childRecord.view.webContents.isDestroyed()) {
      childRecord.view.webContents.destroy()
    }
  }
  previewContexts.delete(ownerContextId)
}

function registerViewEvents(ownerContextId, tabId, view) {
  const previewKey = makePreviewKey(ownerContextId, tabId)
  const webContentsId = view.webContents.id

  view.webContents.setWindowOpenHandler(({ url }) => {
    void loadPreviewUrl(ownerContextId, tabId, url)
    return { action: 'deny' }
  })

  view.webContents.on('did-finish-load', () => {
    sendPreviewEvent(ownerContextId, {
      type: 'browser-location-changed',
      browser_tab_id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle() || view.webContents.getURL(),
    })
  })

  view.webContents.on('page-title-updated', () => {
    sendPreviewEvent(ownerContextId, {
      type: 'browser-location-changed',
      browser_tab_id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle() || view.webContents.getURL(),
    })
  })

  view.webContents.on('destroyed', () => {
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

async function waitForShellReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(SHELL_URL, { cache: 'no-store' })
      if (response.ok) {
        return
      }
    } catch {
      // Retry until the service is ready again.
    }
    await sleep(1000)
  }

  throw new Error('Pixel Forge did not come back after update.')
}

async function applyControllerUpdate(projectPath, bootstrapState) {
  const installProjectPath = normalizeText(projectPath)
  const sanitizedState = sanitizeBootstrapState(bootstrapState)
  if (!installProjectPath) {
    throw new Error('install projectPath is required')
  }
  if (!sanitizedState.projectPath) {
    throw new Error('bootstrap projectPath is required')
  }

  await writeBootstrapState(sanitizedState)
  await runShellCommand('./install.sh && pixel-forge restart', installProjectPath)
  await waitForShellReady()
  await clearPendingControllerUpdate()
  scheduleShellRelaunch()
  return { ok: true }
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

function getOrCreatePreviewView(ownerContextId, tabId) {
  const previewKey = makePreviewKey(ownerContextId, tabId)
  const existing = previewViews.get(previewKey)
  if (existing) {
    return existing.view
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.mjs'),
      partition: PREVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  previewViews.set(previewKey, {
    key: previewKey,
    ownerContextId,
    tabId,
    view,
  })
  previewKeyByWebContentsId.set(view.webContents.id, previewKey)
  registerViewEvents(ownerContextId, tabId, view)
  return view
}

async function loadPreviewUrl(ownerContextId, tabId, url) {
  const view = getOrCreatePreviewView(ownerContextId, tabId)
  const context = ensurePreviewContext(ownerContextId)
  context.activeTabId = tabId
  context.visible = true
  applyAllPreviewViews()
  try {
    await view.webContents.loadURL(url)
  } catch (error) {
    const message = String(error?.message || error || '')
    if (!message.includes('ERR_ABORTED (-3)')) {
      throw error
    }
    await settleAbortedNavigation(view, url)
  }
  view.webContents.focus()
  return {
    mode: 'browser',
    browser_tab_id: tabId,
    target_url: view.webContents.getURL() || url,
    title: view.webContents.getTitle() || url,
    snapshot_data_url: null,
  }
}

function sendPreviewCommand(ownerContextId, tabId, command) {
  const previewRecord = getPreviewRecord(ownerContextId, tabId)
  if (!previewRecord) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }
  const view = previewRecord.view
  if (command?.type === 'set-select-mode' && command.enabled) {
    view.webContents.focus()
  }
  view.webContents.send('pixel-forge-preview:command', command)
  return {
    mode: 'browser',
    browser_tab_id: tabId,
    target_url: view.webContents.getURL(),
    title: view.webContents.getTitle() || view.webContents.getURL(),
    snapshot_data_url: null,
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

  const anchorRect = sanitizeBounds(payload?.anchorRect || {})
  const baseBounds = getOwnerBaseBounds(ownerContextId)
  if (!baseBounds) {
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

  pickerOverlayWindow = new BrowserWindow({
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
  })

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

  return await new Promise((resolve) => {
    pickerOverlayResolver = resolve
  })
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1100,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.maximize()
  mainWindow.loadURL(SHELL_URL)

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

app.whenReady().then(() => {
  void ensureAppStateDir().then(() => syncPendingControllerUpdate())
  watchFile(PENDING_CONTROLLER_UPDATE_PATH, { interval: 1000 }, () => {
    void syncPendingControllerUpdate()
  })
  createMainWindow()

  ipcMain.handle('pixel-forge-preview:load', async (event, payload) => {
    const ownerContextId = event.sender.id
    ensurePreviewContext(ownerContextId)
    const tabId = String(payload?.tabId || '')
    const url = String(payload?.url || '').trim()
    if (!tabId || !url) {
      throw new Error('tabId and url are required')
    }
    return loadPreviewUrl(ownerContextId, tabId, url)
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
    applyAllPreviewViews()
    previewRecord.view.webContents.focus()
    return {
      ok: true,
    }
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
    applyAllPreviewViews()
    previewRecord.view.webContents.focus()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:refresh', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    const view = previewRecord.view
    await view.webContents.reload()
    return {
      mode: 'browser',
      browser_tab_id: tabId,
      target_url: view.webContents.getURL(),
      title: view.webContents.getTitle() || view.webContents.getURL(),
      snapshot_data_url: null,
    }
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
    applyAllPreviewViews()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:close', async (event, payload) => {
    const ownerContextId = event.sender.id
    const tabId = String(payload?.tabId || '')
    const previewRecord = getPreviewRecord(ownerContextId, tabId)
    if (!previewRecord) {
      return { ok: true }
    }
    destroyOwnedPreviewContexts(previewRecord.view.webContents.id)
    removePreviewRecord(previewRecord)
    if (!previewRecord.view.webContents.isDestroyed()) {
      previewRecord.view.webContents.destroy()
    }
    applyAllPreviewViews()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:set-select-mode', async (event, payload) => {
    return sendPreviewCommand(event.sender.id, String(payload?.tabId || ''), {
      type: 'set-select-mode',
      enabled: Boolean(payload?.enabled),
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
    return applyControllerUpdate(
      typeof payload?.projectPath === 'string' ? payload.projectPath : '',
      payload,
    )
  })

  ipcMain.handle('pixel-forge-app:apply-pending-controller-update', async (_event, payload) => {
    const pendingUpdate = await readPendingControllerUpdate()
    if (!pendingUpdate) {
      throw new Error('No staged Pixel Forge update is ready to load.')
    }

    return applyControllerUpdate(pendingUpdate.snapshotPath || pendingUpdate.projectPath, {
      ...payload,
      projectPath:
        typeof payload?.projectPath === 'string' && payload.projectPath.trim()
          ? payload.projectPath
          : pendingUpdate.projectPath,
      previewUrl:
        typeof payload?.previewUrl === 'string' && payload.previewUrl.trim()
          ? payload.previewUrl
          : pendingUpdate.previewUrl,
      activeMode:
        payload?.activeMode === 'live-editor' || payload?.activeMode === 'screenshot'
          ? payload.activeMode
          : pendingUpdate.activeMode,
    })
  })

  ipcMain.handle('pixel-forge-app:consume-bootstrap-state', async () => {
    return consumeBootstrapStateFile()
  })

  ipcMain.handle('pixel-forge-app:get-pending-controller-update', async () => {
    return readPendingControllerUpdate()
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
    const previewKey = previewKeyByWebContentsId.get(event.sender.id)
    const previewRecord = previewKey ? previewViews.get(previewKey) : null
    if (!previewRecord) {
      return
    }
    sendPreviewEvent(previewRecord.ownerContextId, {
      ...payload,
      browser_tab_id: previewRecord.tabId,
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  unwatchFile(PENDING_CONTROLLER_UPDATE_PATH)
})
