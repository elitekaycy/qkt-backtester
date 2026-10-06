import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataFingerprint, runHash, parseStrategyInfo, type RunHashInput } from "@qkt-studio/core";
import { Runner } from "../src/runner.js";
import { invalidateDerivatives } from "../src/derivatives-scan.js";

// The run id hashes the data a run reads by path, size and mtime. Futures and options read more than bars: a changed catalog,
// roll, funding, chain... file must be a new run, not a stale cache hit; a CFD run's id must stay what it always was.

let store: string, ws: string, runner: Runner;
const put = (rel: string, text = "x") => { const p = path.join(store, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
const touch = (rel: string, text: string) => { const p = path.join(store, rel); writeFileSync(p, text); utimesSync(p, new Date(), new Date(Date.now() + 5_000)); };

const CATALOG = JSON.stringify({ root: "CME:ES", contracts: [
  { symbol: "ESH19", expiryMs: Date.parse("2019-03-15T00:00:00Z"), deliveryPrice: "2800" },
  { symbol: "ESM19", expiryMs: Date.parse("2019-06-21T00:00:00Z"), deliveryPrice: "2900" },
  { symbol: "ESU19", expiryMs: Date.parse("2019-09-20T00:00:00Z"), deliveryPrice: "2950" },
] });
const YAML = `futures:
  - root: CME:ES
    multiplier: 50
    tickSize: 0.25
    roll: { daysBeforeExpiry: 7, atUtc: "00:00", adjust: panama }
  - root: BINANCE_UM:BTCUSDT
    multiplier: 1
    tickSize: 0.1
    perpetual: BTCUSDT
options:
  - root: DERIBIT:BTC_USDC
    contractSize: 1
    chains: trade
`;

beforeEach(() => {
  store = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fp-store-")));
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fp-ws-")));
  put("instruments.yaml", YAML);
  put("contracts/CME/ES.json", CATALOG);
  put("contracts/CME/ES.rolls.json", "{}");
  for (const c of ["ESH19", "ESM19", "ESU19"]) put(`bars/CME/${c}/1d/2019-02-04.bin`);
  put("funding/BINANCE_UM/BTCUSDT.csv", "time,rate,price\n");
  put("open_interest/BINANCE_UM/BTCUSDT.csv", "t,v\n");
  put("marks/BINANCE_UM/BTCUSDT/1h/2019-02-04.csv", "t\n");
  put("tape/BINANCE_UM/BTCUSDT/2019-02-04.csv.gz");
  put("liquidations/BINANCE_UM/BTCUSDT/2019-02-04.csv.gz");
  put("depth/BINANCE_UM/BTCUSDT/2019-02-04.csv.gz");
  put("bars/BINANCE_UM/BTCUSDT/1d/2019-02-04.bin");
  put("contracts/DERIBIT/BTC_USDC.options.json", "{}");
  put("chains/DERIBIT/BTC_USDC/trade/2019-02-04.csv.gz");
  put("bars/BACKTEST/XAUUSD/1d/2019-02-04.bin");
  put("bars/BACKTEST/EURUSD/1d/2019-02-04.bin");
  runner = new Runner({ workspace: ws, dataRoot: store, qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 1, terminal: "restricted" });
  invalidateDerivatives();
});
afterEach(() => { rmSync(store, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });

const strat = (stream: string) => `STRATEGY t VERSION 1\n\nSYMBOLS\n    a = ${stream} EVERY 1d\n\nRULES\n    WHEN a.close > 1\n    THEN BUY a SIZING 1\n`;
type Files = Array<{ path: string; size: number; mtimeMs: number }>;
const fp = async (stream: string, tier: "draft" | "full" = "draft") => {
  const files = await (runner as unknown as { dataFiles(s: unknown, t: string, f: string, to: string, w: number): Promise<Files> })
    .dataFiles(parseStrategyInfo(strat(stream)).streams, tier, "2019-02-01", "2019-02-10", 20);
  return dataFingerprint(files);
};

describe("a CFD run's fingerprint", () => {
  it("is unchanged by anything outside its own bars, and by the derivatives files", async () => {
    const a = await fp("BACKTEST:XAUUSD");
    touch("contracts/CME/ES.json", CATALOG + " ");
    touch("funding/BINANCE_UM/BTCUSDT.csv", "time,rate,price\n1,1,1\n");
    touch("bars/BACKTEST/EURUSD/1d/2019-02-04.bin", "other symbol");
    expect(await fp("BACKTEST:XAUUSD")).toBe(a);
    touch("bars/BACKTEST/XAUUSD/1d/2019-02-04.bin", "changed");
    expect(await fp("BACKTEST:XAUUSD")).not.toBe(a);
  });
  it("hashes to a pinned id for fixed inputs", () => {
    const input: RunHashInput = { strategySources: { "s.qkt": "STRATEGY s VERSION 1\n" }, config: "starting_balance: 10000\n", params: {}, from: "2024-10-01", to: "2024-10-31", tier: "draft", engine: { version: "0.55.0" }, flags: ["window-check:1"], dataFingerprint: dataFingerprint([{ path: "/d/bars/BACKTEST/XAUUSD/15m/2024-10-01.bin", size: 10, mtimeMs: 1000 }]) };
    expect(runHash(input)).toBe(PINNED);
  });
});

describe("a futures or options run's fingerprint follows every file it reads", () => {
  const changes: Array<[string, string, string, string]> = [
    ["continuous: catalog", "CME:ES@front", "contracts/CME/ES.json", CATALOG + " "],
    ["the data root's instruments.yaml", "CME:ES@front", "instruments.yaml", YAML + "# edited\n"],
    ["continuous: rolls", "CME:ES@front", "contracts/CME/ES.rolls.json", "{\"rolls\":[]}"],
    ["continuous: a contract's bars", "CME:ES@front", "bars/CME/ESM19/1d/2019-02-04.bin", "changed"],
    ["perpetual: funding", "BINANCE_UM:BTCUSDT", "funding/BINANCE_UM/BTCUSDT.csv", "time,rate,price\n1,1,1\n"],
    ["perpetual: open interest", "BINANCE_UM:BTCUSDT", "open_interest/BINANCE_UM/BTCUSDT.csv", "t,v\n1,1\n"],
    ["perpetual: marks", "BINANCE_UM:BTCUSDT", "marks/BINANCE_UM/BTCUSDT/1h/2019-02-04.csv", "t\n1\n"],
    ["perpetual: tape", "BINANCE_UM:BTCUSDT", "tape/BINANCE_UM/BTCUSDT/2019-02-04.csv.gz", "changed"],
    ["perpetual: liquidations", "BINANCE_UM:BTCUSDT", "liquidations/BINANCE_UM/BTCUSDT/2019-02-04.csv.gz", "changed"],
    ["perpetual: depth", "BINANCE_UM:BTCUSDT", "depth/BINANCE_UM/BTCUSDT/2019-02-04.csv.gz", "changed"],
    ["options chain: a chain day", "OPTIONS:DERIBIT.BTC_USDC", "chains/DERIBIT/BTC_USDC/trade/2019-02-04.csv.gz", "changed"],
    ["options chain: the catalog", "OPTIONS:DERIBIT.BTC_USDC", "contracts/DERIBIT/BTC_USDC.options.json", "{\"contracts\":[]}"],
    ["option contract: a chain day", "DERIBIT:BTC_USDC_26SEP26_84000_C", "chains/DERIBIT/BTC_USDC/trade/2019-02-04.csv.gz", "changed"],
  ];
  for (const [name, stream, file, text] of changes) {
    it(`${name} is a new run`, async () => {
      const tier = stream.startsWith("OPTIONS") || stream.includes("_C") ? "full" : "draft";
      const a = await fp(stream, tier);
      touch(file, text);
      expect(await fp(stream, tier)).not.toBe(a);
    });
  }
  it("a file of another root or symbol is not part of it", async () => {
    const a = await fp("CME:ES@front");
    touch("funding/BINANCE_UM/BTCUSDT.csv", "time,rate,price\n9,9,9\n");
    touch("bars/BACKTEST/EURUSD/1d/2019-02-04.bin", "x");
    expect(await fp("CME:ES@front")).toBe(a);
    const b = await fp("BINANCE_UM:BTCUSDT");
    touch("contracts/CME/ES.rolls.json", "{\"x\":1}");
    expect(await fp("BINANCE_UM:BTCUSDT")).toBe(b);
  });
});

const PINNED = "b06f8a6e2a5d66627169f306a5a533c565e8fa089bdcc81e864fcfb0e32096ba";
