const DEFAULT_URL_HOST =
  String(
    import.meta.env.VITE_PIXEL_FORGE_URL_HOST
    || import.meta.env.PIXEL_FORGE_URL_HOST
    || "pixel-forge.localhost"
  ).trim() || "pixel-forge.localhost";
const DEFAULT_API_PORT =
  String(
    import.meta.env.VITE_PIXEL_FORGE_API_PORT
    || import.meta.env.PIXEL_FORGE_API_PORT
    || "7001"
  ).trim() || "7001";
const DEFAULT_BACKEND_ORIGIN =
  typeof window !== "undefined"
    ? window.location.origin
    : `http://${DEFAULT_URL_HOST}:${DEFAULT_API_PORT}`;
const DEFAULT_BACKEND_HOST =
  typeof window !== "undefined" ? window.location.host : `${DEFAULT_URL_HOST}:${DEFAULT_API_PORT}`;
const DEFAULT_HTTP_PROTOCOL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "https"
    : "http";
const DEFAULT_WS_PROTOCOL = DEFAULT_HTTP_PROTOCOL === "https" ? "wss" : "ws";
const TARGET_MODE_VALUES = new Set(["1", "true", "yes", "on"]);
const RUNTIME_KIND_VALUES = new Set(["controller", "mirror", "dev"]);

const RAW_RUNTIME_KIND = String(
  import.meta.env.VITE_PIXEL_FORGE_RUNTIME_KIND || ""
).toLowerCase();

export const RUNTIME_KIND = RUNTIME_KIND_VALUES.has(RAW_RUNTIME_KIND)
  ? (RAW_RUNTIME_KIND as "controller" | "mirror" | "dev")
  : TARGET_MODE_VALUES.has(String(import.meta.env.VITE_PIXEL_FORGE_TARGET_MODE || "").toLowerCase())
    ? "dev"
    : "controller";

export const IS_TARGET_MODE = RUNTIME_KIND === "dev";
export const TARGET_PROJECT_PATH = String(
  import.meta.env.VITE_PIXEL_FORGE_TARGET_PROJECT_PATH || ""
).trim() || null;

export const WS_BACKEND_URL =
  import.meta.env.VITE_WS_BACKEND_URL || `${DEFAULT_WS_PROTOCOL}://${DEFAULT_BACKEND_HOST}`;

export const HTTP_BACKEND_URL =
  import.meta.env.VITE_HTTP_BACKEND_URL || DEFAULT_BACKEND_ORIGIN;
