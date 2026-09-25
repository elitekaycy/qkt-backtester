import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseStrategyInfo, uniqueStreams, usesIntrabarOrders } from "../src/strategy.js";

describe("parseStrategyInfo", () => {
  it("reads a plain strategy", () => {
    const i = parseStrategyInfo(`STRATEGY momentum VERSION 1\n\nSYMBOLS\n    btc = BACKTEST:BTCUSDT EVERY 1m\n\nRULES\n    WHEN btc.close > 1\n    THEN BUY btc SIZING 1\n`);
    expect(i).toEqual({ kind: "strategy", name: "momentum", streams: [{ alias: "btc", broker: "BACKTEST", symbol: "BTCUSDT", tf: "1m", warmupBars: undefined }], params: [], imports: [] });
  });
  it("reads several streams, WARMUP, other brokers, symbols with dots/dashes, and PARAMs", () => {
    const i = parseStrategyInfo([
      "STRATEGY s VERSION 2", "", "SYMBOLS", "  gold = ICMARKETS:XAUUSD EVERY 5m WARMUP 220 BARS", "  eur  = EXNESS:EURUSD.m EVERY 1h  -- comment",
      "", "PARAM riskPct = 0.5", "PARAM fast = 9  -- fast ema", "", "RULES", "  WHEN gold.close > 1", "  THEN BUY gold SIZING 1",
    ].join("\n"));
    expect(i.streams.map((s) => `${s.alias}=${s.broker}:${s.symbol}@${s.tf}/${s.warmupBars ?? "-"}`)).toEqual(["gold=ICMARKETS:XAUUSD@5m/220", "eur=EXNESS:EURUSD.m@1h/-"]);
    expect(i.params).toEqual([{ name: "riskPct", default: "0.5" }, { name: "fast", default: "9" }]);
  });
  it("reads a portfolio and its imports (path from the raw line)", () => {
    const i = parseStrategyInfo("PORTFOLIO book\n\nIMPORT 'trend.qkt'     AS trend\nIMPORT \"sub/meanrev.qkt\" AS meanrev HOLD\n");
    expect(i.kind).toBe("portfolio");
    expect(i.imports).toEqual([{ path: "trend.qkt", alias: "trend" }, { path: "sub/meanrev.qkt", alias: "meanrev" }]);
  });
  it("ignores commented-out declarations", () => {
    const i = parseStrategyInfo("STRATEGY s VERSION 1\nSYMBOLS\n  -- old = BACKTEST:X EVERY 1m\n  a = BACKTEST:Y EVERY 5m\n-- PARAM z = 1\n");
    expect(i.streams.map((s) => s.alias)).toEqual(["a"]);
    expect(i.params).toEqual([]);
  });
  it("is safe on empty and garbage input", () => {
    expect(parseStrategyInfo("")).toEqual({ kind: "unknown", streams: [], params: [], imports: [] });
    expect(parseStrategyInfo("\u0000\u0001 nonsense = = =").streams).toEqual([]);
  });
  it("uniqueStreams collapses duplicates", () => {
    const s = { alias: "a", broker: "B", symbol: "X", tf: "1m" };
    expect(uniqueStreams([s, { ...s, alias: "b" }, { ...s, tf: "5m" }]).length).toBe(2);
  });
  const real = process.env.QKT_REAL_STRATEGY ?? ""; // optional: path to a real .qkt file to parse
  it.skipIf(!real || !existsSync(real))("parses a real live strategy from the workspace", () => {
    const i = parseStrategyInfo(readFileSync(real, "utf8"));
    expect(i.kind).toBe("strategy");
    expect(i.streams.length).toBeGreaterThan(0);
    expect(i.streams[0]!.symbol).toBe("XAUUSD");
    expect(i.params.some((p) => p.name === "riskPct")).toBe(true);
  });
});

describe("usesIntrabarOrders", () => {
  it("detects brackets, stops, targets, trailing and limit order types", () => {
    for (const s of ["THEN BUY x SIZING 1\n  BRACKET {\n STOP_LOSS BY 1 PCT,\n TAKE_PROFIT BY 2 PCT }", "THEN BUY x SIZING 1 STOP_LOSS BY 5", "THEN SELL x SIZING 1 ORDER_TYPE = TRAILING PCT 5", "THEN BUY x SIZING 1 ORDER_TYPE = LIMIT AT 10"]) expect(usesIntrabarOrders(s), s).toBe(true);
  });
  it("is false for plain market-order strategies and ignores comments and strings", () => {
    expect(usesIntrabarOrders("THEN BUY x SIZING 1 ; LOG \"hit STOP_LOSS\"\n-- BRACKET later")).toBe(false);
    expect(usesIntrabarOrders("")).toBe(false);
  });
});
