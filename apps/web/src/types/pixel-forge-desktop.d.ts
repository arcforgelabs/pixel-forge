export interface PixelForgeBrowserPreviewResponse {
  mode: 'browser'
  browser_tab_id: string
  target_url: string
  title: string
  snapshot_data_url: string | null
}

export interface PixelForgeAppliedSelection {
  id: string
  xpath: string
  globalIndex: number
  tagName: string
  elementId: string | null
  classList: string[]
  textSample: string
}

export interface PixelForgeDesktopPreviewAPI {
  load(payload: { tabId: string; url: string }): Promise<PixelForgeBrowserPreviewResponse>
  activate(tabId: string): Promise<{ ok: true }>
  focus(tabId: string): Promise<{ ok: true }>
  refresh(tabId: string): Promise<PixelForgeBrowserPreviewResponse>
  close(tabId: string): Promise<{ ok: true }>
  setSelectMode(tabId: string, enabled: boolean): Promise<PixelForgeBrowserPreviewResponse>
  clearSelections(tabId: string): Promise<PixelForgeBrowserPreviewResponse>
  deselect(tabId: string, xpath: string): Promise<PixelForgeBrowserPreviewResponse>
  applySelections(tabId: string, selections: PixelForgeAppliedSelection[]): Promise<PixelForgeBrowserPreviewResponse>
  setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: true }>
  hide(): Promise<{ ok: true }>
}

declare global {
  interface Window {
    pixelForgeDesktop?: {
      preview: PixelForgeDesktopPreviewAPI
    }
  }
}
