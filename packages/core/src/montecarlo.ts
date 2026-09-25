/** Trade-list Monte Carlo. The engine's built-in one is fixed (1000 sims, seed 42, bootstrap only). */

export type McMethod = "shuffle" | "bootstrap" | "block" | "skip";

export interface McOptions {
  method: McMethod;
  sims: number;
  seed: number;
  startEquity: number;
  /** block bootstrap: consecutive trades per block (default round(sqrt(n))). */
  blockLen?: number;
  /** skip method: probability a trade is not taken, 0..1 (default 0.1). */
  skipPct?: number;
  /** A path is "ruined" if its max drawdown reaches this fraction (default 0.5). */
  ruinDrawdown?: number;
}

export interface Quantiles { p5: number; p25: number; p50: number; p75: number; p95: number }

export interface McResult {
  method: McMethod;
  seed: number;
  sims: number;
  trades: number;
  startEquity: number;
  /** Equity percentile bands at `fanIndex` positions (trade counts), for the fan chart. */
  fanIndex: number[];
  fan: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  finalEquity: Quantiles;
  /** Max drawdown as a positive fraction of peak equity. */
  maxDrawdown: Quantiles;
  probNegative: number;
  probRuin: number;
  ruinDrawdown: number;
  observed: { finalEquity: number; maxDrawdown: number };
  /** Histogram of max drawdown across paths for the distribution chart. */
  drawdownHistogram: { edges: number[]; counts: number[] };
}

export const MC_MIN_TRADES = 30;
export const MC_MAX_SIMS = 100_000;
const FAN_POINTS = 200;

export class TooFewTrades extends Error {
  constructor(public readonly have: number) { super(`Monte Carlo needs at least ${MC_MIN_TRADES} closed trades (have ${have})`); }
}

/** Small, fast, seedable PRNG (mulberry32). Same seed => same stream on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: Float64Array, q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
const quants = (sorted: Float64Array): Quantiles => ({
  p5: quantile(sorted, 0.05), p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), p95: quantile(sorted, 0.95),
});

function maxDrawdown(path: ArrayLike<number>): number {
  let peak = path[0]!, dd = 0;
  for (let i = 1; i < path.length; i++) {
    const v = path[i]!;
    if (v > peak) peak = v;
    else if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

function fanIndices(n: number): number[] {
  if (n + 1 <= FAN_POINTS) return Array.from({ length: n + 1 }, (_, i) => i);
  const out = new Set<number>([0, n]);
  for (let i = 0; i < FAN_POINTS; i++) out.add(Math.round((i * n) / (FAN_POINTS - 1)));
  return [...out].sort((a, b) => a - b);
}

export function runMonteCarlo(pnls: number[], opt: McOptions): McResult {
  const n = pnls.length;
  if (n < MC_MIN_TRADES) throw new TooFewTrades(n);
  if (!Number.isInteger(opt.sims) || opt.sims < 1 || opt.sims > MC_MAX_SIMS) throw new RangeError(`sims must be an integer in 1..${MC_MAX_SIMS}`);
  if (opt.method === "skip" && opt.skipPct !== undefined && (opt.skipPct < 0 || opt.skipPct > 1)) throw new RangeError("skipPct must be within 0..1");
  const rnd = mulberry32(opt.seed);
  const blockLen = Math.max(1, Math.min(n, opt.blockLen ?? Math.round(Math.sqrt(n))));
  const skipPct = opt.skipPct ?? 0.1;
  const ruin = opt.ruinDrawdown ?? 0.5;
  const idx = fanIndices(n);

  const seq = new Float64Array(n);
  const path = new Float64Array(n + 1);
  const finals = new Float64Array(opt.sims);
  const dds = new Float64Array(opt.sims);
  const fanVals = idx.map(() => new Float64Array(opt.sims));
  let neg = 0, ruined = 0;

  for (let s = 0; s < opt.sims; s++) {
    switch (opt.method) {
      case "shuffle": {
        seq.set(pnls);
        for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = seq[i]!; seq[i] = seq[j]!; seq[j] = t; }
        break;
      }
      case "bootstrap":
        for (let i = 0; i < n; i++) seq[i] = pnls[Math.floor(rnd() * n)]!;
        break;
      case "block": {
        let i = 0;
        while (i < n) {
          const start = Math.floor(rnd() * n);
          for (let k = 0; k < blockLen && i < n; k++, i++) seq[i] = pnls[(start + k) % n]!;
        }
        break;
      }
      case "skip":
        for (let i = 0; i < n; i++) seq[i] = rnd() < skipPct ? 0 : pnls[i]!;
        break;
    }
    path[0] = opt.startEquity;
    for (let i = 0; i < n; i++) path[i + 1] = path[i]! + seq[i]!;
    finals[s] = path[n]!;
    const dd = maxDrawdown(path);
    dds[s] = dd;
    if (path[n]! < opt.startEquity) neg++;
    if (dd >= ruin) ruined++;
    for (let k = 0; k < idx.length; k++) fanVals[k]![s] = path[idx[k]!]!;
  }

  const band = (q: number) => fanVals.map((col) => { col.sort(); return quantile(col, q); });
  const fan = { p5: band(0.05), p25: band(0.25), p50: band(0.5), p75: band(0.75), p95: band(0.95) };
  finals.sort(); const ddSorted = Float64Array.from(dds).sort();

  const obsPath = [opt.startEquity];
  for (const p of pnls) obsPath.push(obsPath[obsPath.length - 1]! + p);

  const bins = 20, top = Math.max(ddSorted[ddSorted.length - 1]!, 1e-9);
  const edges = Array.from({ length: bins + 1 }, (_, i) => (top * i) / bins);
  const counts = new Array<number>(bins).fill(0);
  for (const d of dds) counts[Math.min(bins - 1, Math.floor((d / top) * bins))]!++;

  return {
    method: opt.method, seed: opt.seed, sims: opt.sims, trades: n, startEquity: opt.startEquity, fanIndex: idx, fan,
    finalEquity: quants(finals), maxDrawdown: quants(ddSorted), probNegative: neg / opt.sims, probRuin: ruined / opt.sims,
    ruinDrawdown: ruin, observed: { finalEquity: obsPath[n]!, maxDrawdown: maxDrawdown(obsPath) },
    drawdownHistogram: { edges, counts },
  };
}
