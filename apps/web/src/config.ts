const DEFAULT_BACKEND_ORIGIN =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://pixel-forge.localhost:7001";
const DEFAULT_BACKEND_HOST =
  typeof window !== "undefined" ? window.location.host : "pixel-forge.localhost:7001";
const DEFAULT_HTTP_PROTOCOL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "https"
    : "http";
const DEFAULT_WS_PROTOCOL = DEFAULT_HTTP_PROTOCOL === "https" ? "wss" : "ws";
const TARGET_MODE_VALUES = new Set(["1", "true", "yes", "on"]);
const RUNTIME_KIND_VALUES = new Set(["controller", "mirror", "dev"]);

export function inferRuntimeKindFromHost(host: string | null | undefined): "mirror" | "dev" | null {
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (!normalizedHost) {
    return null;
  }

  if (normalizedHost.includes("-mirror-target-")) {
    return "mirror";
  }

  if (normalizedHost.includes("-dev-target-")) {
    return "dev";
  }

  return null;
}

export function resolveRuntimeKind(options: {
  rawRuntimeKind?: string | null | undefined;
  rawTargetMode?: string | null | undefined;
  host?: string | null | undefined;
}): "controller" | "mirror" | "dev" {
  const rawRuntimeKind = String(options.rawRuntimeKind || "").toLowerCase();
  if (RUNTIME_KIND_VALUES.has(rawRuntimeKind)) {
    return rawRuntimeKind as "controller" | "mirror" | "dev";
  }

  if (TARGET_MODE_VALUES.has(String(options.rawTargetMode || "").toLowerCase())) {
    return "dev";
  }

  const inferredFromHost = inferRuntimeKindFromHost(options.host);
  return inferredFromHost || "controller";
}

export const RUNTIME_KIND = resolveRuntimeKind({
  rawRuntimeKind: import.meta.env.VITE_PIXEL_FORGE_RUNTIME_KIND,
  rawTargetMode: import.meta.env.VITE_PIXEL_FORGE_TARGET_MODE,
  host: typeof window !== "undefined" ? window.location.host : null,
});

export const IS_TARGET_MODE = RUNTIME_KIND === "dev";
export const TARGET_PROJECT_PATH = String(
  import.meta.env.VITE_PIXEL_FORGE_TARGET_PROJECT_PATH || ""
).trim() || null;

export const WS_BACKEND_URL =
  import.meta.env.VITE_WS_BACKEND_URL || `${DEFAULT_WS_PROTOCOL}://${DEFAULT_BACKEND_HOST}`;

export const HTTP_BACKEND_URL =
  import.meta.env.VITE_HTTP_BACKEND_URL || DEFAULT_BACKEND_ORIGIN;
