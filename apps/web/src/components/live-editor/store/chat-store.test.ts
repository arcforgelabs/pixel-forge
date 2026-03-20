import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type SelectedElement,
  type ThreadChatState,
  useLiveEditorStore,
} from './chat-store'
import { useSessionStore } from '@/store/session-store'

function createSelection(
  id: string,
  overrides: Partial<Omit<SelectedElement, 'timestamp'>> = {}
) {
  return {
    id,
    selectorKind: 'dom' as const,
    surfaceKind: 'dom' as const,
    pageKey: 'https://example.com/',
    tagName: 'div',
    elementId: id,
    classList: ['card'],
    textContent: `Selection ${id}`,
    xpath: `//*[@id="${id}"]`,
    outerHTML: `<div id="${id}">Selection ${id}</div>`,
    rootXPath: null,
    rootTagName: null,
    rootElementId: null,
    rootClassList: [],
    region: null,
    previewDataUrl: null,
    sourceTabId: 'tab-a',
    sourceTabLabel: 'Example',
    sourceUrl: 'https://example.com/',
    pageTitle: 'Example',
    ...overrides,
  }
}

class MockWebSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0

  readyState = MockWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  send = vi.fn()
  close = vi.fn()

  constructor(_url: string) {
    super()
  }
}

function setActiveThreadState(partial: Partial<ThreadChatState>) {
  useLiveEditorStore.setState((state) => {
    const activeThreadState = state.threadStates[state.activeThreadKey]
    const nextThreadState: ThreadChatState = {
      ...activeThreadState,
      ...partial,
    }

    return {
      threadStates: {
        ...state.threadStates,
        [state.activeThreadKey]: nextThreadState,
      },
      messages: nextThreadState.messages,
      isStreaming: nextThreadState.isStreaming,
      currentStreamContent: nextThreadState.currentStreamContent,
      pendingAssistantAttachments: nextThreadState.pendingAssistantAttachments,
      currentTool: nextThreadState.currentTool,
      currentStatusMessage: nextThreadState.currentStatusMessage,
      currentSelectionCount: nextThreadState.currentSelectionCount,
      currentRequestId: nextThreadState.currentRequestId,
      ws: nextThreadState.ws,
      connected: nextThreadState.connected,
      queuedMessages: nextThreadState.queuedMessages,
      selectedElements: nextThreadState.selectedElements,
      selectionUndoStack: nextThreadState.selectionUndoStack,
      selectionRedoStack: nextThreadState.selectionRedoStack,
    }
  })
}

describe('live editor selection history', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
    vi.stubGlobal('fetch', vi.fn())
    delete (globalThis as typeof globalThis & { pixelForgeDesktop?: unknown }).pixelForgeDesktop
    useSessionStore.setState({
      projectPath: '/tmp/example-project',
      projectName: 'example-project',
      previewUrl: 'http://example.localhost:3000',
      sessionId: null,
      liveEditorSession: null,
      activeMode: 'live-editor',
      recentProjects: [],
      projectSessions: [],
      agentDeckTargets: [],
      agentDeckTargetsLoading: false,
      projectsLoaded: true,
      projectsLoading: false,
      outputMode: 'scratch',
      customOutputPath: null,
      lastSavedFile: null,
      controllerVersion: null,
      pendingControllerUpdate: null,
      pendingPreviewUpdate: null,
      dismissedControllerUpdateId: null,
      controllerUpdateApplyState: {
        status: 'idle',
        updateId: null,
        phase: 'idle',
        progress: 0,
        message: '',
        error: null,
      },
      selectedAgentDeckTargetId: null,
      agentType: 'claude',
      settingsSidebarOpen: false,
    })
    useLiveEditorStore.getState().resetForProject()
  })

  it('preserves selection order through replace, undo, and redo', () => {
    const store = useLiveEditorStore.getState()

    store.addElement(createSelection('one'))
    store.addElement(createSelection('two'))
    store.addElement(createSelection('three'))

    store.replaceElement('two', createSelection('two', {
      elementId: 'promoted',
      xpath: '/html/body/main[1]',
      textContent: 'Promoted container',
      outerHTML: '<main id="promoted">Promoted container</main>',
    }))

    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(useLiveEditorStore.getState().selectedElements[1]?.xpath).toBe('/html/body/main[1]')

    store.undoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements[1]?.xpath).toBe('//*[@id="two"]')

    store.redoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements[1]?.xpath).toBe('/html/body/main[1]')
  })

  it('treats bulk remove and clear as single undo steps', () => {
    const store = useLiveEditorStore.getState()

    store.addElement(createSelection('one'))
    store.addElement(createSelection('two'))
    store.addElement(createSelection('three'))
    store.removeElements(['one', 'three'])

    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'two',
    ])

    store.undoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ])

    store.clearElements()
    expect(useLiveEditorStore.getState().selectedElements).toHaveLength(0)

    store.undoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('keeps selections and target session state isolated per thread', () => {
    const store = useLiveEditorStore.getState()
    const firstThreadKey = store.activeThreadKey

    store.setTargetAgentDeckSessionId('deck-session-a')
    store.addElement(createSelection('one'))

    store.newSession('deck-session-b')
    const secondThreadKey = useLiveEditorStore.getState().activeThreadKey
    useLiveEditorStore.getState().addElement(createSelection('two'))

    expect(useLiveEditorStore.getState().getTargetAgentDeckSessionId()).toBe('deck-session-b')
    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'two',
    ])

    useLiveEditorStore.getState().activateThread(firstThreadKey)

    expect(useLiveEditorStore.getState().getTargetAgentDeckSessionId()).toBe('deck-session-a')
    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
    ])

    useLiveEditorStore.getState().activateThread(secondThreadKey)

    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'two',
    ])
  })

  it('includes the selected Agent Deck target in outbound live-edit payloads', () => {
    useSessionStore.setState({
      selectedAgentDeckTargetId: 'deck-session-123',
      agentDeckTargets: [
        {
          id: 'deck-session-123',
          title: 'codex-target',
          path: '/tmp/example-project/.agents/codex-target',
          group: 'pixel-forge',
          tool: 'codex',
          command: 'codex',
          status: 'waiting',
          createdAt: null,
        },
      ],
    })
    useLiveEditorStore.getState().setTargetAgentDeckSessionId('deck-session-123')
    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()
    const send = vi.fn()
    ws!.send = send

    useLiveEditorStore.getState().sendMessage('Retarget this change')

    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      message: 'Retarget this change',
      project_path: '/tmp/example-project',
      preview_url: 'http://example.localhost:3000',
      agent_type: 'codex',
      target_agent_deck_session_id: 'deck-session-123',
    })
  })

  it('uses the bound session tool for outbound live-edit payloads', () => {
    useSessionStore.setState({
      liveEditorSession: {
        threadId: 'thread-1',
        backend: 'agent-deck',
        workspacePath: '/tmp/example-project/.agents/bound-codex',
        agentDeckSessionId: 'deck-session-456',
        agentDeckSessionTitle: 'bound-codex',
        agentDeckTool: 'codex',
        requestId: null,
      },
      selectedAgentDeckTargetId: 'deck-session-456',
      agentDeckTargets: [
        {
          id: 'deck-session-456',
          title: 'bound-codex',
          path: '/tmp/example-project/.agents/bound-codex',
          group: 'pixel-forge',
          tool: 'codex',
          command: 'codex',
          status: 'waiting',
          createdAt: null,
        },
      ],
      agentType: 'claude',
    })
    useLiveEditorStore.getState().activateThread('thread-1')
    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()
    const send = vi.fn()
    ws!.send = send

    useLiveEditorStore.getState().sendMessage('Use the bound session tool')

    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      message: 'Use the bound session tool',
      agent_type: 'codex',
      target_agent_deck_session_id: 'deck-session-456',
    })
  })

  it('matches tool results to the correct running tool by tool call id', () => {
    const now = new Date()

    setActiveThreadState({
      messages: [
        {
          id: 'tool-msg-1',
          role: 'tool',
          content: '',
          timestamp: now,
          toolActivity: {
            id: 'tool-msg-1',
            toolCallId: 'call-1',
            tool: 'Run pwd',
            input: { command: 'pwd' },
            status: 'running',
          },
        },
        {
          id: 'tool-msg-2',
          role: 'tool',
          content: '',
          timestamp: now,
          toolActivity: {
            id: 'tool-msg-2',
            toolCallId: 'call-2',
            tool: 'List .',
            input: { command: 'find . -mindepth 1 -maxdepth 1 | wc -l' },
            status: 'running',
          },
        },
      ],
      currentTool: {
        id: 'tool-msg-2',
        toolCallId: 'call-2',
        tool: 'List .',
        input: { command: 'find . -mindepth 1 -maxdepth 1 | wc -l' },
        status: 'running',
      },
    })

    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()

    ws?.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'tool_result',
          tool_call_id: 'call-1',
          content: '/tmp/example-project',
          is_error: false,
        }),
      })
    )

    const toolMessages = useLiveEditorStore
      .getState()
      .messages.filter((message) => message.role === 'tool')

    expect(toolMessages[0]?.toolActivity).toMatchObject({
      toolCallId: 'call-1',
      status: 'complete',
      result: '/tmp/example-project',
      isError: false,
    })
    expect(toolMessages[1]?.toolActivity).toMatchObject({
      toolCallId: 'call-2',
      status: 'running',
    })
    expect(useLiveEditorStore.getState().currentTool).toMatchObject({
      toolCallId: 'call-2',
      status: 'running',
    })
  })

  it('mirrors selection screenshots into the assistant message for screenshot requests', () => {
    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()
    ws!.send = vi.fn()

    useLiveEditorStore.getState().addElement(createSelection('panel', {
      tagName: 'form',
      classList: ['panel'],
      previewDataUrl: 'data:image/jpeg;base64,AAA=',
    }))

    useLiveEditorStore.getState().sendMessage('Can you share a screenshot of that?')

    ws?.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'chunk',
          content: 'Here is the captured screenshot.',
        }),
      })
    )

    ws?.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'complete',
          request_id: 'request-1',
          selection_count: 1,
          backend: 'agent-deck',
          session_id: 'thread-1',
        }),
      })
    )

    const assistantMessages = useLiveEditorStore
      .getState()
      .messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]?.content).toBe('Here is the captured screenshot.')
    expect(assistantMessages[0]?.attachments).toHaveLength(1)
    expect(assistantMessages[0]?.attachments?.[0]).toMatchObject({
      kind: 'image',
      name: 'selection-01-form-panel.jpg',
      dataUrl: 'data:image/jpeg;base64,AAA=',
    })
  })

  it('stages clone-backed self-edit completions as preview-only updates', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          update: {
            id: 'preview-update-1',
            projectPath: '/tmp/example-project',
            workspacePath: '/tmp/example-project/.agents/clone-a',
            snapshotPath: '/tmp/.pixel-forge/preview-updates/preview-update-1',
            previewUrl: null,
            activeMode: 'live-editor',
            summary: 'Pixel Forge preview from request request-1 is ready to load.',
            source: 'live-editor',
            requestId: 'request-1',
            agentDeckSessionId: 'deck-session-1',
            createdAt: '2026-03-20T00:00:00Z',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    useSessionStore.setState({
      projectPath: '/tmp/example-project',
      activeMode: 'live-editor',
      previewUrl: 'http://example.localhost:3000',
    })

    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()

    ws?.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'complete',
          request_id: 'request-1',
          selection_count: 1,
          backend: 'agent-deck',
          session_id: 'thread-1',
          workspace_path: '/tmp/example-project/.agents/clone-a',
          agent_deck_session_id: 'deck-session-1',
          self_edit_safe_mode: true,
          self_edit_scope: 'preview',
        }),
      })
    )

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(useSessionStore.getState().pendingPreviewUpdate).not.toBeNull()
    })

    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toContain('/api/preview-updates')
    expect(useSessionStore.getState().pendingPreviewUpdate).toMatchObject({
      id: 'preview-update-1',
      workspacePath: '/tmp/example-project/.agents/clone-a',
    })
    expect(useSessionStore.getState().pendingControllerUpdate).toBeNull()

    const systemMessages = useLiveEditorStore
      .getState()
      .messages
      .filter((message) => message.role === 'system')
    const systemMessage = systemMessages[systemMessages.length - 1]

    expect(systemMessage).toMatchObject({
      canLoadPreviewUpdate: true,
    })
    expect(systemMessage?.canApplyControllerUpdate).toBeUndefined()
  })

  it('stages canonical self-edit completions as controller updates', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          update: {
            id: 'controller-update-1',
            projectPath: '/tmp/example-project',
            snapshotPath: '/tmp/.pixel-forge/controller-updates/controller-update-1',
            version: '1.3.1',
            previewUrl: 'http://example.localhost:3000',
            activeMode: 'live-editor',
            summary: 'Pixel Forge update from request request-2 is ready to load.',
            source: 'live-editor',
            requestId: 'request-2',
            commitHash: null,
            createdAt: '2026-03-20T00:00:00Z',
            canRollback: true,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    useSessionStore.setState({
      projectPath: '/tmp/example-project',
      activeMode: 'live-editor',
      previewUrl: 'http://example.localhost:3000',
    })

    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()

    ws?.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'complete',
          request_id: 'request-2',
          selection_count: 1,
          backend: 'agent-deck',
          session_id: 'thread-1',
          workspace_path: '/tmp/example-project',
          self_edit_safe_mode: true,
          self_edit_scope: 'controller',
        }),
      })
    )

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(useSessionStore.getState().pendingControllerUpdate).not.toBeNull()
    })

    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toContain('/api/controller-update')
    expect(useSessionStore.getState().pendingControllerUpdate).toMatchObject({
      id: 'controller-update-1',
      projectPath: '/tmp/example-project',
    })
    expect(useSessionStore.getState().pendingPreviewUpdate).toBeNull()

    const systemMessages = useLiveEditorStore
      .getState()
      .messages
      .filter((message) => message.role === 'system')
    const systemMessage = systemMessages[systemMessages.length - 1]

    expect(systemMessage?.content).toContain('controller update staged')
    expect(systemMessage?.canLoadPreviewUpdate).toBeUndefined()
  })
})
