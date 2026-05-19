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
  runPixelForge,
  waitForHttpOk,
} from './lib/smoke-helpers.mjs'

function isTruthy(value) {
  return typeof value === 'string'
    && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
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
      record[key] == null || record[key] === '',
      `${label} leaked ${key}: ${JSON.stringify(record)}`,
    )
  }
}

function assertDirectProviderRecord(record, label, expectedThreadId) {
  assert(record, `Missing ${label}`)
  assert(
    record.thread_id === expectedThreadId,
    `Expected ${label} thread ${expectedThreadId}, got ${record.thread_id}`,
  )
  assert(
    record.provider_id === 'codex-cli',
    `Expected ${label} provider_id codex-cli, got ${record.provider_id}`,
  )
  assert(
    record.provider_agent_id === 'codex',
    `Expected ${label} provider_agent_id codex, got ${record.provider_agent_id}`,
  )
  assertNoAgentDeckBinding(record, label)
}

async function fetchThreadRecords(context, projectPath, threadId) {
  const [sessionsPayload, chatsPayload] = await Promise.all([
    fetchJson(projectUrl(context, projectPath, '/sessions')),
    fetchJson(projectUrl(context, projectPath, '/chats')),
  ])
  const session = sessionsPayload.sessions.find((record) => record.thread_id === threadId)
  const chat = chatsPayload.chats.find((record) => record.thread_id === threadId)
  return { session, chat }
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

async function sendLiveEditorTurn(context, payload, description) {
  const socket = new WebSocket(`ws://127.0.0.1:${context.port}/ws/live-editor`)
  const events = []
  await waitForSocketOpen(socket)
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error(`Timed out waiting for ${description}`))
    }, 240000)

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      events.push(message)
      if (message.type === 'error') {
        clearTimeout(timeout)
        socket.close()
        reject(new Error(`${description} failed: ${message.message || JSON.stringify(message)}`))
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
      reject(new Error(`Live Editor websocket failed during ${description}`))
    }, { once: true })
    socket.send(JSON.stringify(payload))
  })
}

const runLiveTurns = isTruthy(process.env.PIXEL_FORGE_SMOKE_DIRECT_TURN)
const context = await createSmokeContext('direct-provider')
context.env.PIXEL_FORGE_WITH_AGENT_DECK = '0'

try {
  const projectPath = path.join(context.root, 'workspace')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    '# Pixel Forge direct-provider smoke workspace\n',
    'utf-8',
  )

  await installPixelForge(repoRoot, context)
  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'direct-provider smoke runtime',
  })

  const providersPayload = await fetchJson(`${context.baseUrl}/api/agent-providers`)
  const agentDeck = providersPayload.providers.find((provider) => provider.id === 'agent-deck')
  const codexProvider = providersPayload.providers.find((provider) => provider.id === 'codex-cli')
  assert(agentDeck?.enabled === false, 'Expected Agent Deck provider to be disabled in this smoke')
  assert(codexProvider?.available === true, `Expected codex-cli to be available: ${JSON.stringify(codexProvider)}`)

  await postJson(`${context.baseUrl}/api/profile-state`, {
    active_project_path: projectPath,
    active_mode: 'live-editor',
    default_agent_provider_id: 'codex-cli',
    default_agent_type: 'codex',
  })

  const created = await postJson(projectUrl(context, projectPath, '/chats'), {
    provider_id: 'codex-cli',
    agent_type: 'codex',
    title: 'direct-provider-reload-smoke',
    workspace_mode: 'root',
    reuse_empty_draft: false,
  })
  assertDirectProviderRecord(created, 'created draft chat', created.thread_id)
  assert(
    created.provider_session_id == null,
    `Expected fresh draft to have no provider session yet: ${JSON.stringify(created)}`,
  )

  let providerSessionId = 'codex-smoke-persisted-session'
  if (runLiveTurns) {
    const firstTurn = await sendLiveEditorTurn(context, {
      chat_id: created.thread_id,
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
        message: 'Pixel Forge direct provider smoke. Reply with DIRECT_PROVIDER_RELOAD_SMOKE_OK and do not edit files.',
        preview_url: '',
        selection_tunnel: { selections: [] },
        attachments: [],
      },
    }, 'first direct-provider turn')
    providerSessionId = firstTurn.complete.provider_session_id
    assert(
      typeof providerSessionId === 'string' && providerSessionId.trim(),
      `First turn did not return provider_session_id: ${JSON.stringify(firstTurn.complete)}`,
    )
    assertNoAgentDeckBinding(firstTurn.complete, 'first direct-provider complete event')
  } else {
    await postJson(projectUrl(context, projectPath, '/sessions'), {
      thread_id: created.thread_id,
      backend: 'codex-cli',
      workspace_path: projectPath,
      provider_id: 'codex-cli',
      provider_session_id: providerSessionId,
      provider_session_title: 'codex:smoke',
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

  let records = await fetchThreadRecords(context, projectPath, created.thread_id)
  assertDirectProviderRecord(records.session, 'pre-restart session', created.thread_id)
  assertDirectProviderRecord(records.chat, 'pre-restart chat', created.thread_id)
  assert(
    records.session.provider_session_id === providerSessionId,
    `Expected pre-restart provider session ${providerSessionId}, got ${records.session.provider_session_id}`,
  )

  await runPixelForge(context, ['stop'])
  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'restarted direct-provider smoke runtime',
  })

  records = await fetchThreadRecords(context, projectPath, created.thread_id)
  assertDirectProviderRecord(records.session, 'post-restart session', created.thread_id)
  assertDirectProviderRecord(records.chat, 'post-restart chat', created.thread_id)
  assert(
    records.session.provider_session_id === providerSessionId,
    `Expected post-restart provider session ${providerSessionId}, got ${records.session.provider_session_id}`,
  )

  if (runLiveTurns) {
    const secondTurn = await sendLiveEditorTurn(context, {
      chat_id: created.thread_id,
      project_path: projectPath,
      provider_id: 'codex-cli',
      agent_type: 'codex',
      agent_thinking: 'minimal',
      target_intent: {
        mode: 'bound',
        provider_id: 'codex-cli',
        provider_session_id: providerSessionId,
        agent_id: 'codex',
        workspace_mode: null,
      },
      turn_input: {
        message: 'Second Pixel Forge direct provider smoke after restart. Reply with DIRECT_PROVIDER_RELOAD_SMOKE_REUSED_OK and do not edit files.',
        preview_url: '',
        selection_tunnel: { selections: [] },
        attachments: [],
      },
    }, 'second direct-provider turn after restart')
    assert(
      secondTurn.complete.provider_id === 'codex-cli',
      `Expected second turn provider codex-cli: ${JSON.stringify(secondTurn.complete)}`,
    )
    assertNoAgentDeckBinding(secondTurn.complete, 'second direct-provider complete event')
  }

  console.log(
    `[smoke:direct-provider] codex-cli thread ${created.thread_id} persisted and reloaded without Agent Deck metadata`
    + (runLiveTurns ? ' after two live turns' : ' (metadata mode)'),
  )
} catch (error) {
  await reportSmokeFailure('direct-provider', error, context)
  process.exitCode = 1
} finally {
  await cleanupSmokeContext(context)
}
