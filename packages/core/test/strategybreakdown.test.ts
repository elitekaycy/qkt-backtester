import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bookInfo, strategyBreakdown } from "../src/portfolio.js";
import { loadResult } from "../src/results.js";
import { pairRoundTrips, parseTradesCsv } from "../src/roundtrips.js";

const fx = (n: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");
const result = loadResult(JSON.parse(fx("result-portfolio.json")));
const trips = pairRoundTrips(parseTradesCsv(fx("trades-portfolio.csv")));

describe("strategyBreakdown on a real portfolio result", () => {
  const rows = strategyBreakdown(result, trips);
  it("has one row per strategy with numbers, not strings", () => {
    expect(rows.map((r) => r.id).sort()).toEqual(["book:btc", "book:fade", "book:trend"]);
    for (const r of rows) { expect(typeof r.totalPnl).toBe("number"); expect(r.alias).toBe(r.id.split(":")[1]); }
  });
  it("the strategies add up to the book", () => {
    expect(rows.reduce((a, r) => a + r.totalPnl, 0)).toBeCloseTo(Number(result.global.totalPnL), 4);
    expect(rows.reduce((a, r) => a + r.trades + r.openTrades, 0)).toBe(trips.length);
    expect(rows.reduce((a, r) => a + (r.contribution ?? 0), 0)).toBeCloseTo(1, 6);
  });
  it("knows which symbols each strategy traded", () => {
    expect(rows.find((r) => r.id === "book:btc")!.symbols).toEqual(["BACKTEST:BTCUSD"]);
    expect(rows.find((r) => r.id === "book:trend")!.symbols).toEqual(["BACKTEST:XAUUSD"]);
  });
  it("carries the engine's attribution", () => {
    expect(rows.every((r) => r.returnContribution !== null && r.riskContribution !== null)).toBe(true);
  });
});

describe("bookInfo", () => {
  it("reads exposure and correlation from a portfolio result", () => {
    const b = bookInfo(result)!;
    expect(b.maxGrossExposure).toBeGreaterThan(0);
    expect(b.correlation).toHaveLength(3);
    expect(b.correlation[0]!.correlation).toBeTypeOf("number");
  });
  it("is null for a plain strategy result", () => {
    const plain = { ...result, bookAnalytics: undefined, bookRisk: undefined };
    expect(bookInfo(plain)).toBeNull();
  });
});
