export interface PixelForgeBrowserPreviewResponse {
  mode: 'browser'
  browser_tab_id: string
  target_url: string
  title: string
  snapshot_data_url: string | null
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
  activate(tabId: string): Promise<{ ok: true }>
  focus(tabId: string): Promise<{ ok: true }>
  refresh(tabId: string): Promise<PixelForgeBrowserPreviewResponse>
  close(tabId: string): Promise<{ ok: true }>
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
}

export interface PixelForgeDesktopAppAPI {
  applyControllerUpdate(payload: PixelForgeDesktopBootstrapState): Promise<{ ok: true }>
  applyPendingControllerUpdate(payload: PixelForgeDesktopBootstrapState): Promise<{ ok: true }>
  startControllerUpdate?(payload: PixelForgeDesktopBootstrapState): void
  startPendingControllerUpdate?(payload: PixelForgeDesktopBootstrapState): void
  consumeBootstrapState(): Promise<PixelForgeDesktopBootstrapState | null>
  getPendingControllerUpdate(): Promise<PixelForgeDesktopPendingControllerUpdate | null>
  getRuntimeInfo(): Promise<PixelForgeDesktopRuntimeInfo>
  getDismissedControllerUpdateId(): Promise<string | null>
  setDismissedControllerUpdateId(updateId: string | null): Promise<string | null>
  getControllerUpdateApplyState(): Promise<PixelForgeDesktopControllerUpdateApplyState>
  stageControllerUpdate(payload: {
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
  dismissPendingControllerUpdate(): Promise<{ ok: true }>
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
