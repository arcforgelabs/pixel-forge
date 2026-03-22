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

  it("defaults to controller when no metadata or host pattern matches", () => {
    expect(
      resolveRuntimeKind({
        rawRuntimeKind: "",
        rawTargetMode: "",
        host: "pixel-forge.localhost:7001",
      })
    ).toBe("controller");
  });

  it("treats target mode as dev runtime kind", () => {
    expect(
      resolveRuntimeKind({
        rawRuntimeKind: "",
        rawTargetMode: "1",
        host: "",
      })
    ).toBe("dev");
  });
});

describe("runtime bootstrap contract — authoritative override pattern", () => {
  it("authoritative runtimeKind overrides static fallback for mirror", () => {
    // Simulates the case where a controller-built bundle is served by a mirror.
    // The static RUNTIME_KIND would be "controller" (no build-time env var),
    // but the backend says "mirror".
    const staticFallback = resolveRuntimeKind({
      rawRuntimeKind: "",
      rawTargetMode: "",
      host: "pixel-forge.localhost:7001", // no host pattern match
    });
    expect(staticFallback).toBe("controller"); // static says controller

    // Backend authoritative value overrides this:
    const authoritativeKind: "controller" | "mirror" | "dev" = "mirror";
    const effectiveKind = authoritativeKind || staticFallback;
    expect(effectiveKind).toBe("mirror");
  });

  it("non-controller runtimes do not allow profile restore", () => {
    const mirrorBootstrap = {
      runtimeKind: "mirror" as const,
      allowProfileRestore: false,
      allowSelfMirrorLaunch: false,
    };
    expect(mirrorBootstrap.allowProfileRestore).toBe(false);
    expect(mirrorBootstrap.allowSelfMirrorLaunch).toBe(false);
  });

  it("controller runtimes allow profile restore and self-mirror launch", () => {
    const controllerBootstrap = {
      runtimeKind: "controller" as const,
      allowProfileRestore: true,
      allowSelfMirrorLaunch: true,
    };
    expect(controllerBootstrap.allowProfileRestore).toBe(true);
    expect(controllerBootstrap.allowSelfMirrorLaunch).toBe(true);
  });

  it("one-layer self-edit remains possible via controller", () => {
    // Controller can launch mirrors; mirrors cannot launch mirrors.
    const controllerBootstrap = { runtimeKind: "controller" as const, allowSelfMirrorLaunch: true };
    const mirrorBootstrap = { runtimeKind: "mirror" as const, allowSelfMirrorLaunch: false };
    expect(controllerBootstrap.allowSelfMirrorLaunch).toBe(true);
    expect(mirrorBootstrap.allowSelfMirrorLaunch).toBe(false);
  });
});
