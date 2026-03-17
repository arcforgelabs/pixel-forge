import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
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
    webContentsTabIds.delete(view.webContents.id)
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
  await view.webContents.loadURL(url)
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
      xpath: String(payload?.xpath || ''),
    })
  })

  ipcMain.handle('pixel-forge-preview:apply-selections', async (_event, payload) => {
    return sendPreviewCommand(String(payload?.tabId || ''), {
      type: 'apply-selections',
      selections: Array.isArray(payload?.selections) ? payload.selections : [],
    })
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
