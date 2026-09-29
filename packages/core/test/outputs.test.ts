import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { classifyLine, parseIncomplete, parseMissingBarDays, parseBuildBarsHint, normalizeError, extractJsonDocs } from "../src/outputs.js";

const fx = (n: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");

describe("classifyLine (real engine lines)", () => {
  it("tick and bar coverage", () => {
    expect(classifyLine("qkt: tick coverage XAUUSD 26/27 trading days")).toEqual({ kind: "coverage", source: "tick", symbol: "XAUUSD", covered: 26, requested: 27, tf: undefined });
    expect(classifyLine("qkt: bar coverage BACKTEST:XAUUSD 313/313 trading days (15m)")).toMatchObject({ kind: "coverage", source: "bar", covered: 313, tf: "15m" });
  });
  it("order fills carry side/qty/price", () => {
    const l = "12:00:46.372 [main] INFO  [main] com.qkt.app.OrderManager - order filled order_id=ORD-0 strategy_id=xau_ema symbol=BACKTEST:XAUUSD side=BUY qty=0.10 price=4429.69000000";
    expect(classifyLine(l)).toEqual({ kind: "fill", orderId: "ORD-0", strategy: "xau_ema", symbol: "BACKTEST:XAUUSD", side: "BUY", qty: 0.1, price: 4429.69 });
  });
  it("order submissions", () => {
    const l = "12:00:46.357 [main] INFO  [main] com.qkt.app.TradingPipeline - submit Market ORD-0 BACKTEST:XAUUSD BUY GTC qty=0.1  lastPrice=4429.69000000";
    expect(classifyLine(l)).toEqual({ kind: "order", symbol: "BACKTEST:XAUUSD", side: "BUY" });
  });
  it("strategy LOG actions", () => {
    const l = "12:00:46.341 [main] INFO  [main] com.qkt.dsl.strategy.xau_ema - long entry";
    expect(classifyLine(l)).toEqual({ kind: "strategyLog", strategy: "xau_ema", message: "long entry" });
  });
  it("warnings survive the container's non-UTF-8 dash", () => {
    expect(classifyLine("qkt: WARNING \u2014 running with incomplete data:")).toMatchObject({ kind: "warning", message: "running with incomplete data:" });
    expect(classifyLine("qkt: WARNING ? --bars: incomplete built bars for X")).toMatchObject({ kind: "warning" });
  });
  it("errors and everything else", () => {
    expect(classifyLine("qkt: error: unknown risk key(s): nope")).toEqual({ kind: "error", message: "unknown risk key(s): nope" });
    expect(classifyLine("12:00:45.818 [main] INFO  [main] c.qkt.app.PerStreamWarmupCoordinator - warmup: seeded hub")).toMatchObject({ kind: "log" });
  });
});

describe("parseIncomplete", () => {
  it("reads the per-day hole list (MLK day, Good Friday)", () => {
    const h = parseIncomplete(fx("err-incomplete.txt"));
    expect(h).toEqual([
      { day: "2026-01-19", status: "incomplete", emptyHours: [20, 21, 22] },
      { day: "2026-02-16", status: "incomplete", emptyHours: [20, 21, 22] },
      { day: "2026-04-02", status: "incomplete", emptyHours: [21, 22] },
      { day: "2026-04-03", status: "missing", emptyHours: [] },
    ]);
  });
  it("ignores unrelated text", () => expect(parseIncomplete("nothing here\n  re-run with --allow-incomplete")).toEqual([]));
});

describe("bar coverage hints", () => {
  const t = fx("err-unknown-symbol.txt");
  it("extracts the missing days and the build-bars remedy", () => {
    expect(parseMissingBarDays(t)).toEqual(["2024-10-01", "2024-10-02", "2024-10-03", "2024-10-04"]);
    expect(parseBuildBarsHint(t)).toMatch(/^qkt data build-bars NOPE --tf 15m/);
  });
});

describe("normalizeError (real failures)", () => {
  it("syntax error keeps its real position", () => {
    expect(normalizeError(fx("err-parse.txt"), 1)).toEqual({ kind: "parse", message: "expected expression, got ''", file: "/tmp/bad4.qkt", line: 12, col: 1 });
  });
  it("unknown indicator is its own kind (position 1:1 is a qkt limitation)", () => {
    expect(normalizeError(fx("err-unknown-indicator.txt"), 1)).toMatchObject({ kind: "unknown_indicator", message: "Unknown indicator: emaa", line: 1, col: 1 });
  });
  it("bad YAML: stack trace becomes a one-line error with position", () => {
    const e = normalizeError(fx("err-bad-yaml.txt"), 1);
    expect(e.kind).toBe("bad_config_yaml");
    expect(e.line).toBe(1);
    expect(e.col).toBe(12);
    expect(e.message).not.toMatch(/at org\.snakeyaml/);
  });
  it("unknown risk key", () => {
    expect(normalizeError(fx("err-unknown-risk-key.txt"), 1)).toEqual({ kind: "bad_config_key", message: "Unknown risk key(s) in config: nope" });
  });
  it("0/4 bar days is missing_data with the build-bars fix", () => {
    const e = normalizeError(fx("err-unknown-symbol.txt"), 1);
    expect(e.kind).toBe("missing_data");
    expect(e.message).toMatch(/qkt data build-bars NOPE/);
  });
  it("partially covered ticks is incomplete_data", () => {
    expect(normalizeError(fx("err-incomplete.txt"), 1).kind).toBe("incomplete_data");
  });
  it("file not found and generic crashes", () => {
    expect(normalizeError("qkt: error: file not found: strategies/x.qkt", 1)).toMatchObject({ kind: "file_not_found", file: "strategies/x.qkt" });
    expect(normalizeError("qkt: error: something odd", 1)).toEqual({ kind: "engine_crash", message: "something odd" });
    expect(normalizeError('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\n\tat x', 137)).toMatchObject({ kind: "engine_crash", message: expect.stringContaining("OutOfMemoryError") });
    expect(normalizeError("", 137)).toEqual({ kind: "engine_crash", message: "qkt exited with code 137" });
  });
});

describe("extractJsonDocs", () => {
  it("finds the one sweep array among 3,678 log lines", () => {
    const docs = extractJsonDocs(fx("sweep-mixed-stdout.txt"));
    expect(docs.length).toBe(1);
    const rows = docs[0] as Array<{ label: string; sharpe: number }>;
    expect(rows.length).toBe(6);
    expect(rows[0]!.label).toBe("fast=13,slow=34");
  });
  it("handles pretty-printed multi-line objects, braces inside strings, and no JSON", () => {
    const s = 'noise\n{\n  "a": "}{",\n  "b": [1, 2, {"c": "\\"}"}]\n}\nmore noise\n[1,2]\n';
    expect(extractJsonDocs(s)).toEqual([{ a: "}{", b: [1, 2, { c: '"}' }] }, [1, 2]]);
    expect(extractJsonDocs("just logs\nmore logs")).toEqual([]);
    expect(extractJsonDocs("")).toEqual([]);
  });
  it("skips a truncated document instead of throwing", () => {
    expect(extractJsonDocs('{"a": [1, 2')).toEqual([]);
  });
});

describe("incomplete data names the symbol that is short, with its own coverage", () => {
  it("a second symbol with no bars: the first symbol's full coverage does not hide it, and the broker is not the name", () => {
    const text = [
      "qkt: bar coverage BACKTEST:XAUUSD 26/26 trading days (15m)",
      "qkt: bar coverage BACKTEST:NZDUSD 0/26 trading days (30m)",
      "Exception in thread \"main\" com.qkt.backtest.IncompleteDataException: --bars: incomplete built bars for BACKTEST:NZDUSD: 0/26 trading days; missing 2026-08-11,2026-08-12. Run: qkt data build-bars NZDUSD --tf 30m --from 2026-08-11 --to 2026-09-10",
      "  re-run with --allow-incomplete to proceed anyway",
    ].join("\n");
    expect(normalizeError(text)).toMatchObject({
      kind: "missing_data",
      message: "No data for NZDUSD 30m bars (0 of 26 trading days in the window have data). Fix: qkt data build-bars NZDUSD --tf 30m --from 2026-08-11 --to 2026-09-10",
    });
  });
  it("ticks: the tick coverage line of that symbol", () => {
    const text = "qkt: tick coverage EURUSD 7/9 trading days\nqkt: error: incomplete data for EURUSD:\n  2026-09-07  incomplete (empty hours 19,20,21)\n  re-run with --allow-incomplete to proceed anyway";
    expect(normalizeError(text)).toMatchObject({ kind: "incomplete_data", message: expect.stringMatching(/^Incomplete data for EURUSD \(7 of 9 trading days/) });
  });
});
