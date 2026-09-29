import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkQktSource } from "../src/check.js";
import { testConfig, haveQkt } from "./helpers.js";
import { applyChanges } from "@qkt-studio/core";

describe.skipIf(!haveQkt)("the DSL cheat sheet", () => {
  it("every qkt block parses with the qkt the studio runs", async () => {
    const md = readFileSync(path.join(import.meta.dirname, "..", "assets", "dsl", "cheatsheet.md"), "utf8");
    const blocks = [...md.matchAll(/```qkt\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const cfg = testConfig("/tmp");
    for (const b of blocks) expect((await checkQktSource(cfg, b)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("every change operation produces DSL that qkt parses", async () => {
    const base = "STRATEGY t VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n    fx = BACKTEST:NZDUSD EVERY 4h\n\nPARAM fast = 9\n\nRULES\n    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, 21)\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n\n    WHEN POSITION.gold > 0 AND gold.close < ema(gold.close, 50)\n    THEN CLOSE gold\n";
    const out = applyChanges(base, [
      { op: "set_bracket", stop: "2%", target: 4 }, { op: "set_param", name: "fast", value: 12 }, { op: "set_sizing", sizing: "0.5 PCT RISK" },
      { op: "add_condition", expr: "ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)" }, { op: "exclude", dates: ["2026-08-14"], weekdays: ["fri"], hours_utc: [21] },
      { op: "add_symbol", alias: "silver", symbol: "XAGUSD", tf: "15m" }, { op: "add_rule", source: "WHEN POSITION.silver = 0 AND silver.close > 0\nTHEN BUY silver SIZING 0.1" },
    ]).source;
    expect((await checkQktSource(testConfig("/tmp"), out)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("set_bracket on two-word trailing-stop bracket syntax produces valid qkt", async () => {
    const baseWithTrailing = "STRATEGY trailing_test VERSION 1\n\nSYMBOLS\n    btc = BACKTEST:BTCUSD EVERY 15m\n\nRULES\n    WHEN ema(btc.close, 9) CROSSES ABOVE ema(btc.close, 21)\n    THEN BUY btc SIZING 0.1\n        BRACKET {\n          STOP LOSS TRAILING 5 AFTER MFE >= 10,\n          TAKE PROFIT BY 50\n        }\n";
    const out = applyChanges(baseWithTrailing, [{ op: "set_bracket", stop: 8 }, { op: "set_bracket", target: 100 }]).source;
    expect((await checkQktSource(testConfig("/tmp"), out)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
