import { HTTP_BACKEND_URL } from "@/config";
import { getDesktopApp, hasDesktopAppMethod } from "./desktop-app";

interface BrowseDirectoryApiResponse {
  cancelled?: boolean;
  path?: string;
  message?: string;
}

async function browseDirectoryViaApi(initialPath?: string | null): Promise<string | null> {
  const response = await fetch(`${HTTP_BACKEND_URL}/browse/directory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initial_path: initialPath?.trim() || undefined,
    }),
  });
  const result = (await response.json()) as BrowseDirectoryApiResponse;
  if (!response.ok) {
    throw new Error(result.message || `HTTP ${response.status}`);
  }
  if (result.cancelled || !result.path) {
    return null;
  }
  return result.path;
}

export async function browseForDirectory(
  initialPath?: string | null
): Promise<string | null> {
  const desktopApp = getDesktopApp();
  if (hasDesktopAppMethod(desktopApp, "browseForDirectory")) {
    return desktopApp.browseForDirectory({
      initialPath: initialPath?.trim() || null,
    });
  }
  return browseDirectoryViaApi(initialPath);
}
