import type { RoundTrip } from "./roundtrips.js";

/** Bars a trade is judged on: open times ascending, with highs and lows. */
export interface PathBars { ts: ArrayLike<number>; high: ArrayLike<number>; low: ArrayLike<number> }
export interface Dist { p25: number; median: number; p75: number }
export interface ExitDiagnosis {
  trades: number;
  exits: Record<"stop" | "target" | "signal" | "open", number>;
  bracket: { medianStop: number | null; medianTarget: number | null };
  mfe: Dist; mae: Dist; mfeR: Dist | null; barsToExit: Dist;
  whatIf: Array<{ stop: number; target: number; targetFirst: number; stopFirst: number; open: number; netPoints: number; expectancyR: number | null }>;
  note: string;
}

const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!; };
const dist = (xs: number[]): Dist => ({ p25: round(q(xs, 0.25)), median: round(q(xs, 0.5)), p75: round(q(xs, 0.75)) });
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const median = (xs: number[]) => (xs.length ? round(q(xs, 0.5)) : null);

/** First bar index at or after `ts` (bars are open times, ascending). */
function firstAtOrAfter(b: PathBars, ts: number): number { let i = 0; while (i < b.ts.length && b.ts[i]! < ts) i++; return i; }
/** The bar that contains `ts`: the last bar opening at or before it. */
function barOf(b: PathBars, ts: number): number { let i = firstAtOrAfter(b, ts); if (i >= b.ts.length || b.ts[i]! > ts) i--; return i; }

/** Maximum favourable / adverse price move from the entry, over the entry bar through the exit bar. */
export function excursion(t: RoundTrip, bars: PathBars): { mfe: number; mae: number; bars: number } | null {
  const a = barOf(bars, t.entryTs), z = t.exitTs === null ? bars.ts.length - 1 : barOf(bars, t.exitTs);
  if (a < 0 || z < a || bars.ts[a]! > t.entryTs || t.entryTs > bars.ts[bars.ts.length - 1]! || (t.exitTs !== null && t.exitTs - bars.ts[a]! > 400 * 86_400_000)) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = a; i <= z; i++) { hi = Math.max(hi, bars.high[i]!); lo = Math.min(lo, bars.low[i]!); }
  const long = t.side === "long";
  return { mfe: round(Math.max(0, long ? hi - t.entryPx : t.entryPx - lo)), mae: round(Math.max(0, long ? t.entryPx - lo : hi - t.entryPx)), bars: z - a + 1 };
}

/** Which of a stop / target (price distances from entry) is touched first on the bars after the entry bar. */
export function whatIf(t: RoundTrip, bars: PathBars, stop: number, target: number, horizonBars: number): "target" | "stop" | "open" {
  const a = barOf(bars, t.entryTs);
  if (a < 0) return "open";
  const long = t.side === "long";
  const sl = long ? t.entryPx - stop : t.entryPx + stop, tp = long ? t.entryPx + target : t.entryPx - target;
  for (let i = a + 1; i < bars.ts.length && i <= a + horizonBars; i++) {
    const hitStop = long ? bars.low[i]! <= sl : bars.high[i]! >= sl;
    const hitTarget = long ? bars.high[i]! >= tp : bars.low[i]! <= tp;
    if (hitStop) return "stop";         // a bar touching both: the stop, as a conservative guess
    if (hitTarget) return "target";
  }
  return "open";
}

/**
 * How the trades ended and what other stop/target distances would have done. Distances are in the symbol's price units.
 * The grid defaults to multiples of the median stop distance the trades carried.
 */
export function diagnoseExits(trips: RoundTrip[], barsOf: (t: RoundTrip) => PathBars | null, grid?: { stops: number[]; targets: number[] }): ExitDiagnosis {
  const closed = trips.filter((t) => !t.open);
  const exits = { stop: 0, target: 0, signal: 0, open: 0 };
  for (const t of trips) exits[t.exit]++;
  const stops = closed.filter((t) => t.sl !== undefined).map((t) => Math.abs(t.entryPx - t.sl!));
  const targets = closed.filter((t) => t.tp !== undefined).map((t) => Math.abs(t.tp! - t.entryPx));
  const mfe: number[] = [], mae: number[] = [], mfeR: number[] = [], held: number[] = [];
  const withBars: Array<{ t: RoundTrip; b: PathBars }> = [];
  for (const t of closed) {
    const b = barsOf(t);
    const e = b && excursion(t, b);
    if (!b || !e) continue;
    withBars.push({ t, b });
    mfe.push(e.mfe); mae.push(e.mae); held.push(e.bars);
    if (t.sl !== undefined && t.entryPx !== t.sl) mfeR.push(e.mfe / Math.abs(t.entryPx - t.sl));
  }
  const base = median(stops) ?? median(mae) ?? 0;
  const validateGrid = (gr?: { stops: number[]; targets: number[] }) => {
    if (!gr) return null;
    const s = gr.stops.filter((x) => Number.isFinite(x) && x > 0);
    const t = gr.targets.filter((x) => Number.isFinite(x) && x > 0);
    return s.length && t.length ? { stops: s, targets: t } : null;
  };
  const validated = validateGrid(grid);
  const g = validated ?? { stops: [0.5, 1, 1.5, 2].map((m) => round(base * m)).filter((x) => x > 0), targets: [0.5, 1, 1.5, 2, 3].map((m) => round(base * m)).filter((x) => x > 0) };
  const rows: ExitDiagnosis["whatIf"] = [];
  for (const stop of g.stops) for (const target of g.targets) {
    let tf = 0, sf = 0, op = 0;
    for (const { t, b } of withBars) { const r = whatIf(t, b, stop, target, 2000); if (r === "target") tf++; else if (r === "stop") sf++; else op++; }
    const net = tf * target - sf * stop, n = tf + sf;
    rows.push({ stop, target, targetFirst: tf, stopFirst: sf, open: op, netPoints: round(net), expectancyR: n ? round(net / n / stop) : null });
  }
  rows.sort((x, y) => y.netPoints - x.netPoints);
  return {
    trades: trips.length, exits, bracket: { medianStop: median(stops), medianTarget: median(targets) },
    mfe: dist(mfe), mae: dist(mae), mfeR: mfeR.length ? dist(mfeR) : null, barsToExit: dist(held), whatIf: rows.slice(0, 12),
    note: `what-if is an estimate on bars for ${withBars.length} of ${closed.length} closed trades (a bar touching both levels counts as the stop); confirm with try_change`,
  };
}
