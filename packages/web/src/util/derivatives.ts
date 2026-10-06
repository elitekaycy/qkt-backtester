import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { contextFromCatalog, fieldAllowed, kindOf, tierProblem, type CostBridge, type InstrumentKind, type KindContext, type MarginDay, type RollRow, type StructureRow } from "@qkt-studio/core";
import type { InstrumentsInfo } from "../api/client.js";

/** What the browser needs of `GET /api/instruments` to tell a future from a CFD: the same context the server's gate uses. */
export function kindContextFrom(info: InstrumentsInfo | null): KindContext {
  if (!info) return {};
  return contextFromCatalog(info.catalog, { futureRoots: info.futureRoots, perpetuals: info.perpetuals });
}

/** alias -> what its symbol names, for every stream a strategy declares. A source with no stream gives an empty map. */
export function streamKinds(source: string, ctx: KindContext): Map<string, InstrumentKind> {
  const out = new Map<string, InstrumentKind>();
  for (const s of parseStrategyInfo(source).streams) out.set(s.alias, kindOf({ broker: s.broker, symbol: s.symbol }, ctx));
  return out;
}

/** One declared stream with what it is, by the line it is declared on (1-based). A CFD is returned too: callers decide what to show. */
export interface KindMark { line: number; alias: string; broker: string; symbol: string; kind: InstrumentKind }
const DECL = /^\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z0-9_]+):([A-Za-z0-9_.@\-]+)\s+EVERY\b/;
export function kindMarks(source: string, ctx: KindContext): KindMark[] {
  const out: KindMark[] = [];
  let inSymbols = false;
  source.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.replace(/--.*$/, "");
    if (/^SYMBOLS\b/.test(l)) { inSymbols = true; return; }
    if (!inSymbols) return;
    if (l.trim() === "") return;
    if (!/^\s/.test(l)) { inSymbols = false; return; }
    const m = DECL.exec(l);
    if (m) out.push({ line: i + 1, alias: m[1]!, broker: m[2]!, symbol: m[3]!, kind: kindOf({ broker: m[2]!, symbol: m[3]! }, ctx) });
  });
  return out;
}

/**
 * The fields to offer after `alias.`: the vocabulary's own list narrowed to those the stream's kind has. A stream whose kind
 * is not known yet offers everything, so an unlucky load order never hides a field a user may legitimately read.
 */
export function fieldsFor(kind: InstrumentKind | undefined, vocabulary: readonly string[]): string[] {
  if (!kind) return [...vocabulary];
  return vocabulary.filter((f) => fieldAllowed(kind, f));
}

const SHORT: Record<InstrumentKind, string> = { cfd: "CFD", future: "Future", continuous: "Continuous", perpetual: "Perpetual", option: "Option", chain: "Chain", analytic: "Analytic", hub: "Hub" };
const LONG: Record<InstrumentKind, string> = {
  cfd: "A CFD", future: "A listed futures contract", continuous: "A continuous futures stream: follows the front (or next) contract and rolls on schedule",
  perpetual: "A perpetual future: never expires, pays funding", option: "An option contract", chain: "An options chain, read by OPEN ... = OPTIONS ON ...",
  analytic: "A read-only chain analytic (IV, skew)", hub: "A HUB record stream",
};
export const kindShort = (k: InstrumentKind) => SHORT[k];
export const kindTitle = (k: InstrumentKind) => LONG[k];
/** A CFD is the default and gets no chip: only a stream that is something else is called out. */
export const showKind = (k: InstrumentKind | undefined): k is InstrumentKind => !!k && k !== "cfd";

/** Why each data tier is refused for these streams (null: allowed). The tier control says this instead of letting a run be refused. */
export function tierRule(streams: ReadonlyArray<{ broker: string; symbol: string }>): { draft: string | null; full: string | null } {
  return { draft: tierProblem(streams, "draft"), full: tierProblem(streams, "full") };
}

/**
 * The tier a run should use: the one asked for, unless the streams refuse it and refuse only it (continuous futures have no ticks,
 * option chains no bars), in which case the other one, with the reason. Both refused returns the request unchanged: the server
 * names what to do.
 */
export function effectiveTier(requested: "draft" | "full", streams: ReadonlyArray<{ broker: string; symbol: string }>): { tier: "draft" | "full"; note: string | null } {
  const rule = tierRule(streams);
  const other = requested === "draft" ? "full" : "draft";
  if (rule[requested] && !rule[other]) return { tier: other, note: rule[requested] };
  return { tier: requested, note: null };
}

/** True when a strategy trades a perpetual, the only case the Funding option means anything. */
export function streamsPerpetual(source: string, ctx: KindContext): boolean {
  return [...streamKinds(source, ctx).values()].includes("perpetual");
}

// ---- results ------------------------------------------------------------------------------------------------------

export interface CostLine { key: "pnl" | "commission" | "swap" | "rollCosts" | "funding" | "preCost"; label: string; value: number; note?: string }

/**
 * The gross-to-net bridge as rows: net P&L, then each cost qkt booked, then the zero-cost P&L they sum to. A cost that was
 * not charged (swap on a perpetual, funding on a dated future) is left out, so the rows are only what applied.
 */
export function costLines(c: CostBridge): CostLine[] {
  const rows: CostLine[] = [{ key: "pnl", label: "Net P&L", value: c.totalPnl }];
  const cost = (key: CostLine["key"], label: string, v: number, note: string) => { if (v !== 0) rows.push({ key, label, value: v, note }); };
  cost("commission", "Commission", c.commission, "fees paid on fills");
  cost("swap", "Swap", c.swap, "overnight financing");
  cost("rollCosts", "Roll costs", c.rollCosts, "slippage and fees of moving to the next contract");
  cost("funding", "Funding", c.funding, "perpetual funding paid");
  rows.push({ key: "preCost", label: "Before costs", value: c.preCostPnl });
  return rows;
}

export interface MarginPoint { date: string; used: number; maintenance: number; equity: number; call: boolean }
/** Margin days as chart points, with the account's headroom (equity less maintenance) and where it was tightest. */
export function marginView(days: readonly MarginDay[]): { points: MarginPoint[]; calls: number; tightest: { date: string; headroom: number } | null } {
  const points = days.map((d) => ({ date: d.date, used: d.marginUsed, maintenance: d.maintenance, equity: d.equity, call: d.marginCall }));
  let tight: { date: string; headroom: number } | null = null;
  for (const d of days) { const h = d.equity - d.maintenance; if (!tight || h < tight.headroom) tight = { date: d.date, headroom: h }; }
  return { points, calls: days.filter((d) => d.marginCall).length, tightest: tight };
}

/** Rolls summed per stream: how many, what they cost, and the typical price gap between the two contracts. */
export function rollSummary(rolls: readonly RollRow[]): Array<{ stream: string; count: number; cost: number; fees: number; avgGap: number }> {
  const by = new Map<string, { count: number; cost: number; fees: number; gap: number }>();
  for (const r of rolls) {
    const a = by.get(r.stream) ?? { count: 0, cost: 0, fees: 0, gap: 0 };
    a.count++; a.cost += r.rollCost; a.fees += r.fees; a.gap += r.gap; by.set(r.stream, a);
  }
  return [...by].map(([stream, a]) => ({ stream, count: a.count, cost: a.cost, fees: a.fees, avgGap: a.count ? a.gap / a.count : 0 }));
}

export const legText = (l: StructureRow["legs"][number]): string => `${l.side === "BUY" ? "Buy" : "Sell"} ${l.quantity} ${l.symbol.split(":").pop()} @ ${l.entry}`;
