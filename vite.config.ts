import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveApplicationVersion } from "./src/app-version/resolve-version.ts";

const API_SERVER_ORIGIN = "http://127.0.0.1:4637";
const applicationVersion = resolveApplicationVersion();

export default defineConfig({
  define: {
    __COSTLIGHT_VERSION__: JSON.stringify(applicationVersion),
  },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": API_SERVER_ORIGIN,
    },
  },
  build: {
    chunkSizeWarningLimit: 650,
    outDir: "dist",
    emptyOutDir: true,
  },
});
