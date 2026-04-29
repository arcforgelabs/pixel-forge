import { useEffect, useRef, type RefObject } from 'react'
import type { PixelForgeDesktopPreviewAPI } from '@/types/pixel-forge-desktop'

const OVERLAY_SELECTOR =
  [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
    '[data-radix-popper-content-wrapper]',
    '[data-pixel-forge-overlay="true"]',
  ].join(', ')

interface DesktopPreviewOverlayGuardOptions {
  previewHostRef?: RefObject<HTMLElement | null>
  getActiveTabId?: () => string | null
  setSnapshot?: (dataUrl: string | null) => void
}

function rectsIntersect(left: DOMRect, right: DOMRect): boolean {
  return (
    left.right > right.left
    && left.left < right.right
    && left.bottom > right.top
    && left.top < right.bottom
  )
}

function visibleOverlayIntersectsPreview(previewHost: HTMLElement | null | undefined): boolean {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))
    .filter((element) => element.offsetParent !== null || element.getClientRects().length > 0)
  if (overlays.length === 0) {
    return false
  }

  if (!previewHost) {
    return true
  }

  const hostRect = previewHost.getBoundingClientRect()
  if (hostRect.width <= 0 || hostRect.height <= 0) {
    return overlays.length > 0
  }

  return overlays.some((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rectsIntersect(hostRect, rect)
  })
}

/**
 * Occludes the native Electron WebContentsView whenever shell chrome intersects
 * the preview aperture.
 *
 * WebContentsView renders as a native child surface above web content. CSS
 * z-index cannot reliably put React popovers or rounded frames over it, so the
 * shell hides the native view and paints a DOM snapshot while overlays are open.
 */
export function useDesktopPreviewOverlayGuard(
  previewRef: RefObject<PixelForgeDesktopPreviewAPI | null>,
  restoreBounds: () => Promise<void> | void,
  options: DesktopPreviewOverlayGuardOptions = {},
): void {
  const restoreBoundsRef = useRef(restoreBounds)
  restoreBoundsRef.current = restoreBounds
  const hadOverlayRef = useRef<boolean | null>(null)
  const generationRef = useRef(0)
  const getActiveTabIdRef = useRef(options.getActiveTabId)
  const setSnapshotRef = useRef(options.setSnapshot)
  getActiveTabIdRef.current = options.getActiveTabId
  setSnapshotRef.current = options.setSnapshot

  useEffect(() => {
    if (!previewRef.current) return

    const sync = () => {
      if (!previewRef.current) return
      const hasOverlay = visibleOverlayIntersectsPreview(options.previewHostRef?.current)
      if (hadOverlayRef.current === hasOverlay) {
        return
      }
      hadOverlayRef.current = hasOverlay
      const generation = generationRef.current + 1
      generationRef.current = generation
      if (hasOverlay) {
        const tabId = getActiveTabIdRef.current?.() ?? null
        void previewRef.current.hide()
        if (tabId && previewRef.current.captureSnapshot) {
          void previewRef.current.captureSnapshot(tabId)
            .then((payload) => {
              if (generationRef.current !== generation) {
                return
              }
              setSnapshotRef.current?.(payload.snapshot_data_url || null)
            })
            .catch(() => {
              if (generationRef.current === generation) {
                setSnapshotRef.current?.(null)
              }
            })
        } else {
          setSnapshotRef.current?.(null)
        }
      } else {
        setSnapshotRef.current?.(null)
        void restoreBoundsRef.current()
      }
    }

    sync()

    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      attributeFilter: ['class', 'style', 'data-state', 'role'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [options.previewHostRef, previewRef])
}

/**
 * Returns true when any blocking Radix overlay is present in the DOM.
 * Use inside imperative code paths as a safety net alongside the hook.
 */
export function hasBlockingOverlay(previewHost?: HTMLElement | null): boolean {
  return visibleOverlayIntersectsPreview(previewHost)
}
