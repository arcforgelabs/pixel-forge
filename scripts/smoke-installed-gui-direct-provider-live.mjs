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
  runProcess,
  runPixelForge,
  waitForCondition,
  waitForHttpOk,
} from './lib/smoke-helpers.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require(path.join(repoRoot, 'apps/web/node_modules/puppeteer'))

const providerMode = process.env.PIXEL_FORGE_SMOKE_PROVIDER_MODE === 'agent-deck'
  ? 'agent-deck'
  : 'codex-cli'
const smokeName = providerMode === 'agent-deck'
  ? 'installed-gui-agent-deck-provider-live'
  : 'installed-gui-direct-provider-live'
const providerLabel = providerMode === 'agent-deck' ? 'Agent Deck' : 'direct-provider'
const threadTitle = providerMode === 'agent-deck'
  ? 'installed-gui-agent-deck-live-smoke'
  : 'installed-gui-direct-live-smoke'
const expectedFirstToken = providerMode === 'agent-deck'
  ? 'GUI_AGENT_DECK_PROVIDER_LIVE_OK'
  : 'GUI_DIRECT_PROVIDER_LIVE_OK'
const expectedSecondToken = 'GUI_DIRECT_PROVIDER_RELOAD_OK'

function tokenInstruction(token) {
  return `Reply with these underscore-joined words only: ${token.replaceAll('_', ' ')}.`
}

async function findHostGoBinary() {
  if (process.env.PIXEL_FORGE_GO_BIN) {
    try {
      await fs.access(process.env.PIXEL_FORGE_GO_BIN)
      return process.env.PIXEL_FORGE_GO_BIN
    } catch {}
  }
  const home = os.homedir()
  const candidateDirs = []
  try {
    const entries = await fs.readdir(home, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && /^go-\d/.test(entry.name)) {
        candidateDirs.push(path.join(home, entry.name, 'bin', 'go'))
      }
    }
  } catch {}
  candidateDirs.sort().reverse()
  candidateDirs.push(
    path.join(home, 'go', 'bin', 'go'),
    '/usr/local/go/bin/go',
    '/opt/go/bin/go',
    '/snap/bin/go',
  )
  for (const candidate of candidateDirs) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {}
  }
  return null
}

async function configureCodexHome(homeDir, env) {
  const configuredCodexHome = process.env.CODEX_HOME?.trim()
  const sourceCodexHome = configuredCodexHome || path.join(os.homedir(), '.codex')
  try {
    const stat = await fs.stat(sourceCodexHome)
    if (!stat.isDirectory()) {
      return env
    }
  } catch {
    return env
  }

  const targetCodexHome = path.join(homeDir, '.codex')
  try {
    await fs.symlink(sourceCodexHome, targetCodexHome, 'dir')
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error
    }
  }
  return {
    ...env,
    CODEX_HOME: sourceCodexHome,
  }
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

function assertNoAgentDeckBinding(record, label) {
  for (const key of [
    'agent_deck_session_id',
    'agent_deck_session_title',
    'agent_deck_tool',
  ]) {
    assert(
      record?.[key] == null || record[key] === '',
      `${label} leaked ${key}: ${JSON.stringify(record)}`,
    )
  }
}

function assertProviderRecord(record, label, expectedThreadId, expectedProviderSessionId = null) {
  assert(record, `Missing ${label}`)
  assert(record.thread_id === expectedThreadId, `Expected ${label} thread ${expectedThreadId}: ${JSON.stringify(record)}`)
  assert(record.provider_id === providerMode, `Expected ${label} provider_id ${providerMode}: ${JSON.stringify(record)}`)
  assert(record.provider_agent_id === 'codex', `Expected ${label} provider_agent_id codex: ${JSON.stringify(record)}`)
  if (expectedProviderSessionId) {
    assert(
      record.provider_session_id === expectedProviderSessionId,
      `Expected ${label} provider session ${expectedProviderSessionId}: ${JSON.stringify(record)}`,
    )
  }
  if (providerMode === 'agent-deck') {
    assert(
      record.agent_deck_session_id === record.provider_session_id,
      `Expected ${label} Agent Deck compatibility id to mirror provider session: ${JSON.stringify(record)}`,
    )
    assert(
      record.agent_deck_tool === 'codex',
      `Expected ${label} Agent Deck tool codex: ${JSON.stringify(record)}`,
    )
  } else {
    assertNoAgentDeckBinding(record, label)
  }
}

async function fetchThreadRecords(context, projectPath, threadId) {
  const [sessionsPayload, chatsPayload] = await Promise.all([
    fetchJson(projectUrl(context, projectPath, '/sessions')),
    fetchJson(projectUrl(context, projectPath, '/chats')),
  ])
  return {
    session: sessionsPayload.sessions.find((record) => record.thread_id === threadId),
    chat: chatsPayload.chats.find((record) => record.thread_id === threadId),
  }
}

async function waitForBoundProviderRecords(context, projectPath, threadId, label) {
  return await waitForCondition(async () => {
    const records = await fetchThreadRecords(context, projectPath, threadId)
    const sessionProviderSessionId = records.session?.provider_session_id
    const chatProviderSessionId = records.chat?.provider_session_id
    return (
      typeof sessionProviderSessionId === 'string'
      && sessionProviderSessionId.trim()
      && chatProviderSessionId === sessionProviderSessionId
    )
      ? records
      : null
  }, {
    timeoutMs: 300000,
    intervalMs: 1000,
    description: `${label} persisted provider binding`,
  })
}

async function readRequestManifests(projectPath) {
  const requestsRoot = path.join(projectPath, '.pixel-forge', 'requests')
  let entries = []
  try {
    entries = await fs.readdir(requestsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const manifests = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(requestsRoot, entry.name, 'manifest.json')
    try {
      const [manifest, stat] = await Promise.all([
        fs.readFile(manifestPath, 'utf-8').then(JSON.parse),
        fs.stat(manifestPath),
      ])
      manifests.push({
        requestId: entry.name,
        manifestPath,
        manifest,
        mtimeMs: stat.mtimeMs,
      })
    } catch {}
  }
  return manifests.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function waitForNewRequestManifest(projectPath, previousCount) {
  return await waitForCondition(async () => {
    const manifests = await readRequestManifests(projectPath)
    return manifests.length > previousCount ? manifests[0] : null
  }, {
    timeoutMs: 30000,
    intervalMs: 500,
    description: 'new request-pack manifest',
  })
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

async function openInstalledUi(context) {
  const canLaunchShell = (
    !process.env.PIXEL_FORGE_SMOKE_GUI_LIVE_BROWSER_ONLY
    && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  )

  if (!canLaunchShell) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.goto(context.baseUrl, { waitUntil: 'domcontentloaded' })
    return { browser, page, mode: 'headless-browser', shellProcess: null }
  }

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
      PIXEL_FORGE_SHELL_URL: 'data:text/html,<title>Pixel Forge live smoke blank</title>',
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
    await page.goto(context.baseUrl, { waitUntil: 'domcontentloaded' })
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

async function sendPromptAndWait(page, prompt, expectedText) {
  await page.waitForSelector('textarea[placeholder="Type here..."]', { timeout: 45000 })
  const handle = await page.waitForFunction(() => {
    return [...document.querySelectorAll('textarea[placeholder="Type here..."]')]
      .find((textarea) => !textarea.disabled && textarea.offsetParent !== null) ?? null
  }, { timeout: 45000 })
  const textareaHandle = handle.asElement()
  assert(textareaHandle, 'Visible composer textarea not found.')
  await textareaHandle.click()
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type(prompt, { delay: 1 })
  try {
    await page.waitForFunction((expected) => {
      const textarea = [...document.querySelectorAll('textarea[placeholder="Type here..."]')]
        .find((candidate) => !candidate.disabled && candidate.offsetParent !== null)
      const form = textarea?.closest('form')
      const button = form?.querySelector('button[type="submit"]')
      return textarea?.value === expected && button && !button.disabled
    }, { timeout: 15000 }, prompt)
  } catch (error) {
    const composerState = await page.evaluate(() => {
      return [...document.querySelectorAll('textarea[placeholder="Type here..."]')]
        .map((textarea, index) => {
          const form = textarea.closest('form')
          const button = form?.querySelector('button[type="submit"]')
          return {
            index,
            disabled: textarea.disabled,
            visible: textarea.offsetParent !== null,
            valueLength: textarea.value.length,
            valuePreview: textarea.value.slice(0, 80),
            buttonDisabled: button ? button.disabled : null,
            formTextPreview: form?.textContent?.slice(0, 160) ?? null,
          }
        })
    })
    throw new Error(`Composer did not become submittable: ${JSON.stringify(composerState)}`, {
      cause: error,
    })
  }
  const submitButtonHandle = await page.waitForFunction(() => {
    return document.querySelector('button[aria-label="Send message"]:not(:disabled)') ?? null
  }, { timeout: 15000 })
  const submitButton = submitButtonHandle.asElement()
  assert(submitButton, 'Visible enabled submit button not found.')
  await submitButton.click()
  await page.waitForFunction((needle) => {
    return document.body.textContent?.includes(needle)
  }, { timeout: 300000 }, expectedText)
}

function assertProviderManifest(entry, label, threadId) {
  const manifest = entry.manifest
  assert(manifest.thread_id === threadId, `${label} request pack used wrong thread: ${JSON.stringify(manifest)}`)
  assert(manifest.provider_id === providerMode, `${label} request pack provider wrong: ${JSON.stringify(manifest)}`)
  assert(manifest.provider_agent_id === 'codex', `${label} request pack agent wrong: ${JSON.stringify(manifest)}`)
  if (providerMode === 'agent-deck') {
    assert(
      typeof manifest.agent_deck_session_id === 'string' && manifest.agent_deck_session_id.trim(),
      `${label} request pack missing Agent Deck session: ${JSON.stringify(manifest)}`,
    )
    assert(manifest.agent_deck_tool === 'codex', `${label} request pack used non-Codex Agent Deck tool: ${JSON.stringify(manifest)}`)
  } else {
    assert(
      manifest.agent_deck_session_id == null || manifest.agent_deck_session_id === '',
      `${label} request pack leaked Agent Deck session: ${JSON.stringify(manifest)}`,
    )
  }
}

async function stopSmokeAgentDeckSessions(context, projectPath) {
  if (providerMode !== 'agent-deck') {
    return
  }
  const runner = path.join(context.paths.installDir, 'scripts', 'agent-deck.sh')
  try {
    await fs.access(runner)
  } catch {
    return
  }

  let sessions = []
  try {
    const { stdout } = await runProcess(runner, ['ls', '-json'], {
      cwd: projectPath,
      env: context.env,
      label: 'agent-deck ls -json',
    })
    const parsed = JSON.parse(stdout)
    sessions = Array.isArray(parsed) ? parsed : []
  } catch {
    return
  }

  await Promise.all(
    sessions
      .filter((session) => session?.path === projectPath && session?.title === threadTitle)
      .map((session) => runProcess(runner, ['session', 'stop', session.id, '-q'], {
        cwd: projectPath,
        env: context.env,
        label: `agent-deck session stop ${session.id}`,
      }).catch(() => {})),
  )
}

const context = await createSmokeContext(smokeName)
const homeDir = path.join(context.root, 'home')
const hostGoBin = await findHostGoBinary()
context.env = {
  ...context.env,
  HOME: homeDir,
  XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  XDG_CACHE_HOME: path.join(homeDir, '.cache'),
  PIXEL_FORGE_WITH_AGENT_DECK: providerMode === 'agent-deck' ? '1' : '0',
  PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION: '0',
  PIXEL_FORGE_INSTALL_SKIP_SYSTEMD: '1',
  PIXEL_FORGE_INSTALL_CACHE_DIR: path.join(
    os.homedir(),
    '.cache',
    'pixel-forge',
    'install-cache',
    context.env.PIXEL_FORGE_INSTALL_NAME,
  ),
  ...(hostGoBin ? { PIXEL_FORGE_GO_BIN: hostGoBin } : {}),
}

let openedUi = null
let projectPath = null

try {
  projectPath = path.join(context.root, 'workspace')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    `# Pixel Forge installed GUI ${providerLabel} live smoke workspace\n`,
    'utf-8',
  )
  await fs.mkdir(homeDir, { recursive: true })
  context.env = await configureCodexHome(homeDir, context.env)

  await installPixelForge(repoRoot, context)
  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: `installed GUI ${providerLabel} live runtime`,
  })

  const providersPayload = await fetchJson(`${context.baseUrl}/api/agent-providers`)
  const agentDeck = providersPayload.providers.find((provider) => provider.id === 'agent-deck')
  const codexProvider = providersPayload.providers.find((provider) => provider.id === 'codex-cli')
  assert(codexProvider?.available === true, `Expected codex-cli available: ${JSON.stringify(codexProvider)}`)
  if (providerMode === 'agent-deck') {
    assert(agentDeck?.enabled === true, `Expected Agent Deck enabled: ${JSON.stringify(agentDeck)}`)
    assert(agentDeck?.available === true, `Expected Agent Deck available: ${JSON.stringify(agentDeck)}`)
  } else {
    assert(agentDeck?.enabled === false, `Expected Agent Deck disabled: ${JSON.stringify(agentDeck)}`)
  }

  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_mode: 'live-editor',
    default_agent_provider_id: providerMode,
    default_agent_type: 'codex',
  })

  const created = await postJson(projectUrl(context, projectPath, '/chats'), {
    provider_id: providerMode,
    agent_type: 'codex',
    title: threadTitle,
    workspace_mode: 'root',
    reuse_empty_draft: false,
  })

  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_live_editor_thread_id: created.thread_id,
    active_mode: 'live-editor',
    default_agent_provider_id: providerMode,
    default_agent_type: 'codex',
  })

  const initialManifestCount = (await readRequestManifests(projectPath)).length
  openedUi = await openInstalledUi(context)
  await sendPromptAndWait(
    openedUi.page,
    `Pixel Forge installed GUI ${providerLabel} live smoke. ${tokenInstruction(expectedFirstToken)} Do not edit files.`,
    expectedFirstToken,
  )
  if (providerMode !== 'agent-deck') {
    const firstManifest = await waitForNewRequestManifest(projectPath, initialManifestCount)
    assertProviderManifest(firstManifest, `first GUI ${providerLabel} turn`, created.thread_id)
  }

  let records = await waitForBoundProviderRecords(
    context,
    projectPath,
    created.thread_id,
    `first GUI ${providerLabel} turn`,
  )
  assertProviderRecord(records.session, 'first-turn session', created.thread_id)
  assertProviderRecord(records.chat, 'first-turn chat', created.thread_id)
  const providerSessionId = records.session.provider_session_id
  assert(
    typeof providerSessionId === 'string' && providerSessionId.trim(),
    `First GUI ${providerLabel} turn did not bind a provider session: ${JSON.stringify(records.session)}`,
  )
  const bodyAfterFirstTurn = await openedUi.page.evaluate(() => document.body.textContent || '')
  if (providerMode === 'agent-deck') {
    assert(bodyAfterFirstTurn.includes(expectedFirstToken), 'Agent Deck GUI path did not render the Codex response token.')
    console.log(`[smoke:${smokeName}] ${openedUi.mode} sent Agent Deck codex thread ${created.thread_id} through ${providerSessionId}`)
  } else {
    assert(!bodyAfterFirstTurn.includes('Agent Deck'), 'Direct-provider GUI path displayed generic Agent Deck wording.')
    await closeInstalledUi(openedUi)
    openedUi = null

    await runPixelForge(context, ['stop'])
    await runPixelForge(context, ['start'])
    await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
      description: 'restarted installed GUI direct-provider live runtime',
    })

    records = await fetchThreadRecords(context, projectPath, created.thread_id)
    assertProviderRecord(records.session, 'post-restart session', created.thread_id, providerSessionId)
    assertProviderRecord(records.chat, 'post-restart chat', created.thread_id, providerSessionId)
    assert(
      records.session.provider_session_id === providerSessionId,
      `Provider session changed across restart: ${JSON.stringify(records.session)}`,
    )

    const secondStartManifestCount = (await readRequestManifests(projectPath)).length
    openedUi = await openInstalledUi(context)
    await sendPromptAndWait(
      openedUi.page,
      `Second installed GUI direct-provider live smoke after restart. ${tokenInstruction(expectedSecondToken)} Do not edit files.`,
      expectedSecondToken,
    )
    const secondManifest = await waitForNewRequestManifest(projectPath, secondStartManifestCount)
    assertProviderManifest(secondManifest, 'second GUI direct turn', created.thread_id)

    records = await fetchThreadRecords(context, projectPath, created.thread_id)
    assertProviderRecord(records.session, 'second-turn session', created.thread_id, providerSessionId)
    assertProviderRecord(records.chat, 'second-turn chat', created.thread_id, providerSessionId)
    assert(
      records.session.provider_session_id === providerSessionId,
      `Second GUI direct turn did not reuse provider session ${providerSessionId}: ${JSON.stringify(records.session)}`,
    )
    const bodyAfterSecondTurn = await openedUi.page.evaluate(() => document.body.textContent || '')
    assert(!bodyAfterSecondTurn.includes('Agent Deck'), 'Reloaded direct-provider GUI path displayed generic Agent Deck wording.')

    console.log(`[smoke:installed-gui-direct-provider-live] ${openedUi.mode} sent and reloaded codex-cli thread ${created.thread_id} through ${providerSessionId}`)
  }
} catch (error) {
  await reportSmokeFailure(smokeName, error, context)
  process.exitCode = 1
} finally {
  await closeInstalledUi(openedUi)
  if (projectPath) {
    await stopSmokeAgentDeckSessions(context, projectPath)
  }
  await cleanupSmokeContext(context)
}
