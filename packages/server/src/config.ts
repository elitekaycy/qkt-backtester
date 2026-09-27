import os from "node:os";
import path from "node:path";

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
    port: Number(env.PORT ?? 8080),
    host,
    token,
    webRoot: env.WEB_ROOT ? path.resolve(env.WEB_ROOT) : undefined,
    maxParallel: Math.max(1, Number(env.MAX_PARALLEL ?? Math.max(1, os.cpus().length - 1))),
    allowedHosts: (env.STUDIO_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (env.STUDIO_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "").toLowerCase()).filter(Boolean),
    terminal,
  };
}
