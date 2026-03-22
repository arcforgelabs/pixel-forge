export interface PixelForgeBrowserPreviewResponse {
  mode: 'browser'
  browser_tab_id: string
  target_url: string
  title: string
  snapshot_data_url: string | null
}

export interface PixelForgeDesktopLivePreviewInteractive {
  tag_name: string
  role: string | null
  text: string | null
  aria_label: string | null
  xpath: string
  bounding_box: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface PixelForgeDesktopLivePreviewSelectionMatch {
  selection_id: string | null
  found: boolean
  visible: boolean
  selector_kind?: string
  surface_kind?: string
  tag_name?: string
  xpath?: string
  text_excerpt?: string | null
  bounding_box?: {
    x: number
    y: number
    width: number
    height: number
  }
  first_state_attribute?: {
    name: string
    value: string | boolean
  } | null
  closest_container?: {
    tag_name: string
    xpath: string
    text_excerpt: string | null
    bounding_box: {
      x: number
      y: number
      width: number
      height: number
    }
    interactive_descendant_count: number
    interactive_descendants: PixelForgeDesktopLivePreviewInteractive[]
    first_state_attribute?: {
      name: string
      value: string | boolean
    } | null
  } | null
}

export interface PixelForgeDesktopLivePreviewInspection {
  live_inspection_available: boolean
  live_inspection_mode: 'controller-browserview'
  current_url: string
  current_title: string
  ready_state: string
  viewport: {
    width: number
    height: number
    scroll_x: number
    scroll_y: number
  }
  visible_interactives: PixelForgeDesktopLivePreviewInteractive[]
  selection_matches: PixelForgeDesktopLivePreviewSelectionMatch[]
  devtools_browser_url?: string | null
  devtools_target_id?: string | null
  devtools_target_type?: string | null
  devtools_target_url?: string | null
  devtools_target_title?: string | null
  devtools_page_websocket_url?: string | null
  devtools_frontend_url?: string | null
}

export interface PixelForgeBrowserPreviewInspectionResponse extends PixelForgeBrowserPreviewResponse {
  inspection: PixelForgeDesktopLivePreviewInspection | null
}

export interface PixelForgeDesktopLivePreviewSelectionHint {
  id: string
  globalIndex?: number
  selectorKind: 'dom' | 'region'
  surfaceKind: 'dom' | 'svg' | 'canvas' | 'webgl' | 'video' | 'image' | 'unknown'
  pageKey?: string
  tagName?: string
  elementId?: string | null
  classList?: string[]
  textContent?: string
  xpath?: string
  rootXPath?: string | null
  rootTagName?: string | null
  rootElementId?: string | null
  rootClassList?: string[]
  region?: {
    x: number
    y: number
    width: number
    height: number
    normalizedX: number
    normalizedY: number
    normalizedWidth: number
    normalizedHeight: number
    anchorX: number
    anchorY: number
  } | null
}

export type PixelForgeDesktopFocusedSurface = 'shell' | 'preview' | 'overlay'
export type PixelForgeDesktopPreviewTool = 'select' | null

export interface PixelForgeDesktopPreviewInputState {
  activePreviewTabId: string | null
  previewVisible: boolean
  focusedSurface: PixelForgeDesktopFocusedSurface
  armedTool: PixelForgeDesktopPreviewTool
}

export interface PixelForgeAppliedSelection {
  id: string
  selectorKind: 'dom' | 'region'
  surfaceKind: 'dom' | 'svg' | 'canvas' | 'webgl' | 'video' | 'image' | 'unknown'
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
  region: {
    x: number
    y: number
    width: number
    height: number
    normalizedX: number
    normalizedY: number
    normalizedWidth: number
    normalizedHeight: number
    anchorX: number
    anchorY: number
  } | null
}

export interface PixelForgeDesktopPreviewAPI {
  load(payload: { tabId: string; url: string }): Promise<PixelForgeBrowserPreviewResponse>
  show(tabId: string): Promise<{ ok: true }>
  activate(tabId: string): Promise<{ ok: true }>
  focus(tabId: string): Promise<{ ok: true }>
  refresh(tabId: string): Promise<PixelForgeBrowserPreviewResponse>
  inspect(
    tabId: string,
    payload?: { selectionHints?: PixelForgeDesktopLivePreviewSelectionHint[] }
  ): Promise<PixelForgeBrowserPreviewInspectionResponse>
  close(tabId: string): Promise<{ ok: true }>
  setTool(tabId: string, tool: PixelForgeDesktopPreviewTool): Promise<PixelForgeBrowserPreviewResponse>
  setSelectMode(tabId: string, enabled: boolean): Promise<PixelForgeBrowserPreviewResponse>
  clearSelections(tabId: string): Promise<PixelForgeBrowserPreviewResponse>
  deselect(tabId: string, selectionId: string): Promise<PixelForgeBrowserPreviewResponse>
  applySelections(tabId: string, selections: PixelForgeAppliedSelection[]): Promise<PixelForgeBrowserPreviewResponse>
  setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: true }>
  hide(): Promise<{ ok: true }>
}

export interface PixelForgeDesktopOverlayAPI {
  pickList(payload: {
    anchorRect: { x: number; y: number; width: number; height: number }
    items: Array<{ value: string; label: string }>
    selectedValue?: string | null
    width?: number
    maxHeight?: number
  }): Promise<string | null>
}

export interface PixelForgeDesktopBootstrapState {
  projectPath: string | null
  previewUrl: string | null
  activeMode: 'screenshot' | 'live-editor' | null
}

export interface PixelForgeDesktopPendingControllerUpdate {
  id: string
  projectPath: string
  snapshotPath: string | null
  version: string | null
  previewUrl: string | null
  activeMode: 'screenshot' | 'live-editor' | null
  summary: string
  source: string
  requestId: string | null
  commitHash: string | null
  gitRef?: string | null
  createdAt: string
  canRollback: boolean
}

export interface PixelForgePendingPreviewUpdate {
  id: string
  projectPath: string
  workspacePath: string
  snapshotPath: string | null
  previewUrl: string | null
  activeMode: 'screenshot' | 'live-editor' | null
  summary: string
  source: string
  requestId: string | null
  agentDeckSessionId: string | null
  createdAt: string
}

export interface PixelForgeDesktopControllerUpdateApplyState {
  status: 'idle' | 'running' | 'done' | 'error'
  updateId: string | null
  phase:
    | 'idle'
    | 'preparing'
    | 'installing'
    | 'restarting'
    | 'waiting'
    | 'finalizing'
    | 'relaunching'
    | 'done'
    | 'error'
  progress: number
  message: string
  error: string | null
}

export interface PixelForgeDesktopRuntimeInfo {
  controllerVersion: string
  runtimeRoot: string | null
  runtimeLayout: string | null
  acpxBridgeAvailable: boolean
  installedAt: string | null
}

export interface PixelForgeDesktopAppAPI {
  focusShell?(): Promise<{ ok: true }>
  getPreviewInputState?(): Promise<PixelForgeDesktopPreviewInputState>
  openAgentDeckSurface?(payload: { url: string }): Promise<{ ok: true }>
  applyControllerUpdate?(payload: PixelForgeDesktopBootstrapState): Promise<{ ok: true }>
  applyPendingControllerUpdate?(payload: PixelForgeDesktopBootstrapState): Promise<{ ok: true }>
  startControllerUpdate?(payload: PixelForgeDesktopBootstrapState): void
  startPendingControllerUpdate?(payload: PixelForgeDesktopBootstrapState): void
  consumeBootstrapState?(): Promise<PixelForgeDesktopBootstrapState | null>
  getPendingControllerUpdate?(): Promise<PixelForgeDesktopPendingControllerUpdate | null>
  getRuntimeInfo?(): Promise<PixelForgeDesktopRuntimeInfo>
  getDismissedControllerUpdateId?(): Promise<string | null>
  setDismissedControllerUpdateId?(updateId: string | null): Promise<string | null>
  getControllerUpdateApplyState?(): Promise<PixelForgeDesktopControllerUpdateApplyState>
  stageControllerUpdate?(payload: {
    projectPath: string
    previewUrl?: string | null
    activeMode?: 'screenshot' | 'live-editor' | null
    summary?: string | null
    source?: string | null
    requestId?: string | null
    commitHash?: string | null
    gitRef?: string | null
    allowNoncanonicalProject?: boolean
  }): Promise<PixelForgeDesktopPendingControllerUpdate>
  dismissPendingControllerUpdate?(): Promise<{ ok: true }>
}

declare global {
  interface Window {
    pixelForgeDesktop?: {
      preview: PixelForgeDesktopPreviewAPI
      overlay: PixelForgeDesktopOverlayAPI
      app: PixelForgeDesktopAppAPI
    }
  }
}
