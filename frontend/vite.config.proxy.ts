import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";

// The browser's Origin is the Vite dev server, not the backend. Drop it so the
// backend's cross-site write check sees a header-less (same as curl) request.
const backend: ProxyOptions = {
  target: "http://localhost:3000",
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("origin"));
  },
};

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": backend,
      "/stream": backend,
    },
  },
});
