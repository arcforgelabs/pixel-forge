import { app, BrowserWindow, WebContentsView, ipcMain, shell, webContents as electronWebContents } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fsPromises, watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readControllerVersion, readProjectVersion } from './version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHELL_URL = process.env.PIXEL_FORGE_SHELL_URL || 'http://pixel-forge.localhost:7001'
const PREVIEW_PARTITION = 'persist:pixel-forge-preview'
const APP_STATE_DIR = path.resolve(
  process.env.PIXEL_FORGE_STATE_DIR || path.join(os.homedir(), '.pixel-forge'),
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
const IS_UPDATER_UI_MODE = process.argv.includes('--pixel-forge-updater-ui')

app.setName('Pixel Forge')

let mainWindow = null
let updaterWindow = null
let pickerOverlayWindow = null
let pickerOverlayResolver = null
let pickerOverlaySettling = false
let pickerOverlayOwnerContextId = null
let pendingUpdateSnapshot = null
let controllerUpdateApplyState = {
  status: 'idle',
  updateId: null,
  phase: 'idle',
  progress: 0,
  message: '',
  error: null,
  updatedAt: null,
}

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
    focusedSurface: 'shell',
    armedTool: null,
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

function emitPreviewInputState(ownerContextId) {
  sendAppEventToContext(ownerContextId, {
    type: 'preview-input-state-changed',
    inputState: readPreviewInputState(ownerContextId),
  })
}

function updatePreviewInputState(ownerContextId, updates = {}) {
  const context = ensurePreviewContext(ownerContextId)
  let changed = false

  if (Object.prototype.hasOwnProperty.call(updates, 'focusedSurface')) {
    const nextFocusedSurface = normalizeFocusedSurface(updates.focusedSurface)
    if (context.focusedSurface !== nextFocusedSurface) {
      context.focusedSurface = nextFocusedSurface
      changed = true
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'armedTool')) {
    const nextArmedTool = normalizePreviewTool(updates.armedTool)
    if (context.armedTool !== nextArmedTool) {
      context.armedTool = nextArmedTool
      changed = true
    }
  }

  if (changed) {
    emitPreviewInputState(ownerContextId)
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
  const updatedAt = normalizeText(payload?.updatedAt) || new Date().toISOString()
  return {
    status,
    updateId: normalizeText(payload?.updateId),
    phase,
    progress,
    message: normalizeText(payload?.message) || '',
    error: normalizeText(payload?.error),
    updatedAt,
  }
}

function setControllerUpdateApplyState(payload) {
  controllerUpdateApplyState = sanitizeControllerUpdateApplyState(payload)
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
  normalized.version = await readProjectVersion(normalized.projectPath)
  normalized.snapshotPath = await createControllerUpdateSnapshot(
    normalized.projectPath,
    normalized.id,
  )
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

function createUpdaterWindow() {
  updaterWindow = new BrowserWindow({
    width: 520,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
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
  })

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
    webContentsId: view.webContents.id,
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
  updatePreviewInputState(ownerContextId, { focusedSurface: 'overlay' })

  return await new Promise((resolve) => {
    pickerOverlayResolver = resolve
  })
}

async function createMainWindow() {
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

app.whenReady().then(() => {
  if (IS_UPDATER_UI_MODE) {
    ipcMain.handle('pixel-forge-updater:get-state', async () => {
      return (await recoverControllerUpdateApplyState())
        ?? sanitizeControllerUpdateApplyState({
          status: 'idle',
          phase: 'idle',
          progress: 0,
          message: '',
          error: null,
        })
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
  void createMainWindow()

  ipcMain.handle('pixel-forge-preview:load', async (event, payload) => {
    const ownerContextId = event.sender.id
    ensurePreviewContext(ownerContextId)
    const tabId = String(payload?.tabId || '')
    const url = String(payload?.url || '').trim()
    if (!tabId || !url) {
      throw new Error('tabId and url are required')
    }
    const response = await loadPreviewUrl(ownerContextId, tabId, url)
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
    applyAllPreviewViews()
    emitPreviewInputState(ownerContextId)
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
    applyAllPreviewViews()
    emitPreviewInputState(ownerContextId)
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
    applyAllPreviewViews()
    previewRecord.view.webContents.focus()
    updatePreviewInputState(ownerContextId, { focusedSurface: 'preview' })
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
    if (!IS_UPDATER_UI_MODE && BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  unwatchFile(PENDING_CONTROLLER_UPDATE_PATH)
})
