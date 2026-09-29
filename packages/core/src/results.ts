import { maxOf, minOf } from "./stats.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BarCols } from "./bars.js";
import { PNL_TOL, reconcile, type Fill, type RoundTrip } from "./roundtrips.js";

export class UnsupportedResultError extends Error {}

/** The subset of qkt's `qkt-backtest-result-v1` the studio reads. Numbers arrive as decimal strings. */
export interface QktResult {
  schema: string;
  schemaVersion: number;
  cadence?: string;
  inputSummary: {
    liveCandles?: number; warmupCandles?: number; liveTicks?: number; attemptedFeedTicks?: number;
    streamCandles?: Record<string, number>;
  };
  evidence: { qktVersion: string; gitSha?: string; command?: string[]; strategyHash?: string; configHash?: string; warnings?: string[] };
  global: PerfReport;
  perStrategy: Record<string, PerfReport>;
  tradeSummary?: Record<string, unknown>;
  /** Present on portfolio runs only. */
  bookAnalytics?: {
    contributionToReturn?: Record<string, string>; riskContribution?: Record<string, string>; drawdownContribution?: Record<string, string>;
    returnCorrelation?: Array<{ a: string; b: string; correlation: string }>;
  };
  bookRisk?: { bookVol?: string; maxGrossExposure?: string; maxNetExposure?: string; samples?: number; events?: number };
  artifacts?: Record<string, unknown>;
  /** The currency every money figure is in (config `account.currency`, default USD). */
  accounting?: { accountCurrency?: string };
}

export interface PerfReport {
  realizedTotal: string; unrealizedTotal: string; totalPnL: string; commissionPaid: string; swapPaid: string;
  tradeCount: number; winRate: string; maxDrawdown: string; profitFactor: string; avgWin: string; avgLoss: string;
  largestWin: string; largestLoss: string; maxConsecutiveLosses: number; sharpeRatio: string; calmarRatio: string;
  sortinoRatio: string; turnover?: string; maxDailyDrawdown?: string;
  dailyPnL?: Record<string, string>;
  drawdownPeriods?: Array<Record<string, unknown>>;
  monteCarlo?: Record<string, string | number | number[]> | null;
  equityCurve?: unknown[];
}

const SUPPORTED_SCHEMA = "qkt-backtest-result-v1";

/** Refuse anything we have not been built against: a silent misread is worse than an error. */
export function loadResult(json: unknown): QktResult {
  const r = json as Partial<QktResult> | null;
  if (!r || typeof r !== "object") throw new UnsupportedResultError("result.json is not an object");
  if (r.schema !== SUPPORTED_SCHEMA) throw new UnsupportedResultError(`unsupported result schema '${String(r.schema)}' (expected ${SUPPORTED_SCHEMA})`);
  if (r.schemaVersion !== 1) throw new UnsupportedResultError(`unsupported result schemaVersion ${String(r.schemaVersion)} (expected 1)`);
  if (!r.global || !r.inputSummary || !r.evidence) throw new UnsupportedResultError("result.json is missing global/inputSummary/evidence");
  return r as QktResult;
}

const n = (s: string | number | undefined | null) => (s === undefined || s === null || s === "" ? 0 : Number(s));

export interface Summary {
  realized: number; unrealized: number; totalPnl: number; commission: number; swap: number;
  /** Engine `tradeCount`: this counts FILLS, not round trips. */
  fills: number;
  /** Closed round trips (what users mean by "trades"). */
  trades: number; openTrades: number;
  wins: number; losses: number; winRate: number;
  profitFactor: number | null; expectancy: number; avgWin: number; avgLoss: number;
  largestWin: number; largestLoss: number; avgHoldMs: number | null;
  /** Longest run of losing round trips, by exit time (the journal's streak). */
  maxConsecutiveLosses: number;
  /** qkt's own count, per closing fill: differs from the trip count when legs scale in or out. */
  engineMaxConsecutiveLosses: number;
  long: { trades: number; pnl: number; winRate: number }; short: { trades: number; pnl: number; winRate: number };
  /**
   * Null when the account was blown (equity reached zero or below, a drawdown of 100% or more): returns on a negative
   * balance flip sign, so qkt's ratios can read positive for the worst runs. `engineRatios` keeps qkt's values.
   */
  sharpe: number | null; sortino: number | null; calmar: number | null; maxDrawdown: number; maxDailyDrawdown: number;
  /** Equity reached zero or below at some point in the run. */
  blown: boolean;
  engineRatios: { sharpe: number; sortino: number; calmar: number };
  engineWinRate: number; engineProfitFactor: number;
}

export function summarize(result: QktResult, trips: RoundTrip[]): Summary {
  const g = result.global;
  const closed = trips.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = losses.reduce((a, t) => a + t.pnl, 0);
  const side = (s: "long" | "short") => {
    const c = closed.filter((t) => t.side === s);
    return { trades: c.length, pnl: c.reduce((a, t) => a + t.pnl, 0), winRate: c.length ? c.filter((t) => t.pnl > 0).length / c.length : 0 };
  };
  const holds = closed.map((t) => t.holdMs).filter((h): h is number => h !== null);
  return {
    realized: n(g.realizedTotal), unrealized: n(g.unrealizedTotal), totalPnl: n(g.totalPnL), commission: n(g.commissionPaid), swap: n(g.swapPaid),
    fills: g.tradeCount, trades: closed.length, openTrades: trips.length - closed.length,
    wins: wins.length, losses: losses.length, winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: gl < 0 ? gw / -gl : null,
    expectancy: closed.length ? closed.reduce((a, t) => a + t.pnl, 0) / closed.length : 0,
    avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? gl / losses.length : 0,
    largestWin: maxOf(closed.map((t) => t.pnl), 0),
    largestLoss: minOf(closed.map((t) => t.pnl), 0),
    avgHoldMs: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    maxConsecutiveLosses: lossStreak(closed), engineMaxConsecutiveLosses: g.maxConsecutiveLosses,
    long: side("long"), short: side("short"),
    sharpe: n(g.maxDrawdown) >= 1 ? null : n(g.sharpeRatio), sortino: n(g.maxDrawdown) >= 1 ? null : n(g.sortinoRatio), calmar: n(g.maxDrawdown) >= 1 ? null : n(g.calmarRatio),
    blown: n(g.maxDrawdown) >= 1, engineRatios: { sharpe: n(g.sharpeRatio), sortino: n(g.sortinoRatio), calmar: n(g.calmarRatio) },
    maxDrawdown: n(g.maxDrawdown), maxDailyDrawdown: n(g.maxDailyDrawdown),
    engineWinRate: n(g.winRate), engineProfitFactor: n(g.profitFactor),
  };
}

/** Longest run of consecutive losing trips in exit order (a breakeven trip ends a run, as in the journal). */
function lossStreak(closed: RoundTrip[]): number {
  let run = 0, max = 0;
  for (const t of [...closed].sort((a, b) => (a.exitTs ?? 0) - (b.exitTs ?? 0))) { run = t.pnl < 0 ? run + 1 : 0; if (run > max) max = run; }
  return max;
}

export interface MonthRow { month: string; pnl: number; trades: number }

/** Realised P&L per UTC month of the EXIT, closed trips only. */
export function monthlyPnl(trips: RoundTrip[]): MonthRow[] {
  const m = new Map<string, MonthRow>();
  for (const t of trips) {
    if (t.open || t.exitTs === null) continue;
    const key = new Date(t.exitTs).toISOString().slice(0, 7);
    const row = m.get(key) ?? { month: key, pnl: 0, trades: 0 };
    row.pnl += t.pnl; row.trades++;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** `soft`: a failure that is expected for this run type (Draft bar-approximated fills) and must not fail the report. */
export interface IntegrityCheck { id: string; label: string; ok: boolean | null; detail: string; soft?: boolean }
export interface IntegrityReport { ok: boolean; checks: IntegrityCheck[] }

export interface IntegrityInput {
  result: QktResult;
  trips: RoundTrip[];
  fills: Fill[];
  /** Studio-side bar count per engine stream key (`BACKTEST:XAUUSD:15m`) for the run window [from,to). */
  barCounts?: Record<string, number>;
  /** Bars per `${symbol}:${tf}` for the fill-inside-bar check. */
  bars?: Record<string, BarCols>;
  /** Extra price tolerance (e.g. spread) for the fill-inside-bar check. */
  priceTol?: number;
  /** Draft (bars) approximates intrabar stop/target fills, so a fill outside its bar is expected there. */
  softFillsInBars?: boolean;
  manifest?: { ok: boolean; detail: string };
}

function barIndex(b: BarCols, t: number): number {
  let lo = 0, hi = b.ts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (b.ts[mid]! <= t) lo = mid + 1; else hi = mid - 1;
  }
  const i = hi;
  return i >= 0 && t < b.ts[i]! + b.tfMs ? i : -1;
}

export function integrity(inp: IntegrityInput): IntegrityReport {
  const checks: IntegrityCheck[] = [];

  const rec = reconcile(inp.trips, n(inp.result.global.realizedTotal));
  checks.push({
    id: "reconcile", label: "Trades reconcile with engine P&L", ok: rec.ok,
    detail: `Σ round-trip P&L ${rec.sum.toFixed(4)} vs engine realized ${n(inp.result.global.realizedTotal).toFixed(4)} (diff ${rec.diff.toFixed(6)}, tol ${PNL_TOL})`,
  });

  if (inp.barCounts) {
    const eng = inp.result.inputSummary.streamCandles ?? {};
    const bad = Object.entries(inp.barCounts).filter(([k, v]) => eng[k] !== v).map(([k, v]) => `${k}: chart ${v} vs engine ${eng[k] ?? "n/a"}`);
    checks.push({
      id: "barCount", label: "Chart bars match engine candles", ok: bad.length === 0,
      detail: bad.length ? bad.join("; ") : Object.entries(inp.barCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "no streams",
    });
  } else checks.push({ id: "barCount", label: "Chart bars match engine candles", ok: null, detail: "not evaluated (no bars loaded)" });

  if (inp.bars) {
    let inside = 0, outside = 0, noBar = 0, maxExc = 0;
    const tol = (inp.priceTol ?? 0) + 1e-9;
    for (const f of inp.fills) {
      const bars = Object.entries(inp.bars).find(([k]) => k.startsWith(`${f.symbol}:`))?.[1];
      if (!bars) { noBar++; continue; }
      const i = barIndex(bars, f.ts);
      if (i < 0) { noBar++; continue; }
      if (f.price >= bars.low[i]! - tol && f.price <= bars.high[i]! + tol) inside++;
      else { outside++; maxExc = Math.max(maxExc, f.price < bars.low[i]! ? bars.low[i]! - f.price : f.price - bars.high[i]!); }
    }
    const soft = outside > 0 && inp.softFillsInBars === true;
    checks.push({
      id: "fillsInBars", label: "Every fill lies inside its bar", ok: outside === 0,
      detail: `${inside} inside, ${outside} outside${outside ? ` (max excursion ${maxExc.toFixed(4)})` : ""}, ${noBar} without a bar${soft ? ". Expected in Draft mode: stop and target fills are approximated from bars. Run Full to verify." : ""}`,
      ...(soft ? { soft: true } : {}),
    });
  } else checks.push({ id: "fillsInBars", label: "Every fill lies inside its bar", ok: null, detail: "not evaluated (no bars loaded)" });

  checks.push(inp.manifest
    ? { id: "manifest", label: "Engine artifact checksums", ok: inp.manifest.ok, detail: inp.manifest.detail }
    : { id: "manifest", label: "Engine artifact checksums", ok: null, detail: "not evaluated" });

  return { ok: checks.every((c) => c.ok !== false || c.soft === true), checks };
}

/** Verify sha256/size of every artifact listed in the engine's manifest.json against the files on disk. */
export async function verifyManifest(engineDir: string): Promise<{ ok: boolean; detail: string }> {
  let manifest: { schema?: string; artifacts?: Array<{ path: string; sha256: string; bytes: number }> };
  try {
    manifest = JSON.parse(await fs.readFile(path.join(engineDir, "manifest.json"), "utf8"));
  } catch (e) {
    return { ok: false, detail: `cannot read manifest.json: ${(e as Error).message}` };
  }
  const arts = manifest.artifacts ?? [];
  const bad: string[] = [];
  for (const a of arts) {
    try {
      const buf = await fs.readFile(path.join(engineDir, a.path));
      const h = "sha256:" + createHash("sha256").update(buf).digest("hex");
      if (h !== a.sha256 || buf.length !== a.bytes) bad.push(a.path);
    } catch { bad.push(`${a.path} (missing)`); }
  }
  return bad.length ? { ok: false, detail: `mismatch: ${bad.join(", ")}` } : { ok: true, detail: `${arts.length} artifacts verified` };
}
