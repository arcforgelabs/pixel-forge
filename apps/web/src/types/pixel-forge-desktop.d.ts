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

declare global {
  interface Window {
    pixelForgeDesktop?: {
      preview: PixelForgeDesktopPreviewAPI
      overlay: PixelForgeDesktopOverlayAPI
    }
  }
}
