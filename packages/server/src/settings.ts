import { promises as fs } from "node:fs";
import path from "node:path";
import type { Split } from "@qkt-studio/core";
import type { ServerConfig, SymbolPref } from "./config.js";

export interface StudioSettings { dataRoot?: string; sources?: string[]; symbols?: Record<string, SymbolPref>; split?: Split }

const file = (cfg: ServerConfig) => path.join(cfg.workspace, ".qkt-studio", "settings.json");
const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";
/** Locations that may be chosen as a data source when nothing protects the server (no token, reachable beyond loopback). */
const OPEN_ROOTS = ["/data", "/mnt", "/media", "/srv"];

export async function loadSettings(cfg: ServerConfig): Promise<StudioSettings> {
  try { return JSON.parse(await fs.readFile(file(cfg), "utf8")) as StudioSettings; } catch { return {}; }
}

export async function saveSettings(cfg: ServerConfig, s: StudioSettings): Promise<void> {
  await fs.mkdir(path.dirname(file(cfg)), { recursive: true });
  await fs.writeFile(file(cfg), JSON.stringify(s, null, 2));
}

/** May the UI point the studio at `target`? Everything is allowed with a token or on loopback; otherwise only known mount roots. */
export function dataRootAllowed(cfg: ServerConfig, target: string): { ok: boolean; reason?: string; trusted: boolean } {
  const trusted = Boolean(cfg.token) || isLoopback(cfg.host);
  if (trusted) return { ok: true, trusted };
  const roots = [cfg.defaultDataRoot ?? cfg.dataRoot, ...OPEN_ROOTS];
  const ok = roots.some((r) => target === r || target.startsWith(r.replace(/\/$/, "") + "/"));
  return ok ? { ok, trusted } : { ok, trusted, reason: `This server is reachable without a token, so the data source can only be under ${roots.join(", ")}. Set STUDIO_TOKEN to allow any folder.` };
}

/** Apply a saved data source at boot if it still exists; otherwise keep the configured default. */
export async function applySettings(cfg: ServerConfig): Promise<void> {
  cfg.defaultDataRoot ??= cfg.dataRoot;
  const s = await loadSettings(cfg);
  cfg.sources = (s.sources ?? []).filter((x) => typeof x === "string");
  cfg.symbolPrefs = s.symbols ?? {};
  if (s.dataRoot) {
    const st = await fs.stat(s.dataRoot).catch(() => null);
    if (st?.isDirectory()) cfg.dataRoot = s.dataRoot;
  }
}

/** Persist the source list and per-symbol preferences that live on `cfg`. */
export async function savePrefs(cfg: ServerConfig): Promise<void> {
  const s = await loadSettings(cfg);
  s.sources = cfg.sources ?? [];
  s.symbols = Object.fromEntries(Object.entries(cfg.symbolPrefs ?? {}).filter(([, v]) => v.source || v.from || v.to));
  await saveSettings(cfg, s);
}

/** The data folder a symbol is read from: its own override or the default source. */
export const rootFor = (cfg: ServerConfig, symbol: string): string => cfg.symbolPrefs?.[symbol]?.source ?? cfg.dataRoot;
