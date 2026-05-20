import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assert,
  cleanupSmokeContext,
  createSmokeContext,
  fetchJson,
  installPixelForge,
  repoRoot,
  reportSmokeFailure,
  reservePort,
  runPixelForge,
  waitForCondition,
  waitForHttpOk,
} from './lib/smoke-helpers.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require(path.join(repoRoot, 'apps/web/node_modules/puppeteer'))
const uiWaitTimeoutMs = Number.parseInt(
  process.env.PIXEL_FORGE_SMOKE_UI_WAIT_MS || '45000',
  10,
)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function projectUrl(context, projectPath, suffix) {
  return `${context.baseUrl}/api/projects/${encodeURIComponent(projectPath)}${suffix}`
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

async function createDraftChat(context, projectPath, options) {
  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_mode: 'live-editor',
    default_agent_provider_id: options.providerId,
    default_agent_type: options.agentType,
  })

  const chat = await postJson(projectUrl(context, projectPath, '/chats'), {
    provider_id: options.providerId,
    agent_type: options.agentType,
    title: options.title,
    workspace_mode: 'root',
    reuse_empty_draft: false,
  })

  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_live_editor_thread_id: chat.thread_id,
    active_mode: 'live-editor',
    default_agent_provider_id: options.providerId,
    default_agent_type: options.agentType,
  })

  chat.title = chat.title || options.title
  return chat
}

function installWebSocketCapture() {
  const sockets = []
  const payloads = []
  const emitted = []

  class SmokeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    CONNECTING = 0
    OPEN = 1
    CLOSING = 2
    CLOSED = 3

    constructor(url) {
      super()
      this.url = String(url)
      this.readyState = SmokeWebSocket.CONNECTING
      this.binaryType = 'blob'
      this.protocol = ''
      this.extensions = ''
      this.bufferedAmount = 0
      sockets.push(this)
      setTimeout(() => {
        if (this.readyState !== SmokeWebSocket.CONNECTING) return
        this.readyState = SmokeWebSocket.OPEN
        const event = new Event('open')
        this.onopen?.(event)
        this.dispatchEvent(event)
      }, 0)
    }

    send(data) {
      const parsed = JSON.parse(String(data))
      payloads.push(parsed)
      const targetIntent = parsed.target_intent && typeof parsed.target_intent === 'object'
        ? parsed.target_intent
        : {}
      const providerId = String(
        targetIntent.provider_id
        || parsed.target_provider_id
        || parsed.provider_id
        || 'unknown'
      )
      const agentId = String(targetIntent.agent_id || parsed.agent_type || 'codex')
      const threadId = String(parsed.chat_id || parsed.thread_id || `smoke-${payloads.length}`)
      const providerSessionId = providerId === 'agent-deck'
        ? `agent-deck-ui-smoke-${payloads.length}`
        : `${providerId}-ui-smoke-${payloads.length}`
      const base = {
        session_id: threadId,
        backend: providerId,
        provider_id: providerId,
        provider_session_id: providerSessionId,
        provider_session_title: `${providerId} UI smoke`,
        provider_agent_id: agentId,
        workspace_path: parsed.project_path || null,
        request_id: `ui-smoke-${payloads.length}`,
      }
      if (providerId === 'agent-deck') {
        base.agent_deck_session_id = providerSessionId
        base.agent_deck_session_title = base.provider_session_title
        base.agent_deck_tool = agentId
      } else {
        base.agent_deck_session_id = null
        base.agent_deck_session_title = null
        base.agent_deck_tool = null
      }

      this.emitMessage({ type: 'session', ...base })
      this.emitMessage({ type: 'chunk', content: `UI provider matrix smoke ${providerId}` })
      this.emitMessage({ type: 'complete', content: `complete ${providerId}`, ...base })
    }

    close() {
      if (this.readyState === SmokeWebSocket.CLOSED) return
      this.readyState = SmokeWebSocket.CLOSED
      const event = new CloseEvent('close')
      this.onclose?.(event)
      this.dispatchEvent(event)
    }

    emitMessage(payload) {
      emitted.push(payload)
      setTimeout(() => {
        if (this.readyState !== SmokeWebSocket.OPEN) return
        const event = new MessageEvent('message', {
          data: JSON.stringify(payload),
        })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }, 0)
    }
  }

  window.__pixelForgeSmoke = {
    sockets,
    payloads,
    emitted,
    reset() {
      payloads.length = 0
      emitted.length = 0
    },
  }
  window.WebSocket = SmokeWebSocket
}

async function findShellPage(browser, baseUrl) {
  return await waitForCondition(async () => {
    const pages = await browser.pages()
    return pages.find((page) => page.url().startsWith(baseUrl))
      ?? pages.find((page) => !page.url().startsWith('devtools://'))
      ?? null
  }, {
    timeoutMs: 30000,
    intervalMs: 500,
    description: 'installed shell page',
  })
}

async function writeDesktopBootstrapState(context, active) {
  if (!active?.projectPath) {
    return
  }
  await fs.mkdir(context.paths.stateDir, { recursive: true })
  await fs.writeFile(
    path.join(context.paths.stateDir, 'controller-bootstrap-state.json'),
    `${JSON.stringify({
      projectPath: active.projectPath,
      activeMode: 'live-editor',
    })}\n`,
    'utf-8',
  )
}

async function openInstalledUi(context, active = null) {
  const canLaunchShell = (
    !process.env.PIXEL_FORGE_SMOKE_GUI_MATRIX_BROWSER_ONLY
    && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  )

  if (!canLaunchShell) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    return { browser, page, mode: 'headless-browser', shellProcess: null }
  }

  await writeDesktopBootstrapState(context, active)
  const cdpPort = await reservePort()
  const electronBin = path.join(
    context.paths.installDir,
    'desktop',
    'node_modules',
    'electron',
    'dist',
    'electron',
  )
  const desktopApp = path.join(context.paths.installDir, 'desktop')
  const shellProcess = spawn(electronBin, [
    '--no-sandbox',
    `--class=${context.env.PIXEL_FORGE_INSTALL_NAME}-desktop`,
    desktopApp,
  ], {
    cwd: repoRoot,
    env: {
      ...context.env,
      PIXEL_FORGE_SHELL_URL: 'data:text/html,<title>Pixel Forge smoke blank</title>',
      PIXEL_FORGE_CONTROLLER_CDP_HOST: '127.0.0.1',
      PIXEL_FORGE_CONTROLLER_CDP_PORT: String(cdpPort),
    },
    stdio: 'ignore',
  })

  try {
    await waitForHttpOk(`http://127.0.0.1:${cdpPort}/json/version`, {
      timeoutMs: 45000,
      description: 'installed shell CDP endpoint',
    })
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
      defaultViewport: null,
    })
    const page = await findShellPage(browser, context.baseUrl)
    return { browser, page, mode: 'installed-shell', shellProcess }
  } catch (error) {
    shellProcess.kill('SIGTERM')
    throw error
  }
}

async function closeInstalledUi(opened) {
  if (!opened) return
  if (opened.browser) {
    try {
      await opened.browser.close()
    } catch {}
  }
  if (opened.shellProcess && opened.shellProcess.exitCode === null) {
    opened.shellProcess.kill('SIGTERM')
  }
}

async function activateChat(context, active) {
  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: active.projectPath,
    active_live_editor_thread_id: active.threadId,
    active_mode: 'live-editor',
    default_agent_provider_id: active.providerId,
    default_agent_type: active.agentType,
  })
}

async function findElementByText(page, options) {
  let handle = null
  try {
    handle = await page.waitForFunction(({ selector, exact, includes, title }) => {
      const normalizedExact = typeof exact === 'string' ? exact.trim() : null
      const normalizedIncludes = typeof includes === 'string' ? includes.trim() : null
      return [...document.querySelectorAll(selector)]
        .find((element) => {
          const text = element.textContent?.trim() || ''
          const elementTitle = element.getAttribute('title')?.trim() || ''
          if (title && elementTitle === title) {
            return true
          }
          if (normalizedExact && text === normalizedExact) {
            return true
          }
          return Boolean(normalizedIncludes && text.includes(normalizedIncludes))
        }) ?? null
    }, { timeout: uiWaitTimeoutMs }, options)
  } catch (error) {
    const candidates = await page.evaluate((selector) => {
      return [...document.querySelectorAll(selector)]
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          title: element.getAttribute('title') || '',
          aria: element.getAttribute('aria-label') || '',
          disabled: Boolean(element.disabled),
        }))
        .filter((entry) => entry.text || entry.title || entry.aria)
        .slice(0, 80)
    }, options.selector)
    throw new Error(
      `Timed out waiting for ${JSON.stringify(options)}. Candidates: ${JSON.stringify(candidates)}. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const element = handle.asElement()
  assert(element, `Could not find element matching ${JSON.stringify(options)}`)
  return element
}

async function clickElement(element) {
  await element.evaluate((target) => {
    target.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }))
  })
}

async function waitForComposer(page, label) {
  try {
    await page.waitForSelector('textarea[placeholder="Type here..."]', { timeout: uiWaitTimeoutMs })
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '')
    throw new Error(`Timed out waiting for composer after ${label}. Body: ${bodyText}. Cause: ${
      error instanceof Error ? error.message : String(error)
    }`)
  }
}

async function openProjectFromSidebar(page, projectPath) {
  const projectName = path.basename(projectPath)
  const projectVisible = await page.evaluate((targetPath) => {
    return [...document.querySelectorAll('button')]
      .some((button) => button.getAttribute('title') === targetPath)
  }, projectPath)
  if (!projectVisible) {
    await clickButtonByText(page, 'Projects')
  }
  const projectButton = await findElementByText(page, {
    selector: 'button',
    title: projectPath,
    exact: projectName,
  })
  await clickElement(projectButton)
}

async function expandProjectChats(page, projectPath) {
  const expanded = await page.evaluate((targetPath) => {
    const projectButton = [...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('title') === targetPath)
    const row = projectButton?.closest('.group\\/project-row')
    const expandButton = row
      ? [...row.querySelectorAll('button')].find((button) => {
          const label = button.getAttribute('aria-label') || ''
          const title = button.getAttribute('title') || ''
          return label.startsWith('Expand ') || title === 'Expand chats'
        })
      : null
    if (!expandButton) {
      return false
    }
    expandButton.click()
    return true
  }, projectPath)
  if (expanded) {
    await sleep(250)
  }
}

async function selectChatFromSidebar(page, active) {
  const chatButton = await findElementByText(page, {
    selector: 'button',
    title: active.title,
    exact: active.title,
  })
  await clickElement(chatButton)
}

async function openActiveChat(page, active) {
  await openProjectFromSidebar(page, active.projectPath)
  await waitForComposer(page, `opening project ${active.projectPath}`)
  await expandProjectChats(page, active.projectPath)
  await selectChatFromSidebar(page, active)
  await waitForComposer(page, `selecting chat ${active.title}`)
}

async function preparePage(page, context, active) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(`[smoke:installed-gui-provider-matrix:console] ${message.text()}`)
    }
  })
  await page.evaluateOnNewDocument(installWebSocketCapture)
  await page.goto(context.baseUrl, { waitUntil: 'domcontentloaded' })
  await activateChat(context, active)
  await page.goto(context.baseUrl, { waitUntil: 'domcontentloaded' })
  await openActiveChat(page, active)
  await page.evaluate(() => window.__pixelForgeSmoke.reset())
}

async function buttonDisabled(page, selector) {
  return await page.$eval(selector, (element) => Boolean(element.disabled))
}

async function waitForAgent(page, label) {
  await page.waitForFunction((expected) => {
    const button = document.querySelector('button[aria-label^="Agent:"]')
    return button?.getAttribute('aria-label') === `Agent: ${expected}`
  }, { timeout: uiWaitTimeoutMs }, label)
}

async function clickButtonByText(page, text) {
  const handle = await page.waitForFunction((expected) => {
    return [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === expected) ?? null
  }, { timeout: uiWaitTimeoutMs }, text)
  const element = handle.asElement()
  assert(element, `Could not find button with text ${text}`)
  await clickElement(element)
}

async function switchAgent(page, label) {
  const agentButton = await page.$('button[aria-label^="Agent:"]')
  assert(agentButton, 'Could not find agent selector button')
  await clickElement(agentButton)
  await clickButtonByText(page, label)
  await waitForAgent(page, label)
}

async function sendPrompt(page, prompt) {
  await page.focus('textarea[placeholder="Type here..."]')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type(prompt)
  await page.waitForFunction(() => {
    const button = document.querySelector('button[type="submit"]')
    return button && !button.disabled
  }, { timeout: uiWaitTimeoutMs })
  const submitButton = await page.$('button[type="submit"]')
  assert(submitButton, 'Could not find submit button')
  await clickElement(submitButton)
  return await page.waitForFunction(() => {
    const smoke = window.__pixelForgeSmoke
    return smoke?.payloads?.length ? smoke.payloads[smoke.payloads.length - 1] : null
  }, { timeout: uiWaitTimeoutMs })
}

async function assertFreshDirectCodexRoute(page, chat) {
  await page.evaluate(() => window.__pixelForgeSmoke.reset())

  const agentSelector = 'button[aria-label^="Agent:"]'
  assert(
    !await buttonDisabled(page, agentSelector),
    'Fresh direct-provider chat locked the agent selector before first provider bind.',
  )

  await waitForAgent(page, 'Codex')
  await switchAgent(page, 'Claude Code')
  await switchAgent(page, 'Codex')

  const payloadHandle = await sendPrompt(page, 'UI provider matrix direct codex smoke')
  const payload = await payloadHandle.jsonValue()
  assert(payload.chat_id === chat.thread_id, `Direct payload used wrong chat id: ${JSON.stringify(payload)}`)
  assert(payload.provider_id === 'codex-cli', `Direct payload provider leaked: ${JSON.stringify(payload)}`)
  assert(payload.agent_type === 'codex', `Direct payload agent type wrong: ${JSON.stringify(payload)}`)
  assert(payload.target_intent?.mode === 'new', `Direct payload was not a fresh lane: ${JSON.stringify(payload)}`)
  assert(
    payload.target_intent?.provider_id === 'codex-cli',
    `Direct payload target provider wrong: ${JSON.stringify(payload)}`,
  )
  assert(
    !('target_agent_deck_session_id' in payload),
    `Direct payload carried Agent Deck compatibility metadata: ${JSON.stringify(payload)}`,
  )
}

async function assertFreshAgentDeckRoute(page, context, projectPath, chat) {
  await page.evaluate(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  await page.goto(context.baseUrl, { waitUntil: 'domcontentloaded' })
  await activateChat(context, {
    projectPath,
    threadId: chat.thread_id,
    providerId: 'agent-deck',
    agentType: 'codex',
    title: chat.title,
  })
  await page.goto(context.baseUrl, { waitUntil: 'domcontentloaded' })
  await openActiveChat(page, {
    projectPath,
    threadId: chat.thread_id,
    providerId: 'agent-deck',
    agentType: 'codex',
    title: chat.title,
  })
  await page.evaluate(() => window.__pixelForgeSmoke.reset())
  await waitForAgent(page, 'Codex')

  const payloadHandle = await sendPrompt(page, 'UI provider matrix Agent Deck codex smoke')
  const payload = await payloadHandle.jsonValue()
  assert(payload.chat_id === chat.thread_id, `Agent Deck payload used wrong chat id: ${JSON.stringify(payload)}`)
  assert(payload.provider_id === 'agent-deck', `Agent Deck payload provider wrong: ${JSON.stringify(payload)}`)
  assert(payload.agent_type === 'codex', `Agent Deck payload agent type wrong: ${JSON.stringify(payload)}`)
  assert(payload.target_intent?.mode === 'new', `Agent Deck payload was not a fresh lane: ${JSON.stringify(payload)}`)
  assert(
    payload.target_intent?.provider_id === 'agent-deck',
    `Agent Deck target provider wrong: ${JSON.stringify(payload)}`,
  )
  assert(
    !('target_agent_deck_session_id' in payload),
    `Fresh Agent Deck payload should not target a stale compatibility id: ${JSON.stringify(payload)}`,
  )
}

const context = await createSmokeContext('installed-gui-provider-matrix')
const homeDir = path.join(context.root, 'home')
context.env = {
  ...context.env,
  HOME: homeDir,
  PATH: [
    path.join(os.homedir(), 'go-1.24', 'bin'),
    context.env.PATH,
  ].filter(Boolean).join(path.delimiter),
  XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  XDG_CACHE_HOME: path.join(homeDir, '.cache'),
  PIXEL_FORGE_WITH_AGENT_DECK: '1',
  PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION: '0',
  PIXEL_FORGE_INSTALL_SKIP_SYSTEMD: '1',
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  PUPPETEER_SKIP_CHROME_DOWNLOAD: 'true',
  PIXEL_FORGE_INSTALL_CACHE_DIR: path.join(
    os.homedir(),
    '.cache',
    'pixel-forge',
    'install-cache',
    context.env.PIXEL_FORGE_INSTALL_NAME,
  ),
}

let openedUi = null
let projectPath = null

try {
  projectPath = path.join(context.root, 'workspace')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    '# Pixel Forge installed UI provider matrix smoke workspace\n',
    'utf-8',
  )
  await fs.mkdir(homeDir, { recursive: true })

  await installPixelForge(repoRoot, context)
  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'installed UI provider matrix runtime',
  })

  const providersPayload = await fetchJson(`${context.baseUrl}/api/agent-providers`)
  const providerIds = providersPayload.providers.map((provider) => provider.id)
  assert(providerIds.includes('agent-deck'), `Missing Agent Deck provider: ${JSON.stringify(providerIds)}`)
  assert(providerIds.includes('codex-cli'), `Missing Codex CLI provider: ${JSON.stringify(providerIds)}`)

  const directChat = await createDraftChat(context, projectPath, {
    providerId: 'codex-cli',
    agentType: 'codex',
    title: 'installed-ui-direct-codex-smoke',
  })

  const directActive = {
    projectPath,
    threadId: directChat.thread_id,
    providerId: 'codex-cli',
    agentType: 'codex',
    title: directChat.title,
  }
  openedUi = await openInstalledUi(context, directActive)
  await preparePage(openedUi.page, context, directActive)
  await assertFreshDirectCodexRoute(openedUi.page, directChat)
  const firstUiMode = openedUi.mode
  await closeInstalledUi(openedUi)
  openedUi = null

  const agentDeckChat = await createDraftChat(context, projectPath, {
    providerId: 'agent-deck',
    agentType: 'codex',
    title: 'installed-ui-agent-deck-smoke',
  })
  const agentDeckActive = {
    projectPath,
    threadId: agentDeckChat.thread_id,
    providerId: 'agent-deck',
    agentType: 'codex',
    title: agentDeckChat.title,
  }
  openedUi = await openInstalledUi(context, agentDeckActive)
  await preparePage(openedUi.page, context, agentDeckActive)
  await assertFreshAgentDeckRoute(openedUi.page, context, projectPath, agentDeckChat)

  console.log(`[smoke:installed-gui-provider-matrix] ${firstUiMode}/${openedUi.mode} routed fresh codex-cli and Agent Deck chats without stale Agent Deck target metadata`)
} catch (error) {
  await reportSmokeFailure('installed-gui-provider-matrix', error, context)
  process.exitCode = 1
} finally {
  await closeInstalledUi(openedUi)
  await cleanupSmokeContext(context)
}
