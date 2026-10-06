import { promises as fs } from "node:fs";
import path from "node:path";
import { availableTimeframes, barBases, continuousOf, isoDay, kindOf, type KindContext, type StreamDecl } from "@qkt-studio/core";

const DAY_MS = 86_400_000;

/**
 * The files a futures/options run reads beyond the bars and ticks the CFD fingerprint already covers: the contract catalog, the
 * measured rolls, every contract's bars along the window, funding, marks, open interest, tape, liquidations, depth and option
 * chain days. They feed the run's data fingerprint (path, size, mtime), so changing one of them is a new run instead of a stale
 * cache hit. Stat-only and bounded: a contract's bars are looked at only between its predecessor's expiry and its own, so a long
 * continuous window costs about one stat per day, not one per contract per day.
 *
 * A CFD stream yields nothing here, which keeps every CFD run id exactly what it was.
 */
export async function derivativesDataPaths(opts: {
  /** The data root a symbol is read from (a symbol may point at another source). */
  rootOf: (symbol: string) => string;
  streams: StreamDecl[];
  ctx: KindContext;
  /** Window start minus the warmup, and the exclusive end, as epoch ms. */
  fromMs: number; toMs: number;
}): Promise<string[]> {
  const out = new Set<string>();
  const days = (a: number, b: number) => { const r: string[] = []; for (let d = a - (a % DAY_MS); d < b; d += DAY_MS) r.push(isoDay(d)); return r; };
  for (const s of opts.streams) {
    const kind = kindOf(s, opts.ctx);
    if (kind === "cfd" || kind === "hub") continue;
    const root = opts.rootOf(s.symbol), venue = s.broker;
    // a root's terms: the workspace file is hashed by the runner; the data root's one is what qkt reads when the workspace has none
    out.add(path.join(root, "instruments.yaml"));
    if (kind === "continuous") {
      const c = continuousOf(s.symbol)!;
      const catFile = path.join(root, "contracts", venue, `${c.root}.json`);
      out.add(catFile); out.add(path.join(root, "contracts", venue, `${c.root}.rolls.json`));
      const cat = JSON.parse(await fs.readFile(catFile, "utf8").catch(() => "{}")) as { contracts?: Array<{ symbol?: string; expiryMs?: number }> };
      const listed = (cat.contracts ?? []).filter((x): x is { symbol: string; expiryMs: number } => typeof x.symbol === "string" && typeof x.expiryMs === "number").sort((a, b) => a.expiryMs - b.expiryMs);
      // a roll leaves a contract some days before its expiry and `@next` runs one contract ahead: look a contract back and one forward
      for (let i = 0; i < listed.length; i++) {
        const start = (listed[i - 2]?.expiryMs ?? 0) - 14 * DAY_MS, end = listed[i]!.expiryMs + DAY_MS;
        if (end < opts.fromMs || start > opts.toMs) continue;
        const have = await availableTimeframes(root, venue, listed[i]!.symbol);
        const tf = barBases([{ broker: venue, symbol: listed[i]!.symbol, tf: s.tf }], () => have).get(`${venue}:${listed[i]!.symbol}`) ?? s.tf;
        for (const d of days(Math.max(start, opts.fromMs), Math.min(end, opts.toMs))) out.add(path.join(root, "bars", venue, listed[i]!.symbol, tf, `${d}.bin`));
      }
      continue;
    }
    if (kind === "chain" || kind === "analytic" || kind === "option") {
      const rk = optionRootOf(s, opts.ctx);
      if (!rk) continue;
      const [v, r] = rk;
      out.add(path.join(root, "contracts", v, `${r}.options.json`));
      for (const series of ["trade", "book"]) for (const d of days(opts.fromMs, opts.toMs)) out.add(path.join(root, "chains", v, r, series, `${d}.csv.gz`));
      continue;
    }
    // listed future or perpetual: its bars are in the CFD fingerprint; add the series a strategy can read beside them
    const name = s.symbol;
    out.add(path.join(root, "funding", venue, `${name}.csv`));
    out.add(path.join(root, "open_interest", venue, `${name}.csv`));
    const rootRoot = /^(.+?)_\d{6}$/.exec(name)?.[1];
    if (rootRoot) out.add(path.join(root, "contracts", venue, `${rootRoot}.json`));
    for (const d of days(opts.fromMs, opts.toMs)) {
      out.add(path.join(root, "tape", venue, name, `${d}.csv.gz`));
      out.add(path.join(root, "liquidations", venue, name, `${d}.csv.gz`));
      out.add(path.join(root, "depth", venue, name, `${d}.csv.gz`));
    }
    const marks = path.join(root, "marks", venue, name);
    for (const tf of await fs.readdir(marks).catch(() => [] as string[])) for (const d of days(opts.fromMs, opts.toMs)) out.add(path.join(marks, tf, `${d}.csv`));
  }
  return [...out];
}

/** `[venue, root]` of an option stream: an `OPTIONS:V.ROOT` chain, a `CHAIN:V.ROOT.metric.tenor` analytic, or a contract code. */
function optionRootOf(s: StreamDecl, ctx: KindContext): [string, string] | null {
  const b = s.broker.toUpperCase();
  if (b === "OPTIONS" || b === "CHAIN") { const [v, r] = s.symbol.split("."); return v && r ? [v, r] : null; }
  const key = `${s.broker}:${s.symbol}`;
  for (const r of ctx.optionRoots ?? []) if (key.startsWith(r + "_") || key.startsWith(r + "-")) return [r.slice(0, r.indexOf(":")), r.slice(r.indexOf(":") + 1)];
  return null;
}

