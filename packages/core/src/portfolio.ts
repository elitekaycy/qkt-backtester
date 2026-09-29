import { maxOf, minOf } from "./stats.js";
import type { PerfReport, QktResult } from "./results.js";
import type { RoundTrip } from "./roundtrips.js";
import { strategyAlias } from "./strategy.js";

const n = (s: string | number | undefined | null): number => (s === undefined || s === null || s === "" ? 0 : Number(s));

/** One strategy of a portfolio run (or the only strategy of a plain run), numbers already parsed. */
export interface StrategyRow {
  /** Engine id: `<portfolio>:<alias>` for a child. */
  id: string;
  alias: string;
  totalPnl: number; realized: number; unrealized: number; commission: number; swap: number;
  /** Engine fills (not round trips). */
  fills: number;
  /** Closed round trips, counted from the paired trips the whole studio uses. */
  trades: number; openTrades: number; wins: number; losses: number; winRate: number;
  profitFactor: number | null; avgWin: number; avgLoss: number; largestWin: number; largestLoss: number;
  maxDrawdown: number; maxDailyDrawdown: number; sharpe: number; sortino: number; calmar: number; maxConsecutiveLosses: number; turnover: number;
  firstTradeTs: number | null; lastTradeTs: number | null;
  /** Symbols this strategy traded. */
  symbols: string[];
  /** Share of the book's net P&L (may exceed 100% or be negative when strategies offset each other). */
  contribution: number | null;
  /** Engine attribution (fractions of the book's return, risk and drawdown), when the engine reported them. */
  returnContribution: number | null; riskContribution: number | null; drawdownContribution: number | null;
}

export interface BookInfo {
  bookVol: number | null; maxGrossExposure: number | null; maxNetExposure: number | null;
  samples: number | null; events: number | null;
  correlation: Array<{ a: string; b: string; correlation: number }>;
}

const perf = (p: PerfReport | undefined) => p ?? ({} as Partial<PerfReport>);

/** Per-strategy rows from the engine's `perStrategy` and the round trips. Empty when the engine reported none. */
export function strategyBreakdown(result: QktResult, trips: RoundTrip[]): StrategyRow[] {
  const ids = Object.keys(result.perStrategy ?? {});
  const bookTotal = n(result.global.totalPnL);
  const ba = result.bookAnalytics;
  return ids.map((id) => {
    const p = perf(result.perStrategy[id]);
    const mine = trips.filter((t) => t.strategy === id), closed = mine.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
    const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = losses.reduce((a, t) => a + t.pnl, 0);
    const opt = (m: Record<string, string> | undefined) => (m && m[id] !== undefined ? n(m[id]) : null);
    return {
      id, alias: strategyAlias(id),
      totalPnl: n(p.totalPnL), realized: n(p.realizedTotal), unrealized: n(p.unrealizedTotal), commission: n(p.commissionPaid), swap: n(p.swapPaid),
      fills: p.tradeCount ?? 0, trades: closed.length, openTrades: mine.length - closed.length, wins: wins.length, losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      profitFactor: gl < 0 ? gw / -gl : null, avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? gl / losses.length : 0,
      largestWin: maxOf(closed.map((t) => t.pnl), 0), largestLoss: minOf(closed.map((t) => t.pnl), 0),
      maxDrawdown: n(p.maxDrawdown), maxDailyDrawdown: n(p.maxDailyDrawdown), sharpe: n(p.sharpeRatio), sortino: n(p.sortinoRatio), calmar: n(p.calmarRatio),
      maxConsecutiveLosses: p.maxConsecutiveLosses ?? 0, turnover: n(p.turnover),
      firstTradeTs: mine.length ? minOf(mine.map((t) => t.entryTs)) : null,
      lastTradeTs: mine.length ? maxOf(mine.map((t) => t.exitTs ?? t.entryTs)) : null,
      symbols: [...new Set(mine.map((t) => t.symbol))],
      contribution: bookTotal !== 0 ? n(p.totalPnL) / bookTotal : null,
      returnContribution: opt(ba?.contributionToReturn), riskContribution: opt(ba?.riskContribution), drawdownContribution: opt(ba?.drawdownContribution),
    };
  });
}

/** The book-level numbers a portfolio run carries; null for a plain strategy. */
export function bookInfo(result: QktResult): BookInfo | null {
  const br = result.bookRisk, ba = result.bookAnalytics;
  if (!br && !ba) return null;
  const v = (x: string | number | undefined) => (x === undefined ? null : n(x));
  return {
    bookVol: v(br?.bookVol), maxGrossExposure: v(br?.maxGrossExposure), maxNetExposure: v(br?.maxNetExposure), samples: v(br?.samples), events: v(br?.events),
    correlation: (ba?.returnCorrelation ?? []).map((c) => ({ a: c.a, b: c.b, correlation: n(c.correlation) })),
  };
}

/** A run is a portfolio run when more than one strategy traded (or the engine says so through bookRisk). */
export const isPortfolioRun = (strategies: string[]): boolean => strategies.length > 1;
