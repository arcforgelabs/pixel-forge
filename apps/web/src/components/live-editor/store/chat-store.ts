/**
 * Live Editor Chat Store
 *
 * Thread state is the source of truth. Each Live Editor thread owns its
 * transport lane, messages, target Agent Deck binding, and selection history.
 * The top-level chat/selection fields below are active-thread aliases so the
 * existing UI can render the current thread without drilling through maps.
 */

import { create } from 'zustand'

import { HTTP_BACKEND_URL, WS_BACKEND_URL } from '@/config'
import { getDesktopApp, hasDesktopAppMethod } from '@/lib/desktop-app'
import type {
  PersistedPreviewTab,
  PersistedThreadEditorState,
  ProjectSessionRecord,
} from '@/store/session-store'
import type {
  PixelForgeDesktopPendingControllerUpdate,
  PixelForgeDesktopPreviewTool,
  PixelForgePendingPreviewUpdate,
} from '@/types/pixel-forge-desktop'
import { useSessionStore } from '../../../store/session-store'
import {
  buildSelectionArtifacts,
  type SelectionRecord,
} from '../selection-engine'
import { isCloneWorkspaceBound } from '../mirror-targets'
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
  toolCallId?: string | null
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
  canLoadPreviewUpdate?: boolean
  observedSessionId?: string | null
}

export interface SelectedElement extends SelectionRecord {
  timestamp: Date
}

interface PendingOutboundMessage {
  payload: Record<string, unknown>
}

interface ObservedAgentDeckActivity {
  thread_id: string | null
  agent_deck_session_id: string | null
  agent_deck_session_title: string | null
  agent_deck_tool: string | null
  agent_deck_session_status: string | null
  workspace_path: string | null
  binding_state: 'attached' | 'detached'
  output: string
}

export type LiveEditorPanelTab = 'chat' | 'elements'
export type ViewportMode = 'fluid' | 'desktop' | 'phone'
export type PreviewMode = 'proxy' | 'browser' | null

export interface LocalTargetMeta {
  kind: 'pixel-forge'
  runtimeKind: 'mirror' | 'dev'
  instanceSlug: string
  projectPath: string
  sourceRoot: string
  audienceWorkspacePath?: string | null
  buildLabel: string
  createdAt: string | null
}

export interface PreviewTab {
  id: string
  url: string
  title: string
  mode: PreviewMode
  proxySessionId: string | null
  browserTabId: string | null
  frameSrc: string
  snapshotDataUrl: string | null
  localTarget: LocalTargetMeta | null
}

export interface PreviewAuthIssue {
  status: number
  url: string
}

export interface ThreadEditorState {
  draftAgentType: string
  activePreviewTool: PixelForgeDesktopPreviewTool
  targetUrl: string
  activeTab: LiveEditorPanelTab
  viewportMode: ViewportMode
  authIssue: PreviewAuthIssue | null
  showUrlHistory: boolean
  previewTabs: PreviewTab[]
  activePreviewTabId: string | null
  urlHistory: string[]
  urlHistoryCursor: number
}

type StateSetterValue<T> = T | ((current: T) => T)

export interface ThreadChatState {
  messages: ChatMessage[]
  isStreaming: boolean
  currentStreamContent: string
  pendingAssistantAttachments: ChatAttachment[]
  currentTool: ToolActivity | null
  currentStatusMessage: string
  currentSelectionCount: number
  currentRequestId: string | null
  ws: WebSocket | null
  connected: boolean
  queuedMessages: PendingOutboundMessage[]
  targetAgentDeckSessionId: string | null
  draftAgentType: string
  selectedElements: SelectedElement[]
  selectionUndoStack: SelectedElement[][]
  selectionRedoStack: SelectedElement[][]
  activePreviewTool: PixelForgeDesktopPreviewTool
  targetUrl: string
  activeTab: LiveEditorPanelTab
  viewportMode: ViewportMode
  authIssue: PreviewAuthIssue | null
  showUrlHistory: boolean
  previewTabs: PreviewTab[]
  activePreviewTabId: string | null
  urlHistory: string[]
  urlHistoryCursor: number
}

interface ActiveThreadViewState {
  messages: ChatMessage[]
  isStreaming: boolean
  currentStreamContent: string
  pendingAssistantAttachments: ChatAttachment[]
  currentTool: ToolActivity | null
  currentStatusMessage: string
  currentSelectionCount: number
  currentRequestId: string | null
  ws: WebSocket | null
  connected: boolean
  queuedMessages: PendingOutboundMessage[]
  targetAgentDeckSessionId: string | null
  draftAgentType: string
  selectedElements: SelectedElement[]
  selectionUndoStack: SelectedElement[][]
  selectionRedoStack: SelectedElement[][]
  activePreviewTool: PixelForgeDesktopPreviewTool
  targetUrl: string
  activeTab: LiveEditorPanelTab
  viewportMode: ViewportMode
  authIssue: PreviewAuthIssue | null
  showUrlHistory: boolean
  previewTabs: PreviewTab[]
  activePreviewTabId: string | null
  urlHistory: string[]
  urlHistoryCursor: number
}

interface SelectionPayload {
  elementContext: string
  selectionTunnel: {
    selections: ReturnType<typeof buildSelectionArtifacts>['tunnel']['selections']
  }
  selectionAttachments: ChatAttachment[]
}

interface LiveEditorChatStore extends ActiveThreadViewState {
  activeThreadKey: string
  threadStates: Record<string, ThreadChatState>

  // NOTE: projectPath and persisted bound session metadata live in session-store.
  activateThread: (threadKey: string | null) => void
  resetForProject: () => void
  hydrateProjectThreads: (options: {
    projectSessions: ProjectSessionRecord[]
    activeThreadKey?: string | null
    previewUrl?: string | null
  }) => void
  persistThreadState: (threadKey?: string | null) => Promise<void>
  connect: (endpoint?: string) => void
  disconnect: (threadKey?: string | null) => void
  disconnectAll: () => void
  sendMessage: (content: string, attachments?: ChatAttachment[]) => void
  clearMessages: () => void
  newSession: (targetAgentDeckSessionId?: string | null) => void
  removeThread: (threadKey: string | null | undefined, fallbackThreadKey?: string | null) => void
  setTargetAgentDeckSessionId: (sessionId: string | null) => void
  setDraftAgentType: (agentType: string) => void
  getTargetAgentDeckSessionId: (threadKey?: string | null) => string | null
  findThreadKeyByTargetAgentDeckSessionId: (
    sessionId: string | null | undefined
  ) => string | null
  setActivePreviewTool: (tool: PixelForgeDesktopPreviewTool) => void
  setTargetUrl: (url: string) => void
  setActiveTab: (tab: LiveEditorPanelTab) => void
  setViewportMode: (mode: ViewportMode) => void
  setAuthIssue: (issue: PreviewAuthIssue | null) => void
  setShowUrlHistory: (next: StateSetterValue<boolean>) => void
  setPreviewTabs: (next: StateSetterValue<PreviewTab[]>) => void
  setActivePreviewTabId: (tabId: string | null) => void
  setUrlHistory: (next: StateSetterValue<string[]>) => void
  setUrlHistoryCursor: (next: StateSetterValue<number>) => void

  addElement: (element: Omit<SelectedElement, 'timestamp'>) => void
  removeElement: (id: string) => void
  removeElements: (ids: string[]) => void
  replaceElement: (id: string, element: Omit<SelectedElement, 'timestamp'>) => void
  clearElements: () => void
  undoSelectionChange: () => void
  redoSelectionChange: () => void

  buildSelectionPayload: () => SelectionPayload

  getActiveThreadState: () => ThreadChatState
  getThreadState: (threadKey: string | null | undefined) => ThreadChatState
  getThreadStatus: (
    threadKey: string | null | undefined
  ) => Pick<ThreadChatState, 'connected' | 'currentStatusMessage' | 'isStreaming'>
  getSessionId: () => string | null
  getProjectPath: () => string | null
}

// ============================================================================
// Helpers
// ============================================================================

const MAX_SELECTION_HISTORY = 100

function generateId(): string {
  return Math.random().toString(36).substring(2, 15)
}

function normalizeDraftAgentType(agentType: string | null | undefined): string {
  return agentType === 'codex' ? 'codex' : 'claude'
}

function getDefaultDraftAgentType(): string {
  return normalizeDraftAgentType(useSessionStore.getState().defaultAgentType)
}

function createDraftThreadKey(): string {
  return `draft-${generateId()}`
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

function createEmptyPreviewTab(index = 1): PreviewTab {
  return {
    id: `preview-${generateId()}`,
    url: '',
    title: `Tab ${index}`,
    mode: null,
    proxySessionId: null,
    browserTabId: null,
    frameSrc: 'about:blank',
    snapshotDataUrl: null,
    localTarget: null,
  }
}

function createEmptyThreadEditorState(
  draftAgentType: string = getDefaultDraftAgentType()
): ThreadEditorState {
  const initialPreviewTab = createEmptyPreviewTab()
  return {
    draftAgentType: normalizeDraftAgentType(draftAgentType),
    activePreviewTool: null,
    targetUrl: '',
    activeTab: 'chat',
    viewportMode: 'fluid',
    authIssue: null,
    showUrlHistory: false,
    previewTabs: [initialPreviewTab],
    activePreviewTabId: initialPreviewTab.id,
    urlHistory: [],
    urlHistoryCursor: -1,
  }
}

function resolveStateSetterValue<T>(
  next: StateSetterValue<T>,
  current: T
): T {
  return typeof next === 'function'
    ? (next as (value: T) => T)(current)
    : next
}

function pushUndoSnapshot(
  history: SelectedElement[][],
  snapshot: SelectedElement[]
): SelectedElement[][] {
  const nextHistory = [...history, cloneSelectionState(snapshot)]
  return nextHistory.slice(-MAX_SELECTION_HISTORY)
}

function createEmptyThreadState(): ThreadChatState {
  return {
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
    targetAgentDeckSessionId: null,
    selectedElements: [],
    selectionUndoStack: [],
    selectionRedoStack: [],
    ...createEmptyThreadEditorState(),
  }
}

function restorePreviewTab(
  tab: PersistedPreviewTab,
  index: number
): PreviewTab {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title || `Tab ${index}`,
    mode: tab.mode,
    proxySessionId: null,
    browserTabId: null,
    frameSrc: 'about:blank',
    snapshotDataUrl: null,
    localTarget: tab.localTarget
      ? {
          ...tab.localTarget,
          audienceWorkspacePath: tab.localTarget.audienceWorkspacePath ?? null,
        }
      : null,
  }
}

function persistPreviewTab(tab: PreviewTab): PersistedPreviewTab {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    mode: tab.mode,
    localTarget: tab.localTarget
      ? {
          ...tab.localTarget,
          audienceWorkspacePath: tab.localTarget.audienceWorkspacePath ?? null,
        }
      : null,
  }
}

function createThreadEditorStateFromPersisted(
  editorState: PersistedThreadEditorState | null | undefined,
  fallbackUrl?: string | null
): ThreadEditorState {
  const normalizedFallbackUrl = fallbackUrl?.trim() || ''
  if (!editorState) {
    const emptyState = createEmptyThreadEditorState()
    if (normalizedFallbackUrl) {
      emptyState.targetUrl = normalizedFallbackUrl
      emptyState.previewTabs = [
        {
          ...emptyState.previewTabs[0],
          url: normalizedFallbackUrl,
          title: normalizedFallbackUrl,
        },
      ]
      emptyState.activePreviewTabId = emptyState.previewTabs[0]?.id ?? null
      emptyState.urlHistory = [normalizedFallbackUrl]
      emptyState.urlHistoryCursor = 0
    }
    return emptyState
  }

  const restoredTabs = editorState.previewTabs.length > 0
    ? editorState.previewTabs.map((tab, index) => restorePreviewTab(tab, index + 1))
    : createEmptyThreadEditorState().previewTabs

  const activePreviewTabId = restoredTabs.some((tab) => tab.id === editorState.activePreviewTabId)
    ? editorState.activePreviewTabId
    : restoredTabs[0]?.id ?? null
  const targetUrl =
    editorState.targetUrl.trim()
    || restoredTabs.find((tab) => tab.id === activePreviewTabId)?.url?.trim()
    || normalizedFallbackUrl
  const urlHistory = editorState.urlHistory.filter((entry) => entry.trim())
  const urlHistoryCursor = urlHistory.length > 0
    ? Math.max(-1, Math.min(editorState.urlHistoryCursor, urlHistory.length - 1))
    : -1

  return {
    draftAgentType: normalizeDraftAgentType(
      editorState.draftAgentType || getDefaultDraftAgentType()
    ),
    activePreviewTool: editorState.activePreviewTool === 'select' ? 'select' : null,
    targetUrl,
    activeTab: editorState.activeTab === 'elements' ? 'elements' : 'chat',
    viewportMode:
      editorState.viewportMode === 'desktop' || editorState.viewportMode === 'phone'
        ? editorState.viewportMode
        : 'fluid',
    authIssue: null,
    showUrlHistory: !!editorState.showUrlHistory,
    previewTabs: restoredTabs,
    activePreviewTabId,
    urlHistory,
    urlHistoryCursor,
  }
}

function buildPersistedEditorState(
  threadState: ThreadChatState
): PersistedThreadEditorState {
  return {
    draftAgentType: normalizeDraftAgentType(threadState.draftAgentType),
    activePreviewTool: threadState.activePreviewTool === 'select' ? 'select' : null,
    targetUrl: threadState.targetUrl.trim(),
    activeTab: threadState.activeTab,
    viewportMode: threadState.viewportMode,
    showUrlHistory: threadState.showUrlHistory,
    previewTabs: threadState.previewTabs.map(persistPreviewTab),
    activePreviewTabId: threadState.activePreviewTabId,
    urlHistory: threadState.urlHistory.map((entry) => entry.trim()).filter(Boolean),
    urlHistoryCursor: threadState.urlHistoryCursor,
  }
}

function createThreadStateFromSession(
  session: ProjectSessionRecord,
  fallbackUrl?: string | null
): ThreadChatState {
  return {
    ...createEmptyThreadState(),
    targetAgentDeckSessionId: session.agentDeckSessionId ?? null,
    ...createThreadEditorStateFromPersisted(session.editorState, fallbackUrl),
  }
}

function shouldPersistThreadState(
  threadState: ThreadChatState,
  session: ProjectSessionRecord | ReturnType<typeof useSessionStore.getState>['liveEditorSession']
): boolean {
  if (session) {
    return true
  }

  if (threadState.targetAgentDeckSessionId) {
    return true
  }

  if (threadState.targetUrl.trim()) {
    return true
  }

  if (threadState.previewTabs.length > 1) {
    return true
  }

  if (threadState.draftAgentType !== getDefaultDraftAgentType()) {
    return true
  }

  return threadState.previewTabs.some((tab) =>
    Boolean(tab.url.trim() || tab.localTarget)
  )
}

function getThreadStateSnapshot(
  threadStates: Record<string, ThreadChatState>,
  threadKey: string | null | undefined
): ThreadChatState {
  if (!threadKey) {
    return createEmptyThreadState()
  }
  return threadStates[threadKey] ?? createEmptyThreadState()
}

function buildActiveThreadViewState(
  threadState: ThreadChatState
): ActiveThreadViewState {
  return {
    messages: threadState.messages,
    isStreaming: threadState.isStreaming,
    currentStreamContent: threadState.currentStreamContent,
    pendingAssistantAttachments: threadState.pendingAssistantAttachments,
    currentTool: threadState.currentTool,
    currentStatusMessage: threadState.currentStatusMessage,
    currentSelectionCount: threadState.currentSelectionCount,
    currentRequestId: threadState.currentRequestId,
    ws: threadState.ws,
    connected: threadState.connected,
    queuedMessages: threadState.queuedMessages,
    targetAgentDeckSessionId: threadState.targetAgentDeckSessionId,
    draftAgentType: threadState.draftAgentType,
    selectedElements: threadState.selectedElements,
    selectionUndoStack: threadState.selectionUndoStack,
    selectionRedoStack: threadState.selectionRedoStack,
    activePreviewTool: threadState.activePreviewTool,
    targetUrl: threadState.targetUrl,
    activeTab: threadState.activeTab,
    viewportMode: threadState.viewportMode,
    authIssue: threadState.authIssue,
    showUrlHistory: threadState.showUrlHistory,
    previewTabs: threadState.previewTabs,
    activePreviewTabId: threadState.activePreviewTabId,
    urlHistory: threadState.urlHistory,
    urlHistoryCursor: threadState.urlHistoryCursor,
  }
}

function createStoreState(
  activeThreadKey: string,
  threadStates: Record<string, ThreadChatState>
): Pick<
  LiveEditorChatStore,
  | 'activeThreadKey'
  | 'threadStates'
  | keyof ActiveThreadViewState
> {
  const activeThreadState = getThreadStateSnapshot(threadStates, activeThreadKey)
  return {
    activeThreadKey,
    threadStates,
    ...buildActiveThreadViewState(activeThreadState),
  }
}

function createInitialStoreState(): Pick<
  LiveEditorChatStore,
  | 'activeThreadKey'
  | 'threadStates'
  | keyof ActiveThreadViewState
> {
  const initialDraftKey = createDraftThreadKey()
  return createStoreState(initialDraftKey, {
    [initialDraftKey]: createEmptyThreadState(),
  })
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

function shouldMirrorSelectionAttachmentsToAssistant(
  content: string,
  selectionAttachments: ChatAttachment[]
): boolean {
  if (selectionAttachments.length === 0) {
    return false
  }

  const normalized = content.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return (
    /\bscreenshot\b|\bscreen\s*shot\b|\bimage\b|\bpicture\b|\bphoto\b/.test(normalized)
    || (
      /\b(show|share|send)\b/.test(normalized)
      && /\b(this|that|it)\b/.test(normalized)
    )
  )
}

function resetThreadRuntimeState(
  threadState: ThreadChatState,
  overrides?: Partial<ThreadChatState>
): ThreadChatState {
  return {
    ...threadState,
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
    ...overrides,
  }
}

async function stageControllerUpdateNotice(options: {
  projectPath: string
  previewUrl: string | null
  activeMode: 'live-editor' | 'screenshot'
  requestId: string | null
}) {
  if (typeof fetch === 'undefined') {
    return
  }

  const requestLabel = options.requestId ? `request ${options.requestId}` : 'latest request'
  const summary = `Pixel Forge update from ${requestLabel} is ready to load.`
  const desktopApp = getDesktopApp()
  let update: PixelForgeDesktopPendingControllerUpdate

  if (hasDesktopAppMethod(desktopApp, 'stageControllerUpdate')) {
    update = await desktopApp.stageControllerUpdate({
      projectPath: options.projectPath,
      previewUrl: options.previewUrl,
      activeMode: options.activeMode,
      summary,
      source: 'live-editor',
      requestId: options.requestId,
      commitHash: null,
    })
  } else {
    const response = await fetch(`${HTTP_BACKEND_URL}/api/controller-update`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_path: options.projectPath,
        preview_url: options.previewUrl,
        active_mode: options.activeMode,
        summary,
        source: 'live-editor',
        request_id: options.requestId,
        commit_hash: null,
      }),
    })

    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const payload = await response.json() as { detail?: string }
        if (typeof payload.detail === 'string' && payload.detail) {
          message = payload.detail
        }
      } catch {
        const text = await response.text()
        if (text) {
          message = text
        }
      }
      throw new Error(message)
    }

    const payload = await response.json() as {
      update: PixelForgeDesktopPendingControllerUpdate
    }
    update = payload.update
  }

  useSessionStore.getState().setPendingControllerUpdate(update)
}

async function stagePreviewUpdateNotice(options: {
  projectPath: string
  workspacePath: string
  previewUrl: string | null
  activeMode: 'live-editor' | 'screenshot'
  requestId: string | null
  agentDeckSessionId: string | null
}) {
  if (typeof fetch === 'undefined') {
    return
  }

  const requestLabel = options.requestId ? `request ${options.requestId}` : 'latest request'
  const response = await fetch(`${HTTP_BACKEND_URL}/api/preview-updates`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_path: options.projectPath,
      workspace_path: options.workspacePath,
      preview_url: options.previewUrl,
      active_mode: options.activeMode,
      summary: `Pixel Forge preview from ${requestLabel} is ready to load.`,
      source: 'live-editor',
      request_id: options.requestId,
      agent_deck_session_id: options.agentDeckSessionId,
    }),
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = await response.json() as { detail?: string }
      if (typeof payload.detail === 'string' && payload.detail) {
        message = payload.detail
      }
    } catch {
      const text = await response.text()
      if (text) {
        message = text
      }
    }
    throw new Error(message)
  }

  const payload = await response.json() as {
    update: PixelForgePendingPreviewUpdate
  }
  useSessionStore.getState().setPendingPreviewUpdate(payload.update)
}

async function fetchObservedAgentDeckActivity(options: {
  projectPath: string
  threadId?: string | null
  agentDeckSessionId?: string | null
}) {
  const query = new URLSearchParams()
  if (options.threadId?.trim()) {
    query.set('thread_id', options.threadId.trim())
  }
  if (options.agentDeckSessionId?.trim()) {
    query.set('agent_deck_session_id', options.agentDeckSessionId.trim())
  }

  const response = await fetch(
    `${HTTP_BACKEND_URL}/api/projects/${encodeURIComponent(options.projectPath)}/chat-items/activity?${query.toString()}`,
    {
      credentials: 'include',
    }
  )

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = await response.json() as { detail?: string }
      if (typeof payload.detail === 'string' && payload.detail) {
        message = payload.detail
      }
    } catch {
      const text = await response.text()
      if (text) {
        message = text
      }
    }
    throw new Error(message)
  }

  return await response.json() as ObservedAgentDeckActivity
}

// ============================================================================
// Store
// ============================================================================

export const useLiveEditorStore = create<LiveEditorChatStore>((set, get) => {
  const threadPersistenceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let observedThreadKey: string | null = null
  let observedThreadPollTimer: ReturnType<typeof setTimeout> | null = null

  const resolveThreadSession = (threadKey: string | null | undefined) => {
    if (!threadKey) {
      return null
    }
    const sessionState = useSessionStore.getState()
    if (sessionState.liveEditorSession?.threadId === threadKey) {
      return sessionState.liveEditorSession
    }
    return sessionState.projectSessions.find((session) => session.threadId === threadKey) ?? null
  }

  const syncActiveThreadTargetSelection = (threadKey: string | null | undefined) => {
    const resolvedThreadKey = threadKey?.trim() || null
    const threadState = getThreadStateSnapshot(get().threadStates, resolvedThreadKey)
    const boundSession = resolveThreadSession(resolvedThreadKey)
    useSessionStore.getState().setSelectedAgentDeckTargetId(
      boundSession?.agentDeckSessionId ?? threadState.targetAgentDeckSessionId ?? null
    )
  }

  const getThreadPreviewUrl = (threadKey: string | null | undefined): string | null => {
    const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
    const activePreviewTab = threadState.previewTabs.find(
      (tab) => tab.id === threadState.activePreviewTabId
    ) ?? threadState.previewTabs[0] ?? null
    const normalizedTargetUrl = threadState.targetUrl.trim()
    if (normalizedTargetUrl) {
      return normalizedTargetUrl
    }
    const normalizedTabUrl = activePreviewTab?.url?.trim() || ''
    return normalizedTabUrl || null
  }

  const updateThreadState = (
    threadKey: string,
    updater: (threadState: ThreadChatState) => ThreadChatState
  ) => {
    set((state) => {
      const nextThreadState = updater(
        getThreadStateSnapshot(state.threadStates, threadKey)
      )
      const nextThreadStates = {
        ...state.threadStates,
        [threadKey]: nextThreadState,
      }

      if (threadKey === state.activeThreadKey) {
        return {
          threadStates: nextThreadStates,
          ...buildActiveThreadViewState(nextThreadState),
        }
      }

      return { threadStates: nextThreadStates }
    })
  }

  const stopObservedThreadPolling = () => {
    observedThreadKey = null
    if (observedThreadPollTimer) {
      clearTimeout(observedThreadPollTimer)
      observedThreadPollTimer = null
    }
  }

  const syncObservedAgentDeckActivity = async (threadKey: string) => {
    const sessionStore = useSessionStore.getState()
    const projectPath = sessionStore.projectPath
    const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
    const boundSession = resolveThreadSession(threadKey)
    const agentDeckSessionId =
      boundSession?.agentDeckSessionId
      ?? threadState.targetAgentDeckSessionId
      ?? null

    if (!projectPath || !agentDeckSessionId) {
      stopObservedThreadPolling()
      return
    }

    const hasNonObservedMessages = threadState.messages.some(
      (message) => !message.observedSessionId
    )
    if (
      hasNonObservedMessages
      || threadState.isStreaming
      || threadState.currentRequestId
    ) {
      stopObservedThreadPolling()
      return
    }

    try {
      const activity = await fetchObservedAgentDeckActivity({
        projectPath,
        threadId: boundSession?.threadId ?? threadKey,
        agentDeckSessionId,
      })
      if (observedThreadKey !== threadKey) {
        return
      }

      updateThreadState(threadKey, (currentState) => {
        const currentHasNonObservedMessages = currentState.messages.some(
          (message) => !message.observedSessionId
        )
        if (
          currentHasNonObservedMessages
          || currentState.isStreaming
          || currentState.currentRequestId
        ) {
          return currentState
        }

        const observedMessageId = `observed:${agentDeckSessionId}`
        const nextMessages = currentState.messages.filter(
          (message) => message.observedSessionId === agentDeckSessionId || !message.observedSessionId
        )
        const existingObservedIndex = nextMessages.findIndex(
          (message) => message.id === observedMessageId
        )

        let observedMessage: ChatMessage | null = null
        const meaningfulOutput = activity.output.trim()
        if (meaningfulOutput) {
          observedMessage = {
            id: observedMessageId,
            role: 'assistant',
            content: meaningfulOutput,
            timestamp: new Date(),
            observedSessionId: agentDeckSessionId,
          }
        } else if (activity.binding_state === 'attached') {
          const sessionLabel =
            activity.agent_deck_session_title?.trim()
            || agentDeckSessionId
          const statusLabel = activity.agent_deck_session_status?.trim() || 'connected'
          observedMessage = {
            id: observedMessageId,
            role: 'system',
            content: `Attached to Agent Deck session \`${sessionLabel}\` (${statusLabel}). Waiting for output...`,
            timestamp: new Date(),
            systemTone: 'info',
            observedSessionId: agentDeckSessionId,
          }
        }

        if (!observedMessage) {
          if (existingObservedIndex === -1) {
            return currentState
          }
          nextMessages.splice(existingObservedIndex, 1)
        } else if (existingObservedIndex === -1) {
          nextMessages.push(observedMessage)
        } else {
          nextMessages[existingObservedIndex] = observedMessage
        }

        return {
          ...currentState,
          messages: nextMessages,
        }
      })
    } catch (error) {
      if (observedThreadKey !== threadKey) {
        return
      }
      console.error('[live-editor] Failed to observe Agent Deck session:', error)
    } finally {
      if (observedThreadKey === threadKey) {
        observedThreadPollTimer = setTimeout(() => {
          void syncObservedAgentDeckActivity(threadKey)
        }, 1000)
      }
    }
  }

  const maybeObserveActiveThread = () => {
    const activeThreadKey = get().activeThreadKey
    const threadState = getThreadStateSnapshot(get().threadStates, activeThreadKey)
    const boundSession = resolveThreadSession(activeThreadKey)
    const agentDeckSessionId =
      boundSession?.agentDeckSessionId
      ?? threadState.targetAgentDeckSessionId
      ?? null
    const hasNonObservedMessages = threadState.messages.some(
      (message) => !message.observedSessionId
    )

    if (
      !agentDeckSessionId
      || hasNonObservedMessages
      || threadState.isStreaming
      || threadState.currentRequestId
    ) {
      stopObservedThreadPolling()
      return
    }

    if (observedThreadKey === activeThreadKey && observedThreadPollTimer) {
      return
    }

    stopObservedThreadPolling()
    observedThreadKey = activeThreadKey
    observedThreadPollTimer = setTimeout(() => {
      void syncObservedAgentDeckActivity(activeThreadKey)
    }, 0)
  }

  const closeThreadSocket = (threadKey: string, silent = true) => {
    const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
    const ws = threadState.ws
    if (!ws) {
      return
    }
    if (silent) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.onopen = null
    }
    try {
      ws.close()
    } catch {
      // Ignore socket teardown races.
    }
  }

  const migrateThreadState = (fromKey: string, toKey: string): string => {
    if (!fromKey || !toKey || fromKey === toKey) {
      return toKey || fromKey
    }

    set((state) => {
      const fromState = getThreadStateSnapshot(state.threadStates, fromKey)
      const nextThreadStates = {
        ...state.threadStates,
        [toKey]: fromState,
      }
      delete nextThreadStates[fromKey]

      return createStoreState(
        state.activeThreadKey === fromKey ? toKey : state.activeThreadKey,
        nextThreadStates
      )
    })

    syncActiveThreadTargetSelection(get().activeThreadKey)
    return toKey
  }

  const syncSessionRecord = (
    payload: {
      threadId: string
      backend: string
      workspacePath: string | null
      agentDeckSessionId: string | null
      agentDeckSessionTitle: string | null
      agentDeckTool: string | null
      requestId: string | null
    },
    options?: { activate?: boolean; sourceThreadKey?: string | null }
  ) => {
    const sessionStore = useSessionStore.getState()
    const session = {
      threadId: payload.threadId,
      backend: payload.backend,
      workspacePath: payload.workspacePath,
      agentDeckSessionId: payload.agentDeckSessionId,
      agentDeckSessionTitle: payload.agentDeckSessionTitle,
      agentDeckTool: payload.agentDeckTool,
      requestId: payload.requestId,
    }

    sessionStore.upsertProjectSession(session)

    const activeThreadId = sessionStore.liveEditorSession?.threadId ?? null
    if (
      options?.activate
      || activeThreadId === payload.threadId
      || (options?.sourceThreadKey && activeThreadId === options.sourceThreadKey)
    ) {
      sessionStore.setLiveEditorSession(session)
    }
    maybeObserveActiveThread()
  }

  const persistThreadSessionNow = async (threadKey: string) => {
    const sessionStore = useSessionStore.getState()
    const projectPath = sessionStore.projectPath
    if (!projectPath) {
      return
    }

    const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
    const boundSession = resolveThreadSession(threadKey)
    if (!shouldPersistThreadState(threadState, boundSession)) {
      return
    }

    const targetAgentDeckSessionId =
      boundSession?.agentDeckSessionId
      ?? threadState.targetAgentDeckSessionId
      ?? null
    const selectedTarget = targetAgentDeckSessionId
      ? sessionStore.agentDeckTargets.find((target) => target.id === targetAgentDeckSessionId) ?? null
      : null
    const savedSession = await sessionStore.persistProjectSession({
      threadId: threadKey,
      backend: boundSession?.backend ?? 'agent-deck',
      workspacePath:
        boundSession?.workspacePath
        ?? selectedTarget?.path
        ?? projectPath,
      agentDeckSessionId: targetAgentDeckSessionId,
      agentDeckSessionTitle:
        boundSession?.agentDeckSessionTitle
        ?? selectedTarget?.title
        ?? null,
      agentDeckTool:
        boundSession?.agentDeckTool
        ?? selectedTarget?.tool
        ?? null,
      requestId: boundSession?.requestId ?? null,
      editorState: buildPersistedEditorState(threadState),
    })

    if (savedSession && get().activeThreadKey === threadKey) {
      useSessionStore.getState().setLiveEditorSession({
        threadId: savedSession.threadId,
        backend: savedSession.backend,
        workspacePath: savedSession.workspacePath,
        agentDeckSessionId: savedSession.agentDeckSessionId,
        agentDeckSessionTitle: savedSession.agentDeckSessionTitle,
        agentDeckTool: savedSession.agentDeckTool,
        requestId: savedSession.requestId ?? null,
        editorState: savedSession.editorState ?? null,
      })
    }
    maybeObserveActiveThread()
  }

  const scheduleThreadPersistence = (threadKey: string, delay = 150) => {
    const existingTimer = threadPersistenceTimers.get(threadKey)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    threadPersistenceTimers.set(
      threadKey,
      setTimeout(() => {
        threadPersistenceTimers.delete(threadKey)
        void persistThreadSessionNow(threadKey).catch((error) => {
          console.error('[live-editor] Failed to persist thread state:', error)
        })
      }, delay)
    )
  }

  const appendSystemError = (threadKey: string, message: string) => {
    updateThreadState(threadKey, (threadState) => ({
      ...threadState,
      messages: [
        ...threadState.messages,
        {
          id: generateId(),
          role: 'system',
          content: message,
          timestamp: new Date(),
          systemTone: 'error',
        },
      ],
      isStreaming: false,
      currentStreamContent: '',
      pendingAssistantAttachments: [],
      currentStatusMessage: '',
      currentSelectionCount: 0,
      currentRequestId: null,
    }))
  }

  const connectThread = (
    initialThreadKey: string,
    endpoint = '/ws/live-editor'
  ) => {
    const existingThreadState = getThreadStateSnapshot(
      get().threadStates,
      initialThreadKey
    )
    if (
      existingThreadState.ws
      && (
        existingThreadState.ws.readyState === WebSocket.OPEN
        || existingThreadState.ws.readyState === WebSocket.CONNECTING
      )
    ) {
      return
    }

    const wsUrl = endpoint.startsWith('ws://') || endpoint.startsWith('wss://')
      ? endpoint
      : `${WS_BACKEND_URL}${endpoint}`
    const newWs = new WebSocket(wsUrl)
    let threadKeyRef = initialThreadKey

    newWs.onopen = () => {
      updateThreadState(threadKeyRef, (threadState) => {
        if (threadState.ws !== newWs) {
          return threadState
        }

        for (const queuedMessage of threadState.queuedMessages) {
          newWs.send(JSON.stringify(queuedMessage.payload))
        }

        return {
          ...threadState,
          connected: true,
          queuedMessages: [],
        }
      })
      console.log(`[live-editor] WebSocket connected for ${threadKeyRef}`)
    }

    newWs.onmessage = (event) => {
      const data = JSON.parse(event.data)

      switch (data.type) {
        case 'chunk':
          updateThreadState(threadKeyRef, (threadState) => ({
            ...threadState,
            currentStreamContent: threadState.currentStreamContent + data.content,
            currentStatusMessage:
              threadState.currentStatusMessage || 'Receiving agent response...',
          }))
          break

        case 'tool_use': {
          const toolCallId =
            typeof data.tool_call_id === 'string' && data.tool_call_id
              ? data.tool_call_id
              : null
          const toolActivity: ToolActivity = {
            id: generateId(),
            toolCallId,
            tool:
              typeof data.tool === 'string' && data.tool
                ? data.tool
                : 'Tool',
            input:
              data.input && typeof data.input === 'object'
                ? (data.input as Record<string, unknown>)
                : {},
            status: 'running',
          }

          updateThreadState(threadKeyRef, (threadState) => ({
            ...threadState,
            currentTool: toolActivity,
            currentStatusMessage: summarizeToolStatus(
              toolActivity.tool,
              toolActivity.input,
              'running'
            ),
            messages: [
              ...threadState.messages,
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
          const toolCallId =
            typeof data.tool_call_id === 'string' && data.tool_call_id
              ? data.tool_call_id
              : null

          updateThreadState(threadKeyRef, (threadState) => {
            const matchingMessage = [...threadState.messages].reverse().find((msg) => {
              if (msg.role !== 'tool' || !msg.toolActivity) {
                return false
              }
              if (toolCallId) {
                return msg.toolActivity.toolCallId === toolCallId
              }
              return threadState.currentTool
                ? msg.id === threadState.currentTool.id
                : false
            })

            if (!matchingMessage?.toolActivity) {
              return threadState
            }

            const updatedTool = {
              ...matchingMessage.toolActivity,
              result:
                typeof data.content === 'string'
                  ? data.content
                  : String(data.content ?? ''),
              isError: Boolean(data.is_error),
              status: 'complete' as const,
            }

            return {
              ...threadState,
              messages: threadState.messages.map((msg) =>
                msg.id === matchingMessage.id
                  ? {
                      ...msg,
                      toolActivity: updatedTool,
                    }
                  : msg
              ),
              currentTool:
                threadState.currentTool
                && threadState.currentTool.id === matchingMessage.toolActivity.id
                  ? null
                  : threadState.currentTool,
              currentStatusMessage: summarizeToolStatus(
                updatedTool.tool,
                updatedTool.input,
                updatedTool.isError ? 'error' : 'complete'
              ),
            }
          })
          break
        }

        case 'session': {
          const wasActiveThread = get().activeThreadKey === threadKeyRef
          const nextThreadId =
            typeof data.session_id === 'string' && data.session_id
              ? data.session_id
              : null

          if (nextThreadId) {
            threadKeyRef = migrateThreadState(threadKeyRef, nextThreadId)
            syncSessionRecord(
              {
                threadId: nextThreadId,
                backend: data.backend || 'agent-deck',
                workspacePath: data.workspace_path ?? null,
                agentDeckSessionId: data.agent_deck_session_id ?? null,
                agentDeckSessionTitle: data.agent_deck_session_title ?? null,
                agentDeckTool: data.agent_deck_tool ?? null,
                requestId: data.request_id ?? null,
              },
              { activate: wasActiveThread, sourceThreadKey: initialThreadKey }
            )
          }

          updateThreadState(threadKeyRef, (threadState) => ({
            ...threadState,
            currentRequestId:
              typeof data.request_id === 'string' && data.request_id
                ? data.request_id
                : threadState.currentRequestId,
            currentSelectionCount:
              Number.isFinite(Number(data.selection_count))
                ? Number(data.selection_count)
                : threadState.currentSelectionCount,
            targetAgentDeckSessionId:
              typeof data.agent_deck_session_id === 'string' && data.agent_deck_session_id
                ? data.agent_deck_session_id
                : threadState.targetAgentDeckSessionId,
          }))

          if (wasActiveThread) {
            syncActiveThreadTargetSelection(threadKeyRef)
          }
          break
        }

        case 'complete': {
          const threadState = getThreadStateSnapshot(get().threadStates, threadKeyRef)
          const wasActiveThread = get().activeThreadKey === threadKeyRef
          const nextThreadId =
            typeof data.session_id === 'string' && data.session_id
              ? data.session_id
              : null
          if (nextThreadId) {
            threadKeyRef = migrateThreadState(threadKeyRef, nextThreadId)
          }

          const sessionState = useSessionStore.getState()
          const knownSession =
            resolveThreadSession(threadKeyRef)
          const resolvedWorkspacePath =
            typeof data.workspace_path === 'string' && data.workspace_path.trim()
              ? data.workspace_path.trim()
              : knownSession?.workspacePath ?? null
          const resolvedAgentDeckSessionId =
            typeof data.agent_deck_session_id === 'string' && data.agent_deck_session_id
              ? data.agent_deck_session_id
              : knownSession?.agentDeckSessionId ?? null

          if (nextThreadId) {
            syncSessionRecord(
              {
                threadId: nextThreadId,
                backend: data.backend || 'agent-deck',
                workspacePath: resolvedWorkspacePath,
                agentDeckSessionId: resolvedAgentDeckSessionId,
                agentDeckSessionTitle:
                  data.agent_deck_session_title
                  ?? knownSession?.agentDeckSessionTitle
                  ?? null,
                agentDeckTool:
                  data.agent_deck_tool
                  ?? knownSession?.agentDeckTool
                  ?? null,
                requestId: data.request_id ?? null,
              },
              { activate: wasActiveThread, sourceThreadKey: initialThreadKey }
            )
          }

          const isRemoteTarget = !!data.is_remote_target
          const isSelfEditSafeMode = !!data.self_edit_safe_mode
          const selfEditScope =
            data.self_edit_scope === 'preview' || data.self_edit_scope === 'controller'
              ? data.self_edit_scope
              : null
          const cloneWorkspaceBound = isCloneWorkspaceBound({
            projectPath: sessionState.projectPath,
            workspacePath: resolvedWorkspacePath,
          })
          const canLoadPreviewUpdate = selfEditScope === 'preview'
            || (isSelfEditSafeMode && cloneWorkspaceBound)
          const canStageControllerUpdate = selfEditScope === 'controller'
            || (isSelfEditSafeMode && !cloneWorkspaceBound)
          const desktopApp = getDesktopApp()
          const canApplyControllerUpdate =
            canStageControllerUpdate
            && (
              hasDesktopAppMethod(desktopApp, 'startPendingControllerUpdate')
              || hasDesktopAppMethod(desktopApp, 'applyPendingControllerUpdate')
              || hasDesktopAppMethod(desktopApp, 'applyControllerUpdate')
            )
          const requestId =
            typeof data.request_id === 'string' && data.request_id
              ? data.request_id
              : threadState.currentRequestId
          const selectionCount =
            Number.isFinite(Number(data.selection_count))
              ? Number(data.selection_count)
              : threadState.currentSelectionCount
          const completionMessage: ChatMessage = {
            id: generateId(),
            role: 'system',
            content: buildCompletionSummary({
              requestId,
              selectionCount,
              selfEditSafeMode: canLoadPreviewUpdate,
              controllerUpdateStaged: canStageControllerUpdate,
              isRemoteTarget,
            }),
            timestamp: new Date(),
            isRemoteComplete: isRemoteTarget || undefined,
            systemTone: 'success',
            canLoadPreviewUpdate: canLoadPreviewUpdate || undefined,
            canApplyControllerUpdate: canApplyControllerUpdate || undefined,
          }

          updateThreadState(threadKeyRef, (currentThreadState) => {
            const nextMessages = [...currentThreadState.messages]
            if (currentThreadState.currentStreamContent) {
              nextMessages.push({
                id: generateId(),
                role: 'assistant',
                content: currentThreadState.currentStreamContent,
                attachments:
                  currentThreadState.pendingAssistantAttachments.length > 0
                    ? currentThreadState.pendingAssistantAttachments
                    : undefined,
                timestamp: new Date(),
              })
            } else if (currentThreadState.pendingAssistantAttachments.length > 0) {
              nextMessages.push({
                id: generateId(),
                role: 'assistant',
                content: '',
                attachments: currentThreadState.pendingAssistantAttachments,
                timestamp: new Date(),
              })
            }
            nextMessages.push(completionMessage)

            return resetThreadRuntimeState(currentThreadState, {
              messages: nextMessages,
              targetAgentDeckSessionId:
                resolvedAgentDeckSessionId ?? currentThreadState.targetAgentDeckSessionId,
            })
          })

          if (wasActiveThread) {
            syncActiveThreadTargetSelection(threadKeyRef)
          }

          if (canLoadPreviewUpdate) {
            if (sessionState.projectPath && resolvedWorkspacePath) {
              void stagePreviewUpdateNotice({
                projectPath: sessionState.projectPath,
                workspacePath: resolvedWorkspacePath,
                previewUrl: getThreadPreviewUrl(threadKeyRef),
                activeMode: sessionState.activeMode,
                requestId,
                agentDeckSessionId: resolvedAgentDeckSessionId,
              }).catch((error) => {
                console.error('[live-editor] Failed to stage preview update notice:', error)
              })
            }
          } else if (canStageControllerUpdate) {
            if (sessionState.projectPath) {
              void stageControllerUpdateNotice({
                projectPath: sessionState.projectPath,
                previewUrl: getThreadPreviewUrl(threadKeyRef),
                activeMode: sessionState.activeMode,
                requestId,
              }).catch((error) => {
                console.error('[live-editor] Failed to stage controller update notice:', error)
              })
            }
          }
          break
        }

        case 'error':
          updateThreadState(threadKeyRef, (threadState) =>
            resetThreadRuntimeState(threadState, {
              messages: [
                ...threadState.messages,
                {
                  id: generateId(),
                  role: 'assistant',
                  content: `Error: ${data.message}`,
                  timestamp: new Date(),
                },
              ],
            })
          )
          break

        case 'status':
          updateThreadState(threadKeyRef, (threadState) => ({
            ...threadState,
            currentStatusMessage: summarizeBackendStatus(
              typeof data.message === 'string' ? data.message : ''
            ),
          }))
          break
      }
    }

    newWs.onclose = () => {
      const threadState = getThreadStateSnapshot(get().threadStates, threadKeyRef)

      if (threadState.isStreaming) {
        const nextMessages = [...threadState.messages]
        if (threadState.currentStreamContent) {
          nextMessages.push({
            id: generateId(),
            role: 'assistant',
            content: threadState.currentStreamContent,
            attachments:
              threadState.pendingAssistantAttachments.length > 0
                ? threadState.pendingAssistantAttachments
                : undefined,
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
        updateThreadState(threadKeyRef, (currentThreadState) =>
          resetThreadRuntimeState(currentThreadState, {
            messages: nextMessages,
          })
        )
      } else {
        updateThreadState(threadKeyRef, (currentThreadState) => ({
          ...currentThreadState,
          ws: null,
          connected: false,
        }))
      }
      console.log(`[live-editor] WebSocket disconnected for ${threadKeyRef}`)
    }

    newWs.onerror = (error) => {
      console.error('[live-editor] WebSocket error:', error)
    }

    updateThreadState(threadKeyRef, (threadState) => ({
      ...threadState,
      ws: newWs,
      connected: false,
    }))
  }

  return {
    ...createInitialStoreState(),

    getActiveThreadState: () =>
      getThreadStateSnapshot(get().threadStates, get().activeThreadKey),
    getThreadState: (threadKey) =>
      getThreadStateSnapshot(get().threadStates, threadKey),
    getThreadStatus: (threadKey) => {
      const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
      return {
        connected: threadState.connected,
        currentStatusMessage: threadState.currentStatusMessage,
        isStreaming: threadState.isStreaming,
      }
    },
    getSessionId: () => useSessionStore.getState().liveEditorSession?.threadId ?? null,
    getProjectPath: () => useSessionStore.getState().projectPath,
    getTargetAgentDeckSessionId: (threadKey) => {
      const resolvedThreadKey = threadKey?.trim() || get().activeThreadKey
      const boundSession = resolveThreadSession(resolvedThreadKey)
      if (boundSession?.agentDeckSessionId) {
        return boundSession.agentDeckSessionId
      }
      return getThreadStateSnapshot(get().threadStates, resolvedThreadKey).targetAgentDeckSessionId
    },
    findThreadKeyByTargetAgentDeckSessionId: (sessionId) => {
      const normalizedSessionId = sessionId?.trim() || null
      if (!normalizedSessionId) {
        return null
      }

      for (const [threadKey, threadState] of Object.entries(get().threadStates)) {
        if (threadState.targetAgentDeckSessionId === normalizedSessionId) {
          return threadKey
        }
      }

      return null
    },

    activateThread: (threadKey) => {
      const nextThreadKey = threadKey?.trim() || createDraftThreadKey()
      set((state) => {
        const nextThreadStates = state.threadStates[nextThreadKey]
          ? state.threadStates
          : {
              ...state.threadStates,
              [nextThreadKey]: createEmptyThreadState(),
            }
        return createStoreState(nextThreadKey, nextThreadStates)
      })
      syncActiveThreadTargetSelection(nextThreadKey)
      maybeObserveActiveThread()
    },

    resetForProject: () => {
      for (const timer of threadPersistenceTimers.values()) {
        clearTimeout(timer)
      }
      threadPersistenceTimers.clear()
      stopObservedThreadPolling()
      const currentThreadStates = get().threadStates
      for (const threadKey of Object.keys(currentThreadStates)) {
        closeThreadSocket(threadKey, true)
      }
      set(createInitialStoreState())
    },

    hydrateProjectThreads: ({ projectSessions, activeThreadKey, previewUrl }) => {
      for (const timer of threadPersistenceTimers.values()) {
        clearTimeout(timer)
      }
      threadPersistenceTimers.clear()

      const nextThreadStates: Record<string, ThreadChatState> = {}
      const preferredThreadKey = activeThreadKey?.trim() || projectSessions[0]?.threadId || null

      for (const session of projectSessions) {
        nextThreadStates[session.threadId] = createThreadStateFromSession(
          session,
          preferredThreadKey === session.threadId ? previewUrl : null
        )
      }

      if (Object.keys(nextThreadStates).length === 0) {
        const draftThreadKey = preferredThreadKey || createDraftThreadKey()
        nextThreadStates[draftThreadKey] = {
          ...createEmptyThreadState(),
          ...createThreadEditorStateFromPersisted(null, previewUrl),
        }
      }

      const nextActiveThreadKey =
        (preferredThreadKey && nextThreadStates[preferredThreadKey] && preferredThreadKey)
        || Object.keys(nextThreadStates)[0]
        || createDraftThreadKey()

      set(createStoreState(nextActiveThreadKey, nextThreadStates))
      syncActiveThreadTargetSelection(nextActiveThreadKey)
      maybeObserveActiveThread()
    },

    persistThreadState: async (threadKey) => {
      const resolvedThreadKey = threadKey?.trim() || get().activeThreadKey
      const existingTimer = threadPersistenceTimers.get(resolvedThreadKey)
      if (existingTimer) {
        clearTimeout(existingTimer)
        threadPersistenceTimers.delete(resolvedThreadKey)
      }
      await persistThreadSessionNow(resolvedThreadKey)
    },

    connect: (endpoint = '/ws/live-editor') => {
      connectThread(get().activeThreadKey, endpoint)
    },

    disconnect: (threadKey) => {
      const resolvedThreadKey = threadKey?.trim() || get().activeThreadKey
      closeThreadSocket(resolvedThreadKey, true)
      updateThreadState(resolvedThreadKey, (threadState) =>
        resetThreadRuntimeState(threadState)
      )
    },

    disconnectAll: () => {
      stopObservedThreadPolling()
      const currentThreadStates = get().threadStates
      for (const threadKey of Object.keys(currentThreadStates)) {
        closeThreadSocket(threadKey, true)
      }
      set((state) => {
        const nextThreadStates = Object.fromEntries(
          Object.entries(state.threadStates).map(([threadKey, threadState]) => [
            threadKey,
            resetThreadRuntimeState(threadState),
          ])
        )
        return createStoreState(state.activeThreadKey, nextThreadStates)
      })
    },

    sendMessage: (content, attachments = []) => {
      const activeThreadKey = get().activeThreadKey
      const activeThreadState = getThreadStateSnapshot(
        get().threadStates,
        activeThreadKey
      )
      const { buildSelectionPayload, getProjectPath } = get()
      const trimmedContent = content.trim()
      const hasAttachments = attachments.length > 0
      const projectPath = getProjectPath()

      if (!trimmedContent && !hasAttachments) {
        return
      }

      if (!projectPath) {
        appendSystemError(
          activeThreadKey,
          'No project path configured. Please select a project first.'
        )
        return
      }

      const {
        elementContext,
        selectionTunnel,
        selectionAttachments,
      } = buildSelectionPayload()
      const requestAttachments = [...selectionAttachments, ...attachments]
      const pendingAssistantAttachments = shouldMirrorSelectionAttachmentsToAssistant(
        trimmedContent,
        selectionAttachments
      )
        ? selectionAttachments
        : []
      const userVisibleContent =
        trimmedContent
        || buildAttachmentSummary(attachments)
      const sessionState = useSessionStore.getState()
      const boundSession = resolveThreadSession(activeThreadKey)
      const targetAgentDeckSessionId =
        boundSession?.agentDeckSessionId
        ?? activeThreadState.targetAgentDeckSessionId
        ?? null
      const conflictingThread = targetAgentDeckSessionId
        ? sessionState.projectSessions.find(
            (session) =>
              session.threadId !== activeThreadKey
              && session.agentDeckSessionId === targetAgentDeckSessionId
          ) ?? null
        : null

      if (conflictingThread) {
        appendSystemError(
          activeThreadKey,
          `Agent Deck session ${targetAgentDeckSessionId} is already bound to Live Editor thread ${conflictingThread.threadId}. Switch to that thread or choose a different session.`
        )
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        messages: [
          ...threadState.messages,
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
        pendingAssistantAttachments,
        currentStatusMessage:
          selectionTunnel.selections.length > 0
            ? `Preparing request with ${selectionTunnel.selections.length} selection${selectionTunnel.selections.length === 1 ? '' : 's'}...`
            : 'Preparing live edit request...',
        currentSelectionCount: selectionTunnel.selections.length,
        currentRequestId: null,
      }))
      stopObservedThreadPolling()

      const previewUrl = getThreadPreviewUrl(activeThreadKey)
      const selectedTarget =
        sessionState.agentDeckTargets.find(
          (target) => target.id === targetAgentDeckSessionId
        ) ?? null
      const agentType =
        boundSession?.agentDeckTool
        || selectedTarget?.tool
        || activeThreadState.draftAgentType
        || sessionState.defaultAgentType
        || 'claude'
      const payload: Record<string, unknown> = {
        message: trimmedContent,
        project_path: projectPath,
        element_context: elementContext,
        preview_url: previewUrl || '',
        agent_type: agentType,
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

      if (boundSession?.threadId) {
        payload.thread_id = boundSession.threadId
      }

      if (targetAgentDeckSessionId) {
        payload.target_agent_deck_session_id = targetAgentDeckSessionId
      }

      if (!activeThreadState.ws || activeThreadState.ws.readyState !== WebSocket.OPEN) {
        updateThreadState(activeThreadKey, (threadState) => ({
          ...threadState,
          queuedMessages: [...threadState.queuedMessages, { payload }],
          currentStatusMessage: 'Reconnecting Live Editor… request queued.',
        }))
        connectThread(activeThreadKey)
        return
      }

      activeThreadState.ws.send(JSON.stringify(payload))
    },

    clearMessages: () => {
      updateThreadState(get().activeThreadKey, (threadState) =>
        resetThreadRuntimeState(threadState, {
          messages: [],
        })
      )
      maybeObserveActiveThread()
    },

    newSession: (targetAgentDeckSessionId = null) => {
      const nextDraftKey = createDraftThreadKey()
      const nextThreadState = {
        ...createEmptyThreadState(),
        targetAgentDeckSessionId: targetAgentDeckSessionId?.trim() || null,
      }
      useSessionStore.getState().clearLiveEditorSession()
      useSessionStore.getState().setSelectedAgentDeckTargetId(
        nextThreadState.targetAgentDeckSessionId
      )
      set((state) =>
        createStoreState(nextDraftKey, {
          ...state.threadStates,
          [nextDraftKey]: nextThreadState,
        })
      )
      scheduleThreadPersistence(nextDraftKey, 0)
      maybeObserveActiveThread()
    },

    removeThread: (threadKey, fallbackThreadKey = null) => {
      const resolvedThreadKey = threadKey?.trim() || null
      if (!resolvedThreadKey) {
        return
      }

      closeThreadSocket(resolvedThreadKey, true)
      let nextActiveThreadKey: string | null = null

      set((state) => {
        const nextThreadStates = { ...state.threadStates }
        delete nextThreadStates[resolvedThreadKey]

        const normalizedFallbackThreadKey = fallbackThreadKey?.trim() || null
        if (state.activeThreadKey === resolvedThreadKey) {
          nextActiveThreadKey =
            (normalizedFallbackThreadKey && nextThreadStates[normalizedFallbackThreadKey]
              ? normalizedFallbackThreadKey
              : null)
            ?? Object.keys(nextThreadStates)[0]
            ?? createDraftThreadKey()
        } else {
          nextActiveThreadKey = state.activeThreadKey
        }

        if (nextActiveThreadKey && !nextThreadStates[nextActiveThreadKey]) {
          nextThreadStates[nextActiveThreadKey] = createEmptyThreadState()
        }

        return createStoreState(
          nextActiveThreadKey ?? createDraftThreadKey(),
          nextThreadStates
        )
      })

      syncActiveThreadTargetSelection(nextActiveThreadKey)
      maybeObserveActiveThread()
    },

    setTargetAgentDeckSessionId: (sessionId) => {
      const activeThreadKey = get().activeThreadKey
      const normalizedSessionId = sessionId?.trim() || null
      const boundSession = resolveThreadSession(activeThreadKey)
      if (
        boundSession?.agentDeckSessionId
        && boundSession.agentDeckSessionId !== normalizedSessionId
      ) {
        appendSystemError(
          activeThreadKey,
          'This Live Editor thread is already bound. Start a fresh live thread to target a different Agent Deck session.'
        )
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        targetAgentDeckSessionId: normalizedSessionId,
      }))
      useSessionStore.getState().setSelectedAgentDeckTargetId(normalizedSessionId)
      scheduleThreadPersistence(activeThreadKey)
      maybeObserveActiveThread()
    },

    setDraftAgentType: (agentType) => {
      const activeThreadKey = get().activeThreadKey
      const normalizedAgentType = normalizeDraftAgentType(agentType)
      const boundSession = resolveThreadSession(activeThreadKey)
      const targetedSessionId = get().getTargetAgentDeckSessionId(activeThreadKey)
      if (boundSession?.agentDeckSessionId || targetedSessionId) {
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        draftAgentType: normalizedAgentType,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setActivePreviewTool: (tool) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        activePreviewTool: tool === 'select' ? 'select' : null,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setTargetUrl: (url) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        targetUrl: url,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setActiveTab: (tab) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        activeTab: tab,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setViewportMode: (mode) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        viewportMode: mode,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setAuthIssue: (issue) => {
      updateThreadState(get().activeThreadKey, (threadState) => ({
        ...threadState,
        authIssue: issue,
      }))
    },

    setShowUrlHistory: (next) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        showUrlHistory: resolveStateSetterValue(next, threadState.showUrlHistory),
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setPreviewTabs: (next) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        previewTabs: resolveStateSetterValue(next, threadState.previewTabs),
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setActivePreviewTabId: (tabId) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        activePreviewTabId: tabId,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setUrlHistory: (next) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        urlHistory: resolveStateSetterValue(next, threadState.urlHistory),
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setUrlHistoryCursor: (next) => {
      const activeThreadKey = get().activeThreadKey
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        urlHistoryCursor: resolveStateSetterValue(next, threadState.urlHistoryCursor),
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    addElement: (element) => {
      const activeThreadKey = get().activeThreadKey
      const { selectedElements, selectionUndoStack } = get().getActiveThreadState()

      if (selectedElements.some((entry) => entry.id === element.id)) {
        console.log('[live-editor] Element already selected')
        return
      }

      const newElement: SelectedElement = {
        ...element,
        timestamp: new Date(),
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: [...selectedElements, newElement],
        selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
        selectionRedoStack: [],
      }))
    },

    removeElement: (id) => {
      const activeThreadKey = get().activeThreadKey
      const { selectedElements, selectionUndoStack } = get().getActiveThreadState()
      if (!selectedElements.some((entry) => entry.id === id)) {
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: selectedElements.filter((entry) => entry.id !== id),
        selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
        selectionRedoStack: [],
      }))
    },

    removeElements: (ids) => {
      const idSet = new Set(ids)
      if (idSet.size === 0) {
        return
      }

      const activeThreadKey = get().activeThreadKey
      const { selectedElements, selectionUndoStack } = get().getActiveThreadState()
      const nextSelections = selectedElements.filter((entry) => !idSet.has(entry.id))
      if (nextSelections.length === selectedElements.length) {
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: nextSelections,
        selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
        selectionRedoStack: [],
      }))
    },

    replaceElement: (id, element) => {
      const activeThreadKey = get().activeThreadKey
      const { selectedElements, selectionUndoStack } = get().getActiveThreadState()
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

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: nextSelections,
        selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
        selectionRedoStack: [],
      }))
    },

    clearElements: () => {
      const activeThreadKey = get().activeThreadKey
      const { selectedElements, selectionUndoStack } = get().getActiveThreadState()
      if (selectedElements.length === 0) {
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: [],
        selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
        selectionRedoStack: [],
      }))
    },

    undoSelectionChange: () => {
      const activeThreadKey = get().activeThreadKey
      const {
        selectionUndoStack,
        selectionRedoStack,
        selectedElements,
      } = get().getActiveThreadState()
      if (selectionUndoStack.length === 0) {
        return
      }

      const previousSnapshot = selectionUndoStack[selectionUndoStack.length - 1]
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: cloneSelectionState(previousSnapshot),
        selectionUndoStack: selectionUndoStack.slice(0, -1),
        selectionRedoStack: pushUndoSnapshot(selectionRedoStack, selectedElements),
      }))
    },

    redoSelectionChange: () => {
      const activeThreadKey = get().activeThreadKey
      const {
        selectionUndoStack,
        selectionRedoStack,
        selectedElements,
      } = get().getActiveThreadState()
      if (selectionRedoStack.length === 0) {
        return
      }

      const nextSnapshot = selectionRedoStack[selectionRedoStack.length - 1]
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: cloneSelectionState(nextSnapshot),
        selectionUndoStack: pushUndoSnapshot(selectionUndoStack, selectedElements),
        selectionRedoStack: selectionRedoStack.slice(0, -1),
      }))
    },

    buildSelectionPayload: () => {
      const { selectedElements } = get().getActiveThreadState()

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
  }
})
