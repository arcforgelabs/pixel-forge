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
import { getResponseErrorMessage, readResponsePayload } from '@/lib/http-response'
import {
  findLatestRecoverablePdfUrl,
  normalizePersistedPreviewUrl,
} from '@/lib/preview-url'
import type {
  DraftWorkspaceMode,
  LiveEditorSessionMeta,
  PersistedPreviewTab,
  PersistedThreadEditorState,
  PersistedWorkspacePreviewMeta,
  ProjectSessionRecord,
} from '@/store/session-store'
import type {
  PixelForgeDesktopPendingControllerUpdate,
  PixelForgeDesktopPreviewTool,
  PixelForgePendingPreviewUpdate,
} from '@/types/pixel-forge-desktop'
import {
  selectActiveProjectSessions,
  useSessionStore,
} from '../../../store/session-store'

const OBSERVED_THREAD_RECENT_EVENT_LIMIT = 80
import {
  buildSelectionArtifacts,
  type SelectionRecord,
} from '../selection-engine'
import { createPlainTextDataUrl } from '../composer-attachments'
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
  kind: 'image' | 'file' | 'paste'
  label?: string
  inlineToken?: string
  textContent?: string
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
  replayDraft?: ReplayDraftSnapshot
}

export interface SelectedElement extends SelectionRecord {
  timestamp: Date
}

interface PendingOutboundMessage {
  payload: Record<string, unknown>
}

interface ComposerSeed {
  content: string
  attachments: ChatAttachment[]
}

interface ReplayDraftSnapshot {
  projectPath: string | null
  editorState: PersistedThreadEditorState
  selectedElements: SelectedElement[]
  content: string
  attachments: ChatAttachment[]
}

interface ObservedAgentDeckActivity {
  chat_id?: string | null
  thread_id: string | null
  agent_deck_session_id: string | null
  agent_deck_session_title: string | null
  agent_deck_tool: string | null
  agent_deck_session_status: string | null
  workspace_path: string | null
  binding_state: 'attached' | 'detached'
  output: string
}

interface ObservedAgentDeckActivityEvent extends ObservedAgentDeckActivity {
  id: number
  event_type: 'activity'
}

interface ObservedAgentDeckSessionStatusEvent {
  id: number
  event_type: 'session_status'
  chat_id?: string | null
  thread_id: string | null
  agent_deck_session_id: string | null
  agent_deck_session_title: string | null
  agent_deck_tool: string | null
  agent_deck_session_status: string | null
  workspace_path: string | null
  binding_state: 'attached' | 'detached'
  message?: string
}

interface ObservedAgentDeckSessionOutputEvent {
  id: number
  event_type: 'session_output'
  chat_id?: string | null
  thread_id: string | null
  agent_deck_session_id: string | null
  agent_deck_session_title: string | null
  agent_deck_tool: string | null
  agent_deck_session_status: string | null
  workspace_path: string | null
  binding_state: 'attached' | 'detached'
  output: string
}

type ObservedAgentDeckTurnEventType =
  | 'turn_input'
  | 'turn_started'
  | 'turn_status'
  | 'turn_chunk'
  | 'turn_tool_use'
  | 'turn_tool_result'
  | 'turn_completed'
  | 'turn_failed'

interface ObservedAgentDeckTurnEvent {
  id: number
  event_type: ObservedAgentDeckTurnEventType
  chat_id?: string | null
  thread_id: string | null
  request_id: string | null
  agent_deck_session_id: string | null
  agent_deck_session_title?: string | null
  agent_deck_tool?: string | null
  workspace_path?: string | null
  message?: string
  content?: string
  assistant_output?: string | null
  turn_input?: {
    prompt_text?: string
    [key: string]: unknown
  }
  tool_call_id?: string | null
  tool?: string | null
  input?: Record<string, unknown> | null
  is_error?: boolean | null
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

export interface WorkspacePreviewMeta {
  kind: 'workspace-preview'
  workspacePath: string
  workspaceRoot: string
  appPath: string
  relativeAppPath: string
  title: string
  scriptName: string
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun'
  framework: string | null
  preferredPort: number | null
  instanceSlug: string
  createdAt: string | null
}

export interface PreviewTab {
  id: string
  url: string
  title: string
  mode: PreviewMode
  proxySessionId: string | null
  browserTabId: string | null
  canGoBack?: boolean
  canGoForward?: boolean
  frameSrc: string
  snapshotDataUrl: string | null
  localTarget: LocalTargetMeta | null
  workspacePreview: WorkspacePreviewMeta | null
}

export interface PreviewAuthIssue {
  status: number
  url: string
}

export interface ThreadEditorState {
  draftAgentType: string
  draftWorkspaceMode: DraftWorkspaceMode
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
  projectPath: string | null
  messages: ChatMessage[]
  isStreaming: boolean
  isObservedStreaming: boolean
  currentStreamContent: string
  pendingAssistantAttachments: ChatAttachment[]
  currentTool: ToolActivity | null
  currentStatusMessage: string
  currentSelectionCount: number
  currentRequestId: string | null
  ws: WebSocket | null
  connected: boolean
  queuedMessages: PendingOutboundMessage[]
  pendingComposerSeed: ComposerSeed | null
  targetAgentDeckSessionId: string | null
  draftAgentType: string
  draftWorkspaceMode: DraftWorkspaceMode
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
  lastReplayDraft: ReplayDraftSnapshot | null
}

interface ActiveThreadViewState {
  projectPath: string | null
  messages: ChatMessage[]
  isStreaming: boolean
  isObservedStreaming: boolean
  currentStreamContent: string
  pendingAssistantAttachments: ChatAttachment[]
  currentTool: ToolActivity | null
  currentStatusMessage: string
  currentSelectionCount: number
  currentRequestId: string | null
  ws: WebSocket | null
  connected: boolean
  queuedMessages: PendingOutboundMessage[]
  pendingComposerSeed: ComposerSeed | null
  targetAgentDeckSessionId: string | null
  draftAgentType: string
  draftWorkspaceMode: DraftWorkspaceMode
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
  lastReplayDraft: ReplayDraftSnapshot | null
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
  chatScrollPositions: Record<string, number>
  saveChatScrollPosition: (threadKey: string, scrollTop: number) => void

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
  openStatusBus: () => void
  closeStatusBus: () => void
  sendMessage: (
    content: string,
    attachments?: ChatAttachment[],
    agentModel?: string | null,
    agentThinking?: string | null,
  ) => void
  replayMessageIntoNewChat: (messageId: string) => Promise<void>
  retryMessageInCurrentChat: (messageId: string) => Promise<void>
  consumePendingComposerSeed: (threadKey?: string | null) => ComposerSeed | null
  clearMessages: () => void
  newSession: (targetAgentDeckSessionId?: string | null) => void
  removeThread: (threadKey: string | null | undefined, fallbackThreadKey?: string | null) => void
  setTargetAgentDeckSessionId: (sessionId: string | null) => void
  setDraftAgentType: (agentType: string) => void
  setDraftWorkspaceMode: (workspaceMode: DraftWorkspaceMode) => void
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
  ) => Pick<ThreadChatState, 'connected' | 'currentStatusMessage' | 'isStreaming' | 'isObservedStreaming'>
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
  return (
    agentType === 'codex'
    || agentType === 'gemini'
    || agentType === 'pi'
    || agentType === 'openclaw'
  )
    ? agentType
    : 'claude'
}

function normalizeDraftWorkspaceMode(
  workspaceMode: string | null | undefined
): DraftWorkspaceMode {
  void workspaceMode
  return 'root'
}

function getDefaultDraftAgentType(): string {
  return normalizeDraftAgentType(useSessionStore.getState().defaultAgentType)
}

function getDefaultDraftWorkspaceMode(): DraftWorkspaceMode {
  return normalizeDraftWorkspaceMode(useSessionStore.getState().defaultWorkspaceMode)
}

function getCurrentProjectPathSnapshot(): string | null {
  return useSessionStore.getState().projectPath?.trim() || null
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
    pdfTextRange: element.pdfTextRange ? { ...element.pdfTextRange } : null,
    timestamp: new Date(element.timestamp),
  }
}

function cloneSelectionState(elements: SelectedElement[]): SelectedElement[] {
  return elements.map(cloneSelectedElement)
}

function cloneChatAttachment(attachment: ChatAttachment): ChatAttachment {
  return {
    ...attachment,
  }
}

function cloneChatAttachments(attachments: ChatAttachment[] | undefined): ChatAttachment[] {
  return (attachments ?? []).map(cloneChatAttachment)
}

function createEmptyPreviewTab(index = 1): PreviewTab {
  return {
    id: `preview-${generateId()}`,
    url: '',
    title: `Tab ${index}`,
    mode: null,
    proxySessionId: null,
    browserTabId: null,
    canGoBack: false,
    canGoForward: false,
    frameSrc: 'about:blank',
    snapshotDataUrl: null,
    localTarget: null,
    workspacePreview: null,
  }
}

function restoreWorkspacePreviewMeta(
  workspacePreview: PersistedWorkspacePreviewMeta | null | undefined
): WorkspacePreviewMeta | null {
  if (!workspacePreview) {
    return null
  }
  return {
    ...workspacePreview,
    framework: workspacePreview.framework ?? null,
    preferredPort: workspacePreview.preferredPort ?? null,
  }
}

function createEmptyThreadEditorState(
  draftAgentType: string = getDefaultDraftAgentType(),
  draftWorkspaceMode: DraftWorkspaceMode = getDefaultDraftWorkspaceMode(),
): ThreadEditorState {
  const initialPreviewTab = createEmptyPreviewTab()
  return {
    draftAgentType: normalizeDraftAgentType(draftAgentType),
    draftWorkspaceMode: normalizeDraftWorkspaceMode(draftWorkspaceMode),
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

function createEmptyThreadState(projectPath: string | null = getCurrentProjectPathSnapshot()): ThreadChatState {
  return {
    projectPath,
    messages: [],
    isStreaming: false,
    isObservedStreaming: false,
    currentStreamContent: '',
    pendingAssistantAttachments: [],
    currentTool: null,
    currentStatusMessage: '',
    currentSelectionCount: 0,
    currentRequestId: null,
    ws: null,
    connected: false,
    queuedMessages: [],
    pendingComposerSeed: null,
    targetAgentDeckSessionId: null,
    selectedElements: [],
    selectionUndoStack: [],
    selectionRedoStack: [],
    lastReplayDraft: null,
    ...createEmptyThreadEditorState(),
  }
}

function collapseDuplicateHistoryEntries(entries: string[]): string[] {
  return entries.filter((entry, index) => entry !== entries[index - 1])
}

function restorePreviewTab(
  tab: PersistedPreviewTab,
  index: number,
  fallbackUrl?: string | null
): PreviewTab {
  const normalizedUrl = normalizePersistedPreviewUrl(tab.url, fallbackUrl)
  return {
    id: tab.id,
    url: normalizedUrl,
    title: tab.title || `Tab ${index}`,
    mode: tab.mode,
    proxySessionId: null,
    browserTabId: null,
    canGoBack: false,
    canGoForward: false,
    frameSrc: 'about:blank',
    snapshotDataUrl: null,
    localTarget: tab.localTarget
      ? {
          ...tab.localTarget,
          audienceWorkspacePath: tab.localTarget.audienceWorkspacePath ?? null,
        }
      : null,
    workspacePreview: restoreWorkspacePreviewMeta(tab.workspacePreview),
  }
}

function persistPreviewTab(
  tab: PreviewTab,
  fallbackUrl?: string | null
): PersistedPreviewTab {
  return {
    id: tab.id,
    url: normalizePersistedPreviewUrl(tab.url, fallbackUrl),
    title: tab.title,
    mode: tab.mode,
    localTarget: tab.localTarget
      ? {
          ...tab.localTarget,
          audienceWorkspacePath: tab.localTarget.audienceWorkspacePath ?? null,
        }
      : null,
    workspacePreview: tab.workspacePreview
      ? {
          ...tab.workspacePreview,
          framework: tab.workspacePreview.framework ?? null,
          preferredPort: tab.workspacePreview.preferredPort ?? null,
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

  const recoveredPdfUrl = findLatestRecoverablePdfUrl([
    ...editorState.urlHistory,
    ...editorState.previewTabs.map((tab) => tab.url),
    normalizedFallbackUrl,
  ])

  const restoredTabs = editorState.previewTabs.length > 0
    ? editorState.previewTabs.map((tab, index) => restorePreviewTab(tab, index + 1, recoveredPdfUrl))
    : createEmptyThreadEditorState().previewTabs

  const activePreviewTabId = restoredTabs.some((tab) => tab.id === editorState.activePreviewTabId)
    ? editorState.activePreviewTabId
    : restoredTabs[0]?.id ?? null
  const targetUrl =
    normalizePersistedPreviewUrl(editorState.targetUrl, recoveredPdfUrl)
    || restoredTabs.find((tab) => tab.id === activePreviewTabId)?.url?.trim()
    || normalizedFallbackUrl
  const urlHistory = collapseDuplicateHistoryEntries(
    editorState.urlHistory
      .map((entry) => normalizePersistedPreviewUrl(entry, recoveredPdfUrl))
      .filter((entry) => entry.trim())
  )
  const urlHistoryCursor = urlHistory.length > 0
    ? Math.max(-1, Math.min(editorState.urlHistoryCursor, urlHistory.length - 1))
    : -1

  return {
    draftAgentType: normalizeDraftAgentType(
      editorState.draftAgentType || getDefaultDraftAgentType()
    ),
    draftWorkspaceMode: normalizeDraftWorkspaceMode(editorState.draftWorkspaceMode),
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
  const recoveredPdfUrl = findLatestRecoverablePdfUrl([
    threadState.targetUrl,
    ...threadState.previewTabs.map((tab) => tab.url),
    ...threadState.urlHistory,
  ])

  return {
    draftAgentType: normalizeDraftAgentType(threadState.draftAgentType),
    draftWorkspaceMode: normalizeDraftWorkspaceMode(threadState.draftWorkspaceMode),
    activePreviewTool: threadState.activePreviewTool === 'select' ? 'select' : null,
    targetUrl: normalizePersistedPreviewUrl(threadState.targetUrl.trim(), recoveredPdfUrl),
    activeTab: threadState.activeTab,
    viewportMode: threadState.viewportMode,
    showUrlHistory: threadState.showUrlHistory,
    previewTabs: threadState.previewTabs.map((tab) => persistPreviewTab(tab, recoveredPdfUrl)),
    activePreviewTabId: threadState.activePreviewTabId,
    urlHistory: collapseDuplicateHistoryEntries(
      threadState.urlHistory
        .map((entry) => normalizePersistedPreviewUrl(entry.trim(), recoveredPdfUrl))
        .filter(Boolean)
    ),
    urlHistoryCursor: threadState.urlHistoryCursor,
  }
}

function buildReplayDraftSnapshot(
  threadState: ThreadChatState,
  content: string,
  attachments: ChatAttachment[] | undefined
): ReplayDraftSnapshot {
  return {
    projectPath: threadState.projectPath,
    editorState: buildPersistedEditorState(threadState),
    selectedElements: cloneSelectionState(threadState.selectedElements),
    content,
    attachments: cloneChatAttachments(attachments),
  }
}

function cloneReplayDraftSnapshot(
  draft: ReplayDraftSnapshot | undefined
): ReplayDraftSnapshot | undefined {
  if (!draft) {
    return undefined
  }
  return {
    projectPath: draft.projectPath,
    editorState: draft.editorState,
    selectedElements: cloneSelectionState(draft.selectedElements),
    content: draft.content,
    attachments: cloneChatAttachments(draft.attachments),
  }
}

function findLastUserReplayDraft(
  messages: ChatMessage[]
): ReplayDraftSnapshot | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.role === 'user' && candidate.replayDraft) {
      return candidate.replayDraft
    }
  }
  return undefined
}

function createThreadStateFromSession(
  session: LiveEditorSessionMeta,
  fallbackUrl?: string | null
): ThreadChatState {
  return {
    ...createEmptyThreadState(session.projectPath?.trim() || null),
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

  if (threadState.draftWorkspaceMode !== 'root') {
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
    projectPath: threadState.projectPath,
    messages: threadState.messages,
    isStreaming: threadState.isStreaming,
    isObservedStreaming: threadState.isObservedStreaming,
    currentStreamContent: threadState.currentStreamContent,
    pendingAssistantAttachments: threadState.pendingAssistantAttachments,
    currentTool: threadState.currentTool,
    currentStatusMessage: threadState.currentStatusMessage,
    currentSelectionCount: threadState.currentSelectionCount,
    currentRequestId: threadState.currentRequestId,
    ws: threadState.ws,
    connected: threadState.connected,
    queuedMessages: threadState.queuedMessages,
    pendingComposerSeed: threadState.pendingComposerSeed,
    targetAgentDeckSessionId: threadState.targetAgentDeckSessionId,
    draftAgentType: threadState.draftAgentType,
    draftWorkspaceMode: threadState.draftWorkspaceMode,
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
    lastReplayDraft: threadState.lastReplayDraft,
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
  const pasteCount = attachments.filter(
    (attachment) => attachment.kind === 'paste'
  ).length
  const fileCount = attachments.filter(
    (attachment) => attachment.kind === 'file'
  ).length

  if (imageCount > 0 && fileCount === 0 && pasteCount === 0) {
    return imageCount === 1
      ? 'Attached 1 reference image.'
      : `Attached ${imageCount} reference images.`
  }

  if (fileCount > 0 && imageCount === 0 && pasteCount === 0) {
    return fileCount === 1
      ? 'Attached 1 reference file.'
      : `Attached ${fileCount} reference files.`
  }

  if (pasteCount > 0 && imageCount === 0 && fileCount === 0) {
    return pasteCount === 1
      ? 'Attached 1 pasted reference.'
      : `Attached ${pasteCount} pasted references.`
  }

  const parts: string[] = []
  if (imageCount > 0) {
    parts.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`)
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`)
  }
  if (pasteCount > 0) {
    parts.push(`${pasteCount} paste${pasteCount === 1 ? '' : 's'}`)
  }

  return `Attached ${parts.join(', ')}.`
}

function resolveAttachmentDataUrl(attachment: ChatAttachment): string {
  if (attachment.dataUrl) {
    return attachment.dataUrl
  }
  if (attachment.kind === 'paste' && attachment.textContent) {
    return createPlainTextDataUrl(attachment.textContent)
  }
  return ''
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
    isObservedStreaming: false,
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
  activeMode: 'live-editor' | 'screenshot' | 'logo-forge'
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
      const payload = await readResponsePayload(response)
      throw new Error(getResponseErrorMessage(response, payload))
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
  activeMode: 'live-editor' | 'screenshot' | 'logo-forge'
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
    const payload = await readResponsePayload(response)
    throw new Error(getResponseErrorMessage(response, payload))
  }

  const payload = await response.json() as {
    update: PixelForgePendingPreviewUpdate
  }
  useSessionStore.getState().setPendingPreviewUpdate(payload.update)
}

// ============================================================================
// Store
// ============================================================================

export const useLiveEditorStore = create<LiveEditorChatStore>((set, get) => {
  const threadPersistenceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let observedThreadKey: string | null = null
  let observedThreadFromNow = false
  let observedThreadEventSource: EventSource | null = null
  const observedThreadHasPrimaryEvents = new Set<string>()
  let statusBusEventSource: EventSource | null = null
  let statusBusReconnectTimer: ReturnType<typeof setTimeout> | null = null

  const resolveThreadSession = (threadKey: string | null | undefined) => {
    if (!threadKey) {
      return null
    }
    const sessionState = useSessionStore.getState()
    if (sessionState.liveEditorSession?.threadId === threadKey) {
      return sessionState.liveEditorSession
    }
    return selectActiveProjectSessions(sessionState).find(
      (session) => session.threadId === threadKey
    ) ?? null
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

  const canHydrateObservedThread = (threadState: ThreadChatState) => {
    const currentHasNonObservedMessages = threadState.messages.some(
      (message) => !message.observedSessionId
    )
    return !currentHasNonObservedMessages && !threadState.isStreaming && !threadState.currentRequestId
  }

  const canObserveThreadEvents = (threadState: ThreadChatState) =>
    !threadState.isStreaming && !threadState.currentRequestId

  const upsertObservedMessage = (
    messages: ChatMessage[],
    nextMessage: ChatMessage
  ): ChatMessage[] => {
    const nextMessages = [...messages]
    const existingIndex = nextMessages.findIndex((message) => message.id === nextMessage.id)
    if (existingIndex === -1) {
      nextMessages.push(nextMessage)
    } else {
      nextMessages[existingIndex] = nextMessage
    }
    return nextMessages
  }

  const removeObservedMessage = (messages: ChatMessage[], messageId: string): ChatMessage[] =>
    messages.filter((message) => message.id !== messageId)

  const observedSnapshotMessageId = (agentDeckSessionId: string) =>
    `observed:snapshot:${agentDeckSessionId}`

  const observedSessionStatusMessageId = (agentDeckSessionId: string) =>
    `observed:session-status:${agentDeckSessionId}`

  const observedTurnMessageId = (requestId: string) => `observed:turn:${requestId}`

  const observedTurnStatusMessageId = (requestId: string) => `observed:status:${requestId}`

  const observedTurnFailureMessageId = (requestId: string) => `observed:error:${requestId}`

  const applyObservedAgentDeckActivity = (
    threadKey: string,
    activity: ObservedAgentDeckActivity
  ) => {
    updateThreadState(threadKey, (currentState) => {
      if (!canHydrateObservedThread(currentState) || observedThreadHasPrimaryEvents.has(threadKey)) {
        return currentState
      }

      const agentDeckSessionId = activity.agent_deck_session_id?.trim() || null
      if (!agentDeckSessionId) {
        return {
          ...currentState,
          messages: currentState.messages.filter((message) => !message.observedSessionId),
        }
      }

      const observedMessageId = observedSnapshotMessageId(agentDeckSessionId)
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
  }

  const applyObservedSessionStatusEvent = (
    threadKey: string,
    event: ObservedAgentDeckSessionStatusEvent
  ) => {
    observedThreadHasPrimaryEvents.add(threadKey)
    updateThreadState(threadKey, (currentState) => {
      if (!canObserveThreadEvents(currentState)) {
        return currentState
      }

      const agentDeckSessionId = event.agent_deck_session_id?.trim() || null
      if (!agentDeckSessionId) {
        return currentState
      }

      const statusMessageId = observedSessionStatusMessageId(agentDeckSessionId)
      const normalizedStatus = event.agent_deck_session_status?.trim().toLowerCase() || ''
      const hasObservedOutput = currentState.messages.some(
        (message) =>
          message.role === 'assistant'
          && message.observedSessionId === agentDeckSessionId
      )
      const content =
        event.message?.trim()
        || (
          normalizedStatus === 'error'
            ? `Agent Deck session \`${event.agent_deck_session_title?.trim() || agentDeckSessionId}\` entered an error state.`
            : normalizedStatus && !hasObservedOutput && !['idle', 'waiting'].includes(normalizedStatus)
              ? `Attached to Agent Deck session \`${event.agent_deck_session_title?.trim() || agentDeckSessionId}\` (${normalizedStatus}).`
              : ''
        )

      let nextMessages = currentState.messages
      if (!content || (hasObservedOutput && ['idle', 'waiting'].includes(normalizedStatus))) {
        nextMessages = removeObservedMessage(nextMessages, statusMessageId)
      } else {
        nextMessages = upsertObservedMessage(nextMessages, {
          id: statusMessageId,
          role: normalizedStatus === 'error' ? 'system' : 'system',
          content,
          timestamp: new Date(),
          systemTone: normalizedStatus === 'error' ? 'error' : 'info',
          observedSessionId: agentDeckSessionId,
        })
      }

      return {
        ...currentState,
        messages: nextMessages,
      }
    })
  }

  const applyObservedSessionOutputEvent = (
    threadKey: string,
    event: ObservedAgentDeckSessionOutputEvent
  ) => {
    observedThreadHasPrimaryEvents.add(threadKey)
    updateThreadState(threadKey, (currentState) => {
      if (!canObserveThreadEvents(currentState)) {
        return currentState
      }

      const agentDeckSessionId = event.agent_deck_session_id?.trim() || null
      if (!agentDeckSessionId) {
        return currentState
      }

      const output = event.output?.trim() || ''
      const snapshotMessageId = observedSnapshotMessageId(agentDeckSessionId)
      const statusMessageId = observedSessionStatusMessageId(agentDeckSessionId)
      let nextMessages = currentState.messages
      if (!output) {
        nextMessages = removeObservedMessage(nextMessages, snapshotMessageId)
      } else {
        const hasTurnScopedObservedOutput = nextMessages.some(
          (message) =>
            message.role === 'assistant'
            && message.observedSessionId === agentDeckSessionId
            && message.id !== snapshotMessageId
        )
        if (hasTurnScopedObservedOutput) {
          nextMessages = removeObservedMessage(nextMessages, snapshotMessageId)
          if (['idle', 'waiting'].includes(event.agent_deck_session_status?.trim().toLowerCase() || '')) {
            nextMessages = removeObservedMessage(nextMessages, statusMessageId)
          }
          return {
            ...currentState,
            messages: nextMessages,
          }
        }
        nextMessages = upsertObservedMessage(nextMessages, {
          id: snapshotMessageId,
          role: 'assistant',
          content: output,
          timestamp: new Date(),
          observedSessionId: agentDeckSessionId,
        })
        if (['idle', 'waiting'].includes(event.agent_deck_session_status?.trim().toLowerCase() || '')) {
          nextMessages = removeObservedMessage(nextMessages, statusMessageId)
        }
      }

      return {
        ...currentState,
        messages: nextMessages,
      }
    })
  }

  const applyObservedTurnEvent = (
    threadKey: string,
    event: ObservedAgentDeckTurnEvent
  ) => {
    observedThreadHasPrimaryEvents.add(threadKey)
    updateThreadState(threadKey, (currentState) => {
      if (!canObserveThreadEvents(currentState)) {
        return currentState
      }

      const requestId = event.request_id?.trim() || `event-${event.id}`
      const agentDeckSessionId = event.agent_deck_session_id?.trim() || null
      const assistantMessageId = observedTurnMessageId(requestId)
      const statusMessageId = observedTurnStatusMessageId(requestId)
      const failureMessageId = observedTurnFailureMessageId(requestId)
      const sessionLabel =
        event.agent_deck_session_title?.trim()
        || agentDeckSessionId
        || 'Agent Deck session'

      let nextMessages = currentState.messages
      if (agentDeckSessionId) {
        nextMessages = removeObservedMessage(
          nextMessages,
          observedSnapshotMessageId(agentDeckSessionId)
        )
        nextMessages = removeObservedMessage(
          nextMessages,
          observedSessionStatusMessageId(agentDeckSessionId)
        )
      }

      switch (event.event_type) {
        case 'turn_input': {
          // Replay user prompt text when hydrating from historical events.
          const promptText = event.turn_input?.prompt_text?.trim() || event.content?.trim()
          if (!promptText) {
            return currentState
          }
          return {
            ...currentState,
            messages: upsertObservedMessage(nextMessages, {
              id: `observed:input:${requestId}`,
              role: 'user',
              content: promptText,
              timestamp: new Date(),
              observedSessionId: agentDeckSessionId,
            }),
          }
        }

        case 'turn_started': {
          nextMessages = removeObservedMessage(nextMessages, failureMessageId)
          return {
            ...currentState,
            isObservedStreaming: true,
            messages: upsertObservedMessage(nextMessages, {
              id: statusMessageId,
              role: 'system',
              content: `Attached to Agent Deck session \`${sessionLabel}\`. Waiting for output...`,
              timestamp: new Date(),
              systemTone: 'info',
              observedSessionId: agentDeckSessionId,
            }),
          }
        }

        case 'turn_status': {
          const statusText = event.message?.trim()
          if (!statusText) {
            return currentState
          }
          nextMessages = removeObservedMessage(nextMessages, failureMessageId)
          return {
            ...currentState,
            messages: upsertObservedMessage(nextMessages, {
              id: statusMessageId,
              role: 'system',
              content: statusText,
              timestamp: new Date(),
              systemTone: 'info',
              observedSessionId: agentDeckSessionId,
            }),
          }
        }

        case 'turn_chunk': {
          const chunk = event.content ?? ''
          if (!chunk) {
            return currentState
          }
          const existingMessage = nextMessages.find((message) => message.id === assistantMessageId)
          return {
            ...currentState,
            messages: upsertObservedMessage(nextMessages, {
              id: assistantMessageId,
              role: 'assistant',
              content: `${existingMessage?.content ?? ''}${chunk}`,
              timestamp: new Date(),
              observedSessionId: agentDeckSessionId,
            }),
          }
        }

        case 'turn_tool_use': {
          const toolName =
            typeof event.tool === 'string' && event.tool
              ? event.tool
              : 'Tool'
          const toolCallId =
            typeof event.tool_call_id === 'string' && event.tool_call_id
              ? event.tool_call_id
              : null
          const toolInput =
            event.input && typeof event.input === 'object'
              ? (event.input as Record<string, unknown>)
              : {}
          const toolMessageId = `observed:tool:${requestId}:${toolCallId ?? `idx-${event.id}`}`
          const toolActivity: ToolActivity = {
            id: toolMessageId,
            toolCallId,
            tool: toolName,
            input: toolInput,
            status: 'running',
          }
          return {
            ...currentState,
            messages: upsertObservedMessage(nextMessages, {
              id: toolMessageId,
              role: 'tool',
              content: '',
              timestamp: new Date(),
              observedSessionId: agentDeckSessionId,
              toolActivity,
            }),
          }
        }

        case 'turn_tool_result': {
          const toolCallId =
            typeof event.tool_call_id === 'string' && event.tool_call_id
              ? event.tool_call_id
              : null
          const resultContent =
            typeof event.content === 'string' ? event.content : ''
          const isError = Boolean(event.is_error)
          const matchingMessage = [...nextMessages].reverse().find((message) => {
            if (message.role !== 'tool' || !message.toolActivity) return false
            if (toolCallId) return message.toolActivity.toolCallId === toolCallId
            return message.observedSessionId === agentDeckSessionId
              && message.toolActivity.status === 'running'
          })
          if (!matchingMessage?.toolActivity) {
            const fallbackId = `observed:tool:${requestId}:${toolCallId ?? `idx-${event.id}`}`
            const fallbackActivity: ToolActivity = {
              id: fallbackId,
              toolCallId,
              tool: 'Tool',
              input: {},
              status: 'complete',
              result: resultContent,
              isError,
            }
            return {
              ...currentState,
              messages: upsertObservedMessage(nextMessages, {
                id: fallbackId,
                role: 'tool',
                content: '',
                timestamp: new Date(),
                observedSessionId: agentDeckSessionId,
                toolActivity: fallbackActivity,
              }),
            }
          }
          const updatedTool: ToolActivity = {
            ...matchingMessage.toolActivity,
            result: resultContent,
            isError,
            status: 'complete',
          }
          return {
            ...currentState,
            messages: nextMessages.map((message) =>
              message.id === matchingMessage.id
                ? { ...message, toolActivity: updatedTool }
                : message
            ),
          }
        }

        case 'turn_completed': {
          nextMessages = removeObservedMessage(nextMessages, statusMessageId)
          nextMessages = removeObservedMessage(nextMessages, failureMessageId)
          const hasAssistantMessage = nextMessages.some(
            (message) => message.id === assistantMessageId
          )
          const assistantOutput = event.assistant_output?.trim() || ''
          if (!hasAssistantMessage && assistantOutput) {
            nextMessages = upsertObservedMessage(nextMessages, {
              id: assistantMessageId,
              role: 'assistant',
              content: assistantOutput,
              timestamp: new Date(),
              observedSessionId: agentDeckSessionId,
            })
          }
          return {
            ...currentState,
            isObservedStreaming: false,
            messages: nextMessages,
          }
        }

        case 'turn_failed': {
          const failureText = event.message?.trim() || 'Observed Agent Deck turn failed.'
          nextMessages = removeObservedMessage(nextMessages, statusMessageId)
          const replayDraft = cloneReplayDraftSnapshot(findLastUserReplayDraft(nextMessages))
          return {
            ...currentState,
            isObservedStreaming: false,
            messages: upsertObservedMessage(nextMessages, {
              id: failureMessageId,
              role: 'system',
              content: failureText,
              timestamp: new Date(),
              systemTone: 'error',
              observedSessionId: agentDeckSessionId,
              replayDraft,
            }),
          }
        }
      }

      return currentState
    })
  }

  const stopObservedThreadStreaming = () => {
    if (observedThreadKey) {
      observedThreadHasPrimaryEvents.delete(observedThreadKey)
    }
    observedThreadKey = null
    observedThreadFromNow = false
    if (observedThreadEventSource) {
      observedThreadEventSource.close()
      observedThreadEventSource = null
    }
  }

  const openStatusBus = () => {
    if (statusBusReconnectTimer) {
      clearTimeout(statusBusReconnectTimer)
      statusBusReconnectTimer = null
    }
    if (statusBusEventSource) return
    if (typeof EventSource === 'undefined') return

    const url = new URL(`${HTTP_BACKEND_URL}/api/events/status-bus`)
    url.searchParams.set('from_now', '1')

    const es = new EventSource(url.toString(), { withCredentials: true })
    statusBusEventSource = es

    const handleStatusBusEvent = (event: Event) => {
      try {
        const messageEvent = event as MessageEvent<string>
        if (typeof messageEvent.data !== 'string') return
        const payload = JSON.parse(messageEvent.data) as {
          chat_id?: string | null
          thread_id?: string | null
          event_type?: string
        }
        const chatId = (payload.chat_id || payload.thread_id || '').trim()
        if (!chatId) return
        const isObservedStreaming = event.type === 'turn_started'
        set((state) => {
          const threadState = state.threadStates[chatId]
          if (!threadState) return state
          if (threadState.isObservedStreaming === isObservedStreaming) return state
          return {
            threadStates: {
              ...state.threadStates,
              [chatId]: { ...threadState, isObservedStreaming },
            },
          }
        })
      } catch (error) {
        console.error('[status-bus] Failed to parse event:', error)
      }
    }

    for (const eventType of ['turn_started', 'turn_completed', 'turn_failed']) {
      es.addEventListener(eventType, handleStatusBusEvent as EventListener)
    }

    es.onerror = () => {
      if (statusBusEventSource !== es) return
      statusBusEventSource = null
      es.close()
      statusBusReconnectTimer = setTimeout(() => {
        statusBusReconnectTimer = null
        openStatusBus()
      }, 3_000)
    }
  }

  const closeStatusBus = () => {
    if (statusBusReconnectTimer) {
      clearTimeout(statusBusReconnectTimer)
      statusBusReconnectTimer = null
    }
    const es = statusBusEventSource
    statusBusEventSource = null
    es?.close()
  }

  const startObservedAgentDeckActivityStream = (
    threadKey: string,
    options?: { fromNow?: boolean }
  ) => {
    const sessionStore = useSessionStore.getState()
    const projectPath = sessionStore.projectPath
    const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
    const boundSession = resolveThreadSession(threadKey)
    const chatId = boundSession?.threadId ?? threadKey
    const agentDeckSessionId =
      boundSession?.agentDeckSessionId
      ?? threadState.targetAgentDeckSessionId
      ?? null
    const fromNow = options?.fromNow === true

    if (!projectPath || !chatId || !agentDeckSessionId || typeof EventSource === 'undefined') {
      stopObservedThreadStreaming()
      return
    }

    if (!canObserveThreadEvents(threadState)) {
      stopObservedThreadStreaming()
      return
    }

    stopObservedThreadStreaming()
    if (!fromNow) {
      observedThreadHasPrimaryEvents.delete(threadKey)
      updateThreadState(threadKey, (currentState) => {
        if (!canHydrateObservedThread(currentState)) {
          return currentState
        }
        const nextMessages = currentState.messages.filter((message) => !message.observedSessionId)
        if (nextMessages.length === currentState.messages.length) {
          return currentState
        }
        return {
          ...currentState,
          messages: nextMessages,
        }
      })
    }
    observedThreadKey = threadKey
    observedThreadFromNow = fromNow

    const eventStreamUrl = new URL(
      `${HTTP_BACKEND_URL}/api/projects/${encodeURIComponent(projectPath)}/chats/${encodeURIComponent(chatId)}/events`
    )
    if (fromNow) {
      eventStreamUrl.searchParams.set('from_now', '1')
      eventStreamUrl.searchParams.set('recent_limit', String(OBSERVED_THREAD_RECENT_EVENT_LIMIT))
    }

    const eventSource = new EventSource(
      eventStreamUrl.toString(),
      { withCredentials: true }
    )
    observedThreadEventSource = eventSource

    const handleObservedEvent = (event: Event) => {
      if (observedThreadKey !== threadKey) {
        return
      }

      try {
        const messageEvent = event as MessageEvent<string>
        if (typeof messageEvent.data !== 'string') {
          return
        }
        const payload = JSON.parse(messageEvent.data) as
          | ObservedAgentDeckActivityEvent
          | ObservedAgentDeckSessionStatusEvent
          | ObservedAgentDeckSessionOutputEvent
          | ObservedAgentDeckTurnEvent
        if (payload.event_type === 'activity') {
          applyObservedAgentDeckActivity(threadKey, payload)
          return
        }
        if (payload.event_type === 'session_status') {
          applyObservedSessionStatusEvent(threadKey, payload)
          return
        }
        if (payload.event_type === 'session_output') {
          applyObservedSessionOutputEvent(threadKey, payload)
          return
        }
        applyObservedTurnEvent(threadKey, payload as ObservedAgentDeckTurnEvent)
      } catch (error) {
        console.error('[live-editor] Failed to parse workstation event:', error)
      }
    }

    for (const eventType of [
      'activity',
      'session_status',
      'session_output',
      'turn_input',
      'turn_started',
      'turn_status',
      'turn_chunk',
      'turn_tool_use',
      'turn_tool_result',
      'turn_completed',
      'turn_failed',
    ]) {
      eventSource.addEventListener(eventType, handleObservedEvent as EventListener)
    }

    eventSource.onerror = (error) => {
      if (observedThreadKey !== threadKey) {
        return
      }
      console.error('[live-editor] Workstation event stream error:', error)
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
    if (!agentDeckSessionId || !canObserveThreadEvents(threadState)) {
      stopObservedThreadStreaming()
      return
    }

    const fromNow = true

    if (
      observedThreadKey === activeThreadKey
      && observedThreadEventSource
      && observedThreadFromNow === fromNow
    ) {
      return
    }

    startObservedAgentDeckActivityStream(activeThreadKey, { fromNow })
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

    if (observedThreadKey === fromKey) {
      stopObservedThreadStreaming()
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
      projectPath: string | null
      threadId: string
      backend: string
      workspacePath: string | null
      providerId?: string | null
      providerSessionId?: string | null
      providerSessionTitle?: string | null
      providerAgentId?: string | null
      agentDeckSessionId: string | null
      agentDeckSessionTitle: string | null
      agentDeckTool: string | null
      requestId: string | null
    },
    options?: { activate?: boolean; sourceThreadKey?: string | null }
  ) => {
    const sessionStore = useSessionStore.getState()
    const session = {
      projectPath: payload.projectPath,
      threadId: payload.threadId,
      backend: payload.backend,
      workspacePath: payload.workspacePath,
      providerId: payload.providerId ?? (payload.agentDeckSessionId ? 'agent-deck' : null),
      providerSessionId: payload.providerSessionId ?? payload.agentDeckSessionId,
      providerSessionTitle: payload.providerSessionTitle ?? payload.agentDeckSessionTitle,
      providerAgentId: payload.providerAgentId ?? payload.agentDeckTool,
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
    const threadState = getThreadStateSnapshot(get().threadStates, threadKey)
    const projectPath =
      threadState.projectPath?.trim() || sessionStore.projectPath?.trim() || null
    if (!projectPath) {
      return
    }
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
      projectPath,
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

    const resolvedThreadKey =
      savedSession && savedSession.threadId !== threadKey
        ? migrateThreadState(threadKey, savedSession.threadId)
        : threadKey

    if (savedSession && get().activeThreadKey === resolvedThreadKey) {
      useSessionStore.getState().setLiveEditorSession({
        projectPath: savedSession.projectPath,
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
    updateThreadState(threadKey, (threadState) => {
      const replayDraft = cloneReplayDraftSnapshot(
        findLastUserReplayDraft(threadState.messages)
          ?? threadState.lastReplayDraft
          ?? undefined
      )
      return {
        ...threadState,
        messages: [
          ...threadState.messages,
          {
            id: generateId(),
            role: 'system',
            content: message,
            timestamp: new Date(),
            systemTone: 'error',
            replayDraft,
          },
        ],
        isStreaming: false,
        currentStreamContent: '',
        pendingAssistantAttachments: [],
        currentStatusMessage: '',
        currentSelectionCount: threadState.selectedElements.length,
        currentRequestId: null,
      }
    })
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
                projectPath:
                  getThreadStateSnapshot(get().threadStates, threadKeyRef).projectPath
                  ?? getCurrentProjectPathSnapshot(),
                threadId: nextThreadId,
                backend: data.backend || 'agent-deck',
                workspacePath: data.workspace_path ?? null,
                providerId: data.provider_id ?? (data.agent_deck_session_id ? 'agent-deck' : null),
                providerSessionId: data.provider_session_id ?? data.agent_deck_session_id ?? null,
                providerSessionTitle:
                  data.provider_session_title ?? data.agent_deck_session_title ?? null,
                providerAgentId: data.provider_agent_id ?? data.agent_deck_tool ?? null,
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
          const threadProjectPath =
            threadState.projectPath?.trim() || getCurrentProjectPathSnapshot()
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
                projectPath:
                  getThreadStateSnapshot(get().threadStates, threadKeyRef).projectPath
                  ?? threadProjectPath,
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
            projectPath: threadProjectPath,
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
            if (threadProjectPath && resolvedWorkspacePath) {
              void stagePreviewUpdateNotice({
                projectPath: threadProjectPath,
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
            if (threadProjectPath) {
              void stageControllerUpdateNotice({
                projectPath: threadProjectPath,
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

        case 'error': {
          const errorMessage =
            typeof data.message === 'string' && data.message.trim()
              ? data.message
              : 'Live Editor request failed.'
          appendSystemError(threadKeyRef, errorMessage)
          break
        }

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
        isObservedStreaming: threadState.isObservedStreaming,
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
      const existingSession = resolveThreadSession(nextThreadKey)
      const previewUrl = useSessionStore.getState().previewUrl
      set((state) => {
        const nextThreadStates = state.threadStates[nextThreadKey]
          ? state.threadStates
          : {
              ...state.threadStates,
              [nextThreadKey]: existingSession
                ? createThreadStateFromSession(existingSession, previewUrl)
                : createEmptyThreadState(),
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
      stopObservedThreadStreaming()
      const currentThreadStates = get().threadStates
      for (const threadKey of Object.keys(currentThreadStates)) {
        closeThreadSocket(threadKey, true)
      }
      set(createInitialStoreState())
    },

    hydrateProjectThreads: ({ projectSessions, activeThreadKey, previewUrl }) => {
      const currentThreadStates = get().threadStates
      const nextThreadStates: Record<string, ThreadChatState> = { ...currentThreadStates }
      const preferredThreadKey = activeThreadKey?.trim() || projectSessions[0]?.threadId || null

      for (const session of projectSessions) {
        if (nextThreadStates[session.threadId]) {
          continue
        }
        nextThreadStates[session.threadId] = createThreadStateFromSession(
          session,
          preferredThreadKey === session.threadId ? previewUrl : null
        )
      }

      if (Object.keys(nextThreadStates).length === 0) {
        const draftThreadKey = preferredThreadKey || createDraftThreadKey()
        nextThreadStates[draftThreadKey] = {
          ...createEmptyThreadState(getCurrentProjectPathSnapshot()),
          ...createThreadEditorStateFromPersisted(null, previewUrl),
        }
      }

      const nextActiveThreadKey =
        (preferredThreadKey && nextThreadStates[preferredThreadKey] && preferredThreadKey)
        || Object.keys(nextThreadStates)[0]
        || createDraftThreadKey()

      if (get().activeThreadKey !== nextActiveThreadKey && observedThreadKey && observedThreadKey !== nextActiveThreadKey) {
        stopObservedThreadStreaming()
      }

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

    openStatusBus,
    closeStatusBus,

    disconnectAll: () => {
      closeStatusBus()
      stopObservedThreadStreaming()
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

    sendMessage: (
      content,
      attachments = [],
      agentModel: string | null = null,
      agentThinking: string | null = null,
    ) => {
      const activeThreadKey = get().activeThreadKey
      const activeThreadState = getThreadStateSnapshot(
        get().threadStates,
        activeThreadKey
      )
      const { buildSelectionPayload, getProjectPath } = get()
      const trimmedContent = content.trim()
      const hasAttachments = attachments.length > 0
      const sessionProjectPath = getProjectPath()

      if (!trimmedContent && !hasAttachments) {
        return
      }

      if (!sessionProjectPath) {
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
      const projectPath =
        activeThreadState.projectPath?.trim() || sessionProjectPath
      if (
        activeThreadState.projectPath?.trim()
        && sessionProjectPath
        && activeThreadState.projectPath.trim() !== sessionProjectPath
      ) {
        appendSystemError(
          activeThreadKey,
          'This draft belongs to a different project. Reopen the correct chat or replay the prompt into a fresh chat for this project.'
        )
        return
      }
      const targetAgentDeckSessionId =
        boundSession?.agentDeckSessionId
        ?? activeThreadState.targetAgentDeckSessionId
        ?? null
      const conflictingThread = targetAgentDeckSessionId
        ? selectActiveProjectSessions(sessionState).find(
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

      const freshReplayDraft = buildReplayDraftSnapshot(
        activeThreadState,
        trimmedContent,
        attachments
      )
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
            replayDraft: cloneReplayDraftSnapshot(freshReplayDraft),
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
        lastReplayDraft: cloneReplayDraftSnapshot(freshReplayDraft) ?? null,
      }))
      stopObservedThreadStreaming()

      const previewUrl = getThreadPreviewUrl(activeThreadKey)
      const activePreviewTab = activeThreadState.previewTabs.find(
        (tab) => tab.id === activeThreadState.activePreviewTabId
      ) ?? activeThreadState.previewTabs[0] ?? null
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
      const workspaceMode = normalizeDraftWorkspaceMode(activeThreadState.draftWorkspaceMode)
      void (async () => {
        let livePreviewPayload: Record<string, unknown> | null = null
        if (activePreviewTab) {
          livePreviewPayload = {
            preview_tab_id: activePreviewTab.id,
            mode: activePreviewTab.mode,
            title: activePreviewTab.title,
            url: activePreviewTab.url,
            browser_tab_id: activePreviewTab.browserTabId,
            proxy_session_id: activePreviewTab.proxySessionId,
          }

          const desktopPreview = (
            globalThis as typeof globalThis & {
              pixelForgeDesktop?: Window['pixelForgeDesktop']
            }
          ).pixelForgeDesktop?.preview
          if (
            activePreviewTab.mode === 'browser'
            && activePreviewTab.browserTabId
            && desktopPreview?.inspect
          ) {
            try {
              const inspectionResponse = await desktopPreview.inspect(
                activePreviewTab.browserTabId,
                {
                  selectionHints: selectionTunnel.selections,
                }
              )
              if (inspectionResponse.inspection) {
                livePreviewPayload.inspection = inspectionResponse.inspection
              }
              if (inspectionResponse.target_url?.trim()) {
                livePreviewPayload.url = inspectionResponse.target_url
              }
              if (inspectionResponse.title?.trim()) {
                livePreviewPayload.title = inspectionResponse.title
              }
            } catch (error) {
              console.warn('[pixel-forge] Failed to inspect desktop preview before send', error)
            }
          }
        }

        const payload: Record<string, unknown> = {
          message: trimmedContent,
          project_path: projectPath,
          element_context: elementContext,
          preview_url: previewUrl || '',
          agent_type: agentType,
        }

        if (typeof agentModel === 'string' && agentModel.trim().length > 0) {
          payload.agent_model = agentModel.trim()
        }

        if (typeof agentThinking === 'string' && agentThinking.trim().length > 0) {
          payload.agent_thinking = agentThinking.trim()
        }

        if (!boundSession?.agentDeckSessionId && !targetAgentDeckSessionId) {
          payload.workspace_mode = workspaceMode
        }

        if (livePreviewPayload) {
          payload.live_preview = livePreviewPayload
        }

        if (requestAttachments.length > 0) {
          payload.attachments = requestAttachments.map((attachment) => ({
            name: attachment.name,
            mime_type: attachment.mimeType,
            data_url: resolveAttachmentDataUrl(attachment),
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
          payload.target_provider_id = 'agent-deck'
          payload.target_provider_session_id = targetAgentDeckSessionId
        }

        const latestThreadState = getThreadStateSnapshot(
          get().threadStates,
          activeThreadKey
        )
        if (!latestThreadState.ws || latestThreadState.ws.readyState !== WebSocket.OPEN) {
          updateThreadState(activeThreadKey, (threadState) => ({
            ...threadState,
            queuedMessages: [...threadState.queuedMessages, { payload }],
            currentStatusMessage: 'Reconnecting Live Editor… request queued.',
          }))
          connectThread(activeThreadKey)
          return
        }

        latestThreadState.ws.send(JSON.stringify(payload))
      })()
    },

    replayMessageIntoNewChat: async (messageId) => {
      const activeThreadKey = get().activeThreadKey
      const sourceThreadState = getThreadStateSnapshot(get().threadStates, activeThreadKey)
      const sourceMessage = sourceThreadState.messages.find((message) => message.id === messageId)
      if (!sourceMessage || !sourceMessage.replayDraft) {
        throw new Error('That prompt can no longer be replayed.')
      }

      const replayDraft = sourceMessage.replayDraft
      const sessionStore = useSessionStore.getState()
      const targetProjectPath =
        replayDraft.projectPath?.trim() || sessionStore.projectPath?.trim() || null
      if (!targetProjectPath) {
        throw new Error('Project path is required to replay this prompt.')
      }

      if (sessionStore.projectPath?.trim() !== targetProjectPath) {
        await sessionStore.setProject({ path: targetProjectPath })
      }

      const created = await useSessionStore.getState().createProjectChatSession({
        agentType:
          replayDraft.editorState.draftAgentType
          ?? sourceThreadState.draftAgentType
          ?? useSessionStore.getState().defaultAgentType,
        workspaceMode:
          replayDraft.editorState.draftWorkspaceMode
          ?? sourceThreadState.draftWorkspaceMode
          ?? 'root',
        reuseEmptyDraft: false,
      })

      if (!created.threadId) {
        throw new Error('Failed to create a fresh chat for replay.')
      }

      const createdSession = selectActiveProjectSessions(useSessionStore.getState()).find(
        (session) => session.threadId === created.threadId
      ) ?? null
      if (createdSession) {
        useSessionStore.getState().switchToThread(createdSession)
      }
      get().activateThread(created.threadId)

      updateThreadState(created.threadId, (threadState) => ({
        ...threadState,
        projectPath: targetProjectPath,
        targetAgentDeckSessionId: null,
        selectedElements: cloneSelectionState(replayDraft.selectedElements),
        selectionUndoStack: [],
        selectionRedoStack: [],
        pendingComposerSeed: {
          content: replayDraft.content,
          attachments: cloneChatAttachments(replayDraft.attachments),
        },
        ...createThreadEditorStateFromPersisted(replayDraft.editorState),
      }))

      scheduleThreadPersistence(created.threadId, 0)
    },

    retryMessageInCurrentChat: async (messageId) => {
      const activeThreadKey = get().activeThreadKey
      const sourceThreadState = getThreadStateSnapshot(get().threadStates, activeThreadKey)
      const sourceMessage = sourceThreadState.messages.find((message) => message.id === messageId)
      if (!sourceMessage || !sourceMessage.replayDraft) {
        throw new Error('That request can no longer be retried.')
      }

      if (sourceThreadState.isStreaming) {
        throw new Error('Live Editor is still processing the previous request.')
      }

      const replayDraft = sourceMessage.replayDraft
      const restoredEditorState = createThreadEditorStateFromPersisted(replayDraft.editorState)

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        selectedElements: cloneSelectionState(replayDraft.selectedElements),
        selectionUndoStack: pushUndoSnapshot(
          threadState.selectionUndoStack,
          threadState.selectedElements
        ),
        selectionRedoStack: [],
        draftAgentType: restoredEditorState.draftAgentType,
        draftWorkspaceMode: restoredEditorState.draftWorkspaceMode,
      }))

      scheduleThreadPersistence(activeThreadKey, 0)

      get().sendMessage(
        replayDraft.content,
        cloneChatAttachments(replayDraft.attachments),
      )
    },

    consumePendingComposerSeed: (threadKey) => {
      const resolvedThreadKey = threadKey?.trim() || get().activeThreadKey
      const existingSeed = getThreadStateSnapshot(
        get().threadStates,
        resolvedThreadKey
      ).pendingComposerSeed
      if (!existingSeed) {
        return null
      }
      updateThreadState(resolvedThreadKey, (threadState) => ({
        ...threadState,
        pendingComposerSeed: null,
      }))
      return {
        content: existingSeed.content,
        attachments: cloneChatAttachments(existingSeed.attachments),
      }
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
        ...createEmptyThreadState(getCurrentProjectPathSnapshot()),
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
      if (nextThreadState.targetAgentDeckSessionId) {
        scheduleThreadPersistence(nextDraftKey, 0)
      }
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

    setDraftWorkspaceMode: (workspaceMode) => {
      const activeThreadKey = get().activeThreadKey
      const normalizedWorkspaceMode = normalizeDraftWorkspaceMode(workspaceMode)
      const boundSession = resolveThreadSession(activeThreadKey)
      const targetedSessionId = get().getTargetAgentDeckSessionId(activeThreadKey)
      if (boundSession?.agentDeckSessionId || targetedSessionId) {
        return
      }

      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        draftWorkspaceMode: normalizedWorkspaceMode,
      }))
      scheduleThreadPersistence(activeThreadKey)
    },

    setActivePreviewTool: (tool) => {
      const activeThreadKey = get().activeThreadKey
      const nextTool = tool === 'select' ? 'select' : null
      const currentTool = get().threadStates[activeThreadKey]?.activePreviewTool ?? null
      if (currentTool === nextTool) {
        return
      }
      updateThreadState(activeThreadKey, (threadState) => ({
        ...threadState,
        activePreviewTool: nextTool,
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

    chatScrollPositions: {},
    saveChatScrollPosition: (threadKey: string, scrollTop: number) => {
      const nextScrollTop = Math.round(scrollTop)
      if (get().chatScrollPositions[threadKey] === nextScrollTop) {
        return
      }
      set((state) => ({
        chatScrollPositions: {
          ...state.chatScrollPositions,
          [threadKey]: nextScrollTop,
        },
      }))
    },
  }
})
