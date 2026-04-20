import { afterEach, describe, expect, it, vi } from "vitest";

const { getDesktopApp, hasDesktopAppMethod } = vi.hoisted(() => ({
  getDesktopApp: vi.fn(),
  hasDesktopAppMethod: vi.fn(),
}));

vi.mock("@/config", () => ({
  HTTP_BACKEND_URL: "http://pixel-forge.localhost:7001",
}));

vi.mock("./desktop-app", () => ({
  getDesktopApp,
  hasDesktopAppMethod,
}));

import { browseForDirectory } from "./browse-directory";

describe("browseForDirectory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    getDesktopApp.mockReset();
    hasDesktopAppMethod.mockReset();
  });

  it("prefers the desktop bridge when the controller shell exposes it", async () => {
    const browseForDirectoryMock = vi.fn().mockResolvedValue("/tmp/workspace");
    getDesktopApp.mockReturnValue({
      browseForDirectory: browseForDirectoryMock,
    });
    hasDesktopAppMethod.mockReturnValue(true);

    const selectedPath = await browseForDirectory("/tmp/current");

    expect(selectedPath).toBe("/tmp/workspace");
    expect(browseForDirectoryMock).toHaveBeenCalledWith({
      initialPath: "/tmp/current",
    });
  });

  it("falls back to the backend picker when no desktop bridge is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cancelled: false,
        path: "/tmp/project",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    getDesktopApp.mockReturnValue(null);
    hasDesktopAppMethod.mockReturnValue(false);

    const selectedPath = await browseForDirectory("/tmp/current");

    expect(selectedPath).toBe("/tmp/project");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://pixel-forge.localhost:7001/browse/directory",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initial_path: "/tmp/current" }),
      }
    );
  });
});
