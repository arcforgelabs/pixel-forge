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

const stateDir = path.resolve(argValue('--state-dir') || '')
const installRoot = path.resolve(argValue('--install-root') || '')
const updateId = normalizeText(argValue('--update-id'))
const shellUrl = normalizeText(argValue('--shell-url')) || 'http://pixel-forge.localhost:7001'
const appExec = normalizeText(argValue('--app-exec')) || process.execPath
const relaunchArgsB64 = normalizeText(argValue('--relaunch-args-b64')) || ''
const relaunchArgs = (() => {
  try {
    return JSON.parse(Buffer.from(relaunchArgsB64, 'base64').toString('utf-8'))
  } catch {
    return []
  }
})()

const applyStatePath = path.join(stateDir, 'controller-update-apply-state.json')
const pendingUpdatePath = path.join(stateDir, 'pending-controller-update.json')

function requireInstallLayout(candidatePath) {
  return (
    path.isAbsolute(candidatePath)
    && existsSync(path.join(candidatePath, 'install.sh'))
    && existsSync(path.join(candidatePath, 'apps', 'api', 'main.py'))
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
    console.warn('[pixel-forge runner] Failed to delete directory:', dirPath, error)
  }
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

async function waitForShellReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(shellUrl, { cache: 'no-store' })
      if (response.ok) {
        return
      }
    } catch {
      // Retry until ready.
    }
    await sleep(1000)
  }

  throw new Error('Pixel Forge did not come back after update.')
}

async function clearPendingControllerUpdate() {
  const pending = await readJsonFile(pendingUpdatePath)
  if (pending?.snapshotPath) {
    await deleteDirectoryIfPresent(path.resolve(pending.snapshotPath))
  }
  await deleteFileIfPresent(pendingUpdatePath)
}

function relaunchPixelForge() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(appExec, relaunchArgs, {
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
  if (!requireInstallLayout(installRoot)) {
    throw new Error(`Installable Pixel Forge root not found: ${installRoot}`)
  }

  await setState({
    phase: 'installing',
    progress: 40,
    message: 'Installing updated Pixel Forge build…',
    error: null,
  })
  await runShellCommand('./install.sh', installRoot)

  await setState({
    phase: 'restarting',
    progress: 68,
    message: 'Restarting Pixel Forge service…',
    error: null,
  })
  await runShellCommand('pixel-forge restart', installRoot)

  await setState({
    phase: 'waiting',
    progress: 84,
    message: 'Waiting for the updated app to come back online…',
    error: null,
  })
  await waitForShellReady()

  await setState({
    phase: 'finalizing',
    progress: 92,
    message: 'Finalizing the staged Pixel Forge update…',
    error: null,
  })
  try {
    await clearPendingControllerUpdate()
  } catch (error) {
    console.warn('[pixel-forge runner] Failed to clear pending controller update:', error)
  }

  await setState({
    phase: 'relaunching',
    progress: 100,
    message: 'Reloading Pixel Forge with the updated build…',
    error: null,
  })
  relaunchPixelForge()

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
  await setError(error)
  process.exitCode = 1
})
