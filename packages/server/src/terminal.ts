import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import { spawnGroup } from "./proc.js";

/** Split a command line into words (single/double quotes). Returns null on shell metacharacters or bad quoting. */
export function tokenize(line: string): string[] | null {
  const out: string[] = [];
  let cur = "", q: "'" | '"' | null = null, has = false;
  for (const c of line) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ""; has = false; } continue; }
    if (/[;|&<>`$()\\*?{}]/.test(c)) return null;
    cur += c; has = true;
  }
  if (q) return null;
  if (has || cur) out.push(cur);
  return out;
}

export const ALLOWED_SUBCOMMANDS = new Set(["parse", "backtest", "sweep", "walkforward", "data", "fetch", "experiment", "--version", "version"]);

/** Restricted terminal policy: `qkt <allowed-subcommand> ...`, no path escapes. */
export function checkRestricted(words: string[], workspace: string, dataRoot: string): string | null {
  if (words[0] !== "qkt") return "Only qkt commands are available in this terminal (start with 'qkt').";
  if (!words[1] || !ALLOWED_SUBCOMMANDS.has(words[1])) return `Not allowed: ${words[1] ?? "(none)"}. Allowed: ${[...ALLOWED_SUBCOMMANDS].join(", ")}`;
  for (const a of words.slice(2)) {
    if (a.split("/").includes("..")) return "Paths with '..' are not allowed.";
    if (path.isAbsolute(a) && !a.startsWith(workspace + path.sep) && a !== workspace && !a.startsWith(dataRoot)) return `Absolute path outside the workspace: ${a}`;
  }
  return null;
}

type ClientMsg = { t: "in"; d: string } | { t: "resize"; cols: number; rows: number } | { t: "cmd"; line: string } | { t: "interrupt" };

/**
 * Terminal over WebSocket. Frames are JSON: client {t:'in'|'cmd'|'resize'|'interrupt'}, server {t:'hello'|'out'|'exit'}.
 * `shell` mode is a real bash on a pty (via util-linux `script`, so no native module) and is only enabled with a
 * token or a loopback bind. `restricted` mode runs whitelisted `qkt` commands without a shell.
 */
export function registerTerminal(app: FastifyInstance, cfg: ServerConfig): void {
  app.get("/ws/term", { websocket: true }, (socket) => {
    const send = (o: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(o)); };
    send({ t: "hello", mode: cfg.terminal, cwd: cfg.workspace });
    const env = { ...process.env, QKT_DATA_HOME: cfg.dataRoot, TERM: "xterm-256color" };
    let cleanup = () => {};

    if (cfg.terminal === "shell") {
      const cols = 120, rows = 30;
      const child = spawn("script", ["-qfc", `stty cols ${cols} rows ${rows}; exec bash -l`, "/dev/null"], { cwd: cfg.workspace, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      child.stdout.on("data", (d: Buffer) => send({ t: "out", d: d.toString("utf8") }));
      child.stderr.on("data", (d: Buffer) => send({ t: "out", d: d.toString("utf8") }));
      child.on("exit", (code) => { send({ t: "exit", code }); socket.close(); });
      child.on("error", (e) => { send({ t: "out", d: `cannot start shell: ${e.message}\r\n` }); socket.close(); });
      cleanup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
      socket.on("message", (data: Buffer | string) => {
        let m: ClientMsg;
        try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.t === "in" && typeof m.d === "string" && !child.stdin.destroyed) child.stdin.write(m.d);
      });
    } else {
      let running: ReturnType<typeof spawnGroup> | null = null;
      cleanup = () => { void running?.kill(500); };
      socket.on("message", (data: Buffer | string) => {
        let m: ClientMsg;
        try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.t === "interrupt") { void running?.kill(1000); return; }
        if (m.t !== "cmd" || typeof m.line !== "string") return;
        if (running) { send({ t: "out", d: "A command is already running (Ctrl+C to stop it).\r\n" }); return; }
        const words = tokenize(m.line.trim());
        if (words === null) { send({ t: "out", d: "Shell operators and quoting errors are not supported here.\r\n" }); send({ t: "exit", code: 2 }); return; }
        if (words.length === 0) { send({ t: "exit", code: 0 }); return; }
        const denied = checkRestricted(words, cfg.workspace, cfg.dataRoot);
        if (denied) { send({ t: "out", d: denied + "\r\n" }); send({ t: "exit", code: 2 }); return; }
        running = spawnGroup(cfg.qktBin, words.slice(1), { cwd: cfg.workspace, env, timeoutMs: 60 * 60_000, onLine: (l) => send({ t: "out", d: l + "\r\n" }) });
        void running.exited.then((e) => { running = null; send({ t: "exit", code: e.code }); });
      });
    }
    socket.on("close", () => cleanup());
    socket.on("error", () => cleanup());
  });
}
