import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseTradesCsv, parseTradesFile, pairRoundTrips, reconcile, type Fill } from "../src/roundtrips.js";

const fx = (n: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n);

let seq = 0;
function fill(p: Partial<Fill> & Pick<Fill, "posBefore" | "posAfter" | "price" | "ts">): Fill {
  const buy = p.posAfter > p.posBefore;
  return {
    strategy: "s", symbol: "BACKTEST:XAUUSD", side: buy ? "BUY" : "SELL", effect: "X",
    qty: Math.abs(p.posAfter - p.posBefore), realized: 0, legId: `L${seq}`, orderId: `O${seq++}`, ...p,
  };
}

describe("real qkt fixture", () => {
  const fills = parseTradesCsv(readFileSync(fx("trades-oct.csv"), "utf8"));
  const result = JSON.parse(readFileSync(fx("result-oct.json"), "utf8"));
  const trips = pairRoundTrips(fills);
  it("81 fills pair into 40 closed round trips and 1 open one", () => {
    expect(fills.length).toBe(81);
    expect(trips.filter((t) => !t.open).length).toBe(40);
    expect(trips.filter((t) => t.open).length).toBe(1);
    expect(trips.every((t) => t.side === "long")).toBe(true);
  });
  it("sum of P&L reconciles exactly with the engine's realizedTotal", () => {
    const r = reconcile(trips, Number(result.global.realizedTotal));
    expect(r.ok).toBe(true);
    expect(Math.abs(r.diff)).toBeLessThan(1e-6);
    expect(r.sum).toBeCloseTo(376.85, 6);
  });
  it("engine winRate is per round trip, not per fill (17 of 40)", () => {
    const closed = trips.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0).length;
    expect(wins / closed.length).toBeCloseTo(Number(result.global.winRate), 6);
  });
  it("closed trips have a positive hold time and an exit price", () => {
    for (const t of trips.filter((x) => !x.open)) {
      expect(t.holdMs).toBeGreaterThan(0);
      expect(t.exitPx).not.toBeNull();
      expect(t.fills).toBe(2);
    }
  });
  it("the streaming file parser equals the string parser", async () => {
    const s = await parseTradesFile(fx("trades-oct.csv"));
    expect(s).toEqual(fills);
  });
});

describe("real qkt fixture with shorts and bracket exits", () => {
  const fills = parseTradesCsv(readFileSync(fx("trades-both.csv"), "utf8"));
  const result = JSON.parse(readFileSync(fx("result-both.json"), "utf8"));
  const trips = pairRoundTrips(fills);
  it("119 fills -> 59 closed + 1 open round trips, both sides", () => {
    expect(fills.length).toBe(119);
    expect(trips.filter((t) => !t.open).length).toBe(59);
    // effects: 26 long opens/closes, 34 short opens vs 33 short closes -> the still-open trip is a short
    expect(trips.filter((t) => t.side === "long" && !t.open).length).toBe(26);
    expect(trips.filter((t) => t.side === "short" && !t.open).length).toBe(33);
    expect(trips.filter((t) => t.open).map((t) => t.side)).toEqual(["short"]);
  });
  it("reconciles with the engine to floating-point noise", () => {
    expect(reconcile(trips, Number(result.global.realizedTotal)).ok).toBe(true);
  });
  it("derived win rate matches the engine's", () => {
    const closed = trips.filter((t) => !t.open);
    expect(closed.filter((t) => t.pnl > 0).length / closed.length).toBeCloseTo(Number(result.global.winRate), 6);
  });
  it("short trips exit below entry when they win", () => {
    for (const t of trips.filter((x) => x.side === "short" && !x.open && x.pnl > 0)) expect(t.exitPx!).toBeLessThan(t.entryPx);
  });
});

describe("edge cases (synthetic)", () => {
  it("empty input", () => expect(pairRoundTrips([])).toEqual([]));

  it("partial close: 2 lots in, 1 out, 1 out -> one trip, three fills, weighted exit", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, posBefore: 0, posAfter: 2, price: 100 }),
      fill({ ts: 2, posBefore: 2, posAfter: 1, price: 110, realized: 10 }),
      fill({ ts: 3, posBefore: 1, posAfter: 0, price: 130, realized: 30 }),
    ]);
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ side: "long", fills: 3, pnl: 40, open: false, entryPx: 100, qty: 2, exitTs: 3 });
    expect(t[0]!.exitPx).toBeCloseTo(120, 9); // (110*1 + 130*1) / 2
  });

  it("scale-in: entry price is the size-weighted average", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, posBefore: 0, posAfter: 1, price: 100 }),
      fill({ ts: 2, posBefore: 1, posAfter: 3, price: 130 }),
      fill({ ts: 3, posBefore: 3, posAfter: 0, price: 140, realized: 90 }),
    ]);
    expect(t.length).toBe(1);
    expect(t[0]!.entryPx).toBeCloseTo((100 + 130 * 2) / 3, 9);
    expect(t[0]!.qty).toBe(3);
  });

  it("short trade", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, posBefore: 0, posAfter: -1, price: 100 }),
      fill({ ts: 5, posBefore: -1, posAfter: 0, price: 90, realized: 10 }),
    ]);
    expect(t[0]).toMatchObject({ side: "short", pnl: 10, holdMs: 4, open: false });
  });

  it("reversal in one fill closes the long and opens a short", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, posBefore: 0, posAfter: 1, price: 100 }),
      fill({ ts: 2, posBefore: 1, posAfter: -1, price: 110, realized: 10 }),
      fill({ ts: 3, posBefore: -1, posAfter: 0, price: 100, realized: 10 }),
    ]);
    expect(t.length).toBe(2);
    expect(t[0]).toMatchObject({ side: "long", pnl: 10, open: false, exitPx: 110 });
    expect(t[1]).toMatchObject({ side: "short", pnl: 10, open: false, entryPx: 110, entryTs: 2 });
    expect(reconcile(t, 20).ok).toBe(true);
  });

  it("interleaved symbols and strategies never mix", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, symbol: "A", posBefore: 0, posAfter: 1, price: 1 }),
      fill({ ts: 2, symbol: "B", posBefore: 0, posAfter: -1, price: 5 }),
      fill({ ts: 3, symbol: "A", strategy: "other", posBefore: 0, posAfter: 1, price: 2 }),
      fill({ ts: 4, symbol: "A", posBefore: 1, posAfter: 0, price: 3, realized: 2 }),
      fill({ ts: 5, symbol: "B", posBefore: -1, posAfter: 0, price: 4, realized: 1 }),
    ]);
    expect(t.length).toBe(3);
    expect(t.find((x) => x.symbol === "B")).toMatchObject({ side: "short", pnl: 1 });
    expect(t.find((x) => x.strategy === "other")).toMatchObject({ open: true });
  });

  it("position still open at the end is flagged open and keeps partial realised P&L", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, posBefore: 0, posAfter: 2, price: 100 }),
      fill({ ts: 2, posBefore: 2, posAfter: 1, price: 110, realized: 10 }),
    ]);
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ open: true, exitTs: null, exitPx: null, holdMs: null, pnl: 10 });
  });

  it("a log that starts mid-position is recovered, not dropped", () => {
    const t = pairRoundTrips([fill({ ts: 9, posBefore: 1, posAfter: 0, price: 50, realized: 5 })]);
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ open: false, pnl: 5 });
  });

  it("reconcile flags a tampered total", () => {
    const t = pairRoundTrips([
      fill({ ts: 1, posBefore: 0, posAfter: 1, price: 100 }),
      fill({ ts: 2, posBefore: 1, posAfter: 0, price: 110, realized: 10 }),
    ]);
    const r = reconcile(t, 12);
    expect(r.ok).toBe(false);
    expect(r.diff).toBeCloseTo(-2, 9);
  });
});

describe("parseTradesCsv robustness", () => {
  it("rejects a file missing required columns with a clear message", () => {
    expect(() => parseTradesCsv("timestamp,foo\n1,2\n")).toThrow(/missing column/);
  });
  it("handles quoted fields with commas and CRLF", () => {
    const header = "timestamp,strategy,symbol,side,positionEffect,quantity,price,realized,strategyPositionQtyBefore,strategyPositionQtyAfter,legId,brokerOrderId,stopLossPrice,takeProfitPrice";
    const row = '5,"a,b",X,BUY,OPEN_LONG,1,10,0,,1,L1,O1,,';
    const f = parseTradesCsv(`${header}\r\n${row}\r\n`);
    expect(f.length).toBe(1);
    expect(f[0]).toMatchObject({ strategy: "a,b", posBefore: 0, posAfter: 1, sl: undefined });
  });
});
