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

export const IS_TARGET_MODE = TARGET_MODE_VALUES.has(
  String(import.meta.env.VITE_PIXEL_FORGE_TARGET_MODE || "").toLowerCase()
);

export const WS_BACKEND_URL =
  import.meta.env.VITE_WS_BACKEND_URL || `${DEFAULT_WS_PROTOCOL}://${DEFAULT_BACKEND_HOST}`;

export const HTTP_BACKEND_URL =
  import.meta.env.VITE_HTTP_BACKEND_URL || DEFAULT_BACKEND_ORIGIN;
