/**
 * Live Editor Chat Store
 *
 * Manages chat state, streaming responses, tool visualization,
 * and element selection for the Live Editor.
 *
 * Session Management: Uses session-store as single source of truth for
 * projectPath and the Live Editor broker session metadata.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/store/chat-store.ts
 */

import { create } from 'zustand'
import { WS_BACKEND_URL } from '@/config'
import { useSessionStore } from '../../../store/session-store'
import {
  buildSelectionArtifacts,
  type SelectionRecord,
} from '../selection-engine'
import {
  buildCompletionSummary,
  summarizeBackendStatus,
  summarizeToolStatus,
} from '../chat-status'

// ============================================================================
// Types
// ============================================================================

export interface ToolActivity {
  id: string
  tool: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'running' | 'complete'
}

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  kind: 'image' | 'file'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  attachments?: ChatAttachment[]
  timestamp: Date
  toolActivity?: ToolActivity
  isRemoteComplete?: boolean
  systemTone?: 'info' | 'success' | 'error'
  canApplyControllerUpdate?: boolean
}

export interface SelectedElement extends SelectionRecord {
  timestamp: Date
}

const MAX_SELECTION_HISTORY = 100

interface LiveEditorChatStore {
  // Chat state
  messages: ChatMessage[]
  isStreaming: boolean
  currentStreamContent: string
  currentTool: ToolActivity | null
  currentStatusMessage: string
  currentSelectionCount: number
  currentRequestId: string | null

  // Connection state
  ws: WebSocket | null
  connected: boolean

  // Selection state (task_2_3)
  selectedElements: SelectedElement[]
  selectionUndoStack: SelectedElement[][]
  selectionRedoStack: SelectedElement[][]

  // NOTE: projectPath and Live Editor broker session metadata are read from session-store

  // Actions - Chat
  connect: (endpoint?: string) => void
  disconnect: () => void
  sendMessage: (content: string, attachments?: ChatAttachment[]) => void
  clearMessages: () => void
  newSession: () => void

  // Actions - Selection
  addElement: (element: Omit<SelectedElement, 'timestamp'>) => void
  removeElement: (id: string) => void
  removeElements: (ids: string[]) => void
  replaceElement: (id: string, element: Omit<SelectedElement, 'timestamp'>) => void
  clearElements: () => void
  undoSelectionChange: () => void
  redoSelectionChange: () => void

  // Helpers
  buildSelectionPayload: () => {
    elementContext: string
    selectionTunnel: { selections: ReturnType<typeof buildSelectionArtifacts>['tunnel']['selections'] }
    selectionAttachments: ChatAttachment[]
  }

  // Getters for session state (reads from session-store)
  getSessionId: () => string | null
  getProjectPath: () => string | null
}

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return Math.random().toString(36).substring(2, 15)
}

function buildAttachmentSummary(attachments: ChatAttachment[]): string {
  const imageCount = attachments.filter(
    (attachment) => attachment.kind === 'image'
  ).length
  const fileCount = attachments.length - imageCount

  if (imageCount > 0 && fileCount === 0) {
    return imageCount === 1
      ? 'Attached 1 reference image.'
      : `Attached ${imageCount} reference images.`
  }

  if (fileCount > 0 && imageCount === 0) {
    return fileCount === 1
      ? 'Attached 1 reference file.'
      : `Attached ${fileCount} reference files.`
  }

  return `Attached ${imageCount} image${imageCount === 1 ? '' : 's'} and ${fileCount} file${fileCount === 1 ? '' : 's'}.`
}

function cloneSelectedElement(element: SelectedElement): SelectedElement {
  return {
    ...element,
    classList: [...element.classList],
    rootClassList: [...element.rootClassList],
    region: element.region ? { ...element.region } : null,
    timestamp: new Date(element.timestamp),
  }
}

function cloneSelectionState(elements: SelectedElement[]): SelectedElement[] {
  return elements.map(cloneSelectedElement)
}

function pushUndoSnapshot(
  history: SelectedElement[][],
  snapshot: SelectedElement[]
): SelectedElement[][] {
  const nextHistory = [...history, cloneSelectionState(snapshot)]
  return nextHistory.slice(-MAX_SELECTION_HISTORY)
}

async function stageControllerUpdateNotice(options: {
  projectPath: string
  previewUrl: string | null
  activeMode: 'live-editor' | 'screenshot'
  requestId: string | null
}) {
  if (typeof window === 'undefined') {
    return
  }
  const desktopApp = window.pixelForgeDesktop?.app
  if (!desktopApp) {
    return
  }

  const requestLabel = options.requestId ? `request ${options.requestId}` : 'latest request'
  const summary = `Controller update from ${requestLabel} is ready to load.`

  const update = await desktopApp.stageControllerUpdate({
    projectPath: options.projectPath,
    previewUrl: options.previewUrl,
    activeMode: options.activeMode,
    summary,
    source: 'live-editor',
    requestId: options.requestId,
    commitHash: null,
  })

  useSessionStore.getState().setPendingControllerUpdate(update)
}

// ============================================================================
// Store
// ============================================================================

export const useLiveEditorStore = create<LiveEditorChatStore>((set, get) => ({
  // Initial state
  messages: [],
  isStreaming: false,
  currentStreamContent: '',
  currentTool: null,
  currentStatusMessage: '',
  currentSelectionCount: 0,
  currentRequestId: null,
  ws: null,
  connected: false,
  selectedElements: [],
  selectionUndoStack: [],
  selectionRedoStack: [],

  // Getters - read from session-store for Live Editor session management
  getSessionId: () => useSessionStore.getState().liveEditorSession?.threadId ?? null,
  getProjectPath: () => useSessionStore.getState().projectPath,

  // -------------------------------------------------------------------------
  // Connection Management
  // -------------------------------------------------------------------------

  connect: (endpoint = '/ws/live-editor') => {
    const { ws } = get()
    if (ws && ws.readyState === WebSocket.OPEN) return

    const wsUrl = endpoint.startsWith('ws://') || endpoint.startsWith('wss://')
      ? endpoint
      : `${WS_BACKEND_URL}${endpoint}`
    const newWs = new WebSocket(wsUrl)

    newWs.onopen = () => {
      set({ connected: true })
      console.log('[live-editor] WebSocket connected')
    }

    newWs.onmessage = (event) => {
      const data = JSON.parse(event.data)

      switch (data.type) {
        case 'chunk':
          // Streaming text content
          set((state) => ({
            currentStreamContent: state.currentStreamContent + data.content,
            currentStatusMessage: state.currentStatusMessage || 'Receiving agent response...',
          }))
          break

        case 'tool_use': {
          // Tool execution started
          const toolActivity: ToolActivity = {
            id: generateId(),
            tool: data.tool,
            input: data.input,
            status: 'running',
          }
          set((state) => ({
            currentTool: toolActivity,
            currentStatusMessage: summarizeToolStatus(
              toolActivity.tool,
              toolActivity.input,
              'running'
            ),
            messages: [
              ...state.messages,
              {
                id: toolActivity.id,
                role: 'tool',
                content: '',
                timestamp: new Date(),
                toolActivity,
              },
            ],
          }))
          break
        }

        case 'tool_result': {
          // Tool execution completed
          const { currentTool, messages } = get()
          if (currentTool) {
            const updatedMessages = messages.map((msg) =>
              msg.id === currentTool.id
                ? {
                    ...msg,
                    toolActivity: {
                      ...currentTool,
                      result: data.content,
                      isError: data.is_error,
                      status: 'complete' as const,
                    },
                  }
                : msg
            )
            set({
              messages: updatedMessages,
              currentTool: null,
              currentStatusMessage: summarizeToolStatus(
                currentTool.tool,
                currentTool.input,
                data.is_error ? 'error' : 'complete'
              ),
            })
          }
          break
        }

        case 'complete': {
          // Response complete
          const { currentStreamContent, messages: msgs } = get()
          const isRemoteTarget = !!data.is_remote_target
          const isSelfEditSafeMode = !!data.self_edit_safe_mode
          const requestId =
            typeof data.request_id === 'string' && data.request_id
              ? data.request_id
              : get().currentRequestId
          const selectionCount =
            Number.isFinite(Number(data.selection_count))
              ? Number(data.selection_count)
              : get().currentSelectionCount
          const completionMessage: ChatMessage = {
            id: generateId(),
            role: 'system',
            content: buildCompletionSummary({
              requestId,
              selectionCount,
              selfEditSafeMode: isSelfEditSafeMode,
              isRemoteTarget,
            }),
            timestamp: new Date(),
            isRemoteComplete: isRemoteTarget || undefined,
            systemTone: 'success',
            canApplyControllerUpdate: isSelfEditSafeMode || undefined,
          }

          if (currentStreamContent) {
            set({
              messages: [
                ...msgs,
                {
                  id: generateId(),
                  role: 'assistant',
                  content: currentStreamContent,
                  timestamp: new Date(),
                },
                completionMessage,
              ],
              currentStreamContent: '',
              isStreaming: false,
              currentStatusMessage: '',
              currentSelectionCount: 0,
              currentRequestId: null,
            })
          } else {
            set({
              messages: [
                ...get().messages,
                completionMessage,
              ],
              isStreaming: false,
              currentStatusMessage: '',
              currentSelectionCount: 0,
              currentRequestId: null,
            })
          }
          if (data.session_id) {
            useSessionStore.getState().setLiveEditorSession({
              threadId: data.session_id,
              backend: data.backend || 'agent-deck',
              agentDeckSessionId: data.agent_deck_session_id ?? null,
              agentDeckSessionTitle: data.agent_deck_session_title ?? null,
              requestId: data.request_id ?? null,
            })
            console.log('[live-editor] Session synced to session-store:', data.session_id)
          }
          if (isSelfEditSafeMode) {
            const sessionState = useSessionStore.getState()
            if (sessionState.projectPath) {
              void stageControllerUpdateNotice({
                projectPath: sessionState.projectPath,
                previewUrl: sessionState.previewUrl,
                activeMode: sessionState.activeMode,
                requestId,
              }).catch((error) => {
                console.error('[live-editor] Failed to stage controller update notice:', error)
              })
            }
          }
          break
        }

        case 'session': {
          if (data.session_id) {
            useSessionStore.getState().setLiveEditorSession({
              threadId: data.session_id,
              backend: data.backend || 'agent-deck',
              agentDeckSessionId: data.agent_deck_session_id ?? null,
              agentDeckSessionTitle: data.agent_deck_session_title ?? null,
              requestId: data.request_id ?? null,
            })
          }
          set({
            currentRequestId:
              typeof data.request_id === 'string' && data.request_id
                ? data.request_id
                : get().currentRequestId,
            currentSelectionCount:
              Number.isFinite(Number(data.selection_count))
                ? Number(data.selection_count)
                : get().currentSelectionCount,
          })
          break
        }

        case 'error':
          set({
            messages: [
              ...get().messages,
              {
                id: generateId(),
                role: 'assistant',
                content: `Error: ${data.message}`,
                timestamp: new Date(),
              },
            ],
            isStreaming: false,
            currentStreamContent: '',
            currentStatusMessage: '',
            currentSelectionCount: 0,
            currentRequestId: null,
          })
          break

        case 'status':
          set({
            currentStatusMessage: summarizeBackendStatus(
              typeof data.message === 'string' ? data.message : ''
            ),
          })
          break
      }
    }

    newWs.onclose = () => {
      const {
        isStreaming,
        currentStreamContent,
        messages,
      } = get()

      if (isStreaming) {
        const nextMessages = [...messages]
        if (currentStreamContent) {
          nextMessages.push({
            id: generateId(),
            role: 'assistant',
            content: currentStreamContent,
            timestamp: new Date(),
          })
        }
        nextMessages.push({
          id: generateId(),
          role: 'system',
          content: 'Live Editor connection closed before completion.',
          timestamp: new Date(),
          systemTone: 'error',
        })
        set({
          ws: null,
          connected: false,
          isStreaming: false,
          currentStreamContent: '',
          currentStatusMessage: '',
          currentSelectionCount: 0,
          currentRequestId: null,
          messages: nextMessages,
        })
      } else {
        set({ ws: null, connected: false })
      }
      console.log('[live-editor] WebSocket disconnected')
    }

    newWs.onerror = (error) => {
      console.error('[live-editor] WebSocket error:', error)
    }

    set({ ws: newWs })
  },

  disconnect: () => {
    get().ws?.close()
    set({ ws: null, connected: false })
  },

  // -------------------------------------------------------------------------
  // Chat Actions
  // -------------------------------------------------------------------------

  sendMessage: (content: string, attachments: ChatAttachment[] = []) => {
    const {
      ws,
      messages,
      buildSelectionPayload,
      getSessionId,
      getProjectPath,
    } = get()
    const trimmedContent = content.trim()
    const hasAttachments = attachments.length > 0

    // Read from session-store (Live Editor session management)
    const sessionId = getSessionId()
    const projectPath = getProjectPath()

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      get().connect()
      setTimeout(() => get().sendMessage(content), 500)
      return
    }

    if (!trimmedContent && !hasAttachments) {
      return
    }

    if (!projectPath) {
      set({
        messages: [
          ...messages,
          {
            id: generateId(),
            role: 'assistant',
            content: 'Error: No project path configured. Please select a project first.',
            timestamp: new Date(),
          },
        ],
      })
      return
    }

    // Build element context
    const {
      elementContext,
      selectionTunnel,
      selectionAttachments,
    } = buildSelectionPayload()
    const requestAttachments = [...selectionAttachments, ...attachments]
    const userVisibleContent =
      trimmedContent ||
      buildAttachmentSummary(attachments)

    // Add user message to chat
    set({
      messages: [
        ...messages,
        {
          id: generateId(),
          role: 'user',
          content: userVisibleContent,
          attachments: hasAttachments ? attachments : undefined,
          timestamp: new Date(),
        },
      ],
      isStreaming: true,
      currentStreamContent: '',
      currentStatusMessage:
        selectionTunnel.selections.length > 0
          ? `Preparing request with ${selectionTunnel.selections.length} selection${selectionTunnel.selections.length === 1 ? '' : 's'}...`
          : 'Preparing live edit request...',
      currentSelectionCount: selectionTunnel.selections.length,
      currentRequestId: null,
    })

    const previewUrl = useSessionStore.getState().previewUrl
    const agentType = useSessionStore.getState().agentType
    const payload: Record<string, unknown> = {
      message: trimmedContent,
      project_path: projectPath,
      element_context: elementContext,
      preview_url: previewUrl || '',
      agent_type: agentType || 'claude',
    }

    if (requestAttachments.length > 0) {
      payload.attachments = requestAttachments.map((attachment) => ({
        name: attachment.name,
        mime_type: attachment.mimeType,
        data_url: attachment.dataUrl,
        kind: attachment.kind,
      }))
    }

    if (selectionTunnel.selections.length > 0) {
      payload.selection_tunnel = selectionTunnel
    }

    if (sessionId) {
      payload.thread_id = sessionId
    }

    ws.send(JSON.stringify(payload))
  },

  clearMessages: () => {
    set({
      messages: [],
      currentStreamContent: '',
      currentStatusMessage: '',
      currentSelectionCount: 0,
      currentRequestId: null,
    })
  },

  newSession: () => {
    useSessionStore.getState().clearLiveEditorSession()
    set({
      messages: [],
      currentStreamContent: '',
      currentStatusMessage: '',
      currentSelectionCount: 0,
      currentRequestId: null,
      selectedElements: [],
      selectionUndoStack: [],
      selectionRedoStack: [],
    })
  },

  // -------------------------------------------------------------------------
  // Selection Actions (task_2_3)
  // -------------------------------------------------------------------------

  addElement: (element) => {
    const { selectedElements, selectionUndoStack } = get()

    if (selectedElements.some((entry) => entry.id === element.id)) {
      console.log('[live-editor] Element already selected')
      return
    }

    const newElement: SelectedElement = {
      ...element,
      timestamp: new Date(),
    }

    set({
      selectedElements: [...selectedElements, newElement],
      selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
      selectionRedoStack: [],
    })
  },

  removeElement: (id: string) => {
    const { selectedElements, selectionUndoStack } = get()
    if (!selectedElements.some((entry) => entry.id === id)) {
      return
    }

    set({
      selectedElements: selectedElements.filter((entry) => entry.id !== id),
      selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
      selectionRedoStack: [],
    })
  },

  removeElements: (ids: string[]) => {
    const idSet = new Set(ids)
    if (idSet.size === 0) {
      return
    }

    const { selectedElements, selectionUndoStack } = get()
    const nextSelections = selectedElements.filter((entry) => !idSet.has(entry.id))
    if (nextSelections.length === selectedElements.length) {
      return
    }

    set({
      selectedElements: nextSelections,
      selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
      selectionRedoStack: [],
    })
  },

  replaceElement: (id, element) => {
    const { selectedElements, selectionUndoStack } = get()
    const targetIndex = selectedElements.findIndex((entry) => entry.id === id)
    if (targetIndex < 0) {
      return
    }

    const nextSelections = cloneSelectionState(selectedElements)
    nextSelections[targetIndex] = {
      ...element,
      id,
      timestamp: new Date(),
    }

    set({
      selectedElements: nextSelections,
      selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
      selectionRedoStack: [],
    })
  },

  clearElements: () => {
    const { selectedElements, selectionUndoStack } = get()
    if (selectedElements.length === 0) {
      return
    }

    set({
      selectedElements: [],
      selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
      selectionRedoStack: [],
    })
  },

  undoSelectionChange: () => {
    const { selectionUndoStack, selectionRedoStack, selectedElements } = get()
    if (selectionUndoStack.length === 0) {
      return
    }

    const previousSnapshot = selectionUndoStack[selectionUndoStack.length - 1]
    set({
      selectedElements: cloneSelectionState(previousSnapshot),
      selectionUndoStack: selectionUndoStack.slice(0, -1),
      selectionRedoStack: pushUndoSnapshot(selectionRedoStack, selectedElements),
    })
  },

  redoSelectionChange: () => {
    const { selectionUndoStack, selectionRedoStack, selectedElements } = get()
    if (selectionRedoStack.length === 0) {
      return
    }

    const nextSnapshot = selectionRedoStack[selectionRedoStack.length - 1]
    set({
      selectedElements: cloneSelectionState(nextSnapshot),
      selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
      selectionRedoStack: selectionRedoStack.slice(0, -1),
    })
  },

  // Note: setProjectPath removed - use useSessionStore.setProject() instead

  // -------------------------------------------------------------------------
  // Context Building
  // -------------------------------------------------------------------------

  buildSelectionPayload: () => {
    const { selectedElements } = get()

    if (selectedElements.length === 0) {
      return {
        elementContext: '',
        selectionTunnel: { selections: [] },
        selectionAttachments: [],
      }
    }
    const artifacts = buildSelectionArtifacts(selectedElements)
    return {
      elementContext: artifacts.elementContext,
      selectionTunnel: artifacts.tunnel,
      selectionAttachments: artifacts.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: attachment.dataUrl,
        kind: attachment.kind,
      })),
    }
  },
}))
