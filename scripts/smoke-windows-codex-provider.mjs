import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function isTruthy(value) {
  return typeof value === 'string'
    && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve smoke port.'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
    server.on('error', reject)
  })
}

function runProcess(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    label = [command, ...args].join(' '),
    timeoutMs = 0,
  } = options

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })
    let stdout = ''
    let stderr = ''
    let timeout = null
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        proc.kill()
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`))
      }, timeoutMs)
    }
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    proc.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const error = new Error(`${label} failed with exit code ${code ?? 'unknown'}.`)
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

function startProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
}

async function stopProcessTree(proc) {
  if (!proc || typeof proc.pid !== 'number') {
    return
  }
  if (process.platform === 'win32') {
    await runProcess('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
      label: `taskkill ${proc.pid}`,
    }).catch(() => {})
    return
  }
  proc.kill()
}

async function waitForHttpOk(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) {
        return response
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${options.description ?? url}: ${lastError?.message ?? 'no response'}`)
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`)
  }
  return await response.json()
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`)
  }
  return await response.json()
}

function projectUrl(baseUrl, projectPath, suffix) {
  return `${baseUrl}/api/projects/${encodeURIComponent(projectPath)}${suffix}`
}

function waitForSocketOpen(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out opening Live Editor websocket')), timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('Live Editor websocket failed to open'))
    }, { once: true })
  })
}

async function sendLiveEditorTurn({ port, projectPath, threadId }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/live-editor`)
  await waitForSocketOpen(socket)
  const payload = {
    chat_id: threadId,
    project_path: projectPath,
    provider_id: 'codex-cli',
    agent_type: 'codex',
    agent_thinking: 'minimal',
    target_intent: {
      mode: 'new',
      provider_id: 'codex-cli',
      provider_session_id: null,
      agent_id: 'codex',
      workspace_mode: 'root',
    },
    turn_input: {
      message: 'Pixel Forge Windows direct Codex smoke. Reply with WINDOWS_CODEX_PROVIDER_SMOKE_OK and do not edit files.',
      preview_url: '',
      selection_tunnel: { selections: [] },
      attachments: [],
    },
  }

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for direct Codex turn to complete.'))
    }, 300000)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'error') {
        clearTimeout(timeout)
        socket.close()
        reject(new Error(`Direct Codex turn failed: ${message.message || JSON.stringify(message)}`))
        return
      }
      if (message.type === 'complete') {
        clearTimeout(timeout)
        socket.close()
        resolve(message)
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('Live Editor websocket failed during direct Codex turn'))
    }, { once: true })
    socket.send(JSON.stringify(payload))
  })
}

if (process.platform !== 'win32') {
  throw new Error('smoke:windows-codex-provider must be run on Windows.')
}

const liveTurn = isTruthy(process.env.PIXEL_FORGE_WINDOWS_SMOKE_LIVE_TURN)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-forge-windows-codex-'))
const installRoot = path.join(root, 'install')
const stateDir = path.join(root, 'state')
const projectPath = path.join(root, 'workspace')
const port = await reservePort()
const baseUrl = `http://127.0.0.1:${port}`
let apiProcess = null

try {
  await fs.mkdir(projectPath, { recursive: true })
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Pixel Forge Windows Codex smoke\n', 'utf-8')

  const env = {
    ...process.env,
    CI: 'true',
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PIXEL_FORGE_INSTALL_DIR: installRoot,
    PIXEL_FORGE_SHARED_STATE_DIR: stateDir,
    PIXEL_FORGE_PORT: String(port),
    PIXEL_FORGE_API_PORT: String(port),
    PIXEL_FORGE_WITH_AGENT_DECK: '0',
    PIXEL_FORGE_DEFAULT_AGENT_PROVIDER_ID: 'codex-cli',
    PIXEL_FORGE_TUI_OPEN_DRY_RUN: '1',
  }

  await runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(repoRoot, 'install-windows.ps1'),
    '-InstallRoot',
    installRoot,
    '-SourceDir',
    repoRoot,
    '-SkipShortcuts',
  ], {
    env,
    timeoutMs: 600000,
    label: 'install-windows.ps1',
  })

  const apiLauncher = path.join(installRoot, 'bin', 'pixel-forge-api.ps1')
  apiProcess = startProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    apiLauncher,
  ], { env })

  await waitForHttpOk(`${baseUrl}/api/runtime-info`, {
    description: 'Windows Pixel Forge API',
    timeoutMs: 90000,
  })

  const profile = await fetchJson(`${baseUrl}/api/profile-state`)
  assert(
    profile.default_agent_provider_id === 'codex-cli',
    `Expected Windows default provider codex-cli, got ${JSON.stringify(profile)}`,
  )

  const providersPayload = await fetchJson(`${baseUrl}/api/agent-providers`)
  const agentDeck = providersPayload.providers.find((provider) => provider.id === 'agent-deck')
  const codexProvider = providersPayload.providers.find((provider) => provider.id === 'codex-cli')
  assert(agentDeck?.enabled === false, `Expected Agent Deck disabled: ${JSON.stringify(agentDeck)}`)
  assert(codexProvider?.available === true, `Expected Codex CLI available: ${JSON.stringify(codexProvider)}`)
  assert(codexProvider?.capabilities?.open_tui === true, `Expected Codex Open TUI capability: ${JSON.stringify(codexProvider)}`)

  await postJson(`${baseUrl}/api/projects`, {
    path: projectPath,
    name: 'Windows Codex Smoke',
    output_mode: 'scratch',
  })
  await postJson(`${baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_mode: 'live-editor',
    default_agent_provider_id: 'codex-cli',
    default_agent_type: 'codex',
  })
  const created = await postJson(projectUrl(baseUrl, projectPath, '/chats'), {
    provider_id: null,
    agent_type: 'codex',
    title: null,
    workspace_mode: 'root',
    reuse_empty_draft: false,
  })
  assert(created.provider_id === 'codex-cli', `Expected created chat to use codex-cli: ${JSON.stringify(created)}`)
  assert(created.title !== `Chat ${String(created.thread_id).slice(0, 8)}`, `Unexpected legacy chat title: ${JSON.stringify(created)}`)
  assert(!created.agent_deck_session_id, `Direct chat leaked Agent Deck session id: ${JSON.stringify(created)}`)

  let providerSessionId = null
  if (liveTurn) {
    const complete = await sendLiveEditorTurn({ port, projectPath, threadId: created.thread_id })
    assert(complete.provider_id === 'codex-cli', `Expected complete provider codex-cli: ${JSON.stringify(complete)}`)
    assert(!complete.agent_deck_session_id, `Direct complete leaked Agent Deck id: ${JSON.stringify(complete)}`)
    providerSessionId = complete.provider_session_id
  } else {
    providerSessionId = 'codex-windows-smoke-session'
    await postJson(projectUrl(baseUrl, projectPath, '/sessions'), {
      thread_id: created.thread_id,
      backend: 'codex-cli',
      workspace_path: projectPath,
      provider_id: 'codex-cli',
      provider_session_id: providerSessionId,
      provider_session_title: 'Windows Codex smoke',
      provider_agent_id: 'codex',
      agent_deck_session_id: null,
      agent_deck_session_title: null,
      agent_deck_tool: null,
      editor_state: {
        draftAgentType: 'codex',
        draftProviderId: 'codex-cli',
        draftWorkspaceMode: 'root',
      },
    })
  }
  assert(typeof providerSessionId === 'string' && providerSessionId.trim(), 'Missing provider session id for Open TUI proof.')

  const openTui = await postJson(projectUrl(baseUrl, projectPath, '/chat-items/open-tui'), {
    thread_id: created.thread_id,
    provider_id: 'codex-cli',
    provider_session_id: providerSessionId,
    agent_deck_session_id: null,
  })
  assert(openTui.provider_id === 'codex-cli', `Expected Codex Open TUI payload: ${JSON.stringify(openTui)}`)
  assert(openTui.dry_run === true, `Expected dry-run Open TUI payload: ${JSON.stringify(openTui)}`)
  assert(Array.isArray(openTui.command), `Expected Open TUI command: ${JSON.stringify(openTui)}`)
  assert(openTui.command[0]?.toLowerCase() === 'cmd.exe', `Expected cmd.exe launcher: ${JSON.stringify(openTui.command)}`)
  assert(openTui.command.includes('start'), `Expected Windows start launcher: ${JSON.stringify(openTui.command)}`)
  assert(openTui.command.at(-2) === 'resume', `Expected codex resume command: ${JSON.stringify(openTui.command)}`)
  assert(openTui.command.at(-1) === providerSessionId, `Expected provider session in command: ${JSON.stringify(openTui.command)}`)

  console.log(`[smoke:windows-codex-provider] codex-cli default and Open TUI command proved on ${baseUrl}${liveTurn ? ' with live turn' : ''}`)
} catch (error) {
  console.error(`[smoke:windows-codex-provider] ${error instanceof Error ? error.message : String(error)}`)
  if (error?.stdout) {
    console.error('[smoke:windows-codex-provider] stdout:')
    console.error(error.stdout)
  }
  if (error?.stderr) {
    console.error('[smoke:windows-codex-provider] stderr:')
    console.error(error.stderr)
  }
  console.error(`[smoke:windows-codex-provider] temp root: ${root}`)
  process.exitCode = 1
} finally {
  if (apiProcess) {
    await stopProcessTree(apiProcess)
  }
  if (!isTruthy(process.env.PIXEL_FORGE_KEEP_SMOKE_ARTIFACTS)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
