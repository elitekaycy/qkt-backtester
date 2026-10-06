import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { calendarOf, contextFromCatalog, fieldAllowed, futuresDayExpected, kindOf, tierProblem, type CostBridge, type DerivativesReport, type FutureRootReport, type InstrumentKind, type KindContext, type MarginDay, type OptionRootReport, type RollRow, type StructureRow } from "@qkt-studio/core";
import type { DerivFetchKind, DerivFetchReq, InstrumentsInfo } from "../api/client.js";

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
/** What a position size is counted in: lots for a CFD, contracts for a future or option, plain units for a perpetual (coins). */
export const qtyUnit = (k: InstrumentKind | undefined): string => (!k || k === "cfd" ? "lots" : k === "perpetual" ? "units" : "contracts");

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

/** True when any stream is a future, perpetual or option: those fill on qkt's exchange simulator, whatever the broker model says. */
export function hasDerivativeStreams(source: string, ctx: KindContext): boolean {
  return [...streamKinds(source, ctx).values()].some((k) => k !== "cfd" && k !== "hub" && k !== "analytic");
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

/**
 * Filters carried to another run: a `contract:` or a venue-close filter names something only a futures run has, so on a run
 * without it the filter would silently match nothing. Returns the same object when nothing needs dropping.
 */
export function pruneRunFilters<T extends object>(filters: T, sections: readonly string[] | undefined): T {
  const f = filters as { contract?: string; venueExit?: string };
  const has = (x: string) => !!sections?.includes(x);
  const dropContract = f.contract !== undefined && !has("contracts"), dropVenue = f.venueExit !== undefined && (sections?.length ?? 0) === 0;
  if (!dropContract && !dropVenue) return filters;
  const out = { ...f };
  if (dropContract) delete out.contract;
  if (dropVenue) delete out.venueExit;
  return out as T;
}

/** The contracts a continuous-futures run traded or rolled through, bare codes in the order they were first used (for `contract:`). */
export function contractNames(d: { contracts?: ReadonlyArray<{ contract: string }>; rolls?: ReadonlyArray<{ from: string; to: string }> } | null): string[] {
  if (!d) return [];
  const bare = (c: string) => c.replace(/^[A-Za-z0-9_]+:/, "");
  const out = new Set<string>();
  for (const c of d.contracts ?? []) out.add(bare(c.contract));
  for (const r of d.rolls ?? []) { out.add(bare(r.from)); out.add(bare(r.to)); }
  return [...out];
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

// ---- the fix a blocked stream names ----------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KIND_FLAG: Array<[string, DerivFetchKind]> = [["--catalog", "catalog"], ["--rolls", "rolls"], ["--funding", "funding"], ["--open-interest", "open-interest"], ["--marks", "marks"], ["--chains", "chains"], ["--tape", "tape"], ["--liquidations", "liquidations"], ["--depth", "depth"]];

/**
 * The job a `qkt fetch ...` command line stands for, or null when it is not one the studio can run as written (a placeholder
 * such as `<from>` is still in it, or it is not a fetch). The readiness check names the exact command; the studio runs that
 * very command only when it can be run without guessing, so Copy is always there and Run only sometimes.
 */
export function fetchRequestFrom(command: string): DerivFetchReq | null {
  const t = command.trim().split(/\s+/);
  if (t[0] !== "qkt" || t[1] !== "fetch" || !t[2] || t[2].startsWith("--")) return null;
  const flag = (name: string) => { const i = t.indexOf(name); return i >= 0 ? t[i + 1] : undefined; };
  const kind = KIND_FLAG.find(([f]) => t.includes(f))?.[1] ?? (t.includes("--tf") ? "bars" : null);
  if (!kind) return null;
  const req: DerivFetchReq = { target: t[2], kind };
  const tf = flag("--tf"), from = flag("--from"), to = flag("--to");
  if (tf) req.tf = tf;
  if (from) { if (!DATE.test(from)) return null; req.from = from; }
  if (to) { if (!DATE.test(to)) return null; req.to = to; }
  if (t.includes("--live")) req.live = true;
  const needsRange = kind === "funding" || kind === "open-interest" || kind === "marks" || kind === "tape" || kind === "liquidations" || kind === "depth" || kind === "bars" || (kind === "chains" && !req.live);
  if (needsRange && (!req.from || !req.to)) return null;
  if ((kind === "marks" || kind === "bars") && !req.tf) return null;
  return req;
}

/** The `qkt fetch ...` commands written in backticks inside a scan note. */
export const commandsIn = (note: string): string[] => [...note.matchAll(/`(qkt fetch [^`]+)`/g)].map((m) => m[1]!);

/** What a job does, for its label in the Jobs list and on its button. */
export function fetchLabel(r: DerivFetchReq): string {
  const what: Record<DerivFetchKind, string> = { catalog: "contract catalog", rolls: "rolls", funding: "funding", marks: "marks", "open-interest": "open interest", chains: "option chains", tape: "trade tape", liquidations: "liquidations", depth: "order-book depth", bars: `${r.tf ?? ""} bars` };
  return `Fetch ${what[r.kind]} · ${r.target}`;
}

// ---- roots in the Data section ---------------------------------------------------------------------------------------

const yr = (iso: string | null | undefined) => iso?.slice(0, 4) ?? "";
const span = (a: string | null | undefined, b: string | null | undefined) => (!a ? "" : yr(a) === yr(b) ? yr(a) : `${yr(a)}–${yr(b).slice(2)}`);

export interface RootLine { key: string; title: string; facts: string[]; attention: string | null; status: "ok" | "warn" | "bad" }

/**
 * A contract's day calendar comes from the symbol route, which judges days by the FX/crypto rule for the contract's name. A futures
 * exchange has its own hours (CME Globex folds Sunday evening into Monday), so a day it is closed on is shown as closed, not as a
 * hole. Only `m` (missing) days change; a day with data keeps its colour.
 */
export function closedDaysFor(root: string, declared: string | undefined): (first: string, days: string) => string {
  const cal = calendarOf(root, declared);
  return (first, days) => {
    const t0 = Date.parse(`${first}T00:00:00Z`);
    let out = "";
    for (let i = 0; i < days.length; i++) {
      const c = days[i]!;
      out += c === "m" && !futuresDayExpected(cal, new Date(t0 + i * 86_400_000).toISOString().slice(0, 10)) ? "c" : c;
    }
    return out;
  };
}

/** One line per futures root, the way a symbol gets one: what is there at a glance, and the first thing that needs doing. */
export function futureRootLine(r: FutureRootReport): RootLine {
  const facts: string[] = [];
  if (r.catalog) facts.push(`${r.catalog.contracts} contract${r.catalog.contracts === 1 ? "" : "s"}`, span(r.catalog.first, r.catalog.last));
  if (r.rolls) facts.push(`${r.rolls.count} roll${r.rolls.count === 1 ? "" : "s"}`);
  if (r.perpetual) facts.push(`perpetual ${r.perpetual.name}`, r.perpetual.funding ? "funding" : "no funding stored");
  const built = r.contracts.filter((c) => c.bars.some((b) => b.files > 0)).length;
  if (r.contracts.length && !r.perpetual) facts.push(`${built} with bars`);
  const hasData = built > 0 || (r.perpetual?.bars.some((b) => b.files > 0) ?? false);
  const attention = r.notes[0] ?? (hasData ? null : "no bars stored for any contract");
  return { key: r.key, title: r.root, facts: facts.filter(Boolean), attention, status: !hasData && !r.catalog ? "bad" : attention ? "warn" : "ok" };
}

export function optionRootLine(r: OptionRootReport): RootLine {
  const facts: string[] = [];
  if (r.catalog) facts.push(`${r.catalog.contracts} contract${r.catalog.contracts === 1 ? "" : "s"}`);
  if (r.chains.trade) facts.push(`trade chains ${span(r.chains.trade.first, r.chains.trade.last)}`);
  if (r.chains.book) facts.push(`book chains ${span(r.chains.book.first, r.chains.book.last)}`);
  if (!r.chains.trade && !r.chains.book) facts.push("no chains stored");
  const attention = r.notes[0] ?? (!r.chains.trade && !r.chains.book ? "no chain history stored" : null);
  return { key: r.key, title: r.root, facts: facts.filter(Boolean), attention, status: !r.catalog && !r.chains.trade && !r.chains.book ? "bad" : attention ? "warn" : "ok" };
}

/** The `VENUE:ROOT` key of the root a stream reads, or null when the store has none for it (a CFD, or a root it does not know yet). */
export function rootKeyFor(s: { broker: string; symbol: string }, d: DerivativesReport | undefined): string | null {
  if (!d) return null;
  const hit = [...d.futures, ...d.options].find((r) => readsRoot(s, { venue: r.venue, root: r.root, contracts: "contracts" in r ? r.contracts : undefined, perpetual: "perpetual" in r ? r.perpetual : undefined }));
  return hit?.key ?? null;
}

/** Whether a stream reads a root: the root itself (`@front`, a perpetual), one of its contracts, or its option chain. */
export function readsRoot(s: { broker: string; symbol: string }, root: { venue: string; root: string; contracts?: ReadonlyArray<{ symbol: string }>; perpetual?: { name: string } | null }): boolean {
  const b = s.broker.toUpperCase();
  if (b === "OPTIONS" || b === "CHAIN") return s.symbol === `${root.venue}.${root.root}` || s.symbol.startsWith(`${root.venue}.${root.root}.`);
  if (s.broker !== root.venue) return false;
  const bare = s.symbol.replace(/@(front|next)$/, "");
  return bare === root.root || s.symbol === root.perpetual?.name || (root.contracts?.some((c) => c.symbol === bare) ?? false) || bare.startsWith(`${root.root}_`);
}
