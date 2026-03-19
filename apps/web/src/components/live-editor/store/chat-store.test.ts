import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type SelectedElement, useLiveEditorStore } from './chat-store'
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

describe('live editor selection history', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
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
    useLiveEditorStore.setState({
      selectedElements: [],
      selectionUndoStack: [],
      selectionRedoStack: [],
      messages: [],
      isStreaming: false,
      currentStreamContent: '',
      pendingAssistantAttachments: [],
      currentTool: null,
      currentStatusMessage: '',
      currentSelectionCount: 0,
      currentRequestId: null,
      ws: null,
      connected: false,
      queuedMessages: [],
    })
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

  it('includes the selected Agent Deck target in outbound live-edit payloads', () => {
    const send = vi.fn()
    useSessionStore.setState({
      selectedAgentDeckTargetId: 'deck-session-123',
    })
    useLiveEditorStore.setState({
      ws: {
        readyState: 1,
        send,
      } as unknown as WebSocket,
    })

    useLiveEditorStore.getState().sendMessage('Retarget this change')

    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      message: 'Retarget this change',
      project_path: '/tmp/example-project',
      preview_url: 'http://example.localhost:3000',
      agent_type: 'claude',
      target_agent_deck_session_id: 'deck-session-123',
    })
  })

  it('matches tool results to the correct running tool by tool call id', () => {
    const now = new Date()

    useLiveEditorStore.setState({
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
})
