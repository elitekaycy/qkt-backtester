import { promises as fs } from "node:fs";
import path from "node:path";
import {
  integrity, loadResult, monthlyPnl, pairRoundTrips, parseTradesFile, readBars, summarize, verifyManifest,
  type BarCols, type IntegrityReport, type RunJson, type Summary,
} from "@qkt-studio/core";

export const STUDIO_VERSION = "0.1.0";
/** Above this many fills the round-trip file is too large to page from memory. */
export const MAX_FILLS = 2_000_000;

export class PostprocessError extends Error {}

export interface StreamRef { key: string; broker: string; symbol: string; tf: string }

/** `BACKTEST:XAUUSD:15m` -> parts. The symbol may itself contain dots or dashes but never a colon. */
export function parseStreamKey(key: string): StreamRef | null {
  const first = key.indexOf(":"), last = key.lastIndexOf(":");
  if (first <= 0 || last <= first) return null;
  return { key, broker: key.slice(0, first), symbol: key.slice(first + 1, last), tf: key.slice(last + 1) };
}

export interface EquitySeries { ts: number[]; equity: number[]; drawdown: number[] }

/** Min/max-preserving downsample so spikes and troughs survive. */
export function downsampleEquity(ts: number[], eq: number[], maxPoints = 4000): EquitySeries {
  const n = ts.length;
  const dd = new Array<number>(n);
  let peak = -Infinity;
  for (let i = 0; i < n; i++) { peak = Math.max(peak, eq[i]!); dd[i] = peak > 0 ? (eq[i]! - peak) / peak : 0; }
  if (n <= maxPoints) return { ts, equity: eq, drawdown: dd };
  const buckets = Math.floor(maxPoints / 2), size = n / buckets;
  const keep = new Set<number>([0, n - 1]);
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size), e = Math.min(n, Math.floor((b + 1) * size));
    let lo = s, hi = s;
    for (let i = s; i < e; i++) { if (eq[i]! < eq[lo]!) lo = i; if (eq[i]! > eq[hi]!) hi = i; }
    keep.add(lo); keep.add(hi);
  }
  const idx = [...keep].sort((a, b) => a - b);
  return { ts: idx.map((i) => ts[i]!), equity: idx.map((i) => eq[i]!), drawdown: idx.map((i) => dd[i]!) };
}

async function readEquity(file: string): Promise<{ ts: number[]; eq: number[] }> {
  const text = await fs.readFile(file, "utf8");
  const ts: number[] = [], eq: number[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l) continue;
    const c = l.indexOf(",");
    ts.push(Number(l.slice(0, c))); eq.push(Number(l.slice(c + 1)));
  }
  return { ts, eq };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1]! : 0; };

export interface PostprocessResult { summary: Summary; integrity: IntegrityReport; fills: number; trips: number; warnings: string[] }

export async function postprocess(args: { runDir: string; run: RunJson; dataRoot: string }): Promise<PostprocessResult> {
  const { runDir, run, dataRoot } = args;
  const engineDir = path.join(runDir, "engine"), derivedDir = path.join(runDir, "derived");
  await fs.mkdir(derivedDir, { recursive: true });
  const warnings: string[] = [];

  const result = loadResult(JSON.parse(await fs.readFile(path.join(engineDir, "result.json"), "utf8")));

  const st = await fs.stat(path.join(engineDir, "trades.csv"));
  if (st.size > 1.5 * 1024 * 1024 * 1024) throw new PostprocessError(`trades.csv is ${(st.size / 1e9).toFixed(1)} GB, too large for the studio`);
  const fills = await parseTradesFile(path.join(engineDir, "trades.csv"));
  if (fills.length > MAX_FILLS) throw new PostprocessError(`${fills.length.toLocaleString()} fills exceeds the studio limit of ${MAX_FILLS.toLocaleString()}`);
  const trips = pairRoundTrips(fills);
  if (fills.length === 0) warnings.push("The strategy produced no trades in this window. Check the rule conditions and the data range.");

  // Chart-side evidence: bars for every stream the engine evaluated.
  const fromMs = Date.parse(run.from + "T00:00:00Z"), toMs = Date.parse(run.to + "T00:00:00Z");
  const streams = Object.keys(result.inputSummary.streamCandles ?? {}).map(parseStreamKey).filter((s): s is StreamRef => s !== null);
  const barCounts: Record<string, number> = {};
  const bars: Record<string, BarCols> = {};
  const streamNotes: string[] = [];
  for (const s of streams) {
    const r = await readBars(dataRoot, s.broker, s.symbol, s.tf, fromMs, toMs);
    if (r.days.length === 0) { streamNotes.push(`${s.key}: no bar files in the store, chart checks skipped`); continue; }
    bars[s.key] = r.cols;
    if (r.missingDays.length === 0) barCounts[s.key] = r.cols.ts.length;
    else streamNotes.push(`${s.key}: ${r.missingDays.length} day file(s) absent, bar-count check skipped`);
  }
  const allCloses = Object.values(bars).flatMap((b) => Array.from(b.close.subarray(0, 2000)));
  const priceTol = run.tier === "full" ? 0.0005 * median(allCloses) : 0;

  const manifest = await verifyManifest(engineDir);
  const rep = integrity({
    result, trips, fills,
    barCounts: Object.keys(barCounts).length ? barCounts : undefined,
    bars: Object.keys(bars).length ? bars : undefined,
    priceTol, manifest,
  });
  if (streamNotes.length) rep.checks.push({ id: "streams", label: "Bar store coverage", ok: null, detail: streamNotes.join("; ") });

  const summary = summarize(result, trips);
  const eqRaw = await readEquity(path.join(engineDir, "equity_global.csv")).catch(() => ({ ts: [] as number[], eq: [] as number[] }));
  const equity = downsampleEquity(eqRaw.ts, eqRaw.eq);

  const write = (name: string, v: unknown) => fs.writeFile(path.join(derivedDir, name), JSON.stringify(v));
  await Promise.all([
    write("roundtrips.json", trips),
    write("summary.json", summary),
    write("monthly.json", monthlyPnl(trips)),
    write("integrity.json", rep),
    write("equity.json", equity),
    write("meta.json", {
      runId: run.id, tier: run.tier, from: run.from, to: run.to, streams, strategies: Object.keys(result.perStrategy),
      fills: fills.length, trips: trips.length, qktVersion: result.evidence.qktVersion, studioVersion: STUDIO_VERSION,
      monteCarloEngine: result.global.monteCarlo ?? null,
    }),
  ]);
  return { summary, integrity: rep, fills: fills.length, trips: trips.length, warnings };
}
