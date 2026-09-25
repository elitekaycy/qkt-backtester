import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.STUDIO_URL ?? "http://127.0.0.1:8080";
// monaco-vim imports deep `monaco-editor/esm/vs/...` paths that monaco 0.56's export map hides. Point them at the real
// files so it shares the exact module instance (and therefore the same editor registry) our editor uses.
const monacoEsm = path.join(path.dirname(fileURLToPath(import.meta.url)), "node_modules", "monaco-editor", "esm", "vs");

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: `${monacoEsm}/$1.js` }] },
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": target, "/ws": { target: target.replace("http", "ws"), ws: true } } },
  build: { chunkSizeWarningLimit: 6000, target: "es2022" },
  test: { environment: "node" },
});
