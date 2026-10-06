import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanStore, readinessFor } from "../src/data-scan.js";

// a real built bar day (qkt's QKB1 format), used as a stand-in for any day of bars
const BAR_DAY = path.resolve(import.meta.dirname, "../../core/test/fixtures/bars-2024-10-02.bin");
const strat = (stream: string) => `STRATEGY t VERSION 1\n\nSYMBOLS\n    x = ${stream}\n\nRULES\n    WHEN x.close > 0 AND POSITION.x = 0\n    THEN BUY x SIZING 0.01\n`;

describe("a perpetual is listed once", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "perp-once-"));
    writeFileSync(path.join(tmp, "instruments.yaml"), "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 1\n    perpetual: BTCUSDT\n    calendar: crypto\n");
    mkdirSync(path.join(tmp, "funding/BINANCE_UM"), { recursive: true });
    writeFileSync(path.join(tmp, "funding/BINANCE_UM/BTCUSDT.csv"), "time,rate,price\n1727827200000,0.0001,\n");
    mkdirSync(path.join(tmp, "bars/BINANCE_UM/BTCUSDT/1h"), { recursive: true });
    copyFileSync(BAR_DAY, path.join(tmp, "bars/BINANCE_UM/BTCUSDT/1h/2024-10-02.bin"));
    // the same name on another broker is a different thing and stays a plain symbol
    mkdirSync(path.join(tmp, "bars/BACKTEST/BTCUSDT/1h"), { recursive: true });
    copyFileSync(BAR_DAY, path.join(tmp, "bars/BACKTEST/BTCUSDT/1h/2024-10-02.bin"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("shows it under its root, not also as a plain symbol of that venue", async () => {
    const scan = await scanStore(tmp);
    const root = scan.derivatives!.futures.find((f) => f.key === "BINANCE_UM:BTCUSDT")!;
    expect(root.perpetual!.bars.map((b) => b.tf)).toEqual(["1h"]);
    const sym = scan.symbols.find((s) => s.symbol === "BTCUSDT")!;
    expect(sym.bars.map((b) => b.broker)).toEqual(["BACKTEST"]);
  });
  it("a strategy on the perpetual is still ready on its bars", async () => {
    const r = readinessFor(await scanStore(tmp), "s.qkt", strat("BINANCE_UM:BTCUSDT EVERY 1h"));
    expect(r.bars.blocked.filter((b) => !/funding/i.test(b.reason))).toEqual([]);
    expect(r.bars.ranges.length).toBeGreaterThan(0);
  });
  it("keeps it as a plain symbol where no root carries it", async () => {
    const lone = mkdtempSync(path.join(os.tmpdir(), "perp-lone-"));
    try {
      mkdirSync(path.join(lone, "bars/BINANCE_UM/BTCUSDT/1h"), { recursive: true });
      copyFileSync(BAR_DAY, path.join(lone, "bars/BINANCE_UM/BTCUSDT/1h/2024-10-02.bin"));
      const scan = await scanStore(lone);
      expect(scan.symbols.find((s) => s.symbol === "BTCUSDT")!.bars.map((b) => b.broker)).toEqual(["BINANCE_UM"]);
    } finally { rmSync(lone, { recursive: true, force: true }); }
  });
});
