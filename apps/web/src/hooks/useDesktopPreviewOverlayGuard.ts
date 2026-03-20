import { useEffect, useRef } from 'react'
import type { PixelForgeDesktopPreviewAPI } from '@/types/pixel-forge-desktop'

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]'

/**
 * Hides the native Electron BrowserView whenever a blocking DOM overlay
 * (Radix dialog, alert dialog, popover, select dropdown) is present.
 *
 * Electron BrowserViews render in a native OS layer above all web content,
 * so CSS z-index cannot prevent them from obscuring overlays. This hook
 * observes the DOM for overlay elements and hides/restores the preview.
 */
export function useDesktopPreviewOverlayGuard(
  previewRef: React.RefObject<PixelForgeDesktopPreviewAPI | null>,
  restoreBounds: () => Promise<void> | void,
): void {
  const restoreBoundsRef = useRef(restoreBounds)
  restoreBoundsRef.current = restoreBounds
  const hadOverlayRef = useRef<boolean | null>(null)

  useEffect(() => {
    if (!previewRef.current) return

    const sync = () => {
      if (!previewRef.current) return
      const hasOverlay = document.querySelector(OVERLAY_SELECTOR) !== null
      if (hadOverlayRef.current === hasOverlay) {
        return
      }
      hadOverlayRef.current = hasOverlay
      if (hasOverlay) {
        void previewRef.current.hide()
      } else {
        void restoreBoundsRef.current()
      }
    }

    sync()

    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [previewRef])
}

/**
 * Returns true when any blocking Radix overlay is present in the DOM.
 * Use inside imperative code paths as a safety net alongside the hook.
 */
export function hasBlockingOverlay(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null
}
