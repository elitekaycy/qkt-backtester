import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const target = process.env.STUDIO_URL ?? "http://127.0.0.1:8080";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": target, "/ws": { target: target.replace("http", "ws"), ws: true } } },
  build: { chunkSizeWarningLimit: 6000, target: "es2022" },
  test: { environment: "node" },
});
