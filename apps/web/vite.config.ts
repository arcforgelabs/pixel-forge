import path from "path";
import { defineConfig, loadEnv } from "vite";
import checker from "vite-plugin-checker";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = Number.parseInt(env.PIXEL_FORGE_API_PORT || "7001", 10);
  const webPort = Number.parseInt(env.PIXEL_FORGE_WEB_PORT || "5173", 10);
  const previewPort = Number.parseInt(env.PIXEL_FORGE_WEB_PREVIEW_PORT || "4173", 10);
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    base: "",
    plugins: [react(), checker({ typescript: true })],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: true,
      allowedHosts: true,
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, ws: true },
        "/app": { target: apiTarget, changeOrigin: true, ws: true },
        "/browse": { target: apiTarget, changeOrigin: true },
        "/config": { target: apiTarget, changeOrigin: true },
        "/preview-file": { target: apiTarget, changeOrigin: true },
        "/save-code": { target: apiTarget, changeOrigin: true },
        "/test-app": { target: apiTarget, changeOrigin: true },
        "/test-harness.html": { target: apiTarget, changeOrigin: true },
        "/ws": { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
    preview: {
      host: true,
      port: previewPort,
      strictPort: true,
    },
    test: {
      environment: "node",
      setupFiles: ["./src/setupTests.ts"],
      testTimeout: 30000,
    },
  };
});
