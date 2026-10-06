import { describe, it, expect } from "vitest";
import { contextFromCatalog, fieldAllowed, kindOf, parseInstruments, rootOfContract } from "../src/instruments.js";
import { lintFieldKinds } from "../src/lint.js";
import { parseStrategyInfo } from "../src/strategy.js";

const YAML = `
instruments:
  - qktSymbol: BACKTEST:XAUUSD
    contractSize: 100
    volumeStep: 0.01
futures:
  - root: CME:ES
    currency: USD
    multiplier: 50
    tickSize: 0.25
    margin: { initial: 25713, maintenance: 23375, basis: per_contract }
    roll: { daysBeforeExpiry: 7, atUtc: "00:00", adjust: panama }
  - root: BINANCE_UM:BTCUSDT
    multiplier: 1
    perpetual: BTCUSDT
options:
  - root: DERIBIT:BTC_USDC
    contractSize: 1
    chains: trade
`;

describe("instruments.yaml", () => {
  const c = parseInstruments(YAML);
  it("reads all three sections", () => {
    expect(c.errors).toEqual([]);
    expect(c.cfds[0]).toMatchObject({ qktSymbol: "BACKTEST:XAUUSD", contractSize: 100 });
    expect(c.futures[0]).toMatchObject({ root: "CME:ES", multiplier: 50, margin: { initial: 25713, maintenance: 23375, basis: "per_contract" }, roll: { adjust: "panama" } });
    expect(c.options[0]).toMatchObject({ root: "DERIBIT:BTC_USDC", chains: "trade" });
  });
  it("reports a malformed file instead of throwing", () => {
    expect(parseInstruments("futures: [").errors.length).toBeGreaterThan(0);
  });
  it("a file with only CFDs has no futures or options", () => {
    const x = parseInstruments("instruments:\n  - qktSymbol: BACKTEST:EURUSD\n");
    expect(x.futures).toEqual([]);
    expect(x.options).toEqual([]);
  });
});

describe("kindOf", () => {
  const ctx = contextFromCatalog(parseInstruments(YAML));
  it("settles what the symbol alone settles", () => {
    expect(kindOf({ broker: "CME", symbol: "ES@front" })).toBe("continuous");
    expect(kindOf({ broker: "OPTIONS", symbol: "DERIBIT.BTC_USDC" })).toBe("chain");
    expect(kindOf({ broker: "CHAIN", symbol: "DERIBIT.BTC_USDC.atm_iv.30d" })).toBe("analytic");
    expect(kindOf({ broker: "HUB", symbol: "x" })).toBe("hub");
    expect(kindOf({ broker: "BACKTEST", symbol: "XAUUSD" })).toBe("cfd");
  });
  it("uses the catalog for contracts, perpetuals and options", () => {
    expect(kindOf({ broker: "CME", symbol: "ESZ24" }, ctx)).toBe("future");
    expect(kindOf({ broker: "BINANCE_UM", symbol: "BTCUSDT_241227" }, ctx)).toBe("future");
    expect(kindOf({ broker: "BINANCE_UM", symbol: "BTCUSDT" }, ctx)).toBe("perpetual");
    expect(kindOf({ broker: "DERIBIT", symbol: "BTC_USDC-26SEP26-80000-C" }, ctx)).toBe("option");
    // a strategy names the contract by its qkt code: the venue's name with each `-` written `_`
    expect(kindOf({ broker: "DERIBIT", symbol: "BTC_USDC_26SEP26_80000_C" }, ctx)).toBe("option");
    expect(kindOf({ broker: "EXNESS", symbol: "XAUUSD" }, ctx)).toBe("cfd");
  });
  it("finds a contract's root", () => {
    expect(rootOfContract("CME", "ESH19", ctx.futureRoots!)).toBe("ES");
    expect(rootOfContract("CME", "XYZ", ctx.futureRoots!)).toBeNull();
  });
});

describe("fields by kind", () => {
  it("keeps derivatives fields off CFDs and option fields off futures", () => {
    expect(fieldAllowed("cfd", "close")).toBe(true);
    expect(fieldAllowed("cfd", "dte")).toBe(false);
    expect(fieldAllowed("cfd", "iv")).toBe(false);
    expect(fieldAllowed("future", "dte")).toBe(true);
    expect(fieldAllowed("future", "iv")).toBe(false);
    expect(fieldAllowed("continuous", "mark")).toBe(false);
    expect(fieldAllowed("perpetual", "mark")).toBe(true);
    expect(fieldAllowed("option", "delta")).toBe(true);
  });
});

const src = (stream: string, cond: string) => `STRATEGY t VERSION 1\n\nSYMBOLS\n    a = ${stream} EVERY 1h\n\nRULES\n    WHEN ${cond} AND POSITION.a = 0\n    THEN BUY a SIZING 1\n`;

describe("lintFieldKinds", () => {
  it("flags a derivatives field on a CFD stream, where qkt would stay silent", () => {
    const d = lintFieldKinds(src("BACKTEST:XAUUSD", "a.dte > 1"));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "field_not_for_kind", severity: "error", line: 7 });
    expect(d[0]!.message).toContain("CFD");
  });
  it("flags an option field on a continuous future", () => {
    expect(lintFieldKinds(src("CME:ES@front", "a.iv > 1"))).toHaveLength(1);
    expect(lintFieldKinds(src("CME:ES@front", "a.dte > 30"))).toEqual([]);
  });
  it("leaves ordinary CFD strategies alone", () => {
    expect(lintFieldKinds(src("BACKTEST:XAUUSD", "a.close > ema(a.close, 20) AND a.contract_size > 1"))).toEqual([]);
  });
  it("does not judge a bare symbol on an unknown broker without a catalog", () => {
    expect(lintFieldKinds(src("CME:ESZ24", "a.dte > 1"))).toEqual([]);
    const ctx = contextFromCatalog(parseInstruments(YAML));
    expect(lintFieldKinds(src("CME:ESZ24", "a.iv > 1"), ctx)).toHaveLength(1);
    expect(lintFieldKinds(src("CME:ESZ24", "a.dte > 1"), ctx)).toEqual([]);
  });
  it("ignores POSITION members and string literals", () => {
    expect(lintFieldKinds(src("BACKTEST:XAUUSD", "POSITION.a.dte > 1"))).toEqual([]);
  });
});

describe("stream declarations", () => {
  it("parses continuous and option-chain streams that the old pattern dropped", () => {
    const i = parseStrategyInfo("STRATEGY t VERSION 1\n\nSYMBOLS\n    es = CME:ES@front EVERY 1d\n    ch = OPTIONS:DERIBIT.BTC_USDC EVERY 1h,\n    iv = CHAIN:DERIBIT.BTC_USDC.atm_iv.30d EVERY 1h\n");
    expect(i.streams.map((s) => `${s.broker}:${s.symbol}`)).toEqual(["CME:ES@front", "OPTIONS:DERIBIT.BTC_USDC", "CHAIN:DERIBIT.BTC_USDC.atm_iv.30d"]);
  });
});
