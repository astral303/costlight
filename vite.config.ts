import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_SERVER_ORIGIN = "http://127.0.0.1:4637";

export default defineConfig({
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
