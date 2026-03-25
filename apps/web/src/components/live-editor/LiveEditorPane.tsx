/**
 * LiveEditorPane Component
 *
 * Live Editor preview is shell-first: every inspected page should render inside
 * Pixel Forge's embedded Chromium surface rather than through a proxy iframe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '@/store/session-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  hasBlockingOverlay,
  useDesktopPreviewOverlayGuard,
} from '@/hooks/useDesktopPreviewOverlayGuard'
import { getDesktopApp, getDesktopPreview } from '@/lib/desktop-app'
import { HTTP_BACKEND_URL, RUNTIME_KIND, WS_BACKEND_URL } from '@/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getResponseErrorMessage, readResponsePayload } from '@/lib/http-response'
import { normalizePersistedPreviewUrl } from '@/lib/preview-url'
import type {
  PixelForgePendingPreviewUpdate,
  PixelForgeDesktopPreviewTool,
} from '@/types/pixel-forge-desktop'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Globe2,
  Layers,
  Loader2,
  MessageSquare,
  Monitor,
  MousePointer2,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Smartphone,
  X,
} from 'lucide-react'
import toast from 'react-hot-toast'

import { ChatInput } from './ChatInput'
import { ChatMessages } from './ChatMessages'
import {
  findReusableMirrorTabId,
  isCloneWorkspaceBound,
  isPixelForgeTargetUrl,
  isPendingPreviewUpdateForAudience,
  resolveUsableIsolatedMirrorTarget,
  resolveIsolatedMirrorSourceRoot,
} from './mirror-targets'
import { SelectedElementsList } from './SelectedElementsList'
import {
  useLiveEditorStore,
  type LocalTargetMeta,
  type PreviewTab,
  type ViewportMode,
  type WorkspacePreviewMeta,
} from './store/chat-store'
import {
  type SelectionRecord,
  type PdfTextRange,
  type SelectionRegion,
} from './selection-engine'

interface BrowserPreviewLoadResponse {
  mode: 'browser'
  target_url: string
  browser_tab_id: string
  title: string
  snapshot_data_url: string | null
  can_go_back?: boolean
  can_go_forward?: boolean
  did_navigate?: boolean
}

interface LoadAppOptions {
  persist?: boolean
  tabId?: string
  announceSuccess?: boolean
}

interface LocalPixelForgeTargetResponse {
  kind: 'pixel-forge'
  runtime_kind: 'mirror' | 'dev'
  project_path: string
  source_root: string
  build_label: string
  instance_slug: string
  api_port: number
  web_port: number
  web_host: string
  api_url: string
  web_url: string
  stable_url: string
  state_dir: string
  log_file: string
  pid: number | null
  target_mode: boolean
  already_running: boolean
  created_at: string | null
}

interface WorkspacePreviewCandidateResponse {
  candidate_id: string
  workspace_path: string
  workspace_root: string
  app_path: string
  relative_app_path: string
  title: string
  script_name: string
  package_manager: 'pnpm' | 'npm' | 'yarn' | 'bun'
  framework: string | null
  preferred_port: number | null
  command_preview: string
  recommended: boolean
  recommendation_score: number
}

interface WorkspacePreviewResponse {
  kind: 'workspace-preview'
  workspace_path: string
  workspace_root: string
  app_path: string
  relative_app_path: string
  title: string
  script_name: string
  package_manager: 'pnpm' | 'npm' | 'yarn' | 'bun'
  framework: string | null
  preferred_port: number | null
  instance_slug: string
  web_port: number
  web_host: string
  web_url: string
  stable_url: string
  state_dir: string
  log_file: string
  pid: number | null
  already_running: boolean
  created_at: string | null
}

interface BrowserPreviewEvent {
  type:
    | 'browser-location-changed'
    | 'browser-tab-snapshot'
    | 'browser-element-selected'
    | 'browser-element-updated'
    | 'browser-element-deselected'
    | 'browser-selection-cleared'
    | 'browser-select-cancelled'
    | 'browser-tab-closed'
    | 'browser-load-failed'
  browser_tab_id: string
  url?: string
  title?: string
  can_go_back?: boolean
  can_go_forward?: boolean
  snapshot_data_url?: string | null
  data?: Record<string, unknown>
}

interface AppliedSelection {
  id: string
  selectorKind: 'dom' | 'region'
  surfaceKind: SelectionRecord['surfaceKind']
  pageKey: string
  xpath: string
  globalIndex: number
  tagName: string
  elementId: string | null
  classList: string[]
  textSample: string
  pdfSelectionKind?: 'text' | 'text-range' | 'region' | null
  pdfPage?: number | null
  pdfTextRange?: PdfTextRange | null
  pdfTextContent?: string | null
  rootXPath: string | null
  rootTagName: string | null
  rootElementId: string | null
  rootClassList: string[]
  region: SelectionRegion | null
}

function toLocalTargetMeta(
  record: LocalPixelForgeTargetResponse,
  audienceWorkspacePath?: string | null,
): LocalTargetMeta {
  return {
    kind: record.kind,
    runtimeKind: record.runtime_kind,
    instanceSlug: record.instance_slug,
    projectPath: record.project_path,
    sourceRoot: record.source_root,
    audienceWorkspacePath: audienceWorkspacePath?.trim() || null,
    buildLabel: record.build_label,
    createdAt: record.created_at,
  }
}

function toWorkspacePreviewMeta(
  record: WorkspacePreviewResponse,
): WorkspacePreviewMeta {
  return {
    kind: record.kind,
    workspacePath: record.workspace_path,
    workspaceRoot: record.workspace_root,
    appPath: record.app_path,
    relativeAppPath: record.relative_app_path,
    title: record.title,
    scriptName: record.script_name,
    packageManager: record.package_manager,
    framework: record.framework,
    preferredPort: record.preferred_port,
    instanceSlug: record.instance_slug,
    createdAt: record.created_at,
  }
}

function toAppliedSelection(
  element: SelectionRecord,
  globalIndex: number
): AppliedSelection {
  return {
    id: element.id,
    selectorKind: element.selectorKind,
    surfaceKind: element.surfaceKind,
    pageKey: element.pageKey,
    xpath: element.xpath,
    globalIndex,
    tagName: element.tagName,
    elementId: element.elementId,
    classList: element.classList,
    textSample: element.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
    pdfSelectionKind: element.pdfSelectionKind ?? null,
    pdfPage: element.pdfPage ?? null,
    pdfTextRange: element.pdfTextRange ?? null,
    pdfTextContent: element.pdfTextContent ?? null,
    rootXPath: element.rootXPath,
    rootTagName: element.rootTagName,
    rootElementId: element.rootElementId,
    rootClassList: element.rootClassList,
    region: element.region,
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function parseSelectionRegion(value: unknown): SelectionRegion | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const region = value as Record<string, unknown>
  const numericKeys = [
    'x',
    'y',
    'width',
    'height',
    'normalizedX',
    'normalizedY',
    'normalizedWidth',
    'normalizedHeight',
    'anchorX',
    'anchorY',
  ] as const
  for (const key of numericKeys) {
    if (!Number.isFinite(Number(region[key]))) {
      return null
    }
  }

  return {
    x: Number(region.x),
    y: Number(region.y),
    width: Number(region.width),
    height: Number(region.height),
    normalizedX: Number(region.normalizedX),
    normalizedY: Number(region.normalizedY),
    normalizedWidth: Number(region.normalizedWidth),
    normalizedHeight: Number(region.normalizedHeight),
    anchorX: Number(region.anchorX),
    anchorY: Number(region.anchorY),
  }
}

function parsePdfTextRange(value: unknown): PdfTextRange | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const range = value as Record<string, unknown>
  const numericKeys = [
    'startIndex',
    'startOffset',
    'endIndex',
    'endOffset',
  ] as const

  for (const key of numericKeys) {
    if (!Number.isFinite(Number(range[key]))) {
      return null
    }
  }

  return {
    startIndex: Math.max(1, Math.round(Number(range.startIndex))),
    startOffset: Math.max(0, Math.round(Number(range.startOffset))),
    endIndex: Math.max(1, Math.round(Number(range.endIndex))),
    endOffset: Math.max(0, Math.round(Number(range.endOffset))),
  }
}

function parsePreviewSelectionData(
  data: Record<string, unknown>,
  sourceTab: Pick<PreviewTab, 'id' | 'title' | 'url'>
): Omit<SelectionRecord, 'timestamp'> | null {
  const selectionId = typeof data.selectionId === 'string' ? data.selectionId : ''
  const selectorKind = data.selectorKind === 'region' ? 'region' : 'dom'
  const surfaceKind =
    typeof data.surfaceKind === 'string'
      ? data.surfaceKind as SelectionRecord['surfaceKind']
      : selectorKind === 'region'
        ? 'unknown'
        : 'dom'
  const xpath = typeof data.xpath === 'string' ? data.xpath : ''
  const rootXPath = typeof data.rootXPath === 'string' ? data.rootXPath : null
  const pdfSelectionKind =
    data.pdfSelectionKind === 'text'
      || data.pdfSelectionKind === 'text-range'
      || data.pdfSelectionKind === 'region'
      ? data.pdfSelectionKind
      : null
  const pdfPage = Number.isFinite(Number(data.pdfPage)) ? Math.round(Number(data.pdfPage)) : null
  const pdfTextRange = parsePdfTextRange(data.pdfTextRange)
  const pdfTextContent =
    typeof data.pdfTextContent === 'string'
      ? data.pdfTextContent
      : null

  if (!selectionId) {
    return null
  }

  if (selectorKind === 'dom' && !xpath && surfaceKind !== 'pdf') {
    return null
  }

  if (selectorKind === 'region' && !rootXPath && surfaceKind !== 'pdf') {
    return null
  }

  const sourceUrl = normalizePersistedPreviewUrl(
    typeof data.pageUrl === 'string'
      ? data.pageUrl
      : sourceTab.url,
    sourceTab.url
  )

  return {
    id: selectionId,
    selectorKind,
    surfaceKind,
    pageKey:
      typeof data.pageKey === 'string' && data.pageKey.trim()
        ? data.pageKey
        : sourceUrl,
    tagName: typeof data.tagName === 'string' ? data.tagName : 'div',
    elementId:
      typeof data.elementId === 'string'
        ? data.elementId
        : null,
    classList: toStringArray(data.classList),
    textContent: typeof data.textContent === 'string' ? data.textContent : '',
    xpath,
    outerHTML: typeof data.outerHTML === 'string' ? data.outerHTML : '',
    pdfSelectionKind,
    pdfPage,
    pdfTextRange,
    pdfTextContent,
    rootXPath,
    rootTagName: typeof data.rootTagName === 'string' ? data.rootTagName : null,
    rootElementId: typeof data.rootElementId === 'string' ? data.rootElementId : null,
    rootClassList: toStringArray(data.rootClassList),
    region: parseSelectionRegion(data.region),
    previewDataUrl:
      typeof data.previewDataUrl === 'string'
        ? data.previewDataUrl
        : null,
    sourceTabId: sourceTab.id,
    sourceTabLabel: sourceTab.title || 'Preview',
    sourceUrl,
    pageTitle:
      typeof data.pageTitle === 'string'
        ? data.pageTitle
        : sourceTab.title || null,
  }
}

function createPreviewTabId(): string {
  return `preview-${Math.random().toString(36).slice(2, 10)}`
}

function getPreviewTabTitle(
  url: string,
  title?: string | null,
  fallbackIndex?: number
): string {
  if (title?.trim()) {
    return title.trim()
  }

  const trimmedUrl = url.trim()
  if (!trimmedUrl) {
    return fallbackIndex ? `Tab ${fallbackIndex}` : 'New Tab'
  }

  try {
    const parsed = new URL(trimmedUrl)
    const suffix = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
    return `${parsed.hostname}${suffix}`.slice(0, 40)
  } catch {
    return trimmedUrl.slice(0, 40)
  }
}

function createPreviewTab(url = '', title?: string | null, index?: number): PreviewTab {
  return {
    id: createPreviewTabId(),
    url,
    title: getPreviewTabTitle(url, title, index),
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

async function requestPreviewJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HTTP_BACKEND_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })

  if (!response.ok) {
    const payload = await readResponsePayload(response)
    throw new Error(getResponseErrorMessage(response, payload))
  }

  return response.json() as Promise<T>
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const editable = target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')
  return editable instanceof HTMLElement
}

export function LiveEditorPane() {
  const {
    projectPath,
    previewUrl,
    activeMode,
    liveEditorSession,
    projectSessions,
    projectChats,
    agentDeckTargets,
    createAgentDeckTargetSession,
    refreshProjectChats,
    pendingControllerUpdate,
    pendingPreviewUpdate,
    setPendingPreviewUpdate,
    setPreviewUrl,
  } = useSessionStore()

  const targetUrlRef = useRef(previewUrl || '')
  const previewTabsRef = useRef<PreviewTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const lastProjectPathRef = useRef<string | null | undefined>(undefined)
  const lastLiveEditorProjectPathRef = useRef<string | null | undefined>(undefined)
  const internalPreviewUrlRef = useRef<string | null>(null)
  const externalPreviewUrlRef = useRef<string | null>(previewUrl?.trim() || null)
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({})
  const authToastIdsRef = useRef<Record<string, string>>({})
  const previewHostRef = useRef<HTMLDivElement | null>(null)
  const urlHistoryAnchorRef = useRef<HTMLDivElement | null>(null)
  const desktopPreviewRef = useRef(getDesktopPreview())
  const desktopAppRef = useRef(getDesktopApp())

  const [isLaunchingPixelForgeTarget, setIsLaunchingPixelForgeTarget] = useState(false)
  const [workspacePreviewDialogOpen, setWorkspacePreviewDialogOpen] = useState(false)
  const [workspacePreviewCandidates, setWorkspacePreviewCandidates] = useState<WorkspacePreviewCandidateResponse[]>([])
  const [workspacePreviewCandidatesLoading, setWorkspacePreviewCandidatesLoading] = useState(false)
  const [startingWorkspacePreviewCandidateId, setStartingWorkspacePreviewCandidateId] = useState<string | null>(null)
  const [, setMirrorBuilds] = useState<LocalPixelForgeTargetResponse[]>([])
  const urlNavRef = useRef(false) // flag to skip pushing during back/forward

  useEffect(() => {
    const desktopApp = desktopAppRef.current
    if (!desktopApp?.getPreviewInputState) {
      return
    }

    let cancelled = false
    const applyInputState = (inputState?: { armedTool?: PixelForgeDesktopPreviewTool | null } | null) => {
      if (cancelled) {
        return
      }
      useLiveEditorStore
        .getState()
        .setActivePreviewTool(inputState?.armedTool === 'select' ? 'select' : null)
    }

    void desktopApp.getPreviewInputState()
      .then((inputState) => {
        applyInputState(inputState)
      })
      .catch((error) => {
        console.error('[live-editor] Failed to read desktop preview input state:', error)
      })

    const handleAppEvent = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{
        type?: string
        inputState?: {
          armedTool?: PixelForgeDesktopPreviewTool | null
        } | null
      }>
      if (event.detail?.type === 'preview-input-state-changed') {
        applyInputState(event.detail.inputState)
      }
    }

    window.addEventListener('pixel-forge-app', handleAppEvent as EventListener)
    return () => {
      cancelled = true
      window.removeEventListener('pixel-forge-app', handleAppEvent as EventListener)
    }
  }, [])

  // We need a ref to loadApp so goBack/goForward can call it without circular deps
  const loadAppRef = useRef<((url?: string, options?: LoadAppOptions) => Promise<void>) | null>(null)

  const {
    connect,
    disconnectAll,
    activeThreadKey,
    activateThread,
    hydrateProjectThreads,
    persistThreadState,
    getTargetAgentDeckSessionId,
    draftAgentType,
    activePreviewTool,
    targetUrl,
    activeTab,
    viewportMode,
    authIssue,
    showUrlHistory,
    previewTabs,
    activePreviewTabId,
    urlHistory,
    urlHistoryCursor,
    setActivePreviewTool,
    setTargetAgentDeckSessionId,
    setTargetUrl,
    setActiveTab,
    setViewportMode,
    setAuthIssue,
    setShowUrlHistory,
    setPreviewTabs,
    setActivePreviewTabId,
    setUrlHistory,
    setUrlHistoryCursor,
    addElement,
    removeElement,
    removeElements,
    replaceElement,
    clearElements,
    undoSelectionChange,
    redoSelectionChange,
    selectedElements,
    selectionUndoStack,
    selectionRedoStack,
  } = useLiveEditorStore()

  const scopedUrlHistory = useMemo(() => {
    const entries: string[] = []
    const seen = new Set<string>()
    for (let index = urlHistory.length - 1; index >= 0; index -= 1) {
      const url = normalizePersistedPreviewUrl(urlHistory[index]) || ''
      if (!url || seen.has(url)) {
        continue
      }
      seen.add(url)
      entries.push(url)
    }
    return entries
  }, [urlHistory])
  const currentThreadSession =
    projectSessions.find((session) => session.threadId === activeThreadKey)
    || (
      liveEditorSession?.threadId === activeThreadKey
        ? liveEditorSession
        : null
    )
  const activeThreadTargetAgentDeckSessionId =
    currentThreadSession?.agentDeckSessionId
    || getTargetAgentDeckSessionId()
    || liveEditorSession?.agentDeckSessionId
    || null
  const currentProjectChat =
    (currentThreadSession?.threadId
      ? projectChats.find((chat) => chat.threadId === currentThreadSession.threadId) ?? null
      : null)
    || (
      activeThreadTargetAgentDeckSessionId
        ? projectChats.find((chat) => chat.agentDeckSessionId === activeThreadTargetAgentDeckSessionId) ?? null
        : null
    )
  const currentChatWorkspacePath =
    currentProjectChat?.workspacePath?.trim()
    || currentThreadSession?.workspacePath?.trim()
    || liveEditorSession?.workspacePath?.trim()
    || null
  const currentChatIsCloneBacked = isCloneWorkspaceBound({
    projectPath,
    workspacePath: currentChatWorkspacePath,
  })
  const selectedAgentDeckTarget = agentDeckTargets.find(
    (target) => target.id === activeThreadTargetAgentDeckSessionId
  ) ?? null
  const resolvedMirrorTarget = resolveUsableIsolatedMirrorTarget({
    projectPath,
    liveWorkspacePath: currentChatWorkspacePath,
    liveAgentDeckSessionId: activeThreadTargetAgentDeckSessionId,
    selectedTargetId: activeThreadTargetAgentDeckSessionId,
    agentDeckTargets,
  })
  const previewAudienceWorkspacePath = currentChatIsCloneBacked
    ? currentChatWorkspacePath || resolvedMirrorTarget?.workspacePath || null
    : projectPath || null
  const workspacePreviewWorkspacePath = currentChatWorkspacePath || projectPath || null
  const previewAudienceSessionId = currentChatIsCloneBacked
    ? activeThreadTargetAgentDeckSessionId
    : null
  const relevantPendingPreviewUpdate = isPendingPreviewUpdateForAudience({
    pendingPreviewUpdate,
    projectPath,
    audienceWorkspacePath: previewAudienceWorkspacePath,
    audienceSessionId: previewAudienceSessionId,
  })
    && currentChatIsCloneBacked
    ? pendingPreviewUpdate
    : null
  const relevantPendingControllerUpdate =
    !currentChatIsCloneBacked
    && pendingControllerUpdate?.projectPath === projectPath
      ? pendingControllerUpdate
      : null
  const selectedElementsRef = useRef(selectedElements)
  const hasEmbeddedBrowserPreview = desktopPreviewRef.current !== null
  const canLaunchSelfMirror = RUNTIME_KIND === 'controller'
  const isSelectionToolActive = activePreviewTool === 'select'
  const activePreviewTabForNav = previewTabs.find((tab) => tab.id === activePreviewTabId) ?? previewTabs[0] ?? null
  const canGoBack = activePreviewTabForNav?.mode === 'browser'
    ? activePreviewTabForNav.canGoBack
    : urlHistoryCursor > 0
  const canGoForward = activePreviewTabForNav?.mode === 'browser'
    ? activePreviewTabForNav.canGoForward
    : urlHistoryCursor < urlHistory.length - 1
  const canUndoSelections = selectionUndoStack.length > 0
  const canRedoSelections = selectionRedoStack.length > 0

  const pushUrlHistory = useCallback((url: string) => {
    if (urlNavRef.current) {
      urlNavRef.current = false
      return
    }
    const normalizedUrl = normalizePersistedPreviewUrl(url)
    if (!normalizedUrl) return
    setUrlHistory((prev) => {
      const truncated = prev.slice(0, urlHistoryCursor + 1)
      if (truncated[truncated.length - 1] === normalizedUrl) return truncated
      return [...truncated, normalizedUrl]
    })
    setUrlHistoryCursor((prev) => prev + 1)
  }, [setUrlHistory, setUrlHistoryCursor, urlHistoryCursor])

  const goBack = useCallback(() => {
    if (!canGoBack) return
    const prevUrl = urlHistory[urlHistoryCursor - 1]
    const activePreviewTab = previewTabsRef.current.find(
      (tab) => tab.id === activeTabIdRef.current
    ) ?? previewTabsRef.current[0] ?? null
    if (
      activePreviewTab?.mode === 'browser'
      && activePreviewTab.browserTabId
      && desktopPreviewRef.current?.goBack
    ) {
      void (async () => {
        try {
          const response = await desktopPreviewRef.current?.goBack(activePreviewTab.id)
          if (response?.did_navigate) {
            setPreviewTabs((currentTabs) =>
              currentTabs.map((entry) =>
                entry.id === activePreviewTab.id
                  ? {
                      ...entry,
                      canGoBack: Boolean(response.can_go_back),
                      canGoForward: Boolean(response.can_go_forward),
                    }
                  : entry
              )
            )
          }
        } catch (error) {
          console.warn('[live-editor] Embedded browser goBack failed', error)
        }
      })()
      return
    }
    setUrlHistoryCursor((c) => c - 1)
    setTargetUrl(prevUrl)
    urlNavRef.current = true
    void loadAppRef.current?.(prevUrl, { announceSuccess: false })
  }, [
    canGoBack,
    setPreviewTabs,
    setTargetUrl,
    setUrlHistoryCursor,
    urlHistory,
    urlHistoryCursor,
  ])

  const goForward = useCallback(() => {
    if (!canGoForward) return
    const nextUrl = urlHistory[urlHistoryCursor + 1]
    const activePreviewTab = previewTabsRef.current.find(
      (tab) => tab.id === activeTabIdRef.current
    ) ?? previewTabsRef.current[0] ?? null
    if (
      activePreviewTab?.mode === 'browser'
      && activePreviewTab.browserTabId
      && desktopPreviewRef.current?.goForward
    ) {
      void (async () => {
        try {
          const response = await desktopPreviewRef.current?.goForward(activePreviewTab.id)
          if (response?.did_navigate) {
            setPreviewTabs((currentTabs) =>
              currentTabs.map((entry) =>
                entry.id === activePreviewTab.id
                  ? {
                      ...entry,
                      canGoBack: Boolean(response.can_go_back),
                      canGoForward: Boolean(response.can_go_forward),
                    }
                  : entry
              )
            )
          }
        } catch (error) {
          console.warn('[live-editor] Embedded browser goForward failed', error)
        }
      })()
      return
    }
    setUrlHistoryCursor((c) => c + 1)
    setTargetUrl(nextUrl)
    urlNavRef.current = true
    void loadAppRef.current?.(nextUrl, { announceSuccess: false })
  }, [
    canGoForward,
    setPreviewTabs,
    setTargetUrl,
    setUrlHistoryCursor,
    urlHistory,
    urlHistoryCursor,
  ])

  useEffect(() => {
    selectedElementsRef.current = selectedElements
  }, [selectedElements])

  useEffect(() => {
    previewTabsRef.current = previewTabs
  }, [previewTabs])

  useEffect(() => {
    activeTabIdRef.current = activePreviewTabId
  }, [activePreviewTabId])

  useEffect(() => {
    if (!activePreviewTabId && previewTabs[0]) {
      setActivePreviewTabId(previewTabs[0].id)
    }
  }, [activePreviewTabId, previewTabs, setActivePreviewTabId])

  useEffect(() => {
    connect()
    return () => disconnectAll()
  }, [connect, disconnectAll])

  useEffect(() => {
    const flushActiveThreadState = () => {
      void persistThreadState()
    }

    window.addEventListener('pagehide', flushActiveThreadState)
    window.addEventListener('beforeunload', flushActiveThreadState)
    return () => {
      window.removeEventListener('pagehide', flushActiveThreadState)
      window.removeEventListener('beforeunload', flushActiveThreadState)
    }
  }, [persistThreadState])

  useEffect(() => {
    if (lastLiveEditorProjectPathRef.current === projectPath) {
      return
    }
    lastLiveEditorProjectPathRef.current = projectPath
    hydrateProjectThreads({
      projectSessions,
      activeThreadKey: liveEditorSession?.threadId ?? null,
      previewUrl,
    })
  }, [
    hydrateProjectThreads,
    liveEditorSession?.threadId,
    previewUrl,
    projectPath,
    projectSessions,
  ])

  useEffect(() => {
    if (liveEditorSession?.threadId) {
      activateThread(liveEditorSession.threadId)
    }
  }, [activateThread, liveEditorSession?.threadId])

  useEffect(() => {
    targetUrlRef.current = targetUrl
  }, [targetUrl])

  useEffect(() => {
    const handleSelectionHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target)) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undoSelectionChange()
        return
      }

      if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        redoSelectionChange()
      }
    }

    window.addEventListener('keydown', handleSelectionHistoryShortcut)
    return () => {
      window.removeEventListener('keydown', handleSelectionHistoryShortcut)
    }
  }, [redoSelectionChange, undoSelectionChange])

  const getActivePreviewTab = useCallback(() => {
    if (!activeTabIdRef.current) return null
    return previewTabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ?? null
  }, [])

  const getPreviewTabById = useCallback((tabId: string) => {
    return previewTabsRef.current.find((tab) => tab.id === tabId) ?? null
  }, [])

  const getPreviewTabByBrowserId = useCallback((browserTabId: string) => {
    return previewTabsRef.current.find((tab) => tab.browserTabId === browserTabId) ?? null
  }, [])

  const refreshMirrorBuilds = useCallback(async () => {
    if (!canLaunchSelfMirror) {
      setMirrorBuilds([])
      return
    }
    if (!projectPath) {
      setMirrorBuilds([])
      return
    }
    try {
      const payload = await requestPreviewJson<{ targets: LocalPixelForgeTargetResponse[] }>(
        `/api/local-targets/pixel-forge?project_path=${encodeURIComponent(projectPath)}&runtime_kind=mirror`
      )
      setMirrorBuilds(payload.targets)
    } catch (error) {
      console.error('[live-editor] Failed to load Pixel Forge mirror builds:', error)
    }
  }, [canLaunchSelfMirror, projectPath])

  useEffect(() => {
    void refreshMirrorBuilds()
  }, [refreshMirrorBuilds])

  useEffect(() => {
    if (!canLaunchSelfMirror) {
      setPendingPreviewUpdate(null)
      return
    }
    if (!projectPath || !previewAudienceWorkspacePath || !currentChatIsCloneBacked) {
      setPendingPreviewUpdate(null)
      return
    }

    let cancelled = false
    void requestPreviewJson<{ update: PixelForgePendingPreviewUpdate | null }>(
      `/api/preview-updates/latest?${new URLSearchParams({
        project_path: projectPath,
        workspace_path: previewAudienceWorkspacePath,
        ...(previewAudienceSessionId ? { agent_deck_session_id: previewAudienceSessionId } : {}),
      }).toString()}`
    ).then((payload) => {
      if (!cancelled) {
        setPendingPreviewUpdate(payload.update)
      }
    }).catch((error) => {
      console.error('[live-editor] Failed to load pending preview update:', error)
      if (!cancelled) {
        setPendingPreviewUpdate(null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [
    canLaunchSelfMirror,
    currentChatIsCloneBacked,
    previewAudienceSessionId,
    previewAudienceWorkspacePath,
    projectPath,
    setPendingPreviewUpdate,
  ])

  const setIframeRef = useCallback((tabId: string, iframe: HTMLIFrameElement | null) => {
    iframeRefs.current[tabId] = iframe
  }, [])

  const attachLocalTargetToTab = useCallback((
    tabId: string,
    record: LocalPixelForgeTargetResponse,
    options?: { audienceWorkspacePath?: string | null }
  ) => {
    const meta = toLocalTargetMeta(record, options?.audienceWorkspacePath)
    setPreviewTabs((currentTabs) =>
      currentTabs.map((entry) =>
        entry.id === tabId
          ? {
              ...entry,
              localTarget: meta,
              workspacePreview: null,
            }
          : entry
      )
    )
  }, [setPreviewTabs])

  const attachWorkspacePreviewToTab = useCallback((
    tabId: string,
    record: WorkspacePreviewResponse,
  ) => {
    const meta = toWorkspacePreviewMeta(record)
    setPreviewTabs((currentTabs) =>
      currentTabs.map((entry) =>
        entry.id === tabId
          ? {
              ...entry,
              localTarget: null,
              workspacePreview: meta,
            }
          : entry
      )
    )
  }, [setPreviewTabs])

  const getTabForMessageSource = useCallback((source: MessageEventSource | null) => {
    if (!source) return null

    for (const tab of previewTabsRef.current) {
      if (iframeRefs.current[tab.id]?.contentWindow === source) {
        return tab
      }
    }

    return null
  }, [])

  const syncStorePreviewUrl = useCallback(
    async (url: string | null) => {
      const normalizedUrl = normalizePersistedPreviewUrl(url) || null
      internalPreviewUrlRef.current = normalizedUrl
      try {
        await setPreviewUrl(normalizedUrl)
      } catch (error) {
        console.error('[live-editor] Failed to persist preview URL:', error)
        if (normalizedUrl) {
          toast.error('Failed to persist preview URL')
        }
      }
    },
    [setPreviewUrl]
  )

  const sendBrowserCommand = useCallback(async (
    browserTabId: string,
    action: 'show' | 'focus' | 'set_tool' | 'clear' | 'deselect' | 'apply' | 'refresh',
    payload?: Record<string, unknown>
  ) => {
    const desktopPreview = desktopPreviewRef.current
    if (desktopPreview) {
      try {
        if (action === 'show') {
          await desktopPreview.show(browserTabId)
          return null
        }
        if (action === 'focus') {
          await desktopPreview.focus(browserTabId)
          return null
        }
        if (action === 'set_tool') {
          return await desktopPreview.setTool(
            browserTabId,
            payload?.tool === 'select' ? 'select' : null
          )
        }
        if (action === 'clear') {
          return await desktopPreview.clearSelections(browserTabId)
        }
        if (action === 'deselect') {
          return await desktopPreview.deselect(browserTabId, String(payload?.selectionId || ''))
        }
        if (action === 'apply') {
          const reveal = payload?.reveal === true
          return await desktopPreview.applySelections(
            browserTabId,
            Array.isArray(payload?.selections)
              ? payload.selections.filter((entry): entry is AppliedSelection =>
                Boolean(entry)
                && typeof entry === 'object'
                && typeof entry.id === 'string'
                && (entry.selectorKind === 'dom' || entry.selectorKind === 'region')
                && typeof entry.surfaceKind === 'string'
                && typeof entry.pageKey === 'string'
                && typeof entry.xpath === 'string'
                && Number.isFinite(entry.globalIndex)
                && typeof entry.tagName === 'string'
                && (entry.elementId === null || typeof entry.elementId === 'string')
                && Array.isArray(entry.classList)
                && entry.classList.every((value: unknown) => typeof value === 'string')
                && typeof entry.textSample === 'string'
                && (entry.pdfSelectionKind === null || entry.pdfSelectionKind === undefined || entry.pdfSelectionKind === 'text' || entry.pdfSelectionKind === 'text-range' || entry.pdfSelectionKind === 'region')
                && (entry.pdfPage === null || entry.pdfPage === undefined || Number.isFinite(entry.pdfPage))
                && (
                  entry.pdfTextRange === null
                  || entry.pdfTextRange === undefined
                  || (
                    typeof entry.pdfTextRange === 'object'
                    && Number.isFinite(entry.pdfTextRange.startIndex)
                    && Number.isFinite(entry.pdfTextRange.startOffset)
                    && Number.isFinite(entry.pdfTextRange.endIndex)
                    && Number.isFinite(entry.pdfTextRange.endOffset)
                  )
                )
                && (entry.pdfTextContent === null || entry.pdfTextContent === undefined || typeof entry.pdfTextContent === 'string')
                && (entry.rootXPath === null || typeof entry.rootXPath === 'string')
                && (entry.rootTagName === null || typeof entry.rootTagName === 'string')
                && (entry.rootElementId === null || typeof entry.rootElementId === 'string')
                && Array.isArray(entry.rootClassList)
                && entry.rootClassList.every((value: unknown) => typeof value === 'string')
              )
              : [],
            { reveal }
          )
        }
        if (action === 'refresh') {
          return await desktopPreview.refresh(browserTabId)
        }
      } catch (error) {
        console.error(`[live-editor] Embedded preview command failed (${action})`, error)
        return null
      }
    }

    try {
      const normalizedAction =
        action === 'set_tool'
          ? 'set_select_mode'
          : action
      return await requestPreviewJson<BrowserPreviewLoadResponse>('/api/live-preview/browser/command', {
        method: 'POST',
        body: JSON.stringify({
          browser_tab_id: browserTabId,
          action: normalizedAction,
          ...(
            action === 'set_tool'
              ? { enabled: payload?.tool === 'select' }
              : (payload || {})
          ),
        }),
      })
    } catch (error) {
      console.error(`[live-editor] Browser preview command failed (${action})`, error)
      return null
    }
  }, [])

  const syncTabSelections = useCallback(async (
    tabId: string,
    options?: { reveal?: boolean }
  ) => {
    const tab = getPreviewTabById(tabId)
    if (!tab) {
      return
    }

    const selections = useLiveEditorStore
      .getState()
      .selectedElements
      .flatMap((element, globalIndex) => (
        element.sourceTabId === tab.id
          ? [{
              ...toAppliedSelection(element, globalIndex + 1),
            }]
          : []
      ))

    if (tab.mode === 'proxy') {
      const iframe = iframeRefs.current[tabId]
      if (!iframe?.contentWindow) {
        return
      }

      iframe.contentWindow.postMessage(
        {
          type: 'pixel-forge-apply-selections',
          selections,
        },
        '*'
      )
      return
    }

    if (tab.mode === 'browser' && tab.browserTabId) {
      await sendBrowserCommand(tab.browserTabId, 'apply', {
        selections,
        reveal: options?.reveal === true,
      })
    }
  }, [getPreviewTabById, sendBrowserCommand])

  useEffect(() => {
    void Promise.all(
      previewTabsRef.current.map((tab) => syncTabSelections(tab.id))
    )
  }, [selectedElements, syncTabSelections])

  const syncActivePreviewSelectionMode = useCallback(async (tabId?: string | null) => {
    const resolvedTabId = tabId ?? activeTabIdRef.current
    if (!resolvedTabId) {
      return
    }

    const tab = previewTabsRef.current.find((entry) => entry.id === resolvedTabId)
    if (!tab) {
      return
    }

    const tool = activePreviewTool

    if (tab.mode === 'proxy') {
      const iframe = iframeRefs.current[tab.id]
      if (!iframe?.contentWindow) {
        return
      }

      iframe.contentWindow.postMessage(
        {
          type: 'pixel-forge-toggle-select',
          enabled: tool === 'select',
        },
        '*'
      )
      return
    }

    if (tab.mode === 'browser' && tab.browserTabId) {
      await sendBrowserCommand(tab.browserTabId, 'set_tool', { tool })
    }
  }, [activePreviewTool, sendBrowserCommand])

  const updateEmbeddedPreviewBounds = useCallback(async () => {
    const desktopPreview = desktopPreviewRef.current
    if (!desktopPreview) {
      return
    }

    if (hasBlockingOverlay()) {
      await desktopPreview.hide()
      return
    }

    const activePreviewTab = getActivePreviewTab()
    const host = previewHostRef.current

    if (!activePreviewTab || activePreviewTab.mode !== 'browser' || !activePreviewTab.browserTabId || !host) {
      await desktopPreview.hide()
      return
    }

    const rect = host.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      await desktopPreview.hide()
      return
    }

    await desktopPreview.show(activePreviewTab.browserTabId)
    await desktopPreview.setBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
  }, [getActivePreviewTab])

  useDesktopPreviewOverlayGuard(desktopPreviewRef, updateEmbeddedPreviewBounds)

  const loadApp = useCallback(async (
    urlOverride?: string,
    options?: LoadAppOptions
  ) => {
    const resolvedTabId = options?.tabId ?? activeTabIdRef.current
    if (!resolvedTabId) return

    const tab = previewTabsRef.current.find((entry) => entry.id === resolvedTabId) ?? null
    const urlToLoad = (urlOverride || targetUrlRef.current || tab?.url || '').trim()

    setActivePreviewTabId(resolvedTabId)

    if (!urlToLoad) {
      setAuthIssue(null)
      setTargetUrl('')
      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry, index) =>
          entry.id === resolvedTabId
            ? {
                ...entry,
                url: '',
                title: getPreviewTabTitle('', null, index + 1),
                mode: null,
                frameSrc: 'about:blank',
                snapshotDataUrl: null,
                proxySessionId: null,
                browserTabId: null,
                canGoBack: false,
                canGoForward: false,
                localTarget: null,
                workspacePreview: null,
              }
            : entry
        )
      )
      if (options?.persist !== false) {
        await syncStorePreviewUrl(null)
      }
      return
    }

    try {
      if (RUNTIME_KIND !== 'controller' && isPixelForgeTargetUrl(urlToLoad)) {
        throw new Error(
          'Nested Pixel Forge previews are disabled inside target runtimes. Open an ordinary app URL or return to the controller.'
        )
      }

      const desktopPreview = desktopPreviewRef.current
      if (!desktopPreview) {
        throw new Error(
          'Live Editor preview requires the Pixel Forge desktop shell. Open the app from the dock or run `pixel-forge open`.'
        )
      }

      const data = await desktopPreview.load({
        tabId: resolvedTabId,
        url: urlToLoad,
      })
      const resolvedTargetUrl = normalizePersistedPreviewUrl(data.target_url, urlToLoad) || urlToLoad

      setAuthIssue(null)
      setTargetUrl(resolvedTargetUrl)
      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry, index) => {
          if (entry.id !== resolvedTabId) {
            return entry
          }

          return {
            ...entry,
            mode: 'browser',
            url: resolvedTargetUrl,
            title: getPreviewTabTitle(resolvedTargetUrl, data.title, index + 1),
            proxySessionId: null,
            browserTabId: data.browser_tab_id,
            canGoBack: Boolean(data.can_go_back),
            canGoForward: Boolean(data.can_go_forward),
            frameSrc: 'about:blank',
            snapshotDataUrl: data.snapshot_data_url,
            localTarget: null,
            workspacePreview: null,
          }
        })
      )

      if (options?.persist !== false) {
        await syncStorePreviewUrl(resolvedTargetUrl)
      }

      pushUrlHistory(resolvedTargetUrl)

      if (data.browser_tab_id) {
        await sendBrowserCommand(data.browser_tab_id, 'focus')
      }

      window.setTimeout(() => {
        void updateEmbeddedPreviewBounds()
        void syncTabSelections(resolvedTabId, { reveal: true })
        void syncActivePreviewSelectionMode(resolvedTabId)
      }, 150)

      if (options?.announceSuccess !== false) {
        toast.success('Loaded in embedded Chromium')
      }
    } catch (error) {
      console.error('[live-editor] Failed to load preview target:', error)
      if (options?.announceSuccess !== false) {
        toast.error(
          error instanceof Error ? `Failed to load app: ${error.message}` : 'Failed to load app'
        )
      }
    }
  }, [
    pushUrlHistory,
    sendBrowserCommand,
    setActivePreviewTabId,
    setAuthIssue,
    setPreviewTabs,
    setTargetUrl,
    syncActivePreviewSelectionMode,
    syncStorePreviewUrl,
    syncTabSelections,
    updateEmbeddedPreviewBounds,
  ])

  // Keep loadAppRef in sync for back/forward navigation
  loadAppRef.current = loadApp

  const restoreLocalTargetInTab = useCallback(async (tab: PreviewTab) => {
    if (!projectPath || !tab.localTarget) {
      return false
    }

    const record = await requestPreviewJson<LocalPixelForgeTargetResponse>(
      '/api/local-targets/pixel-forge/start',
      {
        method: 'POST',
        body: JSON.stringify({
          project_path: projectPath,
          runtime_kind: tab.localTarget.runtimeKind,
          force_restart: false,
          source_root: tab.localTarget.sourceRoot,
        }),
      }
    )

    attachLocalTargetToTab(tab.id, record, {
      audienceWorkspacePath: tab.localTarget.audienceWorkspacePath ?? null,
    })
    await loadApp(record.stable_url || record.web_url, {
      tabId: tab.id,
      persist: false,
      announceSuccess: false,
    })
    return true
  }, [attachLocalTargetToTab, loadApp, projectPath])

  const restoreWorkspacePreviewInTab = useCallback(async (tab: PreviewTab) => {
    if (!tab.workspacePreview) {
      return false
    }

    const record = await requestPreviewJson<WorkspacePreviewResponse>(
      '/api/workspace-previews/start',
      {
        method: 'POST',
        body: JSON.stringify({
          workspace_path: tab.workspacePreview.workspacePath,
          relative_app_path: tab.workspacePreview.relativeAppPath,
          script_name: tab.workspacePreview.scriptName,
          package_manager: tab.workspacePreview.packageManager,
          force_restart: false,
        }),
      }
    )

    attachWorkspacePreviewToTab(tab.id, record)
    await loadApp(record.stable_url || record.web_url, {
      tabId: tab.id,
      persist: false,
      announceSuccess: false,
    })
    return true
  }, [attachWorkspacePreviewToTab, loadApp])

  const restoreActivePreviewTab = useCallback(async () => {
    if (activeMode !== 'live-editor' || !projectPath) {
      return
    }

    const activePreviewTab = getActivePreviewTab() ?? previewTabsRef.current[0] ?? null
    if (!activePreviewTab?.url.trim()) {
      return
    }

    if (activePreviewTab.browserTabId || activePreviewTab.proxySessionId) {
      return
    }

    if (activePreviewTab.workspacePreview?.kind === 'workspace-preview') {
      try {
        const restored = await restoreWorkspacePreviewInTab(activePreviewTab)
        if (restored) {
          return
        }
      } catch (error) {
        console.error('[live-editor] Failed to restore workspace preview tab:', error)
      }
    }

    if (
      RUNTIME_KIND !== 'controller'
      && activePreviewTab.localTarget?.kind === 'pixel-forge'
    ) {
      return
    }

    if (activePreviewTab.localTarget?.kind === 'pixel-forge') {
      try {
        const restored = await restoreLocalTargetInTab(activePreviewTab)
        if (restored) {
          return
        }
      } catch (error) {
        console.error('[live-editor] Failed to restore local target tab:', error)
      }
    }

    await loadApp(activePreviewTab.url, {
      tabId: activePreviewTab.id,
      persist: false,
      announceSuccess: false,
    })
  }, [
    activeMode,
    getActivePreviewTab,
    loadApp,
    projectPath,
    restoreLocalTargetInTab,
    restoreWorkspacePreviewInTab,
  ])

  useEffect(() => {
    void restoreActivePreviewTab()
  }, [activeMode, activePreviewTabId, activeThreadKey, projectPath, restoreActivePreviewTab])

  const openUrlHistory = useCallback(async () => {
    if (scopedUrlHistory.length === 0) {
      return
    }

    setShowUrlHistory((current) => !current)
  }, [scopedUrlHistory, setShowUrlHistory])

  const applyControllerUpdate = useCallback(async () => {
    const desktopApp = desktopAppRef.current
    if (!desktopApp) {
      toast.error('Applying controller updates requires the Pixel Forge desktop shell.')
      return
    }
    const activePreviewUrl = getActivePreviewTab()?.url || targetUrl || previewUrl

    const toastId = toast.loading('Loading updated Pixel Forge build...')
    try {
      if (desktopApp.startPendingControllerUpdate) {
        desktopApp.startPendingControllerUpdate({
          projectPath: projectPath ?? '',
          previewUrl: activePreviewUrl,
          activeMode,
        })
      } else if (desktopApp.applyPendingControllerUpdate) {
        await desktopApp.applyPendingControllerUpdate({
          projectPath: projectPath ?? '',
          previewUrl: activePreviewUrl,
          activeMode,
        })
      } else if (desktopApp.applyControllerUpdate) {
        if (!projectPath) {
          throw new Error('No project is selected.')
        }
        await desktopApp.applyControllerUpdate({
          projectPath,
          previewUrl: activePreviewUrl,
          activeMode,
        })
      } else {
        throw new Error('This runtime cannot apply controller updates directly.')
      }
      toast.dismiss(toastId)
    } catch (error) {
      toast.dismiss(toastId)
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to load updated Pixel Forge build'
      )
    }
  }, [activeMode, getActivePreviewTab, previewUrl, projectPath, targetUrl])

  const activatePreviewTab = useCallback(async (tabId: string) => {
    const tab = previewTabsRef.current.find((entry) => entry.id === tabId)
    if (!tab) return

    setActivePreviewTabId(tabId)
    setTargetUrl(tab.url)
    setAuthIssue(null)
    setShowUrlHistory(false)
    await syncStorePreviewUrl(tab.url || null)

    if (tab.mode === 'browser' && tab.browserTabId) {
      const desktopPreview = desktopPreviewRef.current
      if (desktopPreview) {
        await desktopPreview.show(tab.browserTabId)
        await syncActivePreviewSelectionMode(tab.id)
        window.setTimeout(() => {
          void updateEmbeddedPreviewBounds()
        }, 60)
      } else {
        await sendBrowserCommand(tab.browserTabId, 'focus')
        await syncActivePreviewSelectionMode(tab.id)
      }
      return
    }

    await syncActivePreviewSelectionMode(tab.id)
  }, [
    sendBrowserCommand,
    setActivePreviewTabId,
    setAuthIssue,
    setShowUrlHistory,
    setTargetUrl,
    syncActivePreviewSelectionMode,
    syncStorePreviewUrl,
    updateEmbeddedPreviewBounds,
  ])

  const openUrlInPreviewTab = useCallback(async (
    url: string,
    options?: {
      title?: string | null
      announceSuccess?: boolean
      preferredTabId?: string | null
    }
  ) => {
    const normalizedUrl = url.trim()
    if (!normalizedUrl) {
      return null
    }

    const preferredTabId = options?.preferredTabId?.trim() || null
    if (preferredTabId) {
      const preferredTab = previewTabsRef.current.find((entry) => entry.id === preferredTabId) || null
      if (preferredTab) {
        setTargetUrl(normalizedUrl)
        await loadApp(normalizedUrl, {
          tabId: preferredTab.id,
          persist: true,
          announceSuccess: options?.announceSuccess,
        })
        return preferredTab.id
      }
    }

    const existingTab = previewTabsRef.current.find((entry) => entry.url === normalizedUrl)
    if (existingTab) {
      await activatePreviewTab(existingTab.id)
      await loadApp(normalizedUrl, {
        tabId: existingTab.id,
        persist: true,
        announceSuccess: options?.announceSuccess,
      })
      return existingTab.id
    }

    const activePreviewTab = getActivePreviewTab()
    if (activePreviewTab && !activePreviewTab.url && activePreviewTab.mode === null) {
      setTargetUrl(normalizedUrl)
      await loadApp(normalizedUrl, {
        tabId: activePreviewTab.id,
        persist: true,
        announceSuccess: options?.announceSuccess,
      })
      return activePreviewTab.id
    }

    const nextTab = createPreviewTab(
      normalizedUrl,
      options?.title ?? null,
      previewTabsRef.current.length + 1
    )
    const nextTabs = [...previewTabsRef.current, nextTab]
    previewTabsRef.current = nextTabs
    activeTabIdRef.current = nextTab.id
    setPreviewTabs(nextTabs)
    setActivePreviewTabId(nextTab.id)
    setTargetUrl(normalizedUrl)
    setAuthIssue(null)
    setShowUrlHistory(false)

    await loadApp(normalizedUrl, {
      tabId: nextTab.id,
      persist: true,
      announceSuccess: options?.announceSuccess,
    })

    return nextTab.id
  }, [
    activatePreviewTab,
    getActivePreviewTab,
    loadApp,
    setActivePreviewTabId,
    setAuthIssue,
    setPreviewTabs,
    setShowUrlHistory,
    setTargetUrl,
  ])

  const openLocalTargetInPreviewTab = useCallback(async (
    record: LocalPixelForgeTargetResponse,
    options?: {
      announceSuccess?: boolean
      preferredTabId?: string | null
      audienceWorkspacePath?: string | null
    }
  ) => {
    const tabId = await openUrlInPreviewTab(record.stable_url || record.web_url, {
      title:
        record.runtime_kind === 'mirror'
          ? `Pixel Forge · ${record.build_label}`
          : 'Pixel Forge Target',
      announceSuccess: options?.announceSuccess,
      preferredTabId: options?.preferredTabId,
    })
    if (tabId) {
      attachLocalTargetToTab(tabId, record, {
        audienceWorkspacePath: options?.audienceWorkspacePath,
      })
      void refreshMirrorBuilds()
    }
    return tabId
  }, [attachLocalTargetToTab, openUrlInPreviewTab, refreshMirrorBuilds])

  const openWorkspacePreviewInTab = useCallback(async (
    record: WorkspacePreviewResponse,
    options?: {
      announceSuccess?: boolean
      preferredTabId?: string | null
    }
  ) => {
    const tabId = await openUrlInPreviewTab(record.stable_url || record.web_url, {
      title: `Workspace · ${record.title}`,
      announceSuccess: options?.announceSuccess,
      preferredTabId: options?.preferredTabId,
    })
    if (tabId) {
      attachWorkspacePreviewToTab(tabId, record)
    }
    return tabId
  }, [attachWorkspacePreviewToTab, openUrlInPreviewTab])

  const startPixelForgeMirror = useCallback(async (
    options?: {
      sourceRoot?: string | null
      forceRestart?: boolean
      announceSuccess?: boolean
      preferredTabId?: string | null
      audienceWorkspacePath?: string | null
    }
  ) => {
    if (RUNTIME_KIND !== 'controller') {
      throw new Error(
        'Nested Pixel Forge mirror launch is disabled inside target runtimes.'
      )
    }
    if (!projectPath) {
      throw new Error('Select a project before launching a Pixel Forge target')
    }

    const record = await requestPreviewJson<LocalPixelForgeTargetResponse>(
      '/api/local-targets/pixel-forge/start',
      {
        method: 'POST',
        body: JSON.stringify({
          project_path: projectPath,
          runtime_kind: 'mirror',
          force_restart: options?.forceRestart ?? true,
          source_root: options?.sourceRoot || undefined,
        }),
      }
    )

    await openLocalTargetInPreviewTab(record, {
      announceSuccess: options?.announceSuccess,
      preferredTabId: options?.preferredTabId,
      audienceWorkspacePath: options?.audienceWorkspacePath,
    })
    return record
  }, [openLocalTargetInPreviewTab, projectPath])

  const openWorkspacePreviewLauncher = useCallback(async () => {
    if (!workspacePreviewWorkspacePath) {
      toast.error('Select or bind a workspace before launching a workspace preview.')
      return
    }

    setWorkspacePreviewCandidatesLoading(true)
    try {
      const payload = await requestPreviewJson<{
        workspace_path: string
        candidates: WorkspacePreviewCandidateResponse[]
      }>(
        `/api/workspace-previews/candidates?workspace_path=${encodeURIComponent(workspacePreviewWorkspacePath)}`
      )
      setWorkspacePreviewCandidates(payload.candidates)
      setWorkspacePreviewDialogOpen(true)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to inspect workspace preview candidates'
      )
    } finally {
      setWorkspacePreviewCandidatesLoading(false)
    }
  }, [workspacePreviewWorkspacePath])

  const launchWorkspacePreviewCandidate = useCallback(async (
    candidate: WorkspacePreviewCandidateResponse
  ) => {
    setStartingWorkspacePreviewCandidateId(candidate.candidate_id)
    try {
      const record = await requestPreviewJson<WorkspacePreviewResponse>(
        '/api/workspace-previews/start',
        {
          method: 'POST',
          body: JSON.stringify({
            workspace_path: candidate.workspace_path,
            relative_app_path: candidate.relative_app_path,
            script_name: candidate.script_name,
            package_manager: candidate.package_manager,
            force_restart: false,
          }),
        }
      )
      const currentActivePreviewTab = getActivePreviewTab()
      const reusableTabId =
        currentActivePreviewTab?.workspacePreview?.instanceSlug === record.instance_slug
        || !currentActivePreviewTab?.url?.trim()
          ? currentActivePreviewTab?.id ?? null
          : null
      await openWorkspacePreviewInTab(record, {
        announceSuccess: false,
        preferredTabId: reusableTabId,
      })
      setWorkspacePreviewDialogOpen(false)
      toast.success(
        record.already_running
          ? `Attached to workspace preview · ${record.title}`
          : `Started workspace preview · ${record.title}`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to launch the workspace preview'
      )
    } finally {
      setStartingWorkspacePreviewCandidateId(null)
    }
  }, [getActivePreviewTab, openWorkspacePreviewInTab])

  const fetchLatestPendingPreviewUpdate = useCallback(async (
    workspacePath: string,
    agentDeckSessionId: string | null,
  ) => {
    if (!projectPath) {
      return null
    }

    const query = new URLSearchParams({
      project_path: projectPath,
      workspace_path: workspacePath,
    })
    if (agentDeckSessionId) {
      query.set('agent_deck_session_id', agentDeckSessionId)
    }

    const payload = await requestPreviewJson<{
      update: PixelForgePendingPreviewUpdate | null
    }>(`/api/preview-updates/latest?${query.toString()}`)
    return payload.update
  }, [projectPath])

  const bindMirrorTargetToActiveThread = useCallback(async (target: {
    id: string
    title: string
    tool: string | null
    path: string
  }) => {
    const workspacePath = target.path?.trim() || null
    if (!isCloneWorkspaceBound({ projectPath, workspacePath })) {
      throw new Error('Failed to resolve an isolated Pixel Forge preview workspace.')
    }

    const alreadyBound =
      currentThreadSession?.agentDeckSessionId === target.id
      && currentThreadSession?.workspacePath === workspacePath
    if (!alreadyBound) {
      setTargetAgentDeckSessionId(target.id)
      await persistThreadState(activeThreadKey)
      await refreshProjectChats().catch((error) => {
        console.error('[live-editor] Failed to refresh project chats after mirror bind:', error)
      })
    }

    return {
      workspacePath,
      agentDeckSessionId: target.id,
    }
  }, [
    activeThreadKey,
    currentThreadSession?.agentDeckSessionId,
    currentThreadSession?.workspacePath,
    persistThreadState,
    projectPath,
    refreshProjectChats,
    setTargetAgentDeckSessionId,
  ])

  const ensureIsolatedMirrorLaunchContext = useCallback(async () => {
    if (!projectPath) {
      throw new Error('Select a project before launching a Pixel Forge target')
    }

    if (currentChatIsCloneBacked && currentChatWorkspacePath) {
      return {
        sourceRoot:
          relevantPendingPreviewUpdate?.snapshotPath?.trim()
          || currentChatWorkspacePath,
        audienceWorkspacePath: currentChatWorkspacePath,
      }
    }

    if (currentProjectChat) {
      return {
        sourceRoot: relevantPendingControllerUpdate?.snapshotPath?.trim() || null,
        audienceWorkspacePath: projectPath,
      }
    }

    const resolvedSourceRoot = resolveIsolatedMirrorSourceRoot({
      projectPath,
      liveWorkspacePath: resolvedMirrorTarget?.workspacePath || null,
      selectedTargetPath: selectedAgentDeckTarget?.path || null,
    })
    if (resolvedSourceRoot) {
      const existingTarget = agentDeckTargets.find(
        (target) => target.id === resolvedMirrorTarget?.agentDeckSessionId
      ) ?? null
      if (existingTarget) {
        await bindMirrorTargetToActiveThread(existingTarget)
      }
      return {
        sourceRoot: resolvedSourceRoot,
        audienceWorkspacePath: resolvedSourceRoot,
      }
    }

    const created = await createAgentDeckTargetSession({
      agentType: draftAgentType,
      refreshProjectChats: false,
    })
    const createdPath = created.path?.trim() || null
    if (!isCloneWorkspaceBound({ projectPath, workspacePath: createdPath })) {
      throw new Error('Failed to create an isolated Pixel Forge preview session.')
    }
    await bindMirrorTargetToActiveThread(created)
    toast.success(`Created isolated session · ${created.title || created.id}`)
    return {
      sourceRoot: createdPath,
      audienceWorkspacePath: createdPath,
    }
  }, [
    agentDeckTargets,
    bindMirrorTargetToActiveThread,
    createAgentDeckTargetSession,
    currentChatIsCloneBacked,
    currentChatWorkspacePath,
    currentProjectChat,
    draftAgentType,
    projectPath,
    relevantPendingControllerUpdate?.snapshotPath,
    relevantPendingPreviewUpdate?.snapshotPath,
    resolvedMirrorTarget?.workspacePath,
    resolvedMirrorTarget?.agentDeckSessionId,
    selectedAgentDeckTarget?.path,
  ])

  const loadUpdatedPixelForgePreview = useCallback(async () => {
    if (!previewAudienceWorkspacePath) {
      toast.error('No isolated Pixel Forge preview session is selected.')
      return
    }

    const update =
      relevantPendingPreviewUpdate
      || await fetchLatestPendingPreviewUpdate(previewAudienceWorkspacePath, previewAudienceSessionId)

    if (!update?.snapshotPath) {
      toast.error('No updated clone preview is ready to load.')
      return
    }

    const toastId = toast.loading('Loading updated Pixel Forge preview...')
    try {
      const reusableMirrorTabId = findReusableMirrorTabId({
        previewTabs: previewTabsRef.current,
        audienceWorkspacePath: update.workspacePath,
        activeTabId: activeTabIdRef.current,
      })
      await startPixelForgeMirror({
        sourceRoot: update.snapshotPath,
        forceRestart: false,
        announceSuccess: false,
        preferredTabId: reusableMirrorTabId,
        audienceWorkspacePath: update.workspacePath,
      })
      setPendingPreviewUpdate(null)
      void fetch(
        `${HTTP_BACKEND_URL}/api/preview-updates/latest?update_id=${encodeURIComponent(update.id)}`,
        {
          method: 'DELETE',
          credentials: 'include',
        }
      ).catch((error) => {
        console.error('[live-editor] Failed to clear consumed preview update:', error)
      })
      toast.success(
        reusableMirrorTabId
          ? 'Refreshed the primary mirror preview with the updated build'
          : 'Loaded updated Pixel Forge preview',
        { id: toastId }
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to load the staged Pixel Forge preview',
        { id: toastId }
      )
    }
  }, [
    fetchLatestPendingPreviewUpdate,
    previewAudienceSessionId,
    previewAudienceWorkspacePath,
    relevantPendingPreviewUpdate,
    setPendingPreviewUpdate,
    startPixelForgeMirror,
  ])

  const addPreviewTab = useCallback(() => {
    const nextTab = createPreviewTab('', null, previewTabsRef.current.length + 1)
    setPreviewTabs((currentTabs) => [...currentTabs, nextTab])
    setActivePreviewTabId(nextTab.id)
    setTargetUrl('')
    setAuthIssue(null)
    setShowUrlHistory(false)
    void syncStorePreviewUrl(null)
  }, [
    setActivePreviewTabId,
    setAuthIssue,
    setPreviewTabs,
    setShowUrlHistory,
    setTargetUrl,
    syncStorePreviewUrl,
  ])

  const launchPixelForgeTarget = useCallback(async () => {
    if (!projectPath) {
      toast.error('Select a project before launching a Pixel Forge target')
      return
    }

    setIsLaunchingPixelForgeTarget(true)
    try {
      const launchContext = await ensureIsolatedMirrorLaunchContext()
      const record = await startPixelForgeMirror({
        sourceRoot: launchContext.sourceRoot,
        forceRestart: true,
        announceSuccess: false,
        audienceWorkspacePath: launchContext.audienceWorkspacePath,
      })

      toast.success(
        record.already_running
          ? `Pixel Forge mirror ready · ${record.build_label}`
          : `Pixel Forge mirror launched · ${record.build_label}`
      )
    } catch (error) {
      console.error('[live-editor] Failed to launch Pixel Forge target:', error)
      toast.error(
        error instanceof Error
          ? `Failed to launch Pixel Forge target: ${error.message}`
          : 'Failed to launch Pixel Forge target'
      )
    } finally {
      setIsLaunchingPixelForgeTarget(false)
    }
  }, [ensureIsolatedMirrorLaunchContext, projectPath, startPixelForgeMirror])

  const closePreviewTab = useCallback(async (tabId: string) => {
    const closingIndex = previewTabsRef.current.findIndex((entry) => entry.id === tabId)
    if (closingIndex < 0) return

    const closingTab = previewTabsRef.current[closingIndex]
    if (closingTab.mode === 'proxy' && closingTab.proxySessionId) {
      try {
        await fetch(
          `${HTTP_BACKEND_URL}/config/app-proxy?session_id=${encodeURIComponent(closingTab.proxySessionId)}`,
          {
            method: 'DELETE',
            credentials: 'include',
          }
        )
      } catch (error) {
        console.error('[live-editor] Failed to clear closed proxy tab session:', error)
      }
    }

    if (closingTab.mode === 'browser' && closingTab.browserTabId) {
      const desktopPreview = desktopPreviewRef.current
      if (desktopPreview) {
        try {
          await desktopPreview.close(closingTab.browserTabId)
        } catch (error) {
          console.error('[live-editor] Failed to close embedded preview tab:', error)
        }
      } else {
        try {
          await fetch(`${HTTP_BACKEND_URL}/api/live-preview/browser/${encodeURIComponent(closingTab.browserTabId)}`, {
            method: 'DELETE',
            credentials: 'include',
          })
        } catch (error) {
          console.error('[live-editor] Failed to close managed browser tab:', error)
        }
      }
    }

    delete iframeRefs.current[tabId]

    const remainingTabs = previewTabsRef.current.filter((entry) => entry.id !== tabId)
    if (remainingTabs.length === 0) {
      const blankTab = createPreviewTab('', null, 1)
      previewTabsRef.current = [blankTab]
      activeTabIdRef.current = blankTab.id
      setPreviewTabs([blankTab])
      setActivePreviewTabId(blankTab.id)
      setTargetUrl('')
      setAuthIssue(null)
      await syncStorePreviewUrl(null)
      return
    }

    previewTabsRef.current = remainingTabs
    setPreviewTabs(remainingTabs)

    if (activeTabIdRef.current !== tabId) {
      return
    }

    const nextTab = remainingTabs[Math.max(0, closingIndex - 1)] ?? remainingTabs[0]
    activeTabIdRef.current = nextTab.id
    setActivePreviewTabId(nextTab.id)
    setTargetUrl(nextTab.url)
    setAuthIssue(null)
    setShowUrlHistory(false)
    await syncStorePreviewUrl(nextTab.url || null)

    if (nextTab.mode === 'browser' && nextTab.browserTabId) {
      const desktopPreview = desktopPreviewRef.current
      if (desktopPreview) {
        await desktopPreview.show(nextTab.browserTabId)
        await syncActivePreviewSelectionMode(nextTab.id)
        window.setTimeout(() => {
          void updateEmbeddedPreviewBounds()
        }, 60)
      } else {
        await sendBrowserCommand(nextTab.browserTabId, 'focus')
        await syncActivePreviewSelectionMode(nextTab.id)
      }
      return
    }

    await syncActivePreviewSelectionMode(nextTab.id)
  }, [
    sendBrowserCommand,
    setActivePreviewTabId,
    setAuthIssue,
    setPreviewTabs,
    setShowUrlHistory,
    setTargetUrl,
    syncActivePreviewSelectionMode,
    syncStorePreviewUrl,
    updateEmbeddedPreviewBounds,
  ])

  const refreshApp = useCallback(async () => {
    const activePreviewTab = getActivePreviewTab()
    if (!activePreviewTab) {
      return
    }

    if (activePreviewTab.mode === 'browser' && activePreviewTab.browserTabId) {
      await sendBrowserCommand(activePreviewTab.browserTabId, 'refresh')
      if (desktopPreviewRef.current) {
        window.setTimeout(() => {
          void updateEmbeddedPreviewBounds()
        }, 120)
      }
      toast.success(hasEmbeddedBrowserPreview ? 'Preview refreshed' : 'Browser refreshed', { duration: 1000 })
      return
    }

    const iframe = iframeRefs.current[activePreviewTab.id]
    if (!iframe || iframe.src === 'about:blank') {
      return
    }

    try {
      const nextUrl = new URL(iframe.src)
      nextUrl.searchParams.set('_pf_t', String(Date.now()))
      const nextFrameSrc = nextUrl.toString()
      iframe.src = nextFrameSrc
      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry) =>
          entry.id === activePreviewTab.id
            ? { ...entry, frameSrc: nextFrameSrc }
            : entry
        )
      )
      toast.success('Refreshed', { duration: 1000 })
    } catch (error) {
      console.error('[live-editor] Failed to refresh active preview tab:', error)
    }
  }, [
    getActivePreviewTab,
    hasEmbeddedBrowserPreview,
    sendBrowserCommand,
    setPreviewTabs,
    updateEmbeddedPreviewBounds,
  ])

  useEffect(() => {
    if (lastProjectPathRef.current === projectPath) {
      return
    }

    lastProjectPathRef.current = projectPath
    externalPreviewUrlRef.current = previewUrl?.trim() || null
    iframeRefs.current = {}
    setShowUrlHistory(false)
    setAuthIssue(null)
  }, [
    previewUrl,
    projectPath,
    setAuthIssue,
    setShowUrlHistory,
  ])

  useEffect(() => {
    const normalizedPreviewUrl = previewUrl?.trim() || null
    if (internalPreviewUrlRef.current === normalizedPreviewUrl) {
      internalPreviewUrlRef.current = null
      externalPreviewUrlRef.current = normalizedPreviewUrl
      return
    }

    if (externalPreviewUrlRef.current === normalizedPreviewUrl) {
      return
    }
    externalPreviewUrlRef.current = normalizedPreviewUrl

    const activePreviewTab = activeTabIdRef.current
      ? previewTabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ?? null
      : previewTabsRef.current[0] ?? null
    if (!activePreviewTab) {
      return
    }

    if (!normalizedPreviewUrl) {
      if (activePreviewTab.url) {
        setPreviewTabs((currentTabs) =>
          currentTabs.map((entry, index) =>
            entry.id === activePreviewTab.id
              ? {
                  ...entry,
                  url: '',
                  title: getPreviewTabTitle('', null, index + 1),
                  mode: null,
                  frameSrc: 'about:blank',
                  snapshotDataUrl: null,
                  proxySessionId: null,
                  browserTabId: null,
                  canGoBack: false,
                  canGoForward: false,
                }
              : entry
          )
        )
      }
      setTargetUrl('')
      setAuthIssue(null)
      return
    }

    if (normalizedPreviewUrl === activePreviewTab.url) {
      setTargetUrl(normalizedPreviewUrl)
      return
    }

    setTargetUrl(normalizedPreviewUrl)
    void loadAppRef.current?.(normalizedPreviewUrl, {
      tabId: activePreviewTab.id,
      persist: false,
      announceSuccess: false,
    })
  }, [previewUrl, setAuthIssue, setPreviewTabs, setTargetUrl])

  useEffect(() => {
    const desktopPreview = desktopPreviewRef.current
    if (!desktopPreview) {
      return
    }

    let frameId: number | null = null
    const syncBounds = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
      frameId = window.requestAnimationFrame(() => {
        void updateEmbeddedPreviewBounds()
      })
    }

    syncBounds()

    const resizeObserver = new ResizeObserver(() => {
      syncBounds()
    })

    if (previewHostRef.current) {
      resizeObserver.observe(previewHostRef.current)
    }

    window.addEventListener('resize', syncBounds)

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
      resizeObserver.disconnect()
      window.removeEventListener('resize', syncBounds)
      void desktopPreview.hide()
    }
  }, [activePreviewTabId, previewTabs, updateEmbeddedPreviewBounds])

  useEffect(() => {
    void syncActivePreviewSelectionMode(activePreviewTabId)
  }, [activePreviewTabId, activePreviewTool, syncActivePreviewSelectionMode])

  const toggleSelectionTool = useCallback(() => {
    const nextTool = isSelectionToolActive ? null : 'select'
    setActivePreviewTool(nextTool)

    if (nextTool === 'select') {
      const activePreviewTab = getActivePreviewTab()
      if (activePreviewTab?.mode === 'browser') {
        toast.success(
          hasEmbeddedBrowserPreview
            ? 'Select mode ON - click elements in the embedded browser'
            : 'Select mode ON - use the managed browser window to click elements',
          {
          duration: 2500,
          }
        )
      } else {
        toast.success('Select mode ON - click elements to select', {
          duration: 2000,
        })
      }
    }
  }, [getActivePreviewTab, hasEmbeddedBrowserPreview, isSelectionToolActive, setActivePreviewTool])

  const handleIframeLoad = useCallback((tabId: string) => {
    setTimeout(() => {
      const tab = getPreviewTabById(tabId)
      const iframe = iframeRefs.current[tabId]
      if (!tab || tab.mode !== 'proxy' || !iframe?.contentWindow) {
        return
      }

      iframe.contentWindow.postMessage(
        {
          type: 'pixel-forge-toggle-select',
          enabled: isSelectionToolActive && tabId === activeTabIdRef.current,
        },
        '*'
      )
      void syncTabSelections(tabId, { reveal: tabId === activeTabIdRef.current })
    }, 120)
  }, [getPreviewTabById, isSelectionToolActive, syncTabSelections])

  useEffect(() => {
    const handleProxyMessage = (event: MessageEvent) => {
      const sourceTab = getTabForMessageSource(event.source)
      const activePreviewTab = getActivePreviewTab()

      if (event.data.type === 'pixel-forge-element-selected') {
        if (!sourceTab) {
          return
        }
        const selection = parsePreviewSelectionData(
          event.data.data || {},
          sourceTab
        )
        if (selection) {
          addElement(selection)
        }
      } else if (event.data.type === 'pixel-forge-element-updated') {
        if (!sourceTab) {
          return
        }
        const selection = parsePreviewSelectionData(
          event.data.data || {},
          sourceTab
        )
        if (selection) {
          replaceElement(selection.id, selection)
        }
      } else if (event.data.type === 'pixel-forge-element-deselected') {
        if (!sourceTab) {
          return
        }
        const element = selectedElementsRef.current.find(
          (entry) =>
            entry.id === event.data.data?.selectionId
            || (
              typeof event.data.data?.xpath === 'string'
              && entry.xpath === event.data.data.xpath
              && entry.sourceTabId === sourceTab.id
            )
        )
        if (element) {
          removeElement(element.id)
        }
      } else if (event.data.type === 'pixel-forge-cancel-select') {
        setActivePreviewTool(null)
      } else if (event.data.type === 'pixel-forge-auth-required') {
        const status = Number(event.data.data?.status || 0)
        const failingUrl = String(event.data.data?.url || '')
        if (!sourceTab || sourceTab.id === activePreviewTab?.id) {
          setAuthIssue({ status, url: failingUrl })
        }
        const toastId = `auth-${sourceTab?.id || 'preview'}`
        authToastIdsRef.current[sourceTab?.id || 'preview'] = toastId
        toast.error(
          status === 401 || status === 403
            ? `Target authentication required (${status}).`
            : 'Target authentication required.',
          { id: toastId }
        )
      } else if (event.data.type === 'pixel-forge-location-changed') {
        if (!sourceTab) {
          return
        }

        const nextUrl =
          typeof event.data.data?.url === 'string'
            ? event.data.data.url
            : sourceTab.url
        const nextTitle =
          typeof event.data.data?.title === 'string'
            ? event.data.data.title
            : sourceTab.title

        setPreviewTabs((currentTabs) =>
          currentTabs.map((entry, index) =>
            entry.id === sourceTab.id
              ? {
                  ...entry,
                  url: nextUrl,
                  title: getPreviewTabTitle(nextUrl, nextTitle, index + 1),
                }
              : entry
          )
        )

        if (sourceTab.id === activePreviewTab?.id) {
          setTargetUrl(nextUrl)
          void syncStorePreviewUrl(nextUrl)
        }
      }
    }

    window.addEventListener('message', handleProxyMessage)
    return () => window.removeEventListener('message', handleProxyMessage)
  }, [
    addElement,
    getActivePreviewTab,
    getTabForMessageSource,
    removeElement,
    replaceElement,
    setActivePreviewTool,
    setAuthIssue,
    setPreviewTabs,
    setTargetUrl,
    syncStorePreviewUrl,
  ])

  const handleBrowserPreviewEvent = useCallback((payload: BrowserPreviewEvent) => {
    const sourceTab = getPreviewTabByBrowserId(payload.browser_tab_id)
    const activePreviewTab = getActivePreviewTab()

    if (!sourceTab) {
      return
    }

    if (payload.type === 'browser-location-changed') {
      const nextUrl = normalizePersistedPreviewUrl(
        typeof payload.url === 'string' ? payload.url : sourceTab.url,
        sourceTab.url,
      ) || sourceTab.url
      const nextTitle = typeof payload.title === 'string' ? payload.title : sourceTab.title

      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry, index) =>
          entry.id === sourceTab.id
            ? {
                ...entry,
                url: nextUrl,
                title: getPreviewTabTitle(nextUrl, nextTitle, index + 1),
                canGoBack:
                  typeof payload.can_go_back === 'boolean'
                    ? payload.can_go_back
                    : entry.canGoBack,
                canGoForward:
                  typeof payload.can_go_forward === 'boolean'
                    ? payload.can_go_forward
                    : entry.canGoForward,
              }
            : entry
        )
      )

      if (sourceTab.id === activePreviewTab?.id) {
        setTargetUrl(nextUrl)
        pushUrlHistory(nextUrl)
        void syncStorePreviewUrl(nextUrl)
      }

      window.setTimeout(() => {
        void syncTabSelections(sourceTab.id, {
          reveal: sourceTab.id === activePreviewTab?.id,
        })
      }, 250)
      return
    }

    if (payload.type === 'browser-tab-snapshot') {
      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry) =>
          entry.id === sourceTab.id
            ? {
                ...entry,
                snapshotDataUrl: payload.snapshot_data_url || null,
              }
            : entry
        )
      )
      return
    }

    if (payload.type === 'browser-element-selected') {
      const data = payload.data || {}
      const selection = parsePreviewSelectionData(data, sourceTab)
      if (selection) {
        addElement(selection)
      }
      return
    }

    if (payload.type === 'browser-element-updated') {
      const data = payload.data || {}
      const selection = parsePreviewSelectionData(data, sourceTab)
      if (selection) {
        replaceElement(selection.id, selection)
      }
      return
    }

    if (payload.type === 'browser-element-deselected') {
      const data = payload.data || {}
      const element = selectedElementsRef.current.find(
        (entry) =>
          entry.id === data.selectionId
          || (
            typeof data.xpath === 'string'
            && entry.xpath === data.xpath
            && entry.sourceTabId === sourceTab.id
          )
      )
      if (element) {
        removeElement(element.id)
      }
      return
    }

    if (payload.type === 'browser-select-cancelled') {
      setActivePreviewTool(null)
      return
    }

    if (payload.type === 'browser-selection-cleared') {
      const toRemove = selectedElementsRef.current
        .filter((entry) => entry.sourceTabId === sourceTab.id)
        .map((entry) => entry.id)
      removeElements(toRemove)
      return
    }

    if (payload.type === 'browser-load-failed') {
      const status = Number(payload.data?.errorCode || 0)
      const failingUrl =
        typeof payload.data?.url === 'string'
          ? payload.data.url
          : sourceTab.url
      if (sourceTab.id === activePreviewTab?.id) {
        setAuthIssue({ status, url: failingUrl })
      }
      toast.error(`Preview load failed: ${payload.data?.errorDescription || 'Unknown error'}`)
      return
    }

    if (payload.type === 'browser-tab-closed') {
      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry) =>
          entry.id === sourceTab.id
            ? {
                ...entry,
                browserTabId: null,
                canGoBack: false,
                canGoForward: false,
                snapshotDataUrl: null,
                mode: null,
              }
            : entry
        )
      )
      toast.error(
        hasEmbeddedBrowserPreview
          ? 'Embedded preview tab was closed. Reload the URL to reopen it.'
          : 'Managed browser tab was closed. Reload the URL to reopen it.'
      )
    }
  }, [
    addElement,
    getActivePreviewTab,
    getPreviewTabByBrowserId,
    hasEmbeddedBrowserPreview,
    pushUrlHistory,
    removeElement,
    removeElements,
    replaceElement,
    setActivePreviewTool,
    setAuthIssue,
    setPreviewTabs,
    setTargetUrl,
    syncStorePreviewUrl,
    syncTabSelections,
  ])

  useEffect(() => {
    if (desktopPreviewRef.current) {
      const handleNativePreviewEvent = (event: Event) => {
        const payload = (event as CustomEvent<BrowserPreviewEvent>).detail
        handleBrowserPreviewEvent(payload)
      }

      window.addEventListener('pixel-forge-preview', handleNativePreviewEvent as EventListener)
      return () => {
        window.removeEventListener('pixel-forge-preview', handleNativePreviewEvent as EventListener)
      }
    }

    const wsUrl = `${WS_BACKEND_URL}/ws/live-preview`
    const ws = new WebSocket(wsUrl)

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as BrowserPreviewEvent
      handleBrowserPreviewEvent(payload)
    }

    return () => ws.close()
  }, [handleBrowserPreviewEvent])

  const handleClearElements = useCallback(() => {
    clearElements()

    for (const tab of previewTabsRef.current) {
      if (tab.mode === 'proxy') {
        iframeRefs.current[tab.id]?.contentWindow?.postMessage(
          { type: 'pixel-forge-clear-selections' },
          '*'
        )
        continue
      }

      if (tab.mode === 'browser' && tab.browserTabId) {
        void sendBrowserCommand(tab.browserTabId, 'clear')
      }
    }
  }, [clearElements, sendBrowserCommand])

  const handleRemoveElement = useCallback((
    id: string,
    sourceTabId: string,
    _sourceUrl: string
  ) => {
    removeElement(id)

    const sourceTab = getPreviewTabById(sourceTabId)
    if (!sourceTab) {
      return
    }

    if (sourceTab.mode === 'proxy') {
      iframeRefs.current[sourceTabId]?.contentWindow?.postMessage(
        { type: 'pixel-forge-deselect', selectionId: id },
        '*'
      )
      return
    }

    if (sourceTab.mode === 'browser' && sourceTab.browserTabId) {
      void sendBrowserCommand(sourceTab.browserTabId, 'deselect', { selectionId: id })
    }
  }, [getPreviewTabById, removeElement, sendBrowserCommand])

  const handleUndoSelections = useCallback(() => {
    undoSelectionChange()
  }, [undoSelectionChange])

  const handleRedoSelections = useCallback(() => {
    redoSelectionChange()
  }, [redoSelectionChange])

  const viewportShellStyle =
    viewportMode === 'phone'
      ? { width: 'min(100%, 430px)', maxWidth: '430px' }
      : viewportMode === 'desktop'
        ? { width: 'min(100%, 1280px)', maxWidth: '1280px' }
        : { width: '100%', maxWidth: '100%' }

  const viewportFrameClassName =
    viewportMode === 'phone'
      ? 'h-full overflow-hidden rounded-[28px] border border-border bg-white shadow-2xl'
      : 'h-full overflow-hidden rounded-xl border border-border bg-white shadow-sm'

  const viewportModes: {
    mode: ViewportMode
    label: string
    title: string
    icon: typeof ArrowLeftRight
  }[] = [
    {
      mode: 'fluid',
      label: 'Fit',
      title: 'Fit preview to available browser width',
      icon: ArrowLeftRight,
    },
    {
      mode: 'desktop',
      label: 'Desktop',
      title: 'Lock preview to a desktop-width viewport',
      icon: Monitor,
    },
    {
      mode: 'phone',
      label: 'Phone',
      title: 'Lock preview to a phone-width viewport',
      icon: Smartphone,
    },
  ]

  const activePreviewTab = getActivePreviewTab()
  const activeMirrorTarget = activePreviewTab?.localTarget
  const hasPendingPreviewUpdate = canLaunchSelfMirror && Boolean(
    relevantPendingPreviewUpdate?.snapshotPath
    && activeMirrorTarget?.sourceRoot !== relevantPendingPreviewUpdate.snapshotPath
  )
  const previewUnavailableMessage =
    'Live Editor preview runs inside the Pixel Forge desktop shell. Use the dock icon or run `pixel-forge open`.'

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border bg-card/60 backdrop-blur-sm">
          <div className="flex items-center gap-1 overflow-x-auto px-3 py-1.5">
            {previewTabs.map((tab, index) => (
              <div
                key={tab.id}
                className={`group flex min-w-[10rem] max-w-[16rem] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                  tab.id === activePreviewTabId
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/50 bg-background/40 text-muted-foreground hover:bg-background/70 hover:text-foreground'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void activatePreviewTab(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={tab.url || tab.title}
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">
                      {tab.title || `Tab ${index + 1}`}
                    </div>
                    <div className="truncate text-[11px] opacity-80">
                      {tab.url || 'Blank tab'}
                    </div>
                    {tab.mode && (
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] opacity-70">
                        {tab.mode === 'browser'
                          ? hasEmbeddedBrowserPreview
                            ? 'Chromium'
                            : 'Chrome'
                          : 'Proxy'}
                      </div>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void closePreviewTab(tab.id)}
                  className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/10"
                  aria-label={`Close ${tab.title || `Tab ${index + 1}`}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={addPreviewTab}
              className="h-8 shrink-0 border-dashed border-border/60 px-2 text-xs"
              title="Open another preview tab"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              New Tab
            </Button>
          </div>

          <div className="flex flex-wrap items-start gap-1.5 border-t border-border/50 px-3 py-1.5">
            {/* Back / Forward navigation */}
            <div className="flex gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={goBack}
                disabled={!canGoBack}
                className="h-7 w-7 p-0"
                title="Back"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={goForward}
                disabled={!canGoForward}
                className="h-7 w-7 p-0"
                title="Forward"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div ref={urlHistoryAnchorRef} className="min-w-[16rem] flex-1">
              <div className="flex gap-0">
                <Input
                  value={targetUrl}
                  onChange={(event) => setTargetUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void loadApp()
                    }
                  }}
                  placeholder="Enter preview URL..."
                  className="h-7 rounded-r-none border-border/60 bg-background/50 font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-l-none border-l-0 border-border/60 px-1.5"
                  onClick={() => void openUrlHistory()}
                  disabled={scopedUrlHistory.length === 0}
                  title="Recent preview URLs"
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${showUrlHistory ? 'rotate-180' : ''}`} />
                </Button>
              </div>
              {showUrlHistory && scopedUrlHistory.length > 0 && (
                <div className="mt-1 rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md">
                  <div className="max-h-48 overflow-y-auto py-1">
                    {scopedUrlHistory.map((url) => (
                      <button
                        key={url}
                        onClick={() => {
                          setTargetUrl(url)
                          setShowUrlHistory(false)
                          void loadApp(url)
                        }}
                        className={`flex w-full items-center px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-primary/10 ${
                          url === targetUrl ? 'bg-primary/5 text-primary' : ''
                        }`}
                      >
                        <span className="truncate">{url}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadApp()}
              disabled={!hasEmbeddedBrowserPreview}
              className="h-7 gap-1 border-border/60 px-2.5 text-xs"
            >
              <Play className="h-3 w-3" />
              Load
            </Button>
            {projectPath && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openWorkspacePreviewLauncher()}
                disabled={!hasEmbeddedBrowserPreview || workspacePreviewCandidatesLoading}
                className="h-7 gap-1 border-border/60 px-2.5 text-xs"
                title="Discover and launch a workspace-bound preview from the active lane workspace"
              >
                {workspacePreviewCandidatesLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Rocket className="h-3 w-3" />
                )}
                Preview
              </Button>
            )}
            {projectPath && canLaunchSelfMirror && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void launchPixelForgeTarget()}
                disabled={!hasEmbeddedBrowserPreview || isLaunchingPixelForgeTarget}
                className="h-7 gap-1 border-border/60 px-2.5 text-xs"
                title="Launch or rebuild the isolated Pixel Forge mirror for this session"
              >
                <ExternalLink className="h-3 w-3" />
                {isLaunchingPixelForgeTarget ? 'Launching...' : 'Mirror'}
              </Button>
            )}
            {hasPendingPreviewUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadUpdatedPixelForgePreview()}
                disabled={!hasEmbeddedBrowserPreview}
                className="h-7 gap-1 border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs text-emerald-100 hover:bg-emerald-500/20"
                title="Load the updated clone preview into this chat's primary mirror"
              >
                <RefreshCw className="h-3 w-3" />
                Load Updated Preview
              </Button>
            )}
            <div className="mx-0.5 h-4 w-px bg-border/40" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshApp()}
              title="Refresh preview"
              disabled={!hasEmbeddedBrowserPreview}
              className="h-7 w-7 border-border/60 p-0"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
            <Button
              variant={isSelectionToolActive ? 'default' : 'outline'}
              size="sm"
              onClick={toggleSelectionTool}
              disabled={!hasEmbeddedBrowserPreview}
              className={`h-7 gap-1 px-2.5 text-xs transition-all ${
                isSelectionToolActive
                  ? 'bg-primary text-primary-foreground shadow-[0_0_12px_-3px_hsl(var(--primary)/0.4)]'
                  : 'border-border/60'
              }`}
            >
              <MousePointer2 className="h-3 w-3" />
              {isSelectionToolActive ? 'Selecting' : 'Select'}
            </Button>

              <div className="ml-auto flex items-center gap-1.5">
                <div className="flex items-center gap-0.5 rounded-md border border-border/40 bg-background/40 p-0.5">
                  {viewportModes.map(({ mode, label, title, icon: Icon }) => (
                    <Button
                    key={mode}
                    variant={viewportMode === mode ? 'default' : 'ghost'}
                    size="sm"
                    className={`h-6 gap-1 px-2 text-xs ${
                      viewportMode === mode ? 'bg-primary/15 text-primary shadow-none' : 'text-muted-foreground'
                    }`}
                    onClick={() => setViewportMode(mode)}
                    title={title}
                  >
                    <Icon className="h-3 w-3" />
                    <span className="hidden sm:inline">{label}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-background/50 p-3">
          {authIssue && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              <AlertTriangle className="h-4 w-4 text-amber-300" />
              <span className="min-w-0 flex-1">
                Upstream auth required: {authIssue.status} on{' '}
                <code className="break-all rounded bg-black/20 px-1 py-0.5 text-xs">
                  {authIssue.url || targetUrl}
                </code>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="border-amber-400/50 bg-transparent text-amber-100 hover:bg-amber-500/10"
                onClick={() => {
                  if (!targetUrl) return
                  const loginUrl = new URL('/login', targetUrl).toString()
                  setTargetUrl(loginUrl)
                  void loadApp(loginUrl)
                }}
              >
                Load /login
              </Button>
            </div>
          )}

          <div
            className="mx-auto h-full min-h-[28rem] transition-[width,max-width] duration-200 ease-out"
            style={viewportShellStyle}
          >
            <div className={`${viewportFrameClassName} relative`}>
              {!hasEmbeddedBrowserPreview && (
                <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
                  <div className="max-w-lg rounded-2xl border border-border/60 bg-card/80 p-6 text-center shadow-xl backdrop-blur-sm">
                    <div className="text-sm font-medium text-foreground">
                      Pixel Forge Desktop is required for Live Editor preview
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {previewUnavailableMessage}
                    </p>
                  </div>
                </div>
              )}
              {previewTabs.some((tab) => tab.mode === 'proxy') && (
                <>
                  {previewTabs.map((tab) => (
                    <iframe
                      key={tab.id}
                      ref={(iframe) => setIframeRef(tab.id, iframe)}
                      src={tab.mode === 'proxy' ? tab.frameSrc : 'about:blank'}
                      className={`absolute inset-0 h-full w-full border-0 bg-white ${
                        tab.id === activePreviewTabId && tab.mode === 'proxy' ? 'block' : 'hidden'
                      }`}
                      onLoad={() => handleIframeLoad(tab.id)}
                    />
                  ))}
                </>
              )}

              {hasEmbeddedBrowserPreview && activePreviewTab?.mode !== 'proxy' && (
                <div
                  ref={previewHostRef}
                  className="absolute inset-0 bg-white"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex w-[clamp(320px,26vw,420px)] min-w-[300px] max-w-[42vw] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-card/50">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value === 'elements' ? 'elements' : 'chat')}
          className="flex h-full flex-col overflow-hidden"
        >
          <TabsList className="mx-2 mt-2 grid w-auto grid-cols-2 flex-shrink-0 bg-background/50">
            <TabsTrigger value="chat" className="gap-1.5 text-xs">
              <MessageSquare className="h-3.5 w-3.5" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="elements" className="gap-1.5 text-xs">
              <Layers className="h-3.5 w-3.5" />
              Elements
              {selectedElements.length > 0 && (
                <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {selectedElements.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <div className="mt-2 flex flex-1 min-h-0 flex-col overflow-hidden">
            <TabsContent
              value="chat"
              className="m-0 min-h-0 flex-1 min-w-0 overflow-hidden"
            >
              <div className="flex h-full flex-col overflow-hidden">
                <ChatMessages
                  onRefreshPreview={() => void refreshApp()}
                  onLoadPreviewUpdate={() => void loadUpdatedPixelForgePreview()}
                  onApplyControllerUpdate={() => void applyControllerUpdate()}
                />
              </div>
            </TabsContent>

            <TabsContent
              value="elements"
              className="m-0 min-h-0 flex-1 overflow-hidden p-3"
            >
              <SelectedElementsList
                onClearAll={handleClearElements}
                onRemoveElement={handleRemoveElement}
                onUndo={handleUndoSelections}
                onRedo={handleRedoSelections}
                canUndo={canUndoSelections}
                canRedo={canRedoSelections}
              />
            </TabsContent>
          </div>
        </Tabs>

        <div className={activeTab === 'chat' ? 'block' : 'hidden'}>
          <ChatInput />
        </div>
      </div>

      <Dialog
        open={workspacePreviewDialogOpen}
        onOpenChange={(open) => {
          setWorkspacePreviewDialogOpen(open)
          if (!open) {
            setStartingWorkspacePreviewCandidateId(null)
          }
        }}
      >
        <DialogContent className="w-[min(92vw,42rem)] max-h-[min(84vh,46rem)] overflow-hidden p-0 sm:max-w-none">
          <div className="flex max-h-[min(84vh,46rem)] flex-col">
            <DialogHeader className="border-b border-border/40 px-6 py-4 pr-12">
              <DialogTitle>Workspace Preview</DialogTitle>
              <DialogDescription>
                Launch an isolated preview from the current lane workspace. The visible preview URL stays stable even if the real dev-server port has to move.
              </DialogDescription>
              {workspacePreviewWorkspacePath && (
                <div className="mt-2 rounded-md border border-border/40 bg-background/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  {workspacePreviewWorkspacePath}
                </div>
              )}
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {workspacePreviewCandidatesLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Inspecting workspace preview candidates...
                </div>
              ) : workspacePreviewCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
                  No supported preview candidates were found in this workspace yet. This launcher currently targets common `package.json` app shapes with `dev`, `start`, or `serve` scripts.
                </div>
              ) : (
                <div className="space-y-3">
                  {workspacePreviewCandidates.map((candidate) => {
                    const isStarting = startingWorkspacePreviewCandidateId === candidate.candidate_id
                    return (
                      <button
                        key={candidate.candidate_id}
                        type="button"
                        disabled={Boolean(startingWorkspacePreviewCandidateId)}
                        onClick={() => void launchWorkspacePreviewCandidate(candidate)}
                        className="w-full rounded-xl border border-border/60 bg-background/50 p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:cursor-wait disabled:opacity-70"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-medium text-foreground">
                                {candidate.title}
                              </div>
                              {candidate.recommended && (
                                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                                  Recommended
                                </span>
                              )}
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                              {candidate.relative_app_path}
                            </div>
                          </div>
                          <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                            <div>{candidate.package_manager} · {candidate.script_name}</div>
                            <div>{candidate.framework || 'generic'}{candidate.preferred_port ? ` · prefers ${candidate.preferred_port}` : ''}</div>
                          </div>
                        </div>
                        <div className="mt-3 rounded-md border border-border/40 bg-background/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                          {candidate.command_preview}
                        </div>
                        <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>
                            Bound to this workspace, not whatever localhost port happens to be alive.
                          </span>
                          <span className="inline-flex items-center gap-1 text-foreground">
                            {isStarting ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Starting...
                              </>
                            ) : (
                              'Launch preview'
                            )}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default LiveEditorPane
