import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHELL_URL = process.env.PIXEL_FORGE_SHELL_URL || 'http://pixel-forge.localhost:7001'
const PREVIEW_PARTITION = 'persist:pixel-forge-preview'

app.setName('Pixel Forge')

let mainWindow = null
let activePreviewTabId = null
let previewVisible = false
let previewBounds = { x: 0, y: 0, width: 0, height: 0 }
let attachedPreviewView = null
let pickerOverlayWindow = null
let pickerOverlayResolver = null
let pickerOverlaySettling = false
let pendingBootstrapState = null

const previewViews = new Map()
const webContentsTabIds = new Map()

function currentView() {
  if (!activePreviewTabId) {
    return null
  }
  return previewViews.get(activePreviewTabId) ?? null
}

function broadcastPreviewEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('pixel-forge-preview:event', event)
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

function applyPreviewView() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  const view = currentView()
  const attached = attachedPreviewView

  if (!previewVisible || !view || previewBounds.width === 0 || previewBounds.height === 0) {
    if (attached) {
      mainWindow.contentView.removeChildView(attached)
      attachedPreviewView = null
    }
    return
  }

  if (attached && attached !== view) {
    mainWindow.contentView.removeChildView(attached)
    attachedPreviewView = null
  }
  if (attachedPreviewView !== view) {
    mainWindow.contentView.addChildView(view)
    attachedPreviewView = view
  }
  view.setBounds(previewBounds)
}

function registerViewEvents(tabId, view) {
  const webContentsId = view.webContents.id

  view.webContents.setWindowOpenHandler(({ url }) => {
    void loadPreviewUrl(tabId, url)
    return { action: 'deny' }
  })

  view.webContents.on('did-finish-load', () => {
    broadcastPreviewEvent({
      type: 'browser-location-changed',
      browser_tab_id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle() || view.webContents.getURL(),
    })
  })

  view.webContents.on('page-title-updated', () => {
    broadcastPreviewEvent({
      type: 'browser-location-changed',
      browser_tab_id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle() || view.webContents.getURL(),
    })
  })

  view.webContents.on('destroyed', () => {
    previewViews.delete(tabId)
    webContentsTabIds.delete(webContentsId)
    if (attachedPreviewView === view) {
      attachedPreviewView = null
    }
    if (activePreviewTabId === tabId) {
      activePreviewTabId = null
      previewVisible = false
      applyPreviewView()
    }
    broadcastPreviewEvent({
      type: 'browser-tab-closed',
      browser_tab_id: tabId,
    })
  })

  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return
    }
    broadcastPreviewEvent({
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
  const sanitizedState = sanitizeBootstrapState(bootstrapState)
  if (!sanitizedState.projectPath) {
    throw new Error('projectPath is required')
  }

  pendingBootstrapState = sanitizedState
  await runShellCommand('./install.sh && pixel-forge restart', sanitizedState.projectPath)
  await waitForShellReady()

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.loadURL(SHELL_URL)
  }

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

function getOrCreatePreviewView(tabId) {
  const existing = previewViews.get(tabId)
  if (existing) {
    return existing
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
  previewViews.set(tabId, view)
  webContentsTabIds.set(view.webContents.id, tabId)
  registerViewEvents(tabId, view)
  return view
}

async function loadPreviewUrl(tabId, url) {
  const view = getOrCreatePreviewView(tabId)
  activePreviewTabId = tabId
  previewVisible = true
  applyPreviewView()
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

function sendPreviewCommand(tabId, command) {
  const view = previewViews.get(tabId)
  if (!view) {
    throw new Error(`Unknown preview tab: ${tabId}`)
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
  const view = previewViews.get(tabId)
  if (!view) {
    throw new Error(`Unknown preview tab: ${tabId}`)
  }

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

async function showPickListOverlay(payload) {
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

  const x = Math.min(Math.max(contentBounds.x + anchorRect.x, minX), maxX)
  const y = Math.min(
    Math.max(contentBounds.y + anchorRect.y + anchorRect.height + 6, minY),
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

  mainWindow.on('resize', applyPreviewView)
  mainWindow.on('move', applyPreviewView)
  mainWindow.on('closed', () => {
    mainWindow = null
    attachedPreviewView = null
  })
}

app.whenReady().then(() => {
  createMainWindow()

  ipcMain.handle('pixel-forge-preview:load', async (_event, payload) => {
    const tabId = String(payload?.tabId || '')
    const url = String(payload?.url || '').trim()
    if (!tabId || !url) {
      throw new Error('tabId and url are required')
    }
    return loadPreviewUrl(tabId, url)
  })

  ipcMain.handle('pixel-forge-preview:activate', async (_event, payload) => {
    const tabId = String(payload?.tabId || '')
    if (!previewViews.has(tabId)) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    activePreviewTabId = tabId
    previewVisible = true
    applyPreviewView()
    const view = previewViews.get(tabId)
    view.webContents.focus()
    return {
      ok: true,
    }
  })

  ipcMain.handle('pixel-forge-preview:focus', async (_event, payload) => {
    const tabId = String(payload?.tabId || '')
    if (!previewViews.has(tabId)) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    activePreviewTabId = tabId
    previewVisible = true
    applyPreviewView()
    previewViews.get(tabId).webContents.focus()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:refresh', async (_event, payload) => {
    const tabId = String(payload?.tabId || '')
    if (!previewViews.has(tabId)) {
      throw new Error(`Unknown preview tab: ${tabId}`)
    }
    const view = previewViews.get(tabId)
    await view.webContents.reload()
    return {
      mode: 'browser',
      browser_tab_id: tabId,
      target_url: view.webContents.getURL(),
      title: view.webContents.getTitle() || view.webContents.getURL(),
      snapshot_data_url: null,
    }
  })

  ipcMain.handle('pixel-forge-preview:set-bounds', async (_event, bounds) => {
    previewBounds = sanitizeBounds(bounds)
    applyPreviewView()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:hide', async () => {
    previewVisible = false
    applyPreviewView()
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:close', async (_event, payload) => {
    const tabId = String(payload?.tabId || '')
    const view = previewViews.get(tabId)
    if (!view) {
      return { ok: true }
    }
    if (attachedPreviewView === view) {
      mainWindow?.contentView.removeChildView(view)
      attachedPreviewView = null
    }
    previewViews.delete(tabId)
    webContentsTabIds.delete(view.webContents.id)
    if (!view.webContents.isDestroyed()) {
      view.webContents.destroy()
    }
    if (activePreviewTabId === tabId) {
      activePreviewTabId = null
      previewVisible = false
    }
    return { ok: true }
  })

  ipcMain.handle('pixel-forge-preview:set-select-mode', async (_event, payload) => {
    return sendPreviewCommand(String(payload?.tabId || ''), {
      type: 'set-select-mode',
      enabled: Boolean(payload?.enabled),
    })
  })

  ipcMain.handle('pixel-forge-preview:clear-selections', async (_event, payload) => {
    return sendPreviewCommand(String(payload?.tabId || ''), {
      type: 'clear-selections',
    })
  })

  ipcMain.handle('pixel-forge-preview:deselect', async (_event, payload) => {
    return sendPreviewCommand(String(payload?.tabId || ''), {
      type: 'deselect',
      selectionId: String(payload?.selectionId || ''),
      xpath: String(payload?.xpath || ''),
    })
  })

  ipcMain.handle('pixel-forge-preview:apply-selections', async (_event, payload) => {
    return sendPreviewCommand(String(payload?.tabId || ''), {
      type: 'apply-selections',
      selections: Array.isArray(payload?.selections) ? payload.selections : [],
    })
  })

  ipcMain.handle('pixel-forge-preview:capture-region', async (event, rect) => {
    const tabId = webContentsTabIds.get(event.sender.id)
    if (!tabId) {
      throw new Error('Unknown preview sender')
    }
    return capturePreviewRegion(tabId, rect)
  })

  ipcMain.handle('pixel-forge-overlay:pick-list', async (_event, payload) => {
    return showPickListOverlay(payload)
  })

  ipcMain.handle('pixel-forge-app:apply-controller-update', async (_event, payload) => {
    return applyControllerUpdate(
      typeof payload?.projectPath === 'string' ? payload.projectPath : '',
      payload,
    )
  })

  ipcMain.handle('pixel-forge-app:consume-bootstrap-state', async () => {
    const state = pendingBootstrapState
    pendingBootstrapState = null
    return state
  })

  ipcMain.on('pixel-forge-overlay:list-selected', (_event, value) => {
    closePickerOverlay(typeof value === 'string' ? value : null)
  })

  ipcMain.on('pixel-forge-overlay:list-cancel', () => {
    closePickerOverlay(null)
  })

  ipcMain.on('pixel-forge-preview:event', (event, payload) => {
    const tabId = webContentsTabIds.get(event.sender.id)
    if (!tabId) {
      return
    }
    broadcastPreviewEvent({
      ...payload,
      browser_tab_id: tabId,
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
