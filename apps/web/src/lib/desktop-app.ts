import type { PixelForgeDesktopAppAPI } from "@/types/pixel-forge-desktop";

type AppMethodName = keyof PixelForgeDesktopAppAPI;

export function getDesktopApp(): PixelForgeDesktopAppAPI | null {
  if (typeof window === "undefined") {
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
