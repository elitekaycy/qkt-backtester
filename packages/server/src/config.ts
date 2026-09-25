import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  /** Directory the user owns: qkt.config.yaml, strategies/, runs/. */
  workspace: string;
  /** qkt data store root; also exported to every child as QKT_DATA_HOME (bars ignore config data_root). */
  dataRoot: string;
  qktBin: string;
  port: number;
  host: string;
  /** When set, /api and /ws require `Authorization: Bearer <token>` (or ?token=). */
  token?: string;
  /** Built web app to serve; omitted in dev/tests. */
  webRoot?: string;
  maxParallel: number;
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
    qktBin: env.QKT_BIN ?? "qkt",
    port: Number(env.PORT ?? 8080),
    host,
    token,
    webRoot: env.WEB_ROOT ? path.resolve(env.WEB_ROOT) : undefined,
    maxParallel: Math.max(1, Number(env.MAX_PARALLEL ?? Math.max(1, os.cpus().length - 1))),
    terminal,
  };
}
