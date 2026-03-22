import { describe, expect, it } from "vitest";

import { inferRuntimeKindFromHost, resolveRuntimeKind } from "./config";

describe("config runtime kind resolution", () => {
  it("infers mirror runtime from mirror target hosts", () => {
    expect(
      inferRuntimeKindFromHost("pixel-forge-mirror-target-abc123.localhost:7101")
    ).toBe("mirror");
  });

  it("infers dev runtime from dev target hosts", () => {
    expect(
      inferRuntimeKindFromHost("pixel-forge-dev-target-abc123.localhost:7101")
    ).toBe("dev");
  });

  it("keeps explicit runtime kind ahead of host inference", () => {
    expect(
      resolveRuntimeKind({
        rawRuntimeKind: "controller",
        rawTargetMode: "",
        host: "pixel-forge-mirror-target-abc123.localhost:7101",
      })
    ).toBe("controller");
  });

  it("uses host inference when build-time runtime metadata is absent", () => {
    expect(
      resolveRuntimeKind({
        rawRuntimeKind: "",
        rawTargetMode: "",
        host: "pixel-forge-mirror-target-abc123.localhost:7101",
      })
    ).toBe("mirror");
  });
});
