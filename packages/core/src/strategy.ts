import { scrub } from "./lint.js";
import type { DayRange } from "./ranges.js";
import type { SymbolReport } from "./scantypes.js";

export interface StreamDecl {
  alias: string;
  /** Venue prefix as written (BACKTEST, MT5, EXNESS, ICMARKETS, HUB...). */
  broker: string;
  symbol: string;
  tf: string;
  warmupBars?: number;
}
export interface ParamDecl { name: string; default: string }
export interface ImportDecl { path: string; alias: string; hold?: boolean }

export interface StrategyInfo {
  kind: "strategy" | "portfolio" | "unknown";
  name?: string;
  streams: StreamDecl[];
  params: ParamDecl[];
  imports: ImportDecl[];
}

const STREAM = /^\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z0-9_]+):([A-Za-z0-9_.@\-]+)\s+EVERY\s+(\d+[smhd])(?:\s+WARMUP\s+(\d+)\s+BARS)?/;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/**
 * qkt's own name for a timeframe (TimeWindow.canonicalSpec): the duration in the largest whole unit, so `60m` is `1h` and
 * `1440m` is `1d`. The bar store keys folders by this name, so a `1440m` folder is never read. null for a spec qkt rejects.
 */
export function canonicalTf(spec: string): string | null {
  const m = /^(\d+)([smhd])$/.exec(spec.trim());
  if (!m || +m[1]! <= 0) return null;
  const ms = +m[1]! * UNIT_MS[m[2]!]!;
  for (const [u, n] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) if (ms % n === 0) return `${ms / n}${u}`;
  return `${ms}ms`;
}

/** Milliseconds in a timeframe spec (`15m`, `1h`, `1d`), or null. */
export function tfMs(spec: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(spec.trim());
  return m && +m[1]! > 0 ? +m[1]! * UNIT_MS[m[2]!]! : null;
}

/**
 * How many bars qkt may read before `from` to warm the indicators up. qkt seeds each stream with as many bars as its longest
 * lookback (`WARMUP N BARS` when declared); the periods are literals or PARAMs in the source, so the largest whole number the
 * sources and parameter values use bounds it (at least 200). Over-estimating only makes the run fingerprint stat a few more
 * files; under-estimating would let a data change in the warmup go unnoticed by the run cache.
 */
export function warmupBarsEstimate(sources: string[], params: Record<string, string> = {}): number {
  let max = 200;
  const look = (text: string) => { for (const m of scrub(text).matchAll(/(?<![\w.])(\d{1,6})(?![\w.])/g)) max = Math.max(max, +m[1]!); };
  for (const s of sources) look(s.split(/\r?\n/).map((l) => (/^\s*--/.test(l) ? "" : l)).join("\n"));
  for (const v of Object.values(params)) look(v);
  return max;
}

const tfMsOr = (tf: string) => tfMs(tf) ?? Number.MAX_SAFE_INTEGER;

/**
 * The bar folder qkt reads for a symbol in a bars run (BacktestContext.resolveBarReplay): of the timeframes built for it, the
 * coarsest one that divides the symbol's FINEST declared timeframe. Every declared stream of that symbol is aggregated from
 * it, so a 1h stream runs on 15m bars when no 1h bars are built. Folders qkt cannot read (not its canonical name) never count.
 */
export function barBaseTf(built: readonly string[], finestDeclared: string): string | null {
  const want = tfMsOr(finestDeclared);
  let best: string | null = null;
  for (const tf of built) {
    if (canonicalTf(tf) !== tf) continue;
    const ms = tfMsOr(tf);
    if (want % ms === 0 && (best === null || ms > tfMsOr(best))) best = tf;
  }
  return best;
}

/** For each `broker:symbol` of these streams, the folder qkt reads in a bars run (null: nothing usable is built). */
export function barBases(streams: ReadonlyArray<{ broker: string; symbol: string; tf: string }>, builtOf: (broker: string, symbol: string) => readonly string[]): Map<string, string | null> {
  const finest = new Map<string, string>();
  for (const s of streams) {
    const k = `${s.broker}:${s.symbol}`, cur = finest.get(k);
    if (!cur || tfMsOr(s.tf) < tfMsOr(cur)) finest.set(k, s.tf);
  }
  const out = new Map<string, string | null>();
  for (const [k, tf] of finest) { const [broker, ...rest] = k.split(":"); out.set(k, barBaseTf(builtOf(broker!, rest.join(":")), tf)); }
  return out;
}

export type StreamPick = { ranges: DayRange[] } | { blocked: string; fix: "build-bars" | "fetch" };

/** Which bars each stream of `group` is run on, the way qkt resolves them in a bars run: per symbol the base folder from
 *  [barBases] over the folders qkt can read, with the base folder's usable days, or why the stream cannot run. */
export function barsPicker(group: readonly StreamDecl[], symOf: (symbol: string) => SymbolReport | undefined): (s: StreamDecl) => StreamPick {
  const readable = (broker: string, symbol: string) => symOf(symbol)?.bars.filter((b) => b.broker === broker && b.files > 0 && !b.qktReads) ?? [];
  const bases = barBases(group, (broker, symbol) => readable(broker, symbol).map((b) => b.tf));
  const finest = new Map<string, string>();
  for (const s of group) { const k = `${s.broker}:${s.symbol}`, cur = finest.get(k); if (!cur || tfMsOr(s.tf) < tfMsOr(cur)) finest.set(k, s.tf); }
  return (s) => {
    const sym = symOf(s.symbol);
    if (!sym) return { blocked: "symbol is not in the data source", fix: "fetch" };
    const k = `${s.broker}:${s.symbol}`, base = bases.get(k), want = finest.get(k) ?? s.tf;
    const tf = base ? readable(s.broker, s.symbol).find((b) => b.tf === base) : undefined;
    if (tf) return { ranges: tf.usable };
    const misnamed = sym.bars.find((b) => b.broker === s.broker && b.qktReads === want && b.files > 0);
    if (misnamed) return { blocked: `the ${want} bars are in a folder named "${misnamed.tf}", which qkt does not read: rename it to ${want}`, fix: "build-bars" };
    return sym.ticks
      ? { blocked: `no bars qkt can use for ${want} on ${s.broker}: build ${want} (or a finer timeframe that divides it)`, fix: "build-bars" }
      : { blocked: `no bars qkt can use for ${want} on ${s.broker}`, fix: "fetch" };
  };
}

/** Read the declarative headers of a .qkt file: what it trades, what it can be tuned by, what it imports. */
export function parseStrategyInfo(source: string): StrategyInfo {
  const info: StrategyInfo = { kind: "unknown", streams: [], params: [], imports: [] };
  let inSymbols = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = scrub(raw);
    if (info.kind === "unknown") {
      const h = /^(STRATEGY|PORTFOLIO)\s+(\w+)/.exec(line);
      if (h) { info.kind = h[1] === "STRATEGY" ? "strategy" : "portfolio"; info.name = h[2]; continue; }
    }
    if (/^SYMBOLS\b/.test(line)) { inSymbols = true; continue; }
    if (inSymbols) {
      if (line.trim() === "") continue;
      if (!/^\s/.test(line)) inSymbols = false;
      else {
        const m = STREAM.exec(line);
        // tf as qkt resolves it (EVERY 60m reads the 1h bars), so data checks and cache keys look where qkt looks
        if (m) info.streams.push({ alias: m[1]!, broker: m[2]!, symbol: m[3]!, tf: canonicalTf(m[4]!) ?? m[4]!, warmupBars: m[5] ? +m[5] : undefined });
        continue;
      }
    }
    const p = /^PARAM\s+(\w+)\s*=\s*(.*?)\s*$/.exec(line);
    if (p) { info.params.push({ name: p[1]!, default: p[2]! }); continue; }
    // IMPORT paths are quoted, and scrub() blanks string literals, so read this one from the raw line.
    const i = /^IMPORT\s+['"]([^'"]+)['"]\s+AS\s+(\w+)(\s+HOLD\b)?/.exec(raw);
    if (i) info.imports.push({ path: i[1]!, alias: i[2]!, ...(i[3] ? { hold: true } : {}) });
  }
  return info;
}

/** Streams may repeat across aliases; return each (broker, symbol, tf) once. */
export function uniqueStreams(streams: StreamDecl[]): StreamDecl[] {
  const seen = new Set<string>();
  return streams.filter((s) => { const k = `${s.broker}:${s.symbol}:${s.tf}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * True when the strategy places orders whose fill depends on intrabar price movement (stops, targets, brackets,
 * trailing or limit orders). Draft (`--bars`) approximates those fills, so its numbers can differ from Full [probed].
 */
export function usesIntrabarOrders(source: string): boolean {
  for (const raw of source.split(/\r?\n/)) {
    const line = scrub(raw);
    if (/\b(STOP_LOSS|TAKE_PROFIT|BRACKET|TRAILING|STOP_LIMIT)\b/.test(line) || /\bORDER_TYPE\s*=\s*(STOP|LIMIT|STOP_LIMIT|TRAILING)\b/.test(line)) return true;
  }
  return false;
}

/** Engine strategy id of a portfolio child is `<portfolio>:<alias>`; the alias is what people call it. */
export const strategyAlias = (id: string): string => { const i = id.indexOf(":"); return i >= 0 ? id.slice(i + 1) : id; };

/** `RUN <alias>` targets in a portfolio's rules. */
export function portfolioRuns(source: string): string[] {
  const out: string[] = [];
  for (const raw of source.split(/\r?\n/)) { const m = /\bRUN\s+([A-Za-z_]\w*)/.exec(scrub(raw)); if (m && !out.includes(m[1]!)) out.push(m[1]!); }
  return out;
}
