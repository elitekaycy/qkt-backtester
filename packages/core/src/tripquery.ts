import type { ExitReason, RoundTrip, VenueExit } from "./roundtrips.js";

export type TripSort = "entryTs" | "exitTs" | "pnl" | "holdMs" | "qty";

export interface TripQuery {
  side?: "long" | "short";
  /** win: pnl>0, loss: pnl<0, breakeven: pnl==0, open: still open, closed: not open. */
  outcome?: "win" | "loss" | "breakeven" | "open" | "closed";
  symbol?: string;
  strategy?: string;
  /** Any-of by strategy id: lets a chart hide some strategies of a portfolio. */
  strategies?: string[];
  /** Entry time window, epoch ms, [fromTs, toTs). */
  fromTs?: number;
  toTs?: number;
  /** Exit time window, epoch ms, [exitFromTs, exitToTs). Open trades never match when set. */
  exitFromTs?: number;
  exitToTs?: number;
  /** Position size bounds (lots / units, as traded). */
  minQty?: number;
  maxQty?: number;
  /** One trade by its number in the run (the # column). */
  id?: number;
  /** Hold time window, [minHoldMs, maxHoldMs): half-open like the journal's hold buckets, so "< 1h" never includes an exactly-1h trade. */
  minHoldMs?: number;
  maxHoldMs?: number;
  minPnl?: number;
  maxPnl?: number;
  /** How the trade ended. */
  exit?: ExitReason;
  /** The venue ended the trade: `expiry`, `liquidation` or `roll_failed` (the API reads `exit=expiry` etc. into this). Separate from `exit`, which stays the 4 values a rule or order produces. */
  venueExit?: VenueExit;
  /** Continuous futures: a contract the trade entered or exited on (`ESH19`, with or without the venue prefix). */
  contract?: string;
  /** R-multiple bounds (pnl / entry risk); trades without recorded risk never match when set. */
  minR?: number;
  maxR?: number;
  /** UTC weekday (0 = Sunday) and hour of ENTRY, and UTC calendar day (YYYY-MM-DD) of EXIT. */
  weekday?: number;
  hour?: number;
  day?: string;
  sort?: TripSort;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export const MAX_PAGE = 1000;

export function matches(t: RoundTrip, q: TripQuery): boolean {
  if (q.side && t.side !== q.side) return false;
  if (q.symbol && t.symbol !== q.symbol) return false;
  if (q.strategy && t.strategy !== q.strategy) return false;
  if (q.strategies && !q.strategies.includes(t.strategy)) return false;
  if (q.fromTs !== undefined && t.entryTs < q.fromTs) return false;
  if (q.toTs !== undefined && t.entryTs >= q.toTs) return false;
  if (q.exitFromTs !== undefined && (t.exitTs === null || t.exitTs < q.exitFromTs)) return false;
  if (q.exitToTs !== undefined && (t.exitTs === null || t.exitTs >= q.exitToTs)) return false;
  if (q.minQty !== undefined && t.qty < q.minQty) return false;
  if (q.maxQty !== undefined && t.qty > q.maxQty) return false;
  if (q.id !== undefined && t.id !== q.id) return false;
  switch (q.outcome) {
    case "win": if (t.open || !(t.pnl > 0)) return false; break;
    case "loss": if (t.open || !(t.pnl < 0)) return false; break;
    case "breakeven": if (t.open || t.pnl !== 0) return false; break;
    case "open": if (!t.open) return false; break;
    case "closed": if (t.open) return false; break;
  }
  if (q.minHoldMs !== undefined && (t.holdMs === null || t.holdMs < q.minHoldMs)) return false;
  if (q.maxHoldMs !== undefined && (t.holdMs === null || t.holdMs >= q.maxHoldMs)) return false;
  if (q.exit && t.exit !== q.exit) return false;
  if (q.venueExit && t.venueExit !== q.venueExit) return false;
  if (q.contract) {
    const bare = (c?: string) => (c ? c.slice(c.lastIndexOf(":") + 1).toUpperCase() : "");
    const want = bare(q.contract);
    if (bare(t.contract) !== want && bare(t.exitContract) !== want && bare(t.symbol) !== want) return false;
  }
  if (q.minR !== undefined && (t.r === undefined || t.r < q.minR)) return false;
  if (q.maxR !== undefined && (t.r === undefined || t.r > q.maxR)) return false;
  if (q.weekday !== undefined && new Date(t.entryTs).getUTCDay() !== q.weekday) return false;
  if (q.hour !== undefined && new Date(t.entryTs).getUTCHours() !== q.hour) return false;
  if (q.day !== undefined && (t.exitTs === null || new Date(t.exitTs).toISOString().slice(0, 10) !== q.day)) return false;
  if (q.minPnl !== undefined && t.pnl < q.minPnl) return false;
  if (q.maxPnl !== undefined && t.pnl > q.maxPnl) return false;
  return true;
}

export function filterTrips(trips: RoundTrip[], q: TripQuery): RoundTrip[] {
  return trips.filter((t) => matches(t, q));
}

const keyOf = (t: RoundTrip, s: TripSort): number => (s === "exitTs" ? t.exitTs ?? Infinity : s === "holdMs" ? t.holdMs ?? -1 : t[s]);

export interface TripPage { total: number; offset: number; limit: number; rows: RoundTrip[] }

/** Filter, sort and page. Trips arrive in entry order, so the default sort costs nothing. */
export function queryTrips(trips: RoundTrip[], q: TripQuery): TripPage {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), MAX_PAGE);
  const offset = Math.max(Math.floor(q.offset ?? 0), 0);
  const sort = q.sort ?? "entryTs", dir = q.dir ?? "asc";
  let rows = filterTrips(trips, q);
  if (sort !== "entryTs") {
    rows = rows.slice().sort((a, b) => {
      const d = keyOf(a, sort) - keyOf(b, sort);
      return d !== 0 && !Number.isNaN(d) ? d : a.id - b.id;
    });
  }
  if (dir === "desc") rows = rows.slice().reverse();
  return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

/** Trips whose [entry, exit] overlaps the visible window, thinned to `cap` so a zoomed-out chart stays light. */
export function overlayTrips(trips: RoundTrip[], q: TripQuery, windowFrom: number, windowTo: number, cap = 5000): { total: number; truncated: boolean; rows: RoundTrip[] } {
  const rows: RoundTrip[] = [];
  let total = 0;
  const base = { ...q, fromTs: undefined, toTs: undefined };
  for (const t of trips) {
    if (!matches(t, base)) continue;
    const end = t.exitTs ?? windowTo;
    if (end < windowFrom || t.entryTs >= windowTo) continue;
    total++;
    if (rows.length < cap) rows.push(t);
  }
  return { total, truncated: total > cap, rows };
}
