import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

export interface SymbolPref {
  /** Absolute data folder for this symbol; omitted = the default source. */
  source?: string;
  /** Inclusive first day and exclusive last day (like qkt --to) the strategies may use for this symbol; omitted = whatever the source has. */
  from?: string; to?: string;
}

export interface ServerConfig {
  /** Directory the user owns: qkt.config.yaml, strategies/, runs/. */
  workspace: string;
  /** qkt data store root; also exported to every child as QKT_DATA_HOME (bars ignore config data_root). */
  dataRoot: string;
  /** The data source the server started with (env); the UI can change `dataRoot` at runtime. */
  defaultDataRoot?: string;
  /** Extra data folders the user added (besides `dataRoot`); a symbol can be pointed at any of them. Persisted in the workspace. */
  sources?: string[];
  /** Per-symbol data preferences. Absent = use `dataRoot` and the full range found there. */
  symbolPrefs?: Record<string, SymbolPref>;
  qktBin: string;
  /** The Claude Code CLI the chat runs (`CLAUDE_BIN`, default `claude` on PATH). */
  claudeBin?: string;
  port: number;
  host: string;
  /** When set, /api and /ws require `Authorization: Bearer <token>` (or ?token=). */
  token?: string;
  /** Built web app to serve; omitted in dev/tests. */
  webRoot?: string;
  maxParallel: number;
  /**
   * Host names (besides localhost) a server WITHOUT a token answers to, e.g. a LAN name. Any other Host header is refused, which
   * is what stops a web page from reaching the studio through DNS rebinding. With a token the token is the protection instead.
   */
  allowedHosts: string[];
  /** Page origins (besides the studio's own) allowed to call the API and open its WebSockets, e.g. a dev server. */
  allowedOrigins: string[];
  /** Allow the pty terminal (real shell). Only ever true with a token or a loopback bind. */
  terminal: "shell" | "restricted";
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? "127.0.0.1";
  const token = env.STUDIO_TOKEN || undefined;
  const requested = env.STUDIO_TERMINAL ?? "auto";
  const shellAllowed = Boolean(token) || isLoopback(host);
  const terminal: "shell" | "restricted" =
    requested === "restricted" ? "restricted" : requested === "shell" || requested === "auto" ? (shellAllowed ? "shell" : "restricted") : "restricted";
  return {
    workspace: path.resolve(env.WORKSPACE ?? process.cwd()),
    dataRoot: path.resolve(env.QKT_DATA_HOME ?? path.join(os.homedir(), ".qkt", "data")),
    defaultDataRoot: path.resolve(env.QKT_DATA_HOME ?? path.join(os.homedir(), ".qkt", "data")),
    qktBin: env.QKT_BIN ?? "qkt",
    claudeBin: env.CLAUDE_BIN || "claude",
    port: Number(env.PORT ?? 8080),
    host,
    token,
    webRoot: env.WEB_ROOT ? path.resolve(env.WEB_ROOT) : undefined,
    maxParallel: Math.max(1, Number(env.MAX_PARALLEL ?? defaultParallel())),
    allowedHosts: (env.STUDIO_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (env.STUDIO_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "").toLowerCase()).filter(Boolean),
    terminal,
  };
}

/** Memory this process may use: a container's cgroup limit when there is one (os.totalmem reports the whole host). */
export function memoryLimitBytes(): number {
  const total = os.totalmem();
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try { const v = Number(readFileSync(f, "utf8").trim()); if (Number.isFinite(v) && v > 0 && v < total) return v; } catch { /* no cgroup limit here */ }
  }
  return total;
}

/**
 * Runs at once when MAX_PARALLEL is not set: one per spare core, but no more than memory allows. A backtest's JVM peaks
 * around 0.3 GB on bars and 1.2 GB on ticks (measured), and the machine keeps a quarter of its memory for everything
 * else, so a 16-core, 15 GB host runs 9 at once instead of 15 (which could exhaust memory on tick runs).
 */
export function defaultParallel(): number {
  const byCpu = Math.max(1, os.cpus().length - 1);
  const byMem = Math.max(1, Math.floor((memoryLimitBytes() * 0.75) / (1.2 * 1024 ** 3)));
  return Math.min(byCpu, byMem);
}
