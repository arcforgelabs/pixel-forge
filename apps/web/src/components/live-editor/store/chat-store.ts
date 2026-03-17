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
  role: 'user' | 'assistant' | 'tool'
  content: string
  attachments?: ChatAttachment[]
  timestamp: Date
  toolActivity?: ToolActivity
  isRemoteComplete?: boolean
}

export interface SelectedElement extends SelectionRecord {
  timestamp: Date
}

interface LiveEditorChatStore {
  // Chat state
  messages: ChatMessage[]
  isStreaming: boolean
  currentStreamContent: string
  currentTool: ToolActivity | null

  // Connection state
  ws: WebSocket | null
  connected: boolean

  // Selection state (task_2_3)
  selectedElements: SelectedElement[]

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
  clearElements: () => void

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

// ============================================================================
// Store
// ============================================================================

export const useLiveEditorStore = create<LiveEditorChatStore>((set, get) => ({
  // Initial state
  messages: [],
  isStreaming: false,
  currentStreamContent: '',
  currentTool: null,
  ws: null,
  connected: false,
  selectedElements: [],

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
            set({ messages: updatedMessages, currentTool: null })
          }
          break
        }

        case 'complete': {
          // Response complete
          const { currentStreamContent, messages: msgs } = get()
          const isRemoteTarget = !!data.is_remote_target
          if (currentStreamContent) {
            set({
              messages: [
                ...msgs,
                {
                  id: generateId(),
                  role: 'assistant',
                  content: currentStreamContent,
                  timestamp: new Date(),
                  isRemoteComplete: isRemoteTarget || undefined,
                },
              ],
              currentStreamContent: '',
              isStreaming: false,
            })
          } else if (isRemoteTarget) {
            // No streamed content but remote target — add a refresh prompt message
            set({
              messages: [
                ...get().messages,
                {
                  id: generateId(),
                  role: 'assistant',
                  content: 'Code changes complete. Deploy may be in progress — refresh the preview when ready.',
                  timestamp: new Date(),
                  isRemoteComplete: true,
                },
              ],
              isStreaming: false,
            })
          } else {
            set({ isStreaming: false })
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
          })
          break

        case 'status':
          // Status updates (e.g., "Finding element...")
          // Could add to a separate statusMessage state if needed
          console.log('[live-editor] Status:', data.message)
          break
      }
    }

    newWs.onclose = () => {
      set({ ws: null, connected: false })
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
    set({ messages: [], currentStreamContent: '' })
  },

  newSession: () => {
    useSessionStore.getState().clearLiveEditorSession()
    set({
      messages: [],
      currentStreamContent: '',
      selectedElements: [],
    })
  },

  // -------------------------------------------------------------------------
  // Selection Actions (task_2_3)
  // -------------------------------------------------------------------------

  addElement: (element) => {
    const { selectedElements } = get()

    if (selectedElements.some((entry) => entry.id === element.id)) {
      console.log('[live-editor] Element already selected')
      return
    }

    const newElement: SelectedElement = {
      ...element,
      timestamp: new Date(),
    }

    set({ selectedElements: [...selectedElements, newElement] })
  },

  removeElement: (id: string) => {
    set((state) => ({
      selectedElements: state.selectedElements.filter((e) => e.id !== id),
    }))
  },

  clearElements: () => {
    set({ selectedElements: [] })
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
