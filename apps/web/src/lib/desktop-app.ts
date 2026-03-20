import { RUNTIME_KIND } from "@/config";
import type {
  PixelForgeDesktopAppAPI,
  PixelForgeDesktopOverlayAPI,
  PixelForgeDesktopPreviewAPI,
} from "@/types/pixel-forge-desktop";

type AppMethodName = keyof PixelForgeDesktopAppAPI;

export function shouldUseControllerAppBridge(
  runtimeKind: string | null | undefined
): boolean {
  return runtimeKind === "controller";
}

export function getDesktopPreview(): PixelForgeDesktopPreviewAPI | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.pixelForgeDesktop?.preview ?? null;
}

export function getDesktopOverlay(): PixelForgeDesktopOverlayAPI | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.pixelForgeDesktop?.overlay ?? null;
}

export function getDesktopApp(): PixelForgeDesktopAppAPI | null {
  if (typeof window === "undefined" || !shouldUseControllerAppBridge(RUNTIME_KIND)) {
    return null;
  }
  return window.pixelForgeDesktop?.app ?? null;
}

export function hasDesktopAppMethod<K extends AppMethodName>(
  app: PixelForgeDesktopAppAPI | null | undefined,
  method: K
): app is PixelForgeDesktopAppAPI & Required<Pick<PixelForgeDesktopAppAPI, K>> {
  return !!app && typeof app[method] === "function";
}
