import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";

/** Parse a `.env` file: KEY=VALUE per line, `#` comments, optional `export`, single/double quotes, `\n` in double quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (v.startsWith('"')) { const end = v.indexOf('"', 1); v = (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/\\n/g, "\n").replace(/\\"/g, '"'); }
    else if (v.startsWith("'")) { const end = v.indexOf("'", 1); v = end > 0 ? v.slice(1, end) : v.slice(1); }
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]!] = v;
  }
  return out;
}

export interface WorkspaceEnv {
  /** Variables from the workspace `.env` (never logged). */
  vars: Record<string, string>;
  /** Fingerprint of the values, so editing `.env` changes a run's identity without the values leaking into run files. */
  fingerprint: string;
  /** Absolute path of instruments.yaml when the workspace has one. */
  instruments: string | null;
  instrumentsText: string;
}

export async function loadWorkspaceEnv(workspace: string): Promise<WorkspaceEnv> {
  const text = await fs.readFile(path.join(workspace, ".env"), "utf8").catch(() => "");
  const vars = parseDotEnv(text);
  const ip = path.join(workspace, "instruments.yaml");
  const instrumentsText = await fs.readFile(ip, "utf8").catch(() => "");
  return {
    vars, instruments: instrumentsText ? ip : null, instrumentsText,
    fingerprint: createHash("sha256").update(JSON.stringify(Object.entries(vars).sort())).digest("hex").slice(0, 16),
  };
}

/** Environment for every qkt child: the process env, then the workspace `.env` (it is the user's explicit choice), then the data source the studio owns. */
export function childEnv(cfg: ServerConfig, ws: WorkspaceEnv, dataRoot = cfg.dataRoot): NodeJS.ProcessEnv {
  const { QKT_DATA_HOME: _ignored, ...rest } = ws.vars;
  void _ignored;
  return { ...process.env, ...rest, QKT_DATA_HOME: dataRoot };
}

/** `--instruments` for backtest-family commands: the workspace's own file wins over the data source's. */
export const instrumentsArgs = (ws: WorkspaceEnv): string[] => (ws.instruments ? ["--instruments", ws.instruments] : []);

/** Same environment, read synchronously at spawn time (terminal, data jobs, LSP): edits to `.env` apply to the next process. */
export function spawnEnv(cfg: ServerConfig, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  let vars: Record<string, string> = {};
  try { vars = parseDotEnv(readFileSync(path.join(cfg.workspace, ".env"), "utf8")); } catch { /* no .env */ }
  const { QKT_DATA_HOME: _ignored, ...rest } = vars;
  void _ignored;
  return { ...process.env, ...rest, QKT_DATA_HOME: cfg.dataRoot, ...extra };
}

