import type { ExitReason, RoundTrip } from "./roundtrips.js";

export interface Bucket { pnl: number; trades: number; wins: number }
export interface Histogram { edges: number[]; counts: number[] }

export interface Analytics {
  /** All trades matched (open included) and how many of them are closed / still open. */
  count: number; closed: number; open: number;
  pnl: number; grossWin: number; grossLoss: number;
  wins: number; losses: number; breakeven: number; winRate: number;
  profitFactor: number | null; avgWin: number; avgLoss: number; payoff: number | null; expectancy: number;
  largestWin: number; largestLoss: number; avgHoldMs: number | null;
  maxWinStreak: number; maxLossStreak: number;
  /** R statistics over closed trades whose entry carried a stop. */
  rTrades: number; avgR: number | null; totalR: number | null;
  /** Running realised P&L by exit time (thinned to <= 600 points). */
  cumulative: { ts: number[]; pnl: number[] };
  /** By UTC exit day. */
  daily: Array<{ day: string } & Bucket>;
  monthly: Array<{ month: string; grossWin: number; grossLoss: number } & Bucket>;
  /** By UTC entry weekday (0 = Sunday) and entry hour. */
  weekday: Bucket[];
  hour: Bucket[];
  side: { long: Bucket; short: Bucket };
  exit: Array<{ reason: ExitReason } & Bucket>;
  hold: Array<{ label: string; minMs: number; maxMs: number } & Bucket>;
  pnlHistogram: Histogram;
  /** Distinct position sizes traded (at most 30, ascending): feeds the size: suggestions. */
  sizes: number[];
  rHistogram: Histogram | null;
}

const bucket = (): Bucket => ({ pnl: 0, trades: 0, wins: 0 });
const add = (b: Bucket, t: RoundTrip) => { b.pnl += t.pnl; b.trades++; if (t.pnl > 0) b.wins++; };
const H = 3_600_000;
const HOLD: Array<{ label: string; minMs: number; maxMs: number }> = [
  { label: "< 1h", minMs: 0, maxMs: H }, { label: "1-4h", minMs: H, maxMs: 4 * H }, { label: "4-24h", minMs: 4 * H, maxMs: 24 * H },
  { label: "1-3d", minMs: 24 * H, maxMs: 72 * H }, { label: "> 3d", minMs: 72 * H, maxMs: Infinity },
];

function histogram(values: number[], bins: number): Histogram {
  if (!values.length) return { edges: [], counts: [] };
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const w = (hi - lo) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * w);
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]!++;
  return { edges, counts };
}

/** Everything the journal shows, computed from a (possibly filtered) list of round trips. Closed trades only, except counts. */
export function analyze(trips: RoundTrip[]): Analytics {
  const closed = trips.filter((t) => !t.open && t.exitTs !== null);
  const byExit = [...closed].sort((a, b) => a.exitTs! - b.exitTs!);
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = losses.reduce((a, t) => a + t.pnl, 0);
  const pnl = closed.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;

  let win = 0, loss = 0, maxWin = 0, maxLoss = 0;
  for (const t of byExit) {
    if (t.pnl > 0) { win++; loss = 0; } else if (t.pnl < 0) { loss++; win = 0; } else { win = 0; loss = 0; }
    maxWin = Math.max(maxWin, win); maxLoss = Math.max(maxLoss, loss);
  }

  const withR = closed.filter((t) => t.r !== undefined);
  const holds = closed.map((t) => t.holdMs).filter((h): h is number => h !== null);

  // cumulative curve, thinned
  const step = Math.max(1, Math.ceil(byExit.length / 600));
  const cum = { ts: [] as number[], pnl: [] as number[] };
  let run = 0;
  byExit.forEach((t, i) => { run += t.pnl; if (i % step === 0 || i === byExit.length - 1) { cum.ts.push(t.exitTs!); cum.pnl.push(run); } });

  const daily = new Map<string, Bucket>(), monthly = new Map<string, { grossWin: number; grossLoss: number } & Bucket>();
  for (const t of byExit) {
    const iso = new Date(t.exitTs!).toISOString();
    const d = daily.get(iso.slice(0, 10)) ?? bucket(); add(d, t); daily.set(iso.slice(0, 10), d);
    const m = monthly.get(iso.slice(0, 7)) ?? { ...bucket(), grossWin: 0, grossLoss: 0 }; add(m, t);
    if (t.pnl > 0) m.grossWin += t.pnl; else if (t.pnl < 0) m.grossLoss += t.pnl;
    monthly.set(iso.slice(0, 7), m);
  }

  const weekday = Array.from({ length: 7 }, bucket), hour = Array.from({ length: 24 }, bucket);
  const side = { long: bucket(), short: bucket() };
  const exit = new Map<ExitReason, Bucket>();
  const hold = HOLD.map((h) => ({ ...h, ...bucket() }));
  for (const t of closed) {
    const d = new Date(t.entryTs);
    add(weekday[d.getUTCDay()]!, t); add(hour[d.getUTCHours()]!, t); add(side[t.side], t);
    const e = exit.get(t.exit) ?? bucket(); add(e, t); exit.set(t.exit, e);
    if (t.holdMs !== null) add(hold.find((h) => t.holdMs! >= h.minMs && t.holdMs! < h.maxMs) ?? hold[hold.length - 1]!, t);
  }

  return {
    count: trips.length, closed: closed.length, open: trips.length - closed.length,
    pnl, grossWin, grossLoss, wins: wins.length, losses: losses.length, breakeven: closed.length - wins.length - losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: grossLoss < 0 ? grossWin / -grossLoss : null, avgWin, avgLoss, payoff: avgLoss < 0 ? avgWin / -avgLoss : null,
    expectancy: closed.length ? pnl / closed.length : 0,
    largestWin: closed.length ? Math.max(0, ...closed.map((t) => t.pnl)) : 0, largestLoss: closed.length ? Math.min(0, ...closed.map((t) => t.pnl)) : 0,
    avgHoldMs: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    maxWinStreak: maxWin, maxLossStreak: maxLoss,
    rTrades: withR.length, avgR: withR.length ? withR.reduce((a, t) => a + t.r!, 0) / withR.length : null, totalR: withR.length ? withR.reduce((a, t) => a + t.r!, 0) : null,
    cumulative: cum,
    daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => ({ day, ...b })),
    monthly: [...monthly].sort(([a], [b]) => a.localeCompare(b)).map(([month, b]) => ({ month, ...b })),
    weekday, hour, side,
    exit: (["target", "stop", "signal"] as ExitReason[]).filter((r) => exit.has(r)).map((reason) => ({ reason, ...exit.get(reason)! })),
    hold,
    sizes: [...new Set(trips.map((t) => t.qty))].sort((a, b) => a - b).slice(0, 30),
    pnlHistogram: histogram(closed.map((t) => t.pnl), Math.min(20, Math.max(6, Math.ceil(Math.sqrt(closed.length))))),
    rHistogram: withR.length ? histogram(withR.map((t) => t.r!), Math.min(16, Math.max(6, Math.ceil(Math.sqrt(withR.length))))) : null,
  };
}
