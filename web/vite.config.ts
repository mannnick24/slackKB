import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  optimizeDeps: {
    exclude: ["jsdom"],
  },
  ssr: {
    noExternal: ["jsdom"],
  },
  plugins: [react()],
  server: {
    allowedHosts: ["localhost", "127.0.0.1", "0.0.0.0", "nm-p1-dev1"],
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      }
    }
  }
});
