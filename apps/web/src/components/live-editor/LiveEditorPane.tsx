/**
 * LiveEditorPane Component
 *
 * Live Editor preview is shell-first: every inspected page should render inside
 * Pixel Forge's embedded Chromium surface rather than through a proxy iframe.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '@/store/session-store'
import { HTTP_BACKEND_URL, WS_BACKEND_URL } from '@/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PixelForgePendingPreviewUpdate } from '@/types/pixel-forge-desktop'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  Globe2,
  Layers,
  MessageSquare,
  Monitor,
  MousePointer2,
  Play,
  Plus,
  RefreshCw,
  Smartphone,
  X,
} from 'lucide-react'
import toast from 'react-hot-toast'

import { ChatInput } from './ChatInput'
import { ChatMessages } from './ChatMessages'
import {
  isCloneWorkspaceBound,
  resolveUsableIsolatedMirrorTarget,
  resolveIsolatedMirrorSourceRoot,
} from './mirror-targets'
import { SelectedElementsList } from './SelectedElementsList'
import { useLiveEditorStore } from './store/chat-store'
import {
  type SelectionRecord,
  type SelectionRegion,
} from './selection-engine'

type ViewportMode = 'fluid' | 'desktop' | 'phone'
type PreviewMode = 'proxy' | 'browser' | null

interface LocalTargetMeta {
  kind: 'pixel-forge'
  runtimeKind: 'mirror' | 'dev'
  instanceSlug: string
  projectPath: string
  sourceRoot: string
  buildLabel: string
  createdAt: string | null
}

interface PreviewTab {
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

interface BrowserPreviewLoadResponse {
  mode: 'browser'
  target_url: string
  browser_tab_id: string
  title: string
  snapshot_data_url: string | null
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
  state_dir: string
  log_file: string
  pid: number | null
  target_mode: boolean
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
  rootXPath: string | null
  rootTagName: string | null
  rootElementId: string | null
  rootClassList: string[]
  region: SelectionRegion | null
}

function toLocalTargetMeta(record: LocalPixelForgeTargetResponse): LocalTargetMeta {
  return {
    kind: record.kind,
    runtimeKind: record.runtime_kind,
    instanceSlug: record.instance_slug,
    projectPath: record.project_path,
    sourceRoot: record.source_root,
    buildLabel: record.build_label,
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

  if (!selectionId) {
    return null
  }

  if (selectorKind === 'dom' && !xpath) {
    return null
  }

  if (selectorKind === 'region' && !rootXPath) {
    return null
  }

  const sourceUrl =
    typeof data.pageUrl === 'string'
      ? data.pageUrl
      : sourceTab.url

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
    frameSrc: 'about:blank',
    snapshotDataUrl: null,
    localTarget: null,
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
    let message = `HTTP ${response.status}`
    try {
      const payload = await response.json()
      if (typeof payload?.detail === 'string') {
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
    agentDeckTargets,
    createAgentDeckTargetSession,
    selectedAgentDeckTargetId,
    pendingPreviewUpdate,
    setPendingPreviewUpdate,
    setPreviewUrl,
  } = useSessionStore()

  const targetUrlRef = useRef(previewUrl || '')
  const previewTabsRef = useRef<PreviewTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const lastProjectPathRef = useRef<string | null | undefined>(undefined)
  const internalPreviewUrlRef = useRef<string | null>(null)
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({})
  const authToastIdsRef = useRef<Record<string, string>>({})
  const previewHostRef = useRef<HTMLDivElement | null>(null)
  const urlHistoryAnchorRef = useRef<HTMLDivElement | null>(null)
  const desktopPreviewRef = useRef(window.pixelForgeDesktop?.preview ?? null)
  const desktopOverlayRef = useRef(window.pixelForgeDesktop?.overlay ?? null)
  const desktopAppRef = useRef(window.pixelForgeDesktop?.app ?? null)

  const [selectMode, setSelectMode] = useState(false)
  const [targetUrl, setTargetUrl] = useState(previewUrl || '')
  const [activeTab, setActiveTab] = useState('chat')
  const [viewportMode, setViewportMode] = useState<ViewportMode>('fluid')
  const [authIssue, setAuthIssue] = useState<{ status: number; url: string } | null>(null)
  const [showUrlHistory, setShowUrlHistory] = useState(false)
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>(() => [
    createPreviewTab('', null, 1),
  ])
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null)
  const [isLaunchingPixelForgeTarget, setIsLaunchingPixelForgeTarget] = useState(false)
  const [, setMirrorBuilds] = useState<LocalPixelForgeTargetResponse[]>([])

  // URL navigation history (back/forward)
  const [urlHistory, setUrlHistory] = useState<string[]>([])
  const [urlHistoryCursor, setUrlHistoryCursor] = useState(-1)
  const urlNavRef = useRef(false) // flag to skip pushing during back/forward

  const canGoBack = urlHistoryCursor > 0
  const canGoForward = urlHistoryCursor < urlHistory.length - 1

  const pushUrlHistory = useCallback((url: string) => {
    if (urlNavRef.current) {
      urlNavRef.current = false
      return
    }
    if (!url) return
    setUrlHistory((prev) => {
      const truncated = prev.slice(0, urlHistoryCursor + 1)
      if (truncated[truncated.length - 1] === url) return truncated
      return [...truncated, url]
    })
    setUrlHistoryCursor((prev) => prev + 1)
  }, [urlHistoryCursor])

  const goBack = useCallback(() => {
    if (!canGoBack) return
    const prevUrl = urlHistory[urlHistoryCursor - 1]
    setUrlHistoryCursor((c) => c - 1)
    setTargetUrl(prevUrl)
    urlNavRef.current = true
    void loadAppRef.current?.(prevUrl)
  }, [canGoBack, urlHistory, urlHistoryCursor])

  const goForward = useCallback(() => {
    if (!canGoForward) return
    const nextUrl = urlHistory[urlHistoryCursor + 1]
    setUrlHistoryCursor((c) => c + 1)
    setTargetUrl(nextUrl)
    urlNavRef.current = true
    void loadAppRef.current?.(nextUrl)
  }, [canGoForward, urlHistory, urlHistoryCursor])

  // We need a ref to loadApp so goBack/goForward can call it without circular deps
  const loadAppRef = useRef<((url?: string) => Promise<void>) | null>(null)

  const currentProjectUrls = useSessionStore((state) => {
    if (!state.projectPath) return []
    const project = state.recentProjects.find((entry) => entry.path === state.projectPath)
    return project?.previewUrls ?? []
  })
  const selectedAgentDeckTarget = agentDeckTargets.find(
    (target) => target.id === selectedAgentDeckTargetId
  ) ?? null
  const resolvedMirrorTarget = resolveUsableIsolatedMirrorTarget({
    projectPath,
    liveWorkspacePath: liveEditorSession?.workspacePath || null,
    liveAgentDeckSessionId: liveEditorSession?.agentDeckSessionId || null,
    selectedTargetId: selectedAgentDeckTargetId,
    agentDeckTargets,
  })
  const liveSessionBoundToCanonicalRoot = Boolean(
    liveEditorSession?.workspacePath
    && !isCloneWorkspaceBound({ projectPath, workspacePath: liveEditorSession.workspacePath })
  )
  const previewAudienceWorkspacePath = liveSessionBoundToCanonicalRoot
    ? null
    : resolvedMirrorTarget?.workspacePath || null
  const previewAudienceSessionId = liveSessionBoundToCanonicalRoot
    ? null
    : resolvedMirrorTarget?.agentDeckSessionId || null

  const {
    connect,
    disconnect,
    connected,
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
  const selectedElementsRef = useRef(selectedElements)
  const hasEmbeddedBrowserPreview = desktopPreviewRef.current !== null
  const canUndoSelections = selectionUndoStack.length > 0
  const canRedoSelections = selectionRedoStack.length > 0

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
  }, [activePreviewTabId, previewTabs])

  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  useEffect(() => {
    const timer1 = setTimeout(() => setActiveTab('elements'), 500)
    const timer2 = setTimeout(() => setActiveTab('chat'), 600)
    return () => {
      clearTimeout(timer1)
      clearTimeout(timer2)
    }
  }, [])

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
  }, [projectPath])

  useEffect(() => {
    void refreshMirrorBuilds()
  }, [refreshMirrorBuilds])

  useEffect(() => {
    if (!projectPath || !previewAudienceWorkspacePath) {
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
    previewAudienceSessionId,
    previewAudienceWorkspacePath,
    projectPath,
    setPendingPreviewUpdate,
  ])

  const setIframeRef = useCallback((tabId: string, iframe: HTMLIFrameElement | null) => {
    iframeRefs.current[tabId] = iframe
  }, [])

  const attachLocalTargetToTab = useCallback((tabId: string, record: LocalPixelForgeTargetResponse) => {
    const meta = toLocalTargetMeta(record)
    setPreviewTabs((currentTabs) =>
      currentTabs.map((entry) =>
        entry.id === tabId
          ? {
              ...entry,
              localTarget: meta,
            }
          : entry
      )
    )
  }, [])

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
      const normalizedUrl = url?.trim() || null
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
    action: 'focus' | 'set_select_mode' | 'clear' | 'deselect' | 'apply' | 'refresh',
    payload?: Record<string, unknown>
  ) => {
    const desktopPreview = desktopPreviewRef.current
    if (desktopPreview) {
      try {
        if (action === 'focus') {
          await desktopPreview.focus(browserTabId)
          return null
        }
        if (action === 'set_select_mode') {
          return await desktopPreview.setSelectMode(browserTabId, Boolean(payload?.enabled))
        }
        if (action === 'clear') {
          return await desktopPreview.clearSelections(browserTabId)
        }
        if (action === 'deselect') {
          return await desktopPreview.deselect(browserTabId, String(payload?.selectionId || ''))
        }
        if (action === 'apply') {
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
                && (entry.rootXPath === null || typeof entry.rootXPath === 'string')
                && (entry.rootTagName === null || typeof entry.rootTagName === 'string')
                && (entry.rootElementId === null || typeof entry.rootElementId === 'string')
                && Array.isArray(entry.rootClassList)
                && entry.rootClassList.every((value: unknown) => typeof value === 'string')
              )
              : []
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
      return await requestPreviewJson<BrowserPreviewLoadResponse>('/api/live-preview/browser/command', {
        method: 'POST',
        body: JSON.stringify({
          browser_tab_id: browserTabId,
          action,
          ...(payload || {}),
        }),
      })
    } catch (error) {
      console.error(`[live-editor] Browser preview command failed (${action})`, error)
      return null
    }
  }, [])

  const syncTabSelections = useCallback(async (tabId: string) => {
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
      await sendBrowserCommand(tab.browserTabId, 'apply', { selections })
    }
  }, [getPreviewTabById, sendBrowserCommand])

  useEffect(() => {
    void Promise.all(
      previewTabsRef.current.map((tab) => syncTabSelections(tab.id))
    )
  }, [selectedElements, syncTabSelections])

  const syncAllPreviewSelectionModes = useCallback(async () => {
    await Promise.all(
      previewTabsRef.current.map(async (tab) => {
        const enabled = selectMode && tab.id === activeTabIdRef.current

        if (tab.mode === 'proxy') {
          const iframe = iframeRefs.current[tab.id]
          if (!iframe?.contentWindow) {
            return
          }

          iframe.contentWindow.postMessage(
            {
              type: 'pixel-forge-toggle-select',
              enabled,
            },
            '*'
          )
          return
        }

        if (tab.mode === 'browser' && tab.browserTabId) {
          await sendBrowserCommand(tab.browserTabId, 'set_select_mode', { enabled })
        }
      })
    )
  }, [selectMode, sendBrowserCommand])

  const updateEmbeddedPreviewBounds = useCallback(async () => {
    const desktopPreview = desktopPreviewRef.current
    if (!desktopPreview) {
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

    await desktopPreview.activate(activePreviewTab.browserTabId)
    await desktopPreview.setBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
  }, [getActivePreviewTab])

  const loadApp = useCallback(async (
    urlOverride?: string,
    options?: {
      persist?: boolean
      tabId?: string
      announceSuccess?: boolean
    }
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
      const resolvedTargetUrl = data.target_url

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
            frameSrc: 'about:blank',
            snapshotDataUrl: data.snapshot_data_url,
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
        void syncTabSelections(resolvedTabId)
        void syncAllPreviewSelectionModes()
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
  }, [pushUrlHistory, sendBrowserCommand, syncAllPreviewSelectionModes, syncStorePreviewUrl, syncTabSelections, updateEmbeddedPreviewBounds])

  // Keep loadAppRef in sync for back/forward navigation
  loadAppRef.current = loadApp

  const openUrlHistory = useCallback(async () => {
    if (currentProjectUrls.length === 0) {
      return
    }

    const desktopOverlay = desktopOverlayRef.current
    const anchor = urlHistoryAnchorRef.current
    if (desktopOverlay && anchor) {
      const rect = anchor.getBoundingClientRect()
      const selectedUrl = await desktopOverlay.pickList({
        anchorRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
        items: currentProjectUrls.map((url) => ({
          value: url,
          label: url,
        })),
        selectedValue: targetUrl,
        width: Math.max(Math.round(rect.width), 420),
        maxHeight: 280,
      })
      if (selectedUrl) {
        setTargetUrl(selectedUrl)
        await loadApp(selectedUrl)
      }
      return
    }

    setShowUrlHistory((current) => !current)
  }, [currentProjectUrls, loadApp, targetUrl])

  const applyControllerUpdate = useCallback(async () => {
    const desktopApp = desktopAppRef.current
    if (!desktopApp) {
      toast.error('Applying controller updates requires the Pixel Forge desktop shell.')
      return
    }

    const toastId = toast.loading('Loading updated Pixel Forge build...')
    try {
      if (desktopApp.startPendingControllerUpdate) {
        desktopApp.startPendingControllerUpdate({
          projectPath: projectPath ?? '',
          previewUrl,
          activeMode,
        })
      } else if (desktopApp.applyPendingControllerUpdate) {
        await desktopApp.applyPendingControllerUpdate({
          projectPath: projectPath ?? '',
          previewUrl,
          activeMode,
        })
      } else {
        if (!projectPath) {
          throw new Error('No project is selected.')
        }
        await desktopApp.applyControllerUpdate({
          projectPath,
          previewUrl,
          activeMode,
        })
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
  }, [activeMode, previewUrl, projectPath])

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
        await desktopPreview.activate(tab.browserTabId)
        window.setTimeout(() => {
          void updateEmbeddedPreviewBounds()
        }, 60)
      } else {
        await sendBrowserCommand(tab.browserTabId, 'focus')
      }
    }
  }, [sendBrowserCommand, syncStorePreviewUrl, updateEmbeddedPreviewBounds])

  const openUrlInPreviewTab = useCallback(async (
    url: string,
    options?: {
      title?: string | null
      announceSuccess?: boolean
    }
  ) => {
    const normalizedUrl = url.trim()
    if (!normalizedUrl) {
      return null
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
  }, [activatePreviewTab, getActivePreviewTab, loadApp])

  const openLocalTargetInPreviewTab = useCallback(async (
    record: LocalPixelForgeTargetResponse,
    options?: {
      announceSuccess?: boolean
    }
  ) => {
    const tabId = await openUrlInPreviewTab(record.web_url, {
      title:
        record.runtime_kind === 'mirror'
          ? `Pixel Forge · ${record.build_label}`
          : 'Pixel Forge Target',
      announceSuccess: options?.announceSuccess,
    })
    if (tabId) {
      attachLocalTargetToTab(tabId, record)
      void refreshMirrorBuilds()
    }
    return tabId
  }, [attachLocalTargetToTab, openUrlInPreviewTab, refreshMirrorBuilds])

  const startPixelForgeMirror = useCallback(async (
    options?: {
      sourceRoot?: string | null
      forceRestart?: boolean
      announceSuccess?: boolean
    }
  ) => {
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
    })
    return record
  }, [openLocalTargetInPreviewTab, projectPath])

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

  const ensureIsolatedMirrorSourceRoot = useCallback(async () => {
    if (!projectPath) {
      throw new Error('Select a project before launching a Pixel Forge target')
    }

    const resolvedSourceRoot = resolveIsolatedMirrorSourceRoot({
      projectPath,
      liveWorkspacePath: resolvedMirrorTarget?.workspacePath || null,
      selectedTargetPath: selectedAgentDeckTarget?.path || null,
    })
    if (resolvedSourceRoot) {
      return resolvedSourceRoot
    }

    const created = await createAgentDeckTargetSession()
    const createdPath = created.path?.trim() || null
    if (!isCloneWorkspaceBound({ projectPath, workspacePath: createdPath })) {
      throw new Error('Failed to create an isolated Pixel Forge preview session.')
    }
    toast.success(`Created isolated session · ${created.title || created.id}`)
    return createdPath
  }, [
    agentDeckTargets,
    createAgentDeckTargetSession,
    projectPath,
    resolvedMirrorTarget?.workspacePath,
    selectedAgentDeckTarget?.path,
  ])

  const loadUpdatedPixelForgePreview = useCallback(async () => {
    if (!previewAudienceWorkspacePath) {
      toast.error('No isolated Pixel Forge preview session is selected.')
      return
    }

    const update =
      pendingPreviewUpdate
      || await fetchLatestPendingPreviewUpdate(previewAudienceWorkspacePath, previewAudienceSessionId)

    if (!update?.snapshotPath) {
      toast.error('No updated clone preview is ready to load.')
      return
    }

    const toastId = toast.loading('Loading updated Pixel Forge preview...')
    try {
      await startPixelForgeMirror({
        sourceRoot: update.snapshotPath,
        forceRestart: false,
        announceSuccess: false,
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
      toast.success('Loaded updated Pixel Forge preview in a new tab', { id: toastId })
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
    pendingPreviewUpdate,
    previewAudienceSessionId,
    previewAudienceWorkspacePath,
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
  }, [syncStorePreviewUrl])

  const launchPixelForgeTarget = useCallback(async () => {
    if (!projectPath) {
      toast.error('Select a project before launching a Pixel Forge target')
      return
    }

    setIsLaunchingPixelForgeTarget(true)
    try {
      const preferredSourceRoot = await ensureIsolatedMirrorSourceRoot()
      const record = await startPixelForgeMirror({
        sourceRoot: preferredSourceRoot,
        forceRestart: true,
        announceSuccess: false,
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
  }, [ensureIsolatedMirrorSourceRoot, projectPath, startPixelForgeMirror])

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
        await desktopPreview.activate(nextTab.browserTabId)
        window.setTimeout(() => {
          void updateEmbeddedPreviewBounds()
        }, 60)
      } else {
        await sendBrowserCommand(nextTab.browserTabId, 'focus')
      }
    }
  }, [sendBrowserCommand, syncStorePreviewUrl, updateEmbeddedPreviewBounds])

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
  }, [getActivePreviewTab, hasEmbeddedBrowserPreview, sendBrowserCommand, updateEmbeddedPreviewBounds])

  useEffect(() => {
    if (lastProjectPathRef.current === projectPath) {
      return
    }

    lastProjectPathRef.current = projectPath
    iframeRefs.current = {}

    const initialTab = createPreviewTab(previewUrl || '', null, 1)
    previewTabsRef.current = [initialTab]
    activeTabIdRef.current = initialTab.id
    setPreviewTabs([initialTab])
    setActivePreviewTabId(initialTab.id)
    setShowUrlHistory(false)
    setAuthIssue(null)
    setTargetUrl(initialTab.url)

    if (initialTab.url) {
      void loadApp(initialTab.url, {
        tabId: initialTab.id,
        persist: false,
        announceSuccess: false,
      })
    }
  }, [projectPath, previewUrl, loadApp])

  useEffect(() => {
    const normalizedPreviewUrl = previewUrl?.trim() || null
    if (internalPreviewUrlRef.current === normalizedPreviewUrl) {
      internalPreviewUrlRef.current = null
      return
    }

    const activePreviewTab = getActivePreviewTab()
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
    void loadApp(normalizedPreviewUrl, {
      tabId: activePreviewTab.id,
      persist: false,
      announceSuccess: false,
    })
  }, [previewUrl, getActivePreviewTab, loadApp])

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
    void syncAllPreviewSelectionModes()
  }, [activePreviewTabId, selectMode, syncAllPreviewSelectionModes])

  const toggleSelectMode = useCallback(() => {
    const newMode = !selectMode
    setSelectMode(newMode)

    if (newMode) {
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
  }, [getActivePreviewTab, hasEmbeddedBrowserPreview, selectMode])

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
          enabled: selectMode && tabId === activeTabIdRef.current,
        },
        '*'
      )
      void syncTabSelections(tabId)
    }, 120)
  }, [getPreviewTabById, selectMode, syncTabSelections])

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
        setSelectMode(false)
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
  }, [addElement, getActivePreviewTab, getTabForMessageSource, removeElement, replaceElement, syncStorePreviewUrl])

  const handleBrowserPreviewEvent = useCallback((payload: BrowserPreviewEvent) => {
    const sourceTab = getPreviewTabByBrowserId(payload.browser_tab_id)
    const activePreviewTab = getActivePreviewTab()

    if (!sourceTab) {
      return
    }

    if (payload.type === 'browser-location-changed') {
      const nextUrl = typeof payload.url === 'string' ? payload.url : sourceTab.url
      const nextTitle = typeof payload.title === 'string' ? payload.title : sourceTab.title

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
        pushUrlHistory(nextUrl)
        void syncStorePreviewUrl(nextUrl)
      }

      window.setTimeout(() => {
        void syncTabSelections(sourceTab.id)
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
      setSelectMode(false)
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
  }, [addElement, getActivePreviewTab, getPreviewTabByBrowserId, hasEmbeddedBrowserPreview, pushUrlHistory, removeElement, removeElements, replaceElement, syncStorePreviewUrl, syncTabSelections])

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

  const focusManagedBrowser = useCallback(async () => {
    const activePreviewTab = getActivePreviewTab()
    if (!activePreviewTab?.browserTabId) {
      return
    }
    await sendBrowserCommand(activePreviewTab.browserTabId, 'focus')
  }, [getActivePreviewTab, sendBrowserCommand])

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
  const hasPendingPreviewUpdate = Boolean(
    pendingPreviewUpdate?.snapshotPath
    && activeMirrorTarget?.sourceRoot !== pendingPreviewUpdate.snapshotPath
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
                  disabled={currentProjectUrls.length === 0}
                  title="Recent preview URLs"
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${showUrlHistory ? 'rotate-180' : ''}`} />
                </Button>
              </div>
              {showUrlHistory && currentProjectUrls.length > 0 && (
                <div className="mt-1 rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md">
                  <div className="max-h-48 overflow-y-auto py-1">
                    {currentProjectUrls.map((url) => (
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
                onClick={() => void launchPixelForgeTarget()}
                disabled={!hasEmbeddedBrowserPreview || isLaunchingPixelForgeTarget}
                className="h-7 gap-1 border-border/60 px-2.5 text-xs"
                title="Launch or rebuild the isolated Pixel Forge mirror for this session"
              >
                <RefreshCw className={`h-3 w-3 ${isLaunchingPixelForgeTarget ? 'animate-spin' : ''}`} />
                {isLaunchingPixelForgeTarget ? 'Launching...' : 'Run Pixel Forge'}
              </Button>
            )}
            {hasPendingPreviewUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadUpdatedPixelForgePreview()}
                disabled={!hasEmbeddedBrowserPreview}
                className="h-7 gap-1 border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs text-emerald-100 hover:bg-emerald-500/20"
                title="Open the updated clone preview in a new tab"
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
            {activePreviewTab?.mode === 'browser' && activePreviewTab.browserTabId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void focusManagedBrowser()}
                className="h-7 gap-1 border-border/60 px-2.5 text-xs"
                title={hasEmbeddedBrowserPreview ? 'Focus the embedded preview' : 'Focus the managed browser window'}
              >
                <Globe2 className="h-3 w-3" />
                {hasEmbeddedBrowserPreview ? 'Focus Preview' : 'Focus Browser'}
              </Button>
            )}
            <Button
              variant={selectMode ? 'default' : 'outline'}
              size="sm"
              onClick={toggleSelectMode}
              disabled={!hasEmbeddedBrowserPreview}
              className={`h-7 gap-1 px-2.5 text-xs transition-all ${
                selectMode
                  ? 'bg-primary text-primary-foreground shadow-[0_0_12px_-3px_hsl(var(--primary)/0.4)]'
                  : 'border-border/60'
              }`}
            >
              <MousePointer2 className="h-3 w-3" />
              {selectMode ? 'Selecting' : 'Select'}
            </Button>

            <div className="ml-auto flex items-center gap-1.5">
              {hasEmbeddedBrowserPreview && (
                <div className="rounded-full border border-border/50 bg-background/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Embedded Chromium
                </div>
              )}
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

              <div
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  connected ? 'bg-primary shadow-[0_0_6px_1px_hsl(var(--primary)/0.3)]' : 'bg-destructive'
                }`}
                title={connected ? 'Connected' : 'Disconnected'}
              />
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
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col overflow-hidden">
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
              className="m-0 flex min-h-0 flex-1 min-w-0 flex-col overflow-hidden"
            >
              <ChatMessages
                onRefreshPreview={() => void refreshApp()}
                onLoadPreviewUpdate={() => void loadUpdatedPixelForgePreview()}
                onApplyControllerUpdate={() => void applyControllerUpdate()}
              />
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
    </div>
  )
}

export default LiveEditorPane
