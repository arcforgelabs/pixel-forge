import { describe, expect, it } from "vitest";

import { hasDesktopAppMethod, shouldUseControllerAppBridge } from "./desktop-app";

describe("desktop-app bridge guards", () => {
  it("keeps controller-only app methods out of target runtimes", () => {
    expect(shouldUseControllerAppBridge("controller")).toBe(true);
    expect(shouldUseControllerAppBridge("mirror")).toBe(false);
    expect(shouldUseControllerAppBridge("dev")).toBe(false);
    expect(shouldUseControllerAppBridge("")).toBe(false);
    expect(shouldUseControllerAppBridge(null)).toBe(false);
  });

  it("detects the Agent Deck surface bridge when present", () => {
    const desktopApp = {
      openAgentDeckSurface: async () => ({ ok: true as const }),
    };

    expect(hasDesktopAppMethod(desktopApp, "openAgentDeckSurface")).toBe(true);
  });
});
