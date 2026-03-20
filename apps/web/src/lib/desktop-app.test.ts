import { describe, expect, it } from "vitest";

import { shouldUseControllerAppBridge } from "./desktop-app";

describe("desktop-app bridge guards", () => {
  it("keeps controller-only app methods out of target runtimes", () => {
    expect(shouldUseControllerAppBridge("controller")).toBe(true);
    expect(shouldUseControllerAppBridge("mirror")).toBe(false);
    expect(shouldUseControllerAppBridge("dev")).toBe(false);
    expect(shouldUseControllerAppBridge("")).toBe(false);
    expect(shouldUseControllerAppBridge(null)).toBe(false);
  });
});
