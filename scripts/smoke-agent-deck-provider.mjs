import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  assert,
  cleanupSmokeContext,
  createSmokeContext,
  fetchJson,
  installPixelForge,
  repoRoot,
  reportSmokeFailure,
  runProcess,
  runPixelForge,
  waitForHttpOk,
} from './lib/smoke-helpers.mjs'

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

function waitForSocketOpen(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out opening Live Editor websocket'))
    }, timeoutMs)
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

async function sendLiveEditorTurn(context, payload) {
  const socket = new WebSocket(`ws://127.0.0.1:${context.port}/ws/live-editor`)
  const events = []
  await waitForSocketOpen(socket)
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for Agent Deck provider Live Editor turn'))
    }, 300000)

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      events.push(message)
      if (message.type === 'error') {
        clearTimeout(timeout)
        socket.close()
        reject(new Error(`Agent Deck provider turn failed: ${message.message || JSON.stringify(message)}`))
        return
      }
      if (message.type === 'complete') {
        clearTimeout(timeout)
        socket.close()
        resolve({ complete: message, events })
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('Live Editor websocket failed during Agent Deck provider turn'))
    }, { once: true })
    socket.send(JSON.stringify(payload))
  })
}

function assertAgentDeckComplete(complete) {
  assert(
    complete.provider_id === 'agent-deck',
    `Expected complete provider_id agent-deck, got ${JSON.stringify(complete)}`,
  )
  assert(
    typeof complete.provider_session_id === 'string' && complete.provider_session_id.trim(),
    `Expected complete provider_session_id, got ${JSON.stringify(complete)}`,
  )
  assert(
    complete.agent_deck_session_id === complete.provider_session_id,
    `Expected Agent Deck compatibility id to mirror provider session: ${JSON.stringify(complete)}`,
  )
}

async function stopSmokeAgentDeckSessions(context, projectPath) {
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
      .filter((session) => session?.path === projectPath && session?.title === 'agent-deck-provider-smoke')
      .map((session) => runProcess(runner, ['session', 'stop', session.id, '-q'], {
        cwd: projectPath,
        env: context.env,
        label: `agent-deck session stop ${session.id}`,
      }).catch(() => {})),
  )
}

const context = await createSmokeContext('agent-deck-provider')
context.env.PIXEL_FORGE_WITH_AGENT_DECK = '1'
let projectPath = null

try {
  projectPath = path.join(context.root, 'workspace')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    '# Pixel Forge Agent Deck provider smoke workspace\n',
    'utf-8',
  )

  await installPixelForge(repoRoot, context)
  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'Agent Deck provider smoke runtime',
  })

  const providersPayload = await fetchJson(`${context.baseUrl}/api/agent-providers`)
  const agentDeck = providersPayload.providers.find((provider) => provider.id === 'agent-deck')
  assert(agentDeck?.enabled === true, `Expected Agent Deck provider enabled: ${JSON.stringify(agentDeck)}`)
  assert(agentDeck?.available === true, `Expected Agent Deck provider available: ${JSON.stringify(agentDeck)}`)

  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_mode: 'live-editor',
    default_agent_provider_id: 'agent-deck',
    default_agent_type: 'codex',
  })

  const created = await postJson(projectUrl(context, projectPath, '/chats'), {
    provider_id: 'agent-deck',
    agent_type: 'codex',
    title: 'agent-deck-provider-smoke',
    workspace_mode: 'root',
    reuse_empty_draft: false,
  })

  const selectionTunnel = {
    selections: [
      {
        id: 'smoke-selection',
        tagName: 'BUTTON',
        text: 'Smoke button',
        role: 'button',
        selector: 'button[data-smoke="agent-deck"]',
        boundingClientRect: {
          x: 12,
          y: 18,
          width: 140,
          height: 40,
        },
      },
    ],
  }

  const { complete } = await sendLiveEditorTurn(context, {
    chat_id: created.thread_id,
    project_path: projectPath,
    provider_id: 'agent-deck',
    agent_type: 'codex',
    agent_thinking: 'minimal',
    target_intent: {
      mode: 'new',
      provider_id: 'agent-deck',
      provider_session_id: null,
      agent_id: 'codex',
      workspace_mode: 'root',
    },
    turn_input: {
      message: 'Pixel Forge Agent Deck provider smoke. Reply with AGENT_DECK_PROVIDER_SMOKE_OK and do not edit files.',
      preview_url: 'http://example.test/agent-deck-smoke',
      selection_tunnel: selectionTunnel,
      attachments: [],
    },
  })

  assertAgentDeckComplete(complete)

  const [sessionsPayload, chatsPayload] = await Promise.all([
    fetchJson(projectUrl(context, projectPath, '/sessions')),
    fetchJson(projectUrl(context, projectPath, '/chats')),
  ])
  const session = sessionsPayload.sessions.find((record) => record.thread_id === created.thread_id)
  const chat = chatsPayload.chats.find((record) => record.thread_id === created.thread_id)
  for (const [label, record] of [['session', session], ['chat', chat]]) {
    assert(record, `Missing ${label} record for ${created.thread_id}`)
    assert(record.provider_id === 'agent-deck', `Expected ${label} provider_id agent-deck: ${JSON.stringify(record)}`)
    assert(
      record.provider_session_id === complete.provider_session_id,
      `Expected ${label} provider session ${complete.provider_session_id}: ${JSON.stringify(record)}`,
    )
    assert(
      record.agent_deck_session_id === complete.provider_session_id,
      `Expected ${label} Agent Deck compatibility id ${complete.provider_session_id}: ${JSON.stringify(record)}`,
    )
  }

  console.log(`[smoke:agent-deck-provider] Agent Deck codex thread ${created.thread_id} completed through ${complete.provider_session_id}`)
} catch (error) {
  await reportSmokeFailure('agent-deck-provider', error, context)
  process.exitCode = 1
} finally {
  if (projectPath) {
    await stopSmokeAgentDeckSessions(context, projectPath)
  }
  await cleanupSmokeContext(context)
}
