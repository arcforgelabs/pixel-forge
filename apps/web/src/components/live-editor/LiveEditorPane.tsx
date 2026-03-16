/**
 * LiveEditorPane Component
 *
 * Main container for the Live Editor feature.
 * Embeds a web app via proxy iframe and provides chat-based editing
 * with Claude, persistent element selection, and tool visualization.
 *
 * Features:
 * - App proxy with script injection for element selection
 * - Multi-element selection with persistent visual highlighting
 * - Full chat interface with streaming responses
 * - Tool execution visualization
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
  Clock,
  FolderOpen,
  Monitor,
  MousePointer2,
  RefreshCw,
  Play,
  MessageSquare,
  Layers,
  Settings,
  Smartphone,
} from 'lucide-react'
import toast from 'react-hot-toast'

// New chat components
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { SelectedElementsList } from './SelectedElementsList'
import { ProjectSelector } from '../project-selector/ProjectSelector'
import { useLiveEditorStore } from './store/chat-store'

type ViewportMode = 'fluid' | 'desktop' | 'phone'

export function LiveEditorPane() {
  const {
    projectPath,
    previewUrl,
    lastSavedFile,
    liveEditorSession,
    clearLiveEditorSession,
    setPreviewUrl,
    recentProjects,
    setProject,
  } = useSessionStore()

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const targetUrlRef = useRef(previewUrl || '')
  const lastLoadedUrlRef = useRef<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [targetUrl, setTargetUrl] = useState(previewUrl || '')
  const [iframeSrc, setIframeSrc] = useState(previewUrl ? `${HTTP_BACKEND_URL}/app/` : 'about:blank')
  const [activeTab, setActiveTab] = useState('chat')
  const [viewportMode, setViewportMode] = useState<ViewportMode>('fluid')
  const [authIssue, setAuthIssue] = useState<{ status: number; url: string } | null>(null)
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false)
  const [showUrlHistory, setShowUrlHistory] = useState(false)

  // Get URL history for current project
  const currentProjectUrls = useSessionStore((s) => {
    if (!s.projectPath) return []
    const project = s.recentProjects.find((p) => p.path === s.projectPath)
    return project?.previewUrls ?? []
  })

  // Get store actions and state
  // Note: sessionId and projectPath are now read from session-store directly
  // by chat-store, so no sync needed here
  const {
    connect,
    disconnect,
    connected,
    addElement,
    removeElement,
    clearElements,
    selectedElements,
    newSession,
  } = useLiveEditorStore()

  // Initialize connection on mount
  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  // KNOWN ISSUE: Chat textarea unresponsive after hard refresh
  // Manual workaround: Switch to Elements/Settings tab, then back to Chat
  // Root cause: Unknown conflict with iframe's chat interface on initial load
  // This auto-switch attempt doesn't work reliably - keeping for documentation
  // TODO: Investigate iframe focus/pointer-events interaction
  useEffect(() => {
    const timer1 = setTimeout(() => setActiveTab('elements'), 500)
    const timer2 = setTimeout(() => setActiveTab('chat'), 600)
    return () => {
      clearTimeout(timer1)
      clearTimeout(timer2)
    }
  }, [])

  // Note: Project path sync removed - chat-store now reads from session-store directly

  useEffect(() => {
    targetUrlRef.current = targetUrl
  }, [targetUrl])

  const buildProxyFrameUrl = useCallback(
    () => `${HTTP_BACKEND_URL}/app/?t=${Date.now()}`,
    []
  )

  // Load the preview target into the proxy
  const loadApp = useCallback(async (
    urlOverride?: string,
    options?: { persist?: boolean }
  ) => {
    const urlToLoad = (urlOverride || targetUrlRef.current).trim()
    if (!urlToLoad) return

    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/config/app-proxy`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_url: urlToLoad }),
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
      const resolvedTargetUrl = typeof data?.target_url === 'string' ? data.target_url : urlToLoad

      // Clear selections when loading new app
      clearElements()
      setAuthIssue(null)
      lastLoadedUrlRef.current = resolvedTargetUrl
      setTargetUrl(resolvedTargetUrl)

      if (
        options?.persist !== false &&
        useSessionStore.getState().previewUrl !== resolvedTargetUrl
      ) {
        setPreviewUrl(resolvedTargetUrl)
      }

      // Reload iframe
      setIframeSrc(buildProxyFrameUrl())

      toast.success('App loaded')
    } catch (error) {
      console.error('Failed to configure app proxy:', error)
      toast.error(
        error instanceof Error ? `Failed to load app: ${error.message}` : 'Failed to load app'
      )
    }
  }, [buildProxyFrameUrl, clearElements, setPreviewUrl])

  // Refresh the iframe with cache busting (harder reload)
  const refreshApp = useCallback(() => {
    if (iframeRef.current && iframeSrc !== 'about:blank') {
      // Force hard reload by resetting src with cache-busting param
      const currentSrc = iframeRef.current.src.split('?')[0]
      iframeRef.current.src = `${currentSrc}?t=${Date.now()}`
      toast.success('Refreshed', { duration: 1000 })
    }
  }, [iframeSrc])

  // Sync local input when the persisted preview target changes externally.
  useEffect(() => {
    setTargetUrl(previewUrl || '')

    if (previewUrl) {
      if (previewUrl !== lastLoadedUrlRef.current) {
        void loadApp(previewUrl, { persist: false })
      }
      return
    }

    lastLoadedUrlRef.current = null
    setIframeSrc('about:blank')
  }, [previewUrl, loadApp])

  // Toggle select mode
  const toggleSelectMode = useCallback(() => {
    const newMode = !selectMode
    setSelectMode(newMode)

    // Send message to iframe
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        {
          type: 'pixel-forge-toggle-select',
          enabled: newMode,
        },
        '*'
      )
    }

    if (newMode) {
      toast.success('Select mode ON - click elements to select', {
        duration: 2000,
      })
    }
  }, [selectMode])

  // Re-sync selectMode to iframe after it loads (handles navigation, HMR, etc.)
  const handleIframeLoad = useCallback(() => {
    // Give the injected script time to initialize
    setTimeout(() => {
      if (iframeRef.current?.contentWindow && selectMode) {
        iframeRef.current.contentWindow.postMessage(
          {
            type: 'pixel-forge-toggle-select',
            enabled: true,
          },
          '*'
        )
      }
    }, 100)
  }, [selectMode])

  // Listen for messages from iframe
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data.type === 'pixel-forge-element-selected') {
        // Add to store (store handles deduplication)
        addElement({
          tagName: e.data.data.tagName,
          elementId: e.data.data.elementId || e.data.data.id,
          classList: e.data.data.classList || [],
          textContent: e.data.data.textContent || '',
          xpath: e.data.data.xpath,
          outerHTML: e.data.data.outerHTML,
        })
      } else if (e.data.type === 'pixel-forge-element-deselected') {
        // Find and remove from store by xpath
        const element = selectedElements.find(
          (el) => el.xpath === e.data.data.xpath
        )
        if (element) {
          removeElement(element.id)
        }
      } else if (e.data.type === 'pixel-forge-cancel-select') {
        setSelectMode(false)
      } else if (e.data.type === 'pixel-forge-auth-required') {
        const status = Number(e.data.data?.status || 0)
        const failingUrl = String(e.data.data?.url || '')
        setAuthIssue({ status, url: failingUrl })
        toast.error(
          status === 401 || status === 403
            ? `Target authentication required (${status}).`
            : 'Target authentication required.'
        )
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [addElement, removeElement, selectedElements])

  // Change workspace — confirm if active session exists
  const handleChangeWorkspace = useCallback(() => {
    const hasActiveSession = !!useSessionStore.getState().liveEditorSession
    const hasMessages = useLiveEditorStore.getState().messages.length > 0

    if (hasActiveSession || hasMessages) {
      const confirmed = window.confirm(
        'Changing workspace will start a new session. The current session will be closed. Continue?'
      )
      if (!confirmed) return

      clearLiveEditorSession()
      newSession()
    }

    setShowWorkspaceSelector(true)
  }, [clearLiveEditorSession, newSession])

  // Quick-switch to a recent project
  const handleQuickSwitch = useCallback((path: string, recentPreviewUrl?: string) => {
    if (path === projectPath) return

    const hasActiveSession = !!useSessionStore.getState().liveEditorSession
    const hasMessages = useLiveEditorStore.getState().messages.length > 0

    if (hasActiveSession || hasMessages) {
      const confirmed = window.confirm(
        'Switching workspace will start a new session. Continue?'
      )
      if (!confirmed) return

      clearLiveEditorSession()
      newSession()
    }

    setProject({ path, previewUrl: recentPreviewUrl })
    if (recentPreviewUrl) {
      void loadApp(recentPreviewUrl)
    }
    toast.success(`Switched to ${path.split('/').pop()}`)
  }, [projectPath, clearLiveEditorSession, newSession, setProject, loadApp])

  // Handle clearing selections from parent (sync to iframe)
  const handleClearElements = useCallback(() => {
    clearElements()
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'pixel-forge-clear-selections' },
        '*'
      )
    }
  }, [clearElements])

  // Handle removing a single element (sync to iframe)
  const handleRemoveElement = useCallback((id: string, xpath: string) => {
    removeElement(id)
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'pixel-forge-deselect', xpath },
        '*'
      )
    }
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
      {/* Left: App Viewer */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card/60 backdrop-blur-sm px-3 py-1.5">
          <div className="relative flex min-w-[16rem] flex-1 gap-0">
            <Input
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadApp()}
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
          <Button variant="outline" size="sm" onClick={() => loadApp()} className="h-7 gap-1 border-border/60 px-2.5 text-xs">
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

            {/* Connection status */}
            <div
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                connected ? 'bg-primary shadow-[0_0_6px_1px_hsl(var(--primary)/0.3)]' : 'bg-destructive'
              }`}
              title={connected ? 'Connected' : 'Disconnected'}
            />
          </div>
        </div>

        {/* Iframe */}
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
            <div className={viewportFrameClassName}>
              <iframe
                ref={iframeRef}
                src={iframeSrc}
                className="h-full w-full border-0 bg-white"
                onLoad={handleIframeLoad}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Right: Chat & Selection Panel */}
      <div className="flex w-[clamp(320px,26vw,420px)] min-w-[300px] max-w-[42vw] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-card/50">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full overflow-hidden">
          <TabsList className="mx-2 mt-2 grid w-auto grid-cols-3 flex-shrink-0 bg-background/50">
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
            <TabsTrigger value="settings" className="gap-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" />
              Settings
            </TabsTrigger>
          </TabsList>

          {/* Tab Content Container */}
          <div className="flex-1 min-h-0 overflow-hidden mt-2">
            {/* Chat Tab - only ChatMessages, ChatInput rendered outside */}
            <TabsContent
              value="chat"
              className="m-0 h-full min-w-0 overflow-hidden"
            >
              <ChatMessages onRefreshPreview={refreshApp} />
            </TabsContent>

            {/* Elements Tab */}
            <TabsContent
              value="elements"
              className="h-full overflow-y-auto m-0 p-3"
            >
              <SelectedElementsList
                onClearAll={handleClearElements}
                onRemoveElement={handleRemoveElement}
              />
            </TabsContent>

            {/* Settings Tab */}
            <TabsContent
              value="settings"
              className="h-full overflow-y-auto m-0 p-3"
            >
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Workspace</label>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={handleChangeWorkspace}
                    >
                      Change
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 font-mono break-all">
                    {projectPath || 'Not set'}
                  </p>

                  {/* Recent projects quick-switch */}
                  {recentProjects.length > 1 && (
                    <div className="mt-2 space-y-1">
                      <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Recent
                      </label>
                      {recentProjects
                        .filter((p) => p.path !== projectPath)
                        .slice(0, 5)
                        .map((project) => (
                          <button
                            key={project.path}
                            onClick={() => handleQuickSwitch(project.path, project.previewUrls[0])}
                            className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                          >
                            <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{project.name}</div>
                              {project.previewUrls[0] && (
                                <div className="truncate text-muted-foreground">
                                  {project.previewUrls[0]}
                                </div>
                              )}
                            </div>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-sm font-medium">Preview URL</label>
                  <p className="text-sm text-muted-foreground mt-1 font-mono">
                    {targetUrl || 'Not set'}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium">Connection</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {connected ? '✓ Connected' : '✗ Disconnected'}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium">Live Editor Backend</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {liveEditorSession?.backend || 'agent-deck'}
                  </p>
                </div>
                {liveEditorSession && (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                    <div>
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Pixel Forge Thread
                      </label>
                      <p className="mt-1 break-all font-mono text-xs text-foreground">
                        {liveEditorSession.threadId}
                      </p>
                    </div>
                    {liveEditorSession.agentDeckSessionTitle && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Agent Deck Session
                        </label>
                        <p className="mt-1 font-mono text-xs text-foreground">
                          {liveEditorSession.agentDeckSessionTitle}
                        </p>
                      </div>
                    )}
                    {liveEditorSession.agentDeckSessionId && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Agent Deck ID
                        </label>
                        <p className="mt-1 break-all font-mono text-xs text-foreground">
                          {liveEditorSession.agentDeckSessionId}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Last Saved File Info */}
                {lastSavedFile && (
                  <div className="pt-4 border-t">
                    <label className="text-sm font-medium">Last Generated Code</label>
                    <div className="mt-2 space-y-1">
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">File:</span>{' '}
                        <code className="bg-muted px-1 py-0.5 rounded text-xs">
                          {lastSavedFile.relPath}
                        </code>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">URL:</span>{' '}
                        <code className="bg-muted px-1 py-0.5 rounded text-xs">
                          {lastSavedFile.urlPath}
                        </code>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">Saved:</span>{' '}
                        {new Date(lastSavedFile.timestamp).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={async () => {
                        const savedTargetUrl = lastSavedFile.urlPath.startsWith('http')
                          ? lastSavedFile.urlPath
                          : `${HTTP_BACKEND_URL}${lastSavedFile.urlPath}`

                        setTargetUrl(savedTargetUrl)
                        await loadApp(savedTargetUrl)
                        toast.success('Loaded saved file preview')
                      }}
                    >
                      View Saved File
                    </Button>
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearElements}
                  disabled={selectedElements.length === 0}
                >
                  Clear All Selections
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    clearLiveEditorSession()
                    newSession()
                    toast.success('Started a fresh Live Editor thread')
                  }}
                >
                  New Live Thread
                </Button>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {/* ChatInput rendered OUTSIDE Tabs to avoid Radix initialization issues */}
        {activeTab === 'chat' && <ChatInput />}
      </div>

      {/* Workspace selector dialog */}
      <ProjectSelector
        open={showWorkspaceSelector}
        onOpenChange={setShowWorkspaceSelector}
      />
    </div>
  )
}

export default LiveEditorPane
