import type { RoundTrip } from "./roundtrips.js";

export type TripSort = "entryTs" | "exitTs" | "pnl" | "holdMs" | "qty";

export interface TripQuery {
  side?: "long" | "short";
  /** win: pnl>0, loss: pnl<0, breakeven: pnl==0, open: still open, closed: not open. */
  outcome?: "win" | "loss" | "breakeven" | "open" | "closed";
  symbol?: string;
  strategy?: string;
  /** Entry time window, epoch ms, [fromTs, toTs). */
  fromTs?: number;
  toTs?: number;
  minHoldMs?: number;
  maxHoldMs?: number;
  minPnl?: number;
  maxPnl?: number;
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
  if (q.fromTs !== undefined && t.entryTs < q.fromTs) return false;
  if (q.toTs !== undefined && t.entryTs >= q.toTs) return false;
  switch (q.outcome) {
    case "win": if (t.open || !(t.pnl > 0)) return false; break;
    case "loss": if (t.open || !(t.pnl < 0)) return false; break;
    case "breakeven": if (t.open || t.pnl !== 0) return false; break;
    case "open": if (!t.open) return false; break;
    case "closed": if (t.open) return false; break;
  }
  if (q.minHoldMs !== undefined && (t.holdMs === null || t.holdMs < q.minHoldMs)) return false;
  if (q.maxHoldMs !== undefined && (t.holdMs === null || t.holdMs > q.maxHoldMs)) return false;
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
