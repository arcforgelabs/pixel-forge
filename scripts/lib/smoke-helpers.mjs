import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const repoRoot = path.resolve(__dirname, '..', '..')

function isTruthy(value) {
  return typeof value === 'string'
    && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

export async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve a smoke-test port.'))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
    server.on('error', reject)
  })
}

export async function createSmokeContext(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pixel-forge-${name}-`))
  const port = await reservePort()
  const installName = `pixel-forge-${name}`
  const shellName = `${installName}-shell`
  const paths = {
    root,
    installDir: path.join(root, 'install'),
    rollbackDir: path.join(root, 'rollback'),
    binDir: path.join(root, 'bin'),
    stateDir: path.join(root, 'state'),
    runtimeDir: path.join(root, 'state', 'runtime'),
    pendingUpdatePath: path.join(root, 'state', 'pending-controller-update.json'),
    applyStatePath: path.join(root, 'state', 'controller-update-apply-state.json'),
    runnerLogPath: path.join(root, 'state', 'controller-update-runner.log'),
    runtimeLogPath: path.join(root, 'state', 'runtime', `${installName}.log`),
  }
  const pathEntries = [paths.binDir]
  if (typeof process.env.PATH === 'string' && process.env.PATH.trim()) {
    pathEntries.push(process.env.PATH)
  }

  const env = {
    ...process.env,
    CI: 'true',
    PATH: pathEntries.join(path.delimiter),
    PIXEL_FORGE_INSTALL_NAME: installName,
    PIXEL_FORGE_CLI_NAME: installName,
    PIXEL_FORGE_SHELL_NAME: shellName,
    PIXEL_FORGE_INSTALL_DIR: paths.installDir,
    PIXEL_FORGE_BACKUP_DIR: paths.rollbackDir,
    PIXEL_FORGE_BIN_DIR: paths.binDir,
    PIXEL_FORGE_SERVICE_NAME: installName,
    PIXEL_FORGE_SHARED_STATE_DIR: paths.stateDir,
    PIXEL_FORGE_RUNTIME_DIR: paths.runtimeDir,
    PIXEL_FORGE_PORT: String(port),
    PIXEL_FORGE_API_PORT: String(port),
    PIXEL_FORGE_URL_HOST: '127.0.0.1',
    PIXEL_FORGE_INSTALL_SKIP_SYSTEMD: '1',
    PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION: '1',
  }

  return {
    name,
    root,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    env,
    paths,
  }
}

function formatCommand(command, args) {
  return [command, ...args].join(' ')
}

export async function runProcess(command, args = [], options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    label = formatCommand(command, args),
  } = options

  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

      const error = new Error(`${label} failed with exit code ${code ?? 'unknown'}.`)
      error.code = code
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

export async function installPixelForge(sourceRoot, context) {
  await runProcess('bash', ['./install.sh'], {
    cwd: sourceRoot,
    env: context.env,
    label: `install.sh (${sourceRoot})`,
  })
}

function cliNameForContext(context) {
  return context.env.PIXEL_FORGE_CLI_NAME || context.env.PIXEL_FORGE_INSTALL_NAME || 'pixel-forge'
}

export async function runPixelForge(context, args, options = {}) {
  return await runProcess(
    path.join(context.paths.binDir, cliNameForContext(context)),
    args,
    {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...context.env,
        ...(options.env ?? {}),
      },
      label: `pixel-forge ${args.join(' ')}`,
    },
  )
}

export async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'))
}

export async function waitForCondition(check, options = {}) {
  const {
    timeoutMs = 30000,
    intervalMs = 500,
    description = 'condition',
  } = options
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) {
        return result
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }

  const suffix = lastError instanceof Error ? ` ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${description}.${suffix}`.trim())
}

export async function waitForHttpOk(url, options = {}) {
  return await waitForCondition(async () => {
    const response = await fetch(url, { cache: 'no-store' })
    return response.ok ? response : null
  }, {
    timeoutMs: options.timeoutMs ?? 45000,
    intervalMs: options.intervalMs ?? 1000,
    description: options.description ?? url,
  })
}

export async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }
  return await response.json()
}

function shouldCopyRepoPath(sourcePath) {
  const relativePath = path.relative(repoRoot, sourcePath)
  if (!relativePath) {
    return true
  }

  const parts = relativePath.split(path.sep).filter(Boolean)
  if (parts.length === 0) {
    return true
  }

  if (
    parts.includes('.git')
    || parts.includes('.venv')
    || parts.includes('node_modules')
    || parts.includes('__pycache__')
  ) {
    return false
  }

  if (parts[0] === 'apps' && parts[1] === 'web' && parts[2] === 'dist') {
    return false
  }

  if (parts[0] === '.pixel-forge' && (parts[1] === 'instances' || parts[1] === 'requests')) {
    return false
  }

  return true
}

export async function copyRepoForSmoke(destinationRoot) {
  await fs.cp(repoRoot, destinationRoot, {
    recursive: true,
    filter: shouldCopyRepoPath,
  })
}

export async function writeVersionSet(rootPath, version) {
  await fs.writeFile(path.join(rootPath, 'VERSION'), `${version}\n`, 'utf-8')

  const packageFiles = [
    path.join(rootPath, 'package.json'),
    path.join(rootPath, 'apps', 'web', 'package.json'),
    path.join(rootPath, 'apps', 'desktop', 'package.json'),
    path.join(rootPath, 'packages', 'sdk-node', 'package.json'),
  ]

  for (const filePath of packageFiles) {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    payload.version = version
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  }
}

function trimOutput(output) {
  const normalized = output.trim()
  if (!normalized) {
    return ''
  }
  const maxLength = 4000
  if (normalized.length <= maxLength) {
    return normalized
  }
  return normalized.slice(-maxLength)
}

export async function reportSmokeFailure(name, error, context) {
  console.error(`[smoke:${name}] ${error instanceof Error ? error.message : String(error)}`)

  if (error && typeof error === 'object' && typeof error.stdout === 'string' && error.stdout.trim()) {
    console.error(`[smoke:${name}] stdout:`)
    console.error(trimOutput(error.stdout))
  }

  if (error && typeof error === 'object' && typeof error.stderr === 'string' && error.stderr.trim()) {
    console.error(`[smoke:${name}] stderr:`)
    console.error(trimOutput(error.stderr))
  }

  for (const logPath of [context.paths.runtimeLogPath, context.paths.runnerLogPath]) {
    if (!(await pathExists(logPath))) {
      continue
    }
    console.error(`[smoke:${name}] tail ${logPath}:`)
    console.error(trimOutput(await fs.readFile(logPath, 'utf-8')))
  }

  console.error(`[smoke:${name}] temp root: ${context.root}`)
}

async function removeSmokeRoot(root) {
  const retryCodes = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM'])
  let lastError = null

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      if (!retryCodes.has(error?.code)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }

  throw lastError
}

async function terminateSmokeRootProcesses(context) {
  const smokeRoot = path.resolve(context.root)
  let output = ''
  try {
    const result = await runProcess('ps', ['-eo', 'pid=,cmd='], {
      label: 'ps smoke cleanup',
    })
    output = result.stdout
  } catch {
    return
  }

  const pids = output
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes(smokeRoot)) {
        return null
      }
      const [pidText] = trimmed.split(/\s+/, 1)
      const pid = Number.parseInt(pidText, 10)
      return Number.isFinite(pid) && pid > 0 && pid !== process.pid ? pid : null
    })
    .filter((pid) => pid !== null)

  if (pids.length === 0) {
    return
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 750))
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

export async function cleanupSmokeContext(context) {
  if (await pathExists(path.join(context.paths.binDir, cliNameForContext(context)))) {
    await runPixelForge(context, ['stop']).catch(() => {})
  }
  await terminateSmokeRootProcesses(context)

  if (isTruthy(process.env.PIXEL_FORGE_SMOKE_KEEP_TEMP)) {
    console.log(`[smoke:${context.name}] kept temp root at ${context.root}`)
    return
  }

  await runProcess('chmod', ['-R', 'u+w', context.root], {
    label: `chmod smoke temp root ${context.root}`,
  }).catch(() => {})
  await removeSmokeRoot(context.root)
}
