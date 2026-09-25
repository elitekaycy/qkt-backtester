import { spawnEnv } from "./workspace-env.js";
import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import type { ServerConfig } from "./config.js";

const MAX_EDITORS = 4;

/**
 * WebSocket <-> `qkt lsp` (LSP over stdio). One child per editor connection; the browser sends and receives plain
 * JSON-RPC text frames and this bridge adds/strips the Content-Length framing. If the child dies the client gets a
 * `studio/lspExit` notification and the socket closes so the editor can reconnect and re-initialise.
 */
export function registerLspBridge(app: FastifyInstance, cfg: ServerConfig): void {
  let active = 0;
  app.get("/ws/lsp", { websocket: true }, (socket) => {
    if (active >= MAX_EDITORS) { socket.close(1013, "too many editor sessions"); return; }
    active++;
    const child = spawn(cfg.qktBin, ["lsp"], { cwd: cfg.workspace, env: spawnEnv(cfg), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let buf = Buffer.alloc(0);
    let alive = true;

    const cleanup = () => {
      if (!alive) return;
      alive = false; active--;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const he = buf.indexOf("\r\n\r\n");
        if (he < 0) return;
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, he).toString("ascii"));
        if (!m) { buf = buf.subarray(he + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < he + 4 + len) return;
        const body = buf.subarray(he + 4, he + 4 + len).toString("utf8");
        buf = buf.subarray(he + 4 + len);
        if (socket.readyState === socket.OPEN) socket.send(body);
      }
    });
    child.stderr.on("data", () => { /* qkt lsp logs to stderr; not surfaced */ });
    child.on("error", () => { cleanup(); if (socket.readyState === socket.OPEN) socket.close(1011, "cannot start qkt lsp"); });
    child.on("exit", (code) => {
      if (alive && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "studio/lspExit", params: { code } }));
        socket.close(1011, "qkt lsp exited");
      }
      cleanup();
    });

    socket.on("message", (data: Buffer | string) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (!alive || child.stdin.destroyed) return;
      child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
