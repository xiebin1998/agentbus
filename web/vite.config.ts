import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 产物由 hub（Starlette StaticFiles）挂载在 /console 下；用相对 base 适配任意前缀
export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
});
