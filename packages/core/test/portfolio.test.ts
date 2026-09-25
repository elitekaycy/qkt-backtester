import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyze } from "../src/analytics.js";
import { pairRoundTrips, parseTradesCsv } from "../src/roundtrips.js";
import { filterTrips } from "../src/tripquery.js";

const fx = (n: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");
const sum = (a: Array<{ pnl: number }>) => a.reduce((x, y) => x + y.pnl, 0);
const cnt = (a: Array<{ trades: number }>) => a.reduce((x, y) => x + y.trades, 0);

describe("portfolio runs (real qkt output: three children in one trades.csv)", () => {
  const book = pairRoundTrips(parseTradesCsv(fx("trades-portfolio.csv")));
  const single = pairRoundTrips(parseTradesCsv(fx("trades-oct.csv")));

  it("keeps the engine strategy id `<portfolio>:<alias>` on every round trip", () => {
    expect([...new Set(book.map((t) => t.strategy))].sort()).toEqual(["book:btc", "book:fade", "book:trend"]);
  });
  it("byStrategy partitions the book exactly", () => {
    const a = analyze(book);
    expect(a.byStrategy.map((s) => s.strategy).sort()).toEqual(["book:btc", "book:fade", "book:trend"]);
    expect(sum(a.byStrategy)).toBeCloseTo(a.pnl, 6);
    expect(cnt(a.byStrategy)).toBe(a.closed);
    expect(a.byStrategy.reduce((n, s) => n + s.closed + s.open, 0)).toBe(a.count);
  });
  it("dailyByStrategy adds up to the daily book P&L", () => {
    const a = analyze(book);
    expect(a.dailyByStrategy).toHaveLength(a.daily.length);
    for (const d of a.daily) {
      const split = a.dailyByStrategy.find((x) => x.day === d.day)!;
      expect(Object.values(split.by).reduce((x, y) => x + y, 0)).toBeCloseTo(d.pnl, 6);
    }
  });
  it("a single strategy has no breakdown (the UI ignores it)", () => {
    const a = analyze(single);
    expect(a.byStrategy).toEqual([]);
    expect(a.dailyByStrategy).toEqual([]);
    expect(a.monthlyByStrategy).toEqual([]);
  });
  it("filters compose with strategy and strategies (any-of)", () => {
    const one = filterTrips(book, { strategy: "book:fade" });
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((t) => t.strategy === "book:fade")).toBe(true);
    const two = filterTrips(book, { strategies: ["book:fade", "book:btc"] });
    expect(two.length).toBe(book.filter((t) => t.strategy !== "book:trend").length);
    const shorts = filterTrips(book, { strategies: ["book:fade"], side: "short" });
    expect(shorts.every((t) => t.strategy === "book:fade" && t.side === "short")).toBe(true);
    expect(filterTrips(book, { strategies: [] }).length).toBe(0);
  });
  it("the analytics of a strategy filter equal the byStrategy row", () => {
    const row = analyze(book).byStrategy.find((s) => s.strategy === "book:trend")!;
    const only = analyze(filterTrips(book, { strategy: "book:trend" }));
    expect(only.pnl).toBeCloseTo(row.pnl, 6);
    expect(only.closed).toBe(row.closed);
  });
});
