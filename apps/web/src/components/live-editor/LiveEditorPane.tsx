/**
 * LiveEditorPane Component
 *
 * The preview/browser layer is tab-based, while chat and selected element
 * context stay unified at the project level.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '@/store/session-store'
import { HTTP_BACKEND_URL } from '@/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertTriangle,
  ArrowLeftRight,
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
import { SelectedElementsList } from './SelectedElementsList'
import { useLiveEditorStore } from './store/chat-store'

type ViewportMode = 'fluid' | 'desktop' | 'phone'

interface PreviewTab {
  id: string
  url: string
  title: string
  proxySessionId: string | null
  frameSrc: string
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

function buildProxyFrameUrl(proxySessionId: string): string {
  return `${HTTP_BACKEND_URL}/app/s/${encodeURIComponent(proxySessionId)}/?_pf_t=${Date.now()}`
}

function createPreviewTab(url = '', title?: string | null, index?: number): PreviewTab {
  return {
    id: createPreviewTabId(),
    url,
    title: getPreviewTabTitle(url, title, index),
    proxySessionId: null,
    frameSrc: 'about:blank',
  }
}

export function LiveEditorPane() {
  const {
    projectPath,
    previewUrl,
    setPreviewUrl,
  } = useSessionStore()

  const targetUrlRef = useRef(previewUrl || '')
  const previewTabsRef = useRef<PreviewTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const lastProjectPathRef = useRef<string | null | undefined>(undefined)
  const internalPreviewUrlRef = useRef<string | null>(null)
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({})
  const authToastIdsRef = useRef<Record<string, string>>({})

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

  const currentProjectUrls = useSessionStore((state) => {
    if (!state.projectPath) return []
    const project = state.recentProjects.find((entry) => entry.path === state.projectPath)
    return project?.previewUrls ?? []
  })

  const {
    connect,
    disconnect,
    connected,
    addElement,
    removeElement,
    clearElements,
    selectedElements,
  } = useLiveEditorStore()

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

  const getActivePreviewTab = useCallback(() => {
    if (!activeTabIdRef.current) return null
    return previewTabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ?? null
  }, [])

  const getPreviewTabById = useCallback((tabId: string) => {
    return previewTabsRef.current.find((tab) => tab.id === tabId) ?? null
  }, [])

  const setIframeRef = useCallback((tabId: string, iframe: HTMLIFrameElement | null) => {
    iframeRefs.current[tabId] = iframe
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

  const syncTabSelections = useCallback((tabId: string) => {
    const tab = getPreviewTabById(tabId)
    const iframe = iframeRefs.current[tabId]
    if (!tab || !iframe?.contentWindow) {
      return
    }

    const xpaths = useLiveEditorStore
      .getState()
      .selectedElements
      .filter(
        (element) =>
          element.sourceTabId === tab.id
          && element.sourceUrl === tab.url
      )
      .map((element) => element.xpath)

    iframe.contentWindow.postMessage(
      {
        type: 'pixel-forge-apply-selections',
        xpaths,
      },
      '*'
    )
  }, [getPreviewTabById])

  const syncAllFrameSelectionModes = useCallback(() => {
    for (const tab of previewTabsRef.current) {
      const iframe = iframeRefs.current[tab.id]
      if (!iframe?.contentWindow) {
        continue
      }

      iframe.contentWindow.postMessage(
        {
          type: 'pixel-forge-toggle-select',
          enabled: selectMode && tab.id === activeTabIdRef.current,
        },
        '*'
      )
    }
  }, [selectMode])

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
                frameSrc: 'about:blank',
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
      const response = await fetch(`${HTTP_BACKEND_URL}/config/app-proxy`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_url: urlToLoad,
          session_id: tab?.proxySessionId || undefined,
        }),
      })
      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          const errorData = await response.json()
          detail = errorData.detail || detail
        } catch {
          const errorText = await response.text()
          detail = errorText || detail
        }
        throw new Error(detail)
      }

      const data = await response.json()
      const resolvedTargetUrl =
        typeof data?.target_url === 'string' ? data.target_url : urlToLoad
      const proxySessionId =
        typeof data?.proxy_session_id === 'string'
          ? data.proxy_session_id
          : tab?.proxySessionId || null

      if (!proxySessionId) {
        throw new Error('Proxy session was not created')
      }

      setAuthIssue(null)
      setTargetUrl(resolvedTargetUrl)
      setPreviewTabs((currentTabs) =>
        currentTabs.map((entry, index) =>
          entry.id === resolvedTabId
            ? {
                ...entry,
                url: resolvedTargetUrl,
                proxySessionId,
                frameSrc: buildProxyFrameUrl(proxySessionId),
                title: getPreviewTabTitle(
                  resolvedTargetUrl,
                  null,
                  index + 1
                ),
              }
            : entry
        )
      )

      if (options?.persist !== false) {
        await syncStorePreviewUrl(resolvedTargetUrl)
      }

      if (options?.announceSuccess !== false) {
        toast.success('App loaded')
      }
    } catch (error) {
      console.error('Failed to configure app proxy:', error)
      toast.error(
        error instanceof Error ? `Failed to load app: ${error.message}` : 'Failed to load app'
      )
    }
  }, [syncStorePreviewUrl])

  const activatePreviewTab = useCallback(async (tabId: string) => {
    const tab = previewTabsRef.current.find((entry) => entry.id === tabId)
    if (!tab) return

    setActivePreviewTabId(tabId)
    setTargetUrl(tab.url)
    setAuthIssue(null)
    setShowUrlHistory(false)

    await syncStorePreviewUrl(tab.url || null)
  }, [syncStorePreviewUrl])

  const addPreviewTab = useCallback(() => {
    const nextTab = createPreviewTab('', null, previewTabsRef.current.length + 1)
    setPreviewTabs((currentTabs) => [...currentTabs, nextTab])
    setActivePreviewTabId(nextTab.id)
    setTargetUrl('')
    setAuthIssue(null)
    setShowUrlHistory(false)
    void syncStorePreviewUrl(null)
  }, [syncStorePreviewUrl])

  const closePreviewTab = useCallback(async (tabId: string) => {
    const closingIndex = previewTabsRef.current.findIndex((entry) => entry.id === tabId)
    if (closingIndex < 0) return

    const closingTab = previewTabsRef.current[closingIndex]
    if (closingTab.proxySessionId) {
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
  }, [syncStorePreviewUrl])

  const refreshApp = useCallback(() => {
    const activePreviewTab = getActivePreviewTab()
    if (!activePreviewTab) {
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
  }, [getActivePreviewTab])

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
                  frameSrc: 'about:blank',
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
    syncAllFrameSelectionModes()
  }, [activePreviewTabId, previewTabs, selectMode, syncAllFrameSelectionModes])

  const toggleSelectMode = useCallback(() => {
    const newMode = !selectMode
    setSelectMode(newMode)

    if (newMode) {
      toast.success('Select mode ON - click elements to select', {
        duration: 2000,
      })
    }
  }, [selectMode])

  const handleIframeLoad = useCallback((tabId: string) => {
    setTimeout(() => {
      const iframe = iframeRefs.current[tabId]
      if (!iframe?.contentWindow) {
        return
      }

      iframe.contentWindow.postMessage(
        {
          type: 'pixel-forge-toggle-select',
          enabled: selectMode && tabId === activeTabIdRef.current,
        },
        '*'
      )
      syncTabSelections(tabId)
    }, 120)
  }, [selectMode, syncTabSelections])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const sourceTab = getTabForMessageSource(event.source)
      const activePreviewTab = getActivePreviewTab()

      if (event.data.type === 'pixel-forge-element-selected') {
        if (!sourceTab) {
          return
        }

        const sourceUrl =
          typeof event.data.data?.pageUrl === 'string'
            ? event.data.data.pageUrl
            : sourceTab.url

        addElement({
          tagName: event.data.data.tagName,
          elementId: event.data.data.elementId || event.data.data.id,
          classList: event.data.data.classList || [],
          textContent: event.data.data.textContent || '',
          xpath: event.data.data.xpath,
          outerHTML: event.data.data.outerHTML,
          sourceTabId: sourceTab.id,
          sourceTabLabel: sourceTab.title || 'Preview',
          sourceUrl,
          pageTitle:
            typeof event.data.data?.pageTitle === 'string'
              ? event.data.data.pageTitle
              : sourceTab.title || null,
        })
      } else if (event.data.type === 'pixel-forge-element-deselected') {
        if (!sourceTab) {
          return
        }

        const sourceUrl =
          typeof event.data.data?.pageUrl === 'string'
            ? event.data.data.pageUrl
            : sourceTab.url
        const element = selectedElements.find(
          (entry) =>
            entry.xpath === event.data.data.xpath
            && entry.sourceTabId === sourceTab.id
            && entry.sourceUrl === sourceUrl
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

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [addElement, getActivePreviewTab, getTabForMessageSource, removeElement, selectedElements, syncStorePreviewUrl])

  const handleClearElements = useCallback(() => {
    clearElements()
    for (const iframe of Object.values(iframeRefs.current)) {
      iframe?.contentWindow?.postMessage(
        { type: 'pixel-forge-clear-selections' },
        '*'
      )
    }
  }, [clearElements])

  const handleRemoveElement = useCallback((
    id: string,
    xpath: string,
    sourceTabId: string,
    _sourceUrl: string
  ) => {
    removeElement(id)

    iframeRefs.current[sourceTabId]?.contentWindow?.postMessage(
      { type: 'pixel-forge-deselect', xpath },
      '*'
    )
  }, [removeElement])

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

          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 px-3 py-1.5">
            <div className="relative flex min-w-[16rem] flex-1 gap-0">
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
                onClick={() => setShowUrlHistory(!showUrlHistory)}
                disabled={currentProjectUrls.length === 0}
                title="Recent preview URLs"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showUrlHistory ? 'rotate-180' : ''}`} />
              </Button>
              {showUrlHistory && currentProjectUrls.length > 0 && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUrlHistory(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md">
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
                </>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadApp()}
              className="h-7 gap-1 border-border/60 px-2.5 text-xs"
            >
              <Play className="h-3 w-3" />
              Load
            </Button>
            <div className="mx-0.5 h-4 w-px bg-border/40" />
            <Button
              variant="outline"
              size="sm"
              onClick={refreshApp}
              title="Refresh preview"
              className="h-7 w-7 border-border/60 p-0"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
            <Button
              variant={selectMode ? 'default' : 'outline'}
              size="sm"
              onClick={toggleSelectMode}
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
              {previewTabs.map((tab) => (
                <iframe
                  key={tab.id}
                  ref={(iframe) => setIframeRef(tab.id, iframe)}
                  src={tab.frameSrc}
                  className={`absolute inset-0 h-full w-full border-0 bg-white ${
                    tab.id === activePreviewTabId ? 'block' : 'hidden'
                  }`}
                  onLoad={() => handleIframeLoad(tab.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex w-[clamp(320px,26vw,420px)] min-w-[300px] max-w-[42vw] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-card/50">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full overflow-hidden">
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

          <div className="mt-2 flex-1 min-h-0 overflow-hidden">
            <TabsContent
              value="chat"
              className="m-0 h-full min-w-0 overflow-hidden"
            >
              <ChatMessages onRefreshPreview={refreshApp} />
            </TabsContent>

            <TabsContent
              value="elements"
              className="m-0 h-full overflow-y-auto p-3"
            >
              <SelectedElementsList
                onClearAll={handleClearElements}
                onRemoveElement={handleRemoveElement}
              />
            </TabsContent>
          </div>
        </Tabs>

        {activeTab === 'chat' && <ChatInput />}
      </div>
    </div>
  )
}

export default LiveEditorPane
