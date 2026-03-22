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

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []

  url: string
  withCredentials: boolean
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()

  constructor(url: string | URL, init?: EventSourceInit) {
    super()
    this.url = String(url)
    this.withCredentials = Boolean(init?.withCredentials)
    MockEventSource.instances.push(this)
  }

  emitEvent(eventType: string, payload: unknown) {
    const event = new MessageEvent(eventType, {
      data: JSON.stringify(payload),
    })
    if (eventType === 'message') {
      this.onmessage?.(event)
    }
    this.dispatchEvent(event)
  }
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
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
      targetAgentDeckSessionId: nextThreadState.targetAgentDeckSessionId,
      draftAgentType: nextThreadState.draftAgentType,
      selectedElements: nextThreadState.selectedElements,
      selectionUndoStack: nextThreadState.selectionUndoStack,
      selectionRedoStack: nextThreadState.selectionRedoStack,
      activePreviewTool: nextThreadState.activePreviewTool,
      targetUrl: nextThreadState.targetUrl,
      activeTab: nextThreadState.activeTab,
      viewportMode: nextThreadState.viewportMode,
      authIssue: nextThreadState.authIssue,
      showUrlHistory: nextThreadState.showUrlHistory,
      previewTabs: nextThreadState.previewTabs,
      activePreviewTabId: nextThreadState.activePreviewTabId,
      urlHistory: nextThreadState.urlHistory,
      urlHistoryCursor: nextThreadState.urlHistoryCursor,
    }
  })
}

describe('live editor selection history', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/profile-state')) {
          return jsonResponse({
            profile_id: 'default',
            active_project_path: '/tmp/example-project',
            active_mode: 'live-editor',
            active_live_editor_thread_id: 'thread-a',
            default_agent_type: 'claude',
            updated_at: '2026-03-20T00:00:00Z',
          })
        }
        return jsonResponse({})
      })
    )
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
      defaultAgentType: 'claude',
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

  it('keeps live editor preview state isolated per thread', () => {
    const store = useLiveEditorStore.getState()
    const firstThreadKey = store.activeThreadKey

    store.setTargetUrl('http://thread-one.localhost:3000')
    store.setViewportMode('desktop')
    store.setActiveTab('elements')
    store.setPreviewTabs([
      {
        id: 'tab-one',
        url: 'http://thread-one.localhost:3000',
        title: 'Thread One',
        mode: 'browser',
        proxySessionId: null,
        browserTabId: 'browser-tab-one',
        frameSrc: 'about:blank',
        snapshotDataUrl: null,
        localTarget: null,
      },
    ])
    store.setActivePreviewTabId('tab-one')
    store.setUrlHistory(['http://thread-one.localhost:3000'])
    store.setUrlHistoryCursor(0)

    store.newSession('deck-session-b')
    const secondThreadKey = useLiveEditorStore.getState().activeThreadKey
    useLiveEditorStore.getState().setTargetUrl('http://thread-two.localhost:3001')
    useLiveEditorStore.getState().setViewportMode('phone')
    useLiveEditorStore.getState().setActiveTab('chat')
    useLiveEditorStore.getState().setPreviewTabs([
      {
        id: 'tab-two',
        url: 'http://thread-two.localhost:3001',
        title: 'Thread Two',
        mode: 'browser',
        proxySessionId: null,
        browserTabId: 'browser-tab-two',
        frameSrc: 'about:blank',
        snapshotDataUrl: null,
        localTarget: null,
      },
    ])
    useLiveEditorStore.getState().setActivePreviewTabId('tab-two')
    useLiveEditorStore.getState().setUrlHistory(['http://thread-two.localhost:3001'])
    useLiveEditorStore.getState().setUrlHistoryCursor(0)

    useLiveEditorStore.getState().activateThread(firstThreadKey)
    expect(useLiveEditorStore.getState().targetUrl).toBe('http://thread-one.localhost:3000')
    expect(useLiveEditorStore.getState().viewportMode).toBe('desktop')
    expect(useLiveEditorStore.getState().activeTab).toBe('elements')
    expect(useLiveEditorStore.getState().activePreviewTabId).toBe('tab-one')
    expect(useLiveEditorStore.getState().previewTabs[0]?.browserTabId).toBe('browser-tab-one')

    useLiveEditorStore.getState().activateThread(secondThreadKey)
    expect(useLiveEditorStore.getState().targetUrl).toBe('http://thread-two.localhost:3001')
    expect(useLiveEditorStore.getState().viewportMode).toBe('phone')
    expect(useLiveEditorStore.getState().activeTab).toBe('chat')
    expect(useLiveEditorStore.getState().activePreviewTabId).toBe('tab-two')
    expect(useLiveEditorStore.getState().previewTabs[0]?.browserTabId).toBe('browser-tab-two')
  })

  it('hydrates persisted preview state from the shared session store', () => {
    useSessionStore.setState({
      projectSessions: [
        {
          id: 1,
          projectPath: '/tmp/example-project',
          workspacePath: '/tmp/example-project/.agents/thread-a',
          threadId: 'thread-a',
          backend: 'agent-deck',
          agentDeckSessionId: 'deck-session-a',
          agentDeckSessionTitle: 'pixel-forge-thread-a',
          agentDeckTool: 'codex',
          editorState: {
            activePreviewTool: null,
            targetUrl: 'https://claude.ai/new',
            activeTab: 'elements',
            viewportMode: 'desktop',
            showUrlHistory: false,
            previewTabs: [
              {
                id: 'tab-a',
                url: 'https://claude.ai/new',
                title: 'Claude',
                mode: 'browser',
                localTarget: null,
              },
            ],
            activePreviewTabId: 'tab-a',
            urlHistory: ['https://claude.ai/new'],
            urlHistoryCursor: 0,
          },
          createdAt: '2026-03-20T00:00:00Z',
          lastActive: '2026-03-20T00:00:00Z',
          requestId: null,
        },
      ],
      liveEditorSession: {
        threadId: 'thread-a',
        backend: 'agent-deck',
        workspacePath: '/tmp/example-project/.agents/thread-a',
        agentDeckSessionId: 'deck-session-a',
        agentDeckSessionTitle: 'pixel-forge-thread-a',
        agentDeckTool: 'codex',
        requestId: null,
      },
    })

    useLiveEditorStore.getState().hydrateProjectThreads({
      projectSessions: useSessionStore.getState().projectSessions,
      activeThreadKey: 'thread-a',
      previewUrl: null,
    })

    expect(useLiveEditorStore.getState().activeThreadKey).toBe('thread-a')
    expect(useLiveEditorStore.getState().targetUrl).toBe('https://claude.ai/new')
    expect(useLiveEditorStore.getState().activeTab).toBe('elements')
    expect(useLiveEditorStore.getState().viewportMode).toBe('desktop')
    expect(useLiveEditorStore.getState().activePreviewTabId).toBe('tab-a')
    expect(useLiveEditorStore.getState().previewTabs[0]).toMatchObject({
      id: 'tab-a',
      url: 'https://claude.ai/new',
      title: 'Claude',
      mode: 'browser',
      browserTabId: null,
      proxySessionId: null,
    })
  })

  it('can find an existing draft thread by target Agent Deck session id', () => {
    const store = useLiveEditorStore.getState()
    const firstThreadKey = store.activeThreadKey

    store.setTargetAgentDeckSessionId('deck-session-a')
    store.newSession('deck-session-b')
    const secondThreadKey = useLiveEditorStore.getState().activeThreadKey

    expect(
      useLiveEditorStore.getState().findThreadKeyByTargetAgentDeckSessionId('deck-session-a')
    ).toBe(firstThreadKey)
    expect(
      useLiveEditorStore.getState().findThreadKeyByTargetAgentDeckSessionId('deck-session-b')
    ).toBe(secondThreadKey)
    expect(
      useLiveEditorStore.getState().findThreadKeyByTargetAgentDeckSessionId('deck-session-missing')
    ).toBeNull()
  })

  it('hydrates attached Agent Deck snapshot output into an otherwise blank adopted chat lane', async () => {
    setActiveThreadState({
      targetAgentDeckSessionId: 'deck-session-a',
    })

    useLiveEditorStore.getState().activateThread(useLiveEditorStore.getState().activeThreadKey)
    const stream = MockEventSource.instances.at(-1)
    expect(stream).toBeTruthy()
    stream?.emitEvent('activity', {
      id: 1,
      event_type: 'activity',
      chat_id: useLiveEditorStore.getState().activeThreadKey,
      thread_id: useLiveEditorStore.getState().activeThreadKey,
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      agent_deck_session_status: 'running',
      workspace_path: '/tmp/example-project',
      binding_state: 'attached',
      output: 'Continuing existing Agent Deck work...',
    })

    await vi.waitFor(() => {
      expect(useLiveEditorStore.getState().messages).toMatchObject([
        {
          role: 'assistant',
          content: 'Continuing existing Agent Deck work...',
          observedSessionId: 'deck-session-a',
        },
      ])
    })
  })

  it('hydrates native Agent Deck session events into an otherwise blank adopted chat lane', async () => {
    setActiveThreadState({
      targetAgentDeckSessionId: 'deck-session-a',
    })

    useLiveEditorStore.getState().activateThread(useLiveEditorStore.getState().activeThreadKey)
    const threadId = useLiveEditorStore.getState().activeThreadKey
    const stream = MockEventSource.instances.at(-1)
    expect(stream).toBeTruthy()

    stream?.emitEvent('session_status', {
      id: 1,
      event_type: 'session_status',
      chat_id: threadId,
      thread_id: threadId,
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      agent_deck_session_status: 'running',
      workspace_path: '/tmp/example-project',
      binding_state: 'attached',
      message: 'Codex is working in Agent Deck...',
    })
    stream?.emitEvent('session_output', {
      id: 2,
      event_type: 'session_output',
      chat_id: threadId,
      thread_id: threadId,
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      agent_deck_session_status: 'idle',
      workspace_path: '/tmp/example-project',
      binding_state: 'attached',
      output: 'Continuing existing Agent Deck work...',
    })

    await vi.waitFor(() => {
      expect(useLiveEditorStore.getState().messages).toMatchObject([
        {
          role: 'assistant',
          content: 'Continuing existing Agent Deck work...',
          observedSessionId: 'deck-session-a',
        },
      ])
    })
  })

  it('hydrates typed workstation turn events into an otherwise blank adopted chat lane', async () => {
    setActiveThreadState({
      targetAgentDeckSessionId: 'deck-session-a',
    })

    useLiveEditorStore.getState().activateThread(useLiveEditorStore.getState().activeThreadKey)
    const threadId = useLiveEditorStore.getState().activeThreadKey
    const stream = MockEventSource.instances.at(-1)
    expect(stream).toBeTruthy()

    stream?.emitEvent('turn_started', {
      id: 1,
      event_type: 'turn_started',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      workspace_path: '/tmp/example-project',
    })
    stream?.emitEvent('turn_status', {
      id: 2,
      event_type: 'turn_status',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      workspace_path: '/tmp/example-project',
      message: 'Codex is still working in Agent Deck... 20s elapsed.',
    })
    stream?.emitEvent('turn_chunk', {
      id: 3,
      event_type: 'turn_chunk',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      workspace_path: '/tmp/example-project',
      content: 'Continuing existing Agent Deck work...',
    })
    stream?.emitEvent('turn_completed', {
      id: 4,
      event_type: 'turn_completed',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'former multi-chat',
      agent_deck_tool: 'codex',
      workspace_path: '/tmp/example-project',
      assistant_output: 'Continuing existing Agent Deck work...',
    })

    await vi.waitFor(() => {
      expect(useLiveEditorStore.getState().messages).toMatchObject([
        {
          role: 'assistant',
          content: 'Continuing existing Agent Deck work...',
          observedSessionId: 'deck-session-a',
        },
      ])
    })
  })

  it('does not duplicate turn-scoped observed Claude output with later session snapshots', async () => {
    setActiveThreadState({
      targetAgentDeckSessionId: 'deck-session-a',
    })

    useLiveEditorStore.getState().activateThread(useLiveEditorStore.getState().activeThreadKey)
    const threadId = useLiveEditorStore.getState().activeThreadKey
    const stream = MockEventSource.instances.at(-1)
    expect(stream).toBeTruthy()

    stream?.emitEvent('turn_started', {
      id: 1,
      event_type: 'turn_started',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-claude-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'manual claude',
      agent_deck_tool: 'claude',
      workspace_path: '/tmp/example-project',
    })
    stream?.emitEvent('turn_chunk', {
      id: 2,
      event_type: 'turn_chunk',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-claude-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'manual claude',
      agent_deck_tool: 'claude',
      workspace_path: '/tmp/example-project',
      content: 'Hello from Claude',
    })
    stream?.emitEvent('turn_completed', {
      id: 3,
      event_type: 'turn_completed',
      chat_id: threadId,
      thread_id: threadId,
      request_id: 'request-claude-1',
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'manual claude',
      agent_deck_tool: 'claude',
      workspace_path: '/tmp/example-project',
      assistant_output: 'Hello from Claude',
    })
    stream?.emitEvent('session_output', {
      id: 4,
      event_type: 'session_output',
      chat_id: threadId,
      thread_id: threadId,
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'manual claude',
      agent_deck_tool: 'claude',
      agent_deck_session_status: 'idle',
      workspace_path: '/tmp/example-project',
      binding_state: 'attached',
      output: 'Hello from Claude',
    })
    stream?.emitEvent('session_status', {
      id: 5,
      event_type: 'session_status',
      chat_id: threadId,
      thread_id: threadId,
      agent_deck_session_id: 'deck-session-a',
      agent_deck_session_title: 'manual claude',
      agent_deck_tool: 'claude',
      agent_deck_session_status: 'waiting',
      workspace_path: '/tmp/example-project',
      binding_state: 'attached',
      message: 'Attached to Agent Deck session `manual claude`. Waiting for output...',
    })

    await vi.waitFor(() => {
      expect(useLiveEditorStore.getState().messages).toMatchObject([
        {
          role: 'assistant',
          content: 'Hello from Claude',
          observedSessionId: 'deck-session-a',
        },
      ])
      expect(useLiveEditorStore.getState().messages).toHaveLength(1)
    })
  })

  it('persists sanitized editor state through the shared session API', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({
        id: 1,
        project_path: '/tmp/example-project',
        workspace_path: '/tmp/example-project/.agents/thread-a',
        thread_id: useLiveEditorStore.getState().activeThreadKey,
        backend: 'agent-deck',
        agent_deck_session_id: 'deck-session-a',
        agent_deck_session_title: 'pixel-forge-thread-a',
        agent_deck_tool: 'codex',
        editor_state: {
          activePreviewTool: null,
          targetUrl: 'https://claude.ai/new',
          activeTab: 'chat',
          viewportMode: 'desktop',
          showUrlHistory: false,
          previewTabs: [
            {
              id: 'tab-a',
              url: 'https://claude.ai/new',
              title: 'Claude',
              mode: 'browser',
              localTarget: null,
            },
          ],
          activePreviewTabId: 'tab-a',
          urlHistory: ['https://claude.ai/new'],
          urlHistoryCursor: 0,
        },
        created_at: '2026-03-20T00:00:00Z',
        last_active: '2026-03-20T00:00:00Z',
      })
    )

    useSessionStore.setState({
      agentDeckTargets: [
        {
          id: 'deck-session-a',
          title: 'pixel-forge-thread-a',
          path: '/tmp/example-project/.agents/thread-a',
          group: 'pixel-forge',
          tool: 'codex',
          command: 'codex',
          status: 'waiting',
          createdAt: null,
        },
      ],
    })
    useLiveEditorStore.getState().setTargetAgentDeckSessionId('deck-session-a')
    useLiveEditorStore.getState().setTargetUrl('https://claude.ai/new')
    useLiveEditorStore.getState().setViewportMode('desktop')
    useLiveEditorStore.getState().setPreviewTabs([
      {
        id: 'tab-a',
        url: 'https://claude.ai/new',
        title: 'Claude',
        mode: 'browser',
        proxySessionId: 'proxy-runtime-only',
        browserTabId: 'browser-runtime-only',
        frameSrc: 'about:blank',
        snapshotDataUrl: null,
        localTarget: null,
      },
    ])
    useLiveEditorStore.getState().setActivePreviewTabId('tab-a')
    useLiveEditorStore.getState().setUrlHistory(['https://claude.ai/new'])
    useLiveEditorStore.getState().setUrlHistoryCursor(0)

    await useLiveEditorStore.getState().persistThreadState()

    const sessionRequest = fetchMock.mock.calls.find(([requestUrl]) =>
      String(requestUrl).includes('/api/projects/%2Ftmp%2Fexample-project/sessions')
    )
    expect(sessionRequest).toBeDefined()
    const [requestUrl, requestInit] = sessionRequest ?? []
    expect(String(requestUrl)).toContain('/api/projects/%2Ftmp%2Fexample-project/sessions')
    expect(requestInit?.method).toBe('POST')
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      thread_id: useLiveEditorStore.getState().activeThreadKey,
      agent_deck_session_id: 'deck-session-a',
      agent_deck_tool: 'codex',
      editor_state: {
        targetUrl: 'https://claude.ai/new',
        viewportMode: 'desktop',
        activePreviewTabId: 'tab-a',
        previewTabs: [
          {
            id: 'tab-a',
            url: 'https://claude.ai/new',
            title: 'Claude',
            mode: 'browser',
            localTarget: null,
          },
        ],
      },
    })
    expect(JSON.parse(String(requestInit?.body)).editor_state.previewTabs[0]).not.toHaveProperty('browserTabId')
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
    useLiveEditorStore.getState().setTargetUrl('http://example.localhost:3000')
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
      defaultAgentType: 'claude',
    })
    useLiveEditorStore.getState().activateThread('thread-1')
    useLiveEditorStore.getState().setTargetUrl('http://example.localhost:3000')
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

  it('uses the draft agent choice for the first outbound live-edit payload before bind', () => {
    useSessionStore.setState({
      defaultAgentType: 'claude',
    })
    useLiveEditorStore.getState().setDraftAgentType('codex')
    useLiveEditorStore.getState().setTargetUrl('http://example.localhost:3000')
    useLiveEditorStore.getState().connect('ws://example.test/ws/live-editor')
    const ws = useLiveEditorStore.getState().ws as MockWebSocket | null
    expect(ws).not.toBeNull()
    const send = vi.fn()
    ws!.send = send

    useLiveEditorStore.getState().sendMessage('Use the draft agent')

    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      message: 'Use the draft agent',
      agent_type: 'codex',
    })
    expect(JSON.parse(send.mock.calls[0][0] as string)).not.toHaveProperty(
      'target_agent_deck_session_id'
    )
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
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/preview-updates')) {
        return jsonResponse({
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
        })
      }

      return jsonResponse({
        profile_id: 'default',
        active_project_path: '/tmp/example-project',
        active_mode: 'live-editor',
        active_live_editor_thread_id: 'thread-1',
        updated_at: '2026-03-20T00:00:00Z',
      })
    })

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
      expect(useSessionStore.getState().pendingPreviewUpdate).not.toBeNull()
    })

    const previewUpdateCall = fetchMock.mock.calls.find(([requestUrl]) =>
      String(requestUrl).includes('/api/preview-updates')
    )
    expect(String(previewUpdateCall?.[0] || '')).toContain('/api/preview-updates')
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
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/controller-update')) {
        return jsonResponse({
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
        })
      }

      return jsonResponse({
        profile_id: 'default',
        active_project_path: '/tmp/example-project',
        active_mode: 'live-editor',
        active_live_editor_thread_id: 'thread-1',
        updated_at: '2026-03-20T00:00:00Z',
      })
    })

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
      expect(useSessionStore.getState().pendingControllerUpdate).not.toBeNull()
    })

    const controllerUpdateCall = fetchMock.mock.calls.find(([requestUrl]) =>
      String(requestUrl).includes('/api/controller-update')
    )
    expect(String(controllerUpdateCall?.[0] || '')).toContain('/api/controller-update')
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
