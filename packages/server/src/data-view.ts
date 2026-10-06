import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import { rootFor } from "./settings.js";

const SAFE = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;
const ls = (d: string) => fs.readdir(d).catch(() => [] as string[]);

/**
 * qkt reads ONE data folder per run (QKT_DATA_HOME). When some symbols come from another source, the studio assembles a
 * folder of symlinks for the run: every symbol of the default source, with the overridden symbols pointed at their own
 * source. Nothing is copied and nothing in either source is modified.
 * Returns the default root untouched when none of `symbols` is overridden.
 */
export async function prepareDataView(cfg: ServerConfig, symbols: string[]): Promise<{ root: string; overridden: Record<string, string> }> {
  const overridden: Record<string, string> = {};
  for (const s of new Set(symbols)) { const r = rootFor(cfg, s); if (r !== cfg.dataRoot) overridden[s] = r; }
  if (!Object.keys(overridden).length) return { root: cfg.dataRoot, overridden };

  const key = createHash("sha256").update(JSON.stringify([cfg.dataRoot, Object.entries(overridden).sort()])).digest("hex").slice(0, 16);
  const root = path.join(cfg.workspace, ".qkt-studio", "views", key);
  await fs.rm(root, { recursive: true, force: true });
  const link = async (from: string, to: string) => { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.symlink(from, to).catch(() => undefined); };
  const srcOf = (sym: string) => overridden[sym] ?? cfg.dataRoot;

  // bars/<broker>/<symbol>: brokers and symbols of the default source, plus whatever the overridden sources hold
  const roots = [cfg.dataRoot, ...new Set(Object.values(overridden))];
  const brokers = new Set<string>();
  for (const r of roots) for (const b of await ls(path.join(r, "bars"))) if (SAFE.test(b)) brokers.add(b);
  for (const b of brokers) {
    const syms = new Set<string>();
    for (const r of roots) for (const s of await ls(path.join(r, "bars", b))) if (SAFE.test(s)) syms.add(s);
    for (const s of syms) {
      const from = path.join(srcOf(s), "bars", b, s);
      if (await fs.stat(from).then((x) => x.isDirectory(), () => false)) await link(from, path.join(root, "bars", b, s));
    }
  }
  const tickSyms = new Set<string>();
  for (const r of roots) for (const s of await ls(path.join(r, "symbols"))) if (SAFE.test(s)) tickSyms.add(s);
  for (const s of tickSyms) {
    const from = path.join(srcOf(s), "symbols", s);
    if (await fs.stat(from).then((x) => x.isDirectory(), () => false)) await link(from, path.join(root, "symbols", s));
  }
  // futures and options read more than bars: catalogs and measured rolls, funding, marks, open interest, tape, option chains
  for (const d of ["contracts", "funding", "marks", "open_interest", "tape", "liquidations", "depth", "chains"]) {
    if (await fs.stat(path.join(cfg.dataRoot, d)).then((x) => x.isDirectory(), () => false)) await link(path.join(cfg.dataRoot, d), path.join(root, d));
  }
  for (const f of ["instruments.yaml"]) if (await fs.stat(path.join(cfg.dataRoot, f)).then(() => true, () => false)) await link(path.join(cfg.dataRoot, f), path.join(root, f));
  return { root, overridden };
}

/** Strictest window the per-symbol preferences allow for these symbols: [from, to) as ISO days, or null bounds when unrestricted. */
export function allowedWindow(cfg: ServerConfig, symbols: string[]): { from: string | null; to: string | null; by: { from?: string; to?: string } } {
  let from: string | null = null, to: string | null = null;
  const by: { from?: string; to?: string } = {};
  for (const s of new Set(symbols)) {
    const p = cfg.symbolPrefs?.[s];
    if (p?.from && (!from || p.from > from)) { from = p.from; by.from = s; }
    if (p?.to && (!to || p.to < to)) { to = p.to; by.to = s; }
  }
  return { from, to, by };
}
