const DEFAULT_BACKEND_HOST =
  typeof window !== "undefined" ? window.location.hostname : "pixel-forge.localhost";
const DEFAULT_HTTP_PROTOCOL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "https"
    : "http";
const DEFAULT_WS_PROTOCOL = DEFAULT_HTTP_PROTOCOL === "https" ? "wss" : "ws";

export const WS_BACKEND_URL =
  import.meta.env.VITE_WS_BACKEND_URL ||
  `${DEFAULT_WS_PROTOCOL}://${DEFAULT_BACKEND_HOST}:7001`;

export const HTTP_BACKEND_URL =
  import.meta.env.VITE_HTTP_BACKEND_URL ||
  `${DEFAULT_HTTP_PROTOCOL}://${DEFAULT_BACKEND_HOST}:7001`;
