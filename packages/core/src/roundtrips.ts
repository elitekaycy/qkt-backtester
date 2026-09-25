import { createReadStream } from "node:fs";
import readline from "node:readline";

/** One row of qkt's trades.csv: a single FILL (not a round trip). */
export interface Fill {
  ts: number;
  strategy: string;
  symbol: string;
  side: "BUY" | "SELL";
  effect: string;
  qty: number;
  price: number;
  /** Realised P&L booked by this fill (0 for pure entries). */
  realized: number;
  /** Signed strategy position before/after this fill (blank in the CSV means flat = 0). */
  posBefore: number;
  posAfter: number;
  legId: string;
  orderId: string;
  sl?: number;
  tp?: number;
  /** Dollar risk qkt recorded on the entry (stop distance x size), when the entry had a stop. */
  risk?: number;
}

export interface TripEntry { ts: number; px: number; qty: number; sl?: number; tp?: number; risk?: number }

/** How the trade ended. `stop`/`target` need a bracket on the entry; `signal` means a rule closed it. */
export type ExitReason = "stop" | "target" | "signal" | "open";

export interface RoundTrip {
  id: number;
  strategy: string;
  symbol: string;
  side: "long" | "short";
  entryTs: number;
  entryPx: number;
  exitTs: number | null;
  exitPx: number | null;
  /** Largest size held during the trip. */
  qty: number;
  pnl: number;
  fills: number;
  holdMs: number | null;
  open: boolean;
  sl?: number;
  tp?: number;
  risk?: number;
  /** Every entry fill of a trip that scaled in (two or more), each with the stop, target and risk it carried. Absent for single-entry trips. */
  entries?: TripEntry[];
  exit: ExitReason;
  /** pnl / risk, present for closed trades whose entry carried a stop. */
  r?: number;
}

/**
 * Classify a finished trade. A bracketed entry that exits at its target is a `target`; a bracketed entry that exits on
 * the losing side is a `stop` (Draft fills stops at a bar-approximated price, so exact price equality is not usable);
 * everything else, including every exit of a strategy without brackets, is a rule-driven `signal`.
 */
export function classifyExit(t: Pick<RoundTrip, "open" | "sl" | "tp" | "side" | "entryPx">, exitPx: number | null): ExitReason {
  if (t.open || exitPx === null) return "open";
  if (t.sl === undefined && t.tp === undefined) return "signal";
  if (t.tp !== undefined && Math.abs(exitPx - t.tp) <= Math.abs(t.entryPx) * 0.0002) return "target";
  const lossSide = t.side === "long" ? exitPx < t.entryPx : exitPx > t.entryPx;
  return t.sl !== undefined && lossSide ? "stop" : "signal";
}

/** One tolerance for every P&L comparison in the studio (spec §9, review focus 5). */
export const PNL_TOL = 0.005;

function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined) => (s === undefined || s === "" ? 0 : Number(s));
const optNum = (s: string | undefined) => (s === undefined || s === "" ? undefined : Number(s));

class Columns {
  private ix = new Map<string, number>();
  constructor(header: string[]) { header.forEach((h, i) => this.ix.set(h, i)); }
  opt(name: string): number { return this.ix.get(name) ?? -1; }
  need(name: string): number {
    const i = this.ix.get(name);
    if (i === undefined) throw new Error(`trades.csv is missing column '${name}'`);
    return i;
  }
}

function makeParser(headerLine: string): (line: string) => Fill {
  const c = new Columns(splitCsvLine(headerLine));
  const ix = {
    ts: c.need("timestamp"), strategy: c.need("strategy"), symbol: c.need("symbol"), side: c.need("side"),
    effect: c.need("positionEffect"), qty: c.need("quantity"), price: c.need("price"), realized: c.need("realized"),
    before: c.need("strategyPositionQtyBefore"), after: c.need("strategyPositionQtyAfter"),
    leg: c.need("legId"), order: c.need("brokerOrderId"), sl: c.need("stopLossPrice"), tp: c.need("takeProfitPrice"), risk: c.opt("riskUsd"),
  };
  return (line) => {
    const f = splitCsvLine(line);
    return {
      ts: Number(f[ix.ts]), strategy: f[ix.strategy]!, symbol: f[ix.symbol]!, side: f[ix.side] as "BUY" | "SELL",
      effect: f[ix.effect]!, qty: num(f[ix.qty]), price: num(f[ix.price]), realized: num(f[ix.realized]),
      posBefore: num(f[ix.before]), posAfter: num(f[ix.after]), legId: f[ix.leg] ?? "", orderId: f[ix.order] ?? "",
      sl: optNum(f[ix.sl]), tp: optNum(f[ix.tp]), risk: ix.risk >= 0 ? optNum(f[ix.risk]) : undefined,
    };
  };
}

export function parseTradesCsv(text: string): Fill[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return [];
  const parse = makeParser(lines[0]!);
  return lines.slice(1).map(parse);
}

/** Streaming variant for very large files (millions of fills). */
export async function parseTradesFile(file: string): Promise<Fill[]> {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let parse: ((l: string) => Fill) | null = null;
  const out: Fill[] = [];
  for await (const line of rl) {
    if (!line) continue;
    if (!parse) { parse = makeParser(line); continue; }
    out.push(parse(line));
  }
  return out;
}

interface Acc {
  trip: RoundTrip;
  entries: TripEntry[];
  entryQty: number; entryNotional: number;
  exitQty: number; exitNotional: number;
}

/**
 * Pair fills into round trips using the signed strategy position before/after each fill.
 * A trip opens when the position leaves flat, absorbs scale-ins and partial closes, and closes when the
 * position returns to flat. A sign flip in one fill closes the trip and opens the opposite one.
 */
export function pairRoundTrips(fills: Fill[]): RoundTrip[] {
  const trips: RoundTrip[] = [];
  const openBy = new Map<string, Acc>();
  let nextId = 1;

  const start = (f: Fill, side: "long" | "short", qtyNow: number, fillsCount: number): Acc => {
    const trip: RoundTrip = {
      id: nextId++, strategy: f.strategy, symbol: f.symbol, side, entryTs: f.ts, entryPx: f.price,
      exitTs: null, exitPx: null, qty: Math.abs(qtyNow), pnl: 0, fills: fillsCount, holdMs: null, open: true, sl: f.sl, tp: f.tp, risk: f.risk, exit: "open",
    };
    trips.push(trip);
    return { trip, entries: [], entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0 };
  };
  const finish = (a: Acc, f: Fill) => {
    a.trip.exitTs = f.ts;
    a.trip.exitPx = a.exitQty > 0 ? a.exitNotional / a.exitQty : f.price;
    a.trip.holdMs = f.ts - a.trip.entryTs;
    a.trip.open = false;
    if (a.entries.length > 1) a.trip.entries = a.entries;
    a.trip.exit = classifyExit(a.trip, a.trip.exitPx);
    if (a.trip.risk && a.trip.risk > 0) a.trip.r = a.trip.pnl / a.trip.risk;
  };

  for (const f of fills) {
    const key = `${f.strategy}\u0000${f.symbol}`;
    const before = f.posBefore, after = f.posAfter;
    let acc = openBy.get(key);
    if (before === 0 && after === 0) continue; // nothing held before or after (should not happen)

    // A fill can only carry P&L if it reduces or flips an existing position.
    const flips = before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after);
    const reduces = before !== 0 && (after === 0 || flips || Math.abs(after) < Math.abs(before));
    const opens = before === 0 && after !== 0;
    const increases = before !== 0 && !flips && after !== 0 && Math.abs(after) > Math.abs(before);

    if (opens || (!acc && (increases || reduces))) {
      // Trip starts here (also recovers if the log starts mid-position).
      const side = (opens ? after : before) > 0 ? "long" : "short";
      acc = start(f, side, opens ? after : before, 0);
      openBy.set(key, acc);
    }
    if (!acc) continue;

    acc.trip.fills++;
    acc.trip.pnl += f.realized;
    if (opens || increases) {
      const added = Math.abs(after) - Math.abs(before);
      acc.entryQty += added; acc.entryNotional += added * f.price;
      acc.trip.entryPx = acc.entryNotional / acc.entryQty;
      acc.trip.qty = Math.max(acc.trip.qty, Math.abs(after));
      acc.entries.push({ ts: f.ts, px: f.price, qty: added, sl: f.sl, tp: f.tp, risk: f.risk });
      if (f.sl !== undefined) acc.trip.sl = f.sl;
      if (f.tp !== undefined) acc.trip.tp = f.tp;
      if (f.risk !== undefined) acc.trip.risk = (increases ? acc.trip.risk ?? 0 : 0) + f.risk;
    } else if (reduces) {
      const closed = flips ? Math.abs(before) : Math.abs(before) - Math.abs(after);
      acc.exitQty += closed; acc.exitNotional += closed * f.price;
      if (after === 0 || flips) {
        finish(acc, f);
        openBy.delete(key);
        if (flips) {
          const n = start(f, after > 0 ? "long" : "short", after, 1);
          n.entryQty = Math.abs(after); n.entryNotional = Math.abs(after) * f.price;
          n.entries.push({ ts: f.ts, px: f.price, qty: Math.abs(after), sl: f.sl, tp: f.tp, risk: f.risk });
          openBy.set(key, n);
        }
      }
    }
  }
  for (const a of openBy.values()) if (a.entries.length > 1) a.trip.entries = a.entries;
  return trips;
}

/** Σ pnl of every fill equals the engine's realised total; open trips keep their partial realised pnl. */
export function reconcile(trips: RoundTrip[], engineRealized: number, tol = PNL_TOL): { ok: boolean; diff: number; sum: number } {
  const sum = trips.reduce((a, t) => a + t.pnl, 0);
  const diff = sum - engineRealized;
  return { ok: Math.abs(diff) <= tol, diff, sum };
}
