import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) {
    return null
  }
  return process.argv[index + 1] ?? null
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

const retiredInstallNames = new Set(['pixel-forge-alpha', 'pixel-forge-workstation-v2'])

function normalizeLaneName(value) {
  const normalized = normalizeText(value)
  if (!normalized || retiredInstallNames.has(normalized)) {
    return null
  }
  return normalized
}

function normalizeShellLauncherName(value) {
  const normalized = normalizeText(value)
  if (!normalized || retiredInstallNames.has(normalized.replace(/-shell$/, ''))) {
    return null
  }
  return normalized
}

function isTruthy(value) {
  return typeof value === 'string'
    && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

const instanceSlug = normalizeText(process.env.PIXEL_FORGE_INSTANCE_SLUG) || 'pixel-forge'
const stateDir = path.resolve(argValue('--state-dir') || '')
const installRoot = path.resolve(argValue('--install-root') || '')
const updateId = normalizeText(argValue('--update-id'))
const shellHost =
  normalizeText(process.env.PIXEL_FORGE_URL_HOST)
  || `${instanceSlug}.localhost`
const shellPort =
  normalizeText(process.env.PIXEL_FORGE_API_PORT)
  || normalizeText(process.env.PIXEL_FORGE_PORT)
  || '7001'
const shellUrl =
  normalizeText(argValue('--shell-url'))
  || normalizeText(process.env.PIXEL_FORGE_SHELL_URL)
  || `http://${shellHost}:${shellPort}`
const pixelForgeBinDir = normalizeText(process.env.PIXEL_FORGE_BIN_DIR)
const pixelForgeCliName = normalizeLaneName(process.env.PIXEL_FORGE_CLI_NAME) || 'pixel-forge'
const pixelForgeShellName =
  normalizeShellLauncherName(process.env.PIXEL_FORGE_SHELL_NAME) || 'pixel-forge-shell'

const applyStatePath = path.join(stateDir, 'controller-update-apply-state.json')
const pendingUpdatePath = path.join(stateDir, 'pending-controller-update.json')
const runnerLogPath = path.join(stateDir, 'controller-update-runner.log')
const cleanupQueuePath = path.join(stateDir, 'controller-update-cleanup-queue.json')

async function appendLog(message) {
  if (!stateDir) {
    return
  }
  await fs.mkdir(path.dirname(runnerLogPath), { recursive: true })
  await fs.appendFile(
    runnerLogPath,
    `[${new Date().toISOString()}] ${message}\n`,
    'utf-8',
  )
}

async function logInfo(message) {
  await appendLog(message)
}

async function logError(message, error = null) {
  const detail = error instanceof Error ? error.stack || error.message : String(error ?? '')
  await appendLog(detail ? `${message}\n${detail}` : message)
}

function pixelForgeCommand(binaryName) {
  if (pixelForgeBinDir) {
    return path.join(path.resolve(pixelForgeBinDir), binaryName)
  }
  return binaryName
}

function requireInstallLayout(candidatePath) {
  return (
    path.isAbsolute(candidatePath)
    && existsSync(path.join(candidatePath, 'install.sh'))
    && existsSync(path.join(candidatePath, 'apps', 'api', 'main.py'))
  )
}

function requireInstalledRuntimeAssets(candidatePath) {
  return (
    path.isAbsolute(candidatePath)
    && existsSync(path.join(candidatePath, 'frontend', 'index.html'))
    && existsSync(path.join(candidatePath, 'desktop', 'package.json'))
    && existsSync(path.join(candidatePath, 'pixel_forge_cli.py'))
  )
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function deleteFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
      throw error
    }
  }
}

async function deleteDirectoryIfPresent(dirPath) {
  if (!dirPath) {
    return
  }
  try {
    await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  } catch (error) {
    await logError(`[pixel-forge runner] Failed to delete directory: ${dirPath}`, error)
  }
}

async function enqueueSnapshotCleanup(snapshotPath) {
  if (!snapshotPath) {
    return
  }
  const resolvedPath = path.resolve(snapshotPath)
  let entries = []
  const current = await readJsonFile(cleanupQueuePath)
  if (Array.isArray(current)) {
    entries = current.filter((value) => typeof value === 'string' && value.trim())
  }
  if (!entries.includes(resolvedPath)) {
    entries.push(resolvedPath)
  }
  await writeJsonFile(cleanupQueuePath, entries)
}

function launchDetachedSnapshotCleanup(stateDirPath) {
  const script = `
set -eu
sleep 8
python3 - <<'PY'
import json
import pathlib
import shutil
import time

state_dir = pathlib.Path(${JSON.stringify(stateDirPath)})
queue_path = state_dir / 'controller-update-cleanup-queue.json'
if not queue_path.exists():
    raise SystemExit(0)

try:
    payload = json.loads(queue_path.read_text(encoding='utf-8'))
except Exception:
    raise SystemExit(0)

paths = [pathlib.Path(p).expanduser() for p in payload if isinstance(p, str) and p.strip()]
remaining = []
for target in paths:
    deleted = False
    for attempt in range(6):
        try:
            shutil.rmtree(target)
            deleted = True
            break
        except FileNotFoundError:
            deleted = True
            break
        except OSError:
            time.sleep(1.0 + attempt)
    if not deleted:
        remaining.append(str(target))

if remaining:
    queue_path.write_text(json.dumps(remaining, indent=2), encoding='utf-8')
else:
    try:
        queue_path.unlink()
    except FileNotFoundError:
        pass
PY
`
  const proc = spawn('bash', ['-lc', script], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  proc.unref()
}

async function setState(payload) {
  await writeJsonFile(applyStatePath, {
    status: 'running',
    updateId,
    phase: 'idle',
    progress: 0,
    message: '',
    error: null,
    updatedAt: new Date().toISOString(),
    ...payload,
  })
}

async function setError(error) {
  await writeJsonFile(applyStatePath, {
    status: 'error',
    updateId,
    phase: 'error',
    progress: 100,
    message: 'Failed to apply the staged Pixel Forge update.',
    error: error instanceof Error ? error.message : String(error || 'Unknown error'),
    updatedAt: new Date().toISOString(),
  })
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

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function readExpectedControllerVersion(rootPath) {
  for (const relativePath of ['VERSION', 'package.json']) {
    try {
      const raw = await fs.readFile(path.join(rootPath, relativePath), 'utf-8')
      if (relativePath === 'VERSION') {
        const value = raw.trim()
        if (value) {
          return value
        }
        continue
      }

      const payload = JSON.parse(raw)
      if (typeof payload?.version === 'string' && payload.version.trim()) {
        return payload.version.trim()
      }
    } catch {
      // Keep looking for a readable version surface.
    }
  }

  return null
}

async function waitForShellReady(expectedVersion = null, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  const runtimeInfoUrl = new URL('/api/runtime-info', shellUrl).toString()

  while (Date.now() < deadline) {
    try {
      const response = await fetch(shellUrl, { cache: 'no-store' })
      if (response.ok) {
        if (!expectedVersion) {
          return
        }

        const runtimeInfoResponse = await fetch(runtimeInfoUrl, { cache: 'no-store' })
        if (runtimeInfoResponse.ok) {
          const payload = await runtimeInfoResponse.json()
          if (payload?.controllerVersion === expectedVersion) {
            return
          }
        }
      }
    } catch {
      // Retry until ready.
    }
    await sleep(1000)
  }

  if (expectedVersion) {
    throw new Error(`Pixel Forge did not come back with controller version ${expectedVersion}.`)
  }

  throw new Error('Pixel Forge did not come back after update.')
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
  const stat = await fs.lstat(sourcePath)

  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath)
    await fs.symlink(linkTarget, destinationPath)
    return
  }

  if (stat.isDirectory()) {
    await fs.mkdir(destinationPath, { recursive: true })
    await fs.chmod(destinationPath, stat.mode)
    const entries = await fs.readdir(sourcePath, { withFileTypes: true })
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

  await fs.copyFile(sourcePath, destinationPath)
  await fs.chmod(destinationPath, stat.mode)
}

async function createControllerUpdateSnapshot(projectPath, requestedUpdateId) {
  const sourcePath = path.resolve(projectPath)
  if (!requireInstallLayout(sourcePath)) {
    throw new Error(`Cannot create controller update snapshot from non-installable root: ${sourcePath}`)
  }

  const updateRoot = path.join(stateDir, 'controller-updates')
  const normalizedUpdateId = requestedUpdateId || Math.random().toString(36).slice(2, 14)
  let snapshotPath = path.join(updateRoot, normalizedUpdateId)
  await fs.mkdir(updateRoot, { recursive: true })
  await deleteDirectoryIfPresent(snapshotPath)

  if (existsSync(snapshotPath)) {
    snapshotPath = path.join(updateRoot, `${normalizedUpdateId}-${Date.now().toString(36)}`)
    await deleteDirectoryIfPresent(snapshotPath)
  }

  await copyControllerSnapshotTree(sourcePath, snapshotPath)
  if (!requireInstallLayout(snapshotPath)) {
    throw new Error(`Rebuilt controller update snapshot is incomplete: ${snapshotPath}`)
  }
  return snapshotPath
}

async function readPendingControllerUpdate() {
  const payload = await readJsonFile(pendingUpdatePath)
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const pendingProjectPath = normalizeText(payload.projectPath)
  if (!pendingProjectPath) {
    return null
  }
  return {
    ...payload,
    id: normalizeText(payload.id),
    projectPath: pendingProjectPath,
    snapshotPath: normalizeText(payload.snapshotPath),
  }
}

async function writePendingControllerUpdate(payload) {
  await writeJsonFile(pendingUpdatePath, payload)
}

async function clearPendingControllerUpdate() {
  const pending = await readJsonFile(pendingUpdatePath)
  if (pending?.snapshotPath) {
    await enqueueSnapshotCleanup(pending.snapshotPath)
  }
  await deleteFileIfPresent(pendingUpdatePath)
}

async function ensureInstallRoot(candidatePath) {
  if (requireInstallLayout(candidatePath)) {
    return candidatePath
  }

  const pendingUpdate = await readPendingControllerUpdate()
  if (!pendingUpdate) {
    throw new Error('No staged Pixel Forge update is ready to install.')
  }
  if (updateId && pendingUpdate.id && pendingUpdate.id !== updateId) {
    throw new Error(
      `Staged controller update mismatch. Expected ${updateId}, found ${pendingUpdate.id}.`,
    )
  }
  if (requireInstallLayout(pendingUpdate.snapshotPath || '')) {
    return path.resolve(pendingUpdate.snapshotPath)
  }
  if (!requireInstallLayout(pendingUpdate.projectPath)) {
    throw new Error(`Staged Pixel Forge update has no installable source root: ${pendingUpdate.projectPath}`)
  }

  await logInfo(`Repairing staged controller update snapshot from ${pendingUpdate.projectPath}`)
  const rebuiltSnapshotPath = await createControllerUpdateSnapshot(
    pendingUpdate.projectPath,
    pendingUpdate.id || updateId,
  )
  await logInfo(`Rebuilt staged controller update snapshot at ${rebuiltSnapshotPath}`)
  await writePendingControllerUpdate({
    ...pendingUpdate,
    snapshotPath: rebuiltSnapshotPath,
  })
  return rebuiltSnapshotPath
}

function relaunchPixelForge() {
  if (isTruthy(process.env.PIXEL_FORGE_SKIP_SHELL_RELAUNCH)) {
    return
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn('bash', ['-lc', JSON.stringify(pixelForgeCommand(pixelForgeShellName))], {
    detached: true,
    stdio: 'ignore',
    env,
  })
  proc.unref()
}

async function main() {
  if (!stateDir) {
    throw new Error('Missing --state-dir')
  }

  await setState({
    phase: 'preparing',
    progress: 24,
    message: 'Verifying the staged Pixel Forge update snapshot…',
    error: null,
  })
  const resolvedInstallRoot = await ensureInstallRoot(installRoot)
  const expectedVersion = await readExpectedControllerVersion(resolvedInstallRoot)
  await logInfo(`Starting controller update runner for ${resolvedInstallRoot}`)

  await setState({
    phase: 'installing',
    progress: 40,
    message: 'Installing updated Pixel Forge build…',
    error: null,
  })
  await runShellCommand('bash ./install.sh', resolvedInstallRoot)
  await logInfo('Finished install.sh')

  const installedRoot = path.resolve(
    normalizeText(process.env.PIXEL_FORGE_INSTALL_DIR) || resolvedInstallRoot,
  )
  if (!requireInstalledRuntimeAssets(installedRoot)) {
    throw new Error(
      `Installed Pixel Forge runtime is incomplete after install.sh: ${installedRoot}`,
    )
  }
  await logInfo(`Verified installed runtime assets at ${installedRoot}`)

  await setState({
    phase: 'restarting',
    progress: 68,
    message: 'Restarting Pixel Forge service…',
    error: null,
  })
  // Use stateDir as cwd — install.sh may have relocated resolvedInstallRoot
  // and Node surfaces a missing cwd as a confusing "spawn bash ENOENT".
  await runShellCommand(`${JSON.stringify(pixelForgeCommand(pixelForgeCliName))} restart`, stateDir)
  await logInfo(`Finished ${pixelForgeCliName} restart`)

  await setState({
    phase: 'waiting',
    progress: 84,
    message: 'Waiting for the updated app to come back online…',
    error: null,
  })
  await waitForShellReady(expectedVersion)

  await setState({
    phase: 'finalizing',
    progress: 92,
    message: 'Finalizing the staged Pixel Forge update…',
    error: null,
  })
  try {
    await clearPendingControllerUpdate()
  } catch (error) {
    await logError('[pixel-forge runner] Failed to clear pending controller update', error)
  }

  await setState({
    phase: 'relaunching',
    progress: 100,
    message: 'Reloading Pixel Forge with the updated build…',
    error: null,
  })
  relaunchPixelForge()
  launchDetachedSnapshotCleanup(stateDir)
  await logInfo('Relaunched Pixel Forge shell')

  await setState({
    status: 'done',
    phase: 'done',
    progress: 100,
    message: 'Updated Pixel Forge is ready.',
    error: null,
  })
  await sleep(1800)
  await deleteFileIfPresent(applyStatePath)
}

main().catch(async (error) => {
  await logError('Controller update runner failed', error)
  await setError(error)
  process.exitCode = 1
})
