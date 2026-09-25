import { describe, it, expect } from "vitest";
import { filterTrips, queryTrips, overlayTrips, MAX_PAGE } from "../src/tripquery.js";
import type { RoundTrip } from "../src/roundtrips.js";

const mk = (id: number, p: Partial<RoundTrip> = {}): RoundTrip => ({
  id, strategy: "s", symbol: "X", side: "long", entryTs: id * 1000, entryPx: 100, exitTs: id * 1000 + 500, exitPx: 101, qty: 1,
  pnl: id % 2 ? 10 : -5, fills: 2, holdMs: 500, open: false, exit: "signal", ...p,
});
const trips: RoundTrip[] = [
  mk(1), mk(2), mk(3, { side: "short", pnl: 0 }), mk(4, { pnl: 40, holdMs: 9000 }), mk(5, { open: true, exitTs: null, exitPx: null, holdMs: null, pnl: 2 }),
  mk(6, { symbol: "Y", strategy: "t", qty: 3 }),
];

describe("filterTrips", () => {
  it("side", () => expect(filterTrips(trips, { side: "short" }).map((t) => t.id)).toEqual([3]));
  it("outcome win/loss/breakeven/open/closed", () => {
    expect(filterTrips(trips, { outcome: "win" }).map((t) => t.id)).toEqual([1, 4]);
    expect(filterTrips(trips, { outcome: "loss" }).map((t) => t.id)).toEqual([2, 6]);
    expect(filterTrips(trips, { outcome: "breakeven" }).map((t) => t.id)).toEqual([3]);
    expect(filterTrips(trips, { outcome: "open" }).map((t) => t.id)).toEqual([5]);
    expect(filterTrips(trips, { outcome: "closed" }).length).toBe(5);
  });
  it("an open trade is never a win or a loss even with pnl", () => {
    expect(filterTrips(trips, { outcome: "win" }).some((t) => t.open)).toBe(false);
  });
  it("symbol, strategy, entry window [from,to), hold and pnl bounds", () => {
    expect(filterTrips(trips, { symbol: "Y" }).map((t) => t.id)).toEqual([6]);
    expect(filterTrips(trips, { strategy: "t" }).map((t) => t.id)).toEqual([6]);
    expect(filterTrips(trips, { fromTs: 2000, toTs: 4000 }).map((t) => t.id)).toEqual([2, 3]);
    expect(filterTrips(trips, { minHoldMs: 1000 }).map((t) => t.id)).toEqual([4]);
    expect(filterTrips(trips, { maxHoldMs: 600 }).map((t) => t.id)).toEqual([1, 2, 3, 6]); // open trade has no hold time: excluded
    expect(filterTrips(trips, { minPnl: 10 }).map((t) => t.id)).toEqual([1, 4]);
    expect(filterTrips(trips, { maxPnl: -5 }).map((t) => t.id)).toEqual([2, 6]);
  });
  it("filters combine (AND)", () => expect(filterTrips(trips, { side: "long", outcome: "win", minHoldMs: 1000 }).map((t) => t.id)).toEqual([4]));
  it("no filters returns everything", () => expect(filterTrips(trips, {}).length).toBe(6));
});

describe("queryTrips", () => {
  it("pages and reports the total", () => {
    const p = queryTrips(trips, { limit: 2, offset: 2 });
    expect(p).toMatchObject({ total: 6, offset: 2, limit: 2 });
    expect(p.rows.map((t) => t.id)).toEqual([3, 4]);
  });
  it("sorts by pnl, hold, and desc, with id as a stable tiebreak", () => {
    expect(queryTrips(trips, { sort: "pnl", dir: "desc" }).rows.map((t) => t.id)).toEqual([4, 1, 5, 3, 6, 2]);
    expect(queryTrips(trips, { sort: "holdMs", dir: "desc", limit: 1 }).rows[0]!.id).toBe(4);
    expect(queryTrips(trips, { dir: "desc", limit: 2 }).rows.map((t) => t.id)).toEqual([6, 5]);
  });
  it("open trips sort last by exit time", () => expect(queryTrips(trips, { sort: "exitTs", dir: "asc" }).rows.at(-1)!.id).toBe(5));
  it("clamps limit and offset", () => {
    expect(queryTrips(trips, { limit: 1e9 }).limit).toBe(MAX_PAGE);
    expect(queryTrips(trips, { limit: -5 }).limit).toBe(1);
    expect(queryTrips(trips, { offset: -3 }).offset).toBe(0);
    expect(queryTrips(trips, { offset: 99 }).rows).toEqual([]);
  });
  it("does not mutate its input", () => {
    const before = trips.map((t) => t.id);
    queryTrips(trips, { sort: "pnl", dir: "desc" });
    expect(trips.map((t) => t.id)).toEqual(before);
  });
});

describe("overlayTrips", () => {
  it("returns trips overlapping the visible window, including open ones", () => {
    expect(overlayTrips(trips, {}, 3400, 5200).rows.map((t) => t.id)).toEqual([3, 4, 5]);
    expect(overlayTrips(trips, {}, 5200, 9999).rows.map((t) => t.id)).toEqual([5, 6]); // open trip 5 still open in the window
  });
  it("honours filters and caps with a truncated flag", () => {
    expect(overlayTrips(trips, { side: "short" }, 0, 1e9).rows.map((t) => t.id)).toEqual([3]);
    const o = overlayTrips(trips, {}, 0, 1e9, 2);
    expect(o).toMatchObject({ total: 6, truncated: true });
    expect(o.rows.length).toBe(2);
  });
});

describe("performance guard: 1,000,000 trades", () => {
  const big: RoundTrip[] = Array.from({ length: 1_000_000 }, (_, i) => mk(i + 1, { side: i % 3 ? "long" : "short", pnl: (i * 7919) % 200 - 100 }));
  it("filters and pages the default order well under a second", () => {
    const t0 = performance.now();
    const p = queryTrips(big, { side: "short", outcome: "win", limit: 100, offset: 5000 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(p.total).toBeGreaterThan(100_000);
    expect(p.rows.length).toBe(100);
  });
  it("sorting by pnl stays under a few seconds", () => {
    const t0 = performance.now();
    queryTrips(big, { sort: "pnl", dir: "desc", limit: 50 });
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe("entry/exit windows, size and trade number", () => {
  const base = { strategy: "s", symbol: "X", side: "long" as const, entryPx: 1, exitPx: 2, pnl: 1, open: false, holdMs: 1000, exit: "signal" as const, risk: 1, r: 1 };
  const mk = (id: number, entry: string, exit: string | null, qty: number) => ({ ...base, id, qty, entryTs: Date.parse(entry), exitTs: exit ? Date.parse(exit) : null, open: exit === null }) as never;
  const trips = [mk(1, "2024-10-01T10:00:00Z", "2024-10-01T12:00:00Z", 0.1), mk(2, "2024-10-15T10:00:00Z", "2024-10-16T09:00:00Z", 0.5), mk(3, "2024-11-02T10:00:00Z", null, 1)];
  it("exit window excludes open trades and is half-open", () => {
    expect(filterTrips(trips, { exitFromTs: Date.parse("2024-10-16T00:00:00Z"), exitToTs: Date.parse("2024-10-17T00:00:00Z") }).map((t) => t.id)).toEqual([2]);
    expect(filterTrips(trips, { exitFromTs: 0 }).map((t) => t.id)).toEqual([1, 2]);
  });
  it("size bounds and trade id", () => {
    expect(filterTrips(trips, { minQty: 0.5 }).map((t) => t.id)).toEqual([2, 3]);
    expect(filterTrips(trips, { maxQty: 0.1 }).map((t) => t.id)).toEqual([1]);
    expect(filterTrips(trips, { id: 3 }).map((t) => t.id)).toEqual([3]);
  });
});
