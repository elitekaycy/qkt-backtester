import { describe, it, expect } from "vitest";
import { lintAliases, relocate, redactConfig, checkConfig, KNOWN_CONFIG_KEYS } from "../src/lint.js";

const strat = (rules: string, symbols = "    gold = BACKTEST:XAUUSD EVERY 15m") =>
  `STRATEGY t VERSION 1\n\nSYMBOLS\n${symbols}\n\nRULES\n${rules}\n`;

describe("lintAliases", () => {
  it("flags the silent zero-trade case: undeclared alias in a condition", () => {
    const d = lintAliases(strat("    WHEN ema(gld.close, 9) CROSSES ABOVE ema(gold.close, 21)\n    THEN BUY gold SIZING 0.1"));
    expect(d.length).toBe(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "unknown_alias", line: 7, col: 14, endCol: 17 });
    expect(d[0]!.message).toMatch(/Declared in SYMBOLS: gold/);
  });
  it("accepts declared aliases, including several and any prefix", () => {
    const sym = "    a = BACKTEST:XAUUSD EVERY 15m\n    b = MT5:EURUSD EVERY 1h";
    expect(lintAliases(strat("    WHEN a.close > b.close\n    THEN BUY a SIZING 1", sym))).toEqual([]);
  });
  it("does not flag non-stream dotted names, POSITION on declared aliases, comments or strings", () => {
    const rules = [
      "    -- gld.close is only a comment",
      '    WHEN gold.close > 1 AND POSITION.gold = 0',
      '    THEN BUY gold SIZING 0.1 ; LOG "gld.close in a string"',
    ].join("\n");
    expect(lintAliases(strat(rules))).toEqual([]);
    expect(lintAliases(strat("    WHEN x.notafield > 1\n    THEN BUY gold SIZING 1"))).toEqual([]);
  });
  it("warns on POSITION.<unknown>", () => {
    const d = lintAliases(strat("    WHEN gold.close > 1 AND POSITION.gld = 0\n    THEN BUY gold SIZING 1"));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", line: 7 });
  });
  it("flags several bad references on one line and reports real columns", () => {
    const d = lintAliases(strat("    WHEN q.close > r.high\n    THEN BUY gold SIZING 1"));
    expect(d.map((x) => x.col)).toEqual([10, 20]);
  });
  it("ignores files that are not strategies", () => {
    expect(lintAliases("PORTFOLIO p\n  x.close > 1")).toEqual([]);
    expect(lintAliases("")).toEqual([]);
  });
  it("handles CRLF", () => {
    const d = lintAliases(strat("    WHEN gld.close > 1\n    THEN BUY gold SIZING 1").replace(/\n/g, "\r\n"));
    expect(d).toHaveLength(1);
  });
});

describe("relocate", () => {
  const src = strat("    WHEN emaa(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)\n    THEN BUY gold SIZING 0.1");
  it("finds an unknown indicator that qkt reports at 1:1", () => {
    expect(relocate(src, "Unknown indicator: emaa")).toEqual({ line: 7, col: 10, endCol: 14 });
  });
  it("finds an unknown alias but skips the SYMBOLS declaration", () => {
    const s = strat("    WHEN gold.close > 1\n    THEN BUY gld SIZING 1");
    expect(relocate(s, "Unknown stream alias: gld")).toEqual({ line: 8, col: 14, endCol: 17 });
  });
  it("returns null for messages it does not understand or identifiers that are absent", () => {
    expect(relocate(src, "something else")).toBeNull();
    expect(relocate(src, "Unknown indicator: nothere")).toBeNull();
  });
});

describe("redactConfig", () => {
  const yaml = [
    "starting_balance: 10000  # keep",
    "brokers:",
    "  demo:",
    "    api_key: abc123",
    '    gateway_url: "http://gw:5001"',
    "    password: 'p@ss'  # note",
    "notify:",
    "  telegram:",
    "    bot_token: ${TG_TOKEN}",
    "    chat: ${CHAT_ID}",
    "    api_secret:",
  ].join("\n");
  const r = redactConfig(yaml);
  it("hides secret values and env expansions but keeps structure and comments", () => {
    expect(r).toContain("api_key: ***");
    expect(r).toContain("password: ***  # note");
    expect(r).toContain("bot_token: ***");
    expect(r).toContain("chat: ${***}");
    expect(r).not.toMatch(/abc123|p@ss|TG_TOKEN|CHAT_ID/);
    expect(r).toContain("starting_balance: 10000  # keep");
    expect(r).toContain('gateway_url: "http://gw:5001"');
    expect(r.split("\n").length).toBe(yaml.split("\n").length);
  });
  it("leaves an empty secret key empty and is idempotent", () => {
    expect(r).toContain("api_secret:");
    expect(redactConfig(r)).toBe(r);
  });
});

describe("checkConfig", () => {
  const good = "source: tv\ndata_root: /data\nstarting_balance: 10000\n";
  it("passes a normal config", () => expect(checkConfig(good, true, { QKT_DATA_HOME: "/data" })).toEqual([]));
  it("a missing file is an error (qkt would silently use defaults)", () => {
    const f = checkConfig(null, false, {});
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "error", code: "missing_config" });
  });
  it("bad YAML is an error with a position", () => {
    const f = checkConfig("data_root: [unclosed\n", true, {});
    expect(f[0]).toMatchObject({ severity: "error", code: "bad_config_yaml" });
    expect(f[0]!.line).toBeGreaterThan(0);
  });
  it("unknown top-level keys warn with a line number; known keys never warn", () => {
    const f = checkConfig("source: tv\nbogus_key: 1\nrisk:\n  max_daily_loss: 5\n", true, {});
    expect(f).toEqual([expect.objectContaining({ severity: "warning", code: "unknown_key", line: 2 })]);
    for (const k of KNOWN_CONFIG_KEYS) expect(checkConfig(`${k}: {}\n`, true, {}).filter((x) => x.code === "unknown_key")).toEqual([]);
  });
  it("warns when data_root differs from QKT_DATA_HOME (bars ignore data_root)", () => {
    const f = checkConfig("data_root: /home/me/.qkt/data\n", true, { QKT_DATA_HOME: "/data" });
    expect(f.map((x) => x.code)).toEqual(["data_root_mismatch"]);
    expect(checkConfig("data_root: /data/\n", true, { QKT_DATA_HOME: "/data" })).toEqual([]);
  });
  it("an empty file is fine; a non-mapping is an error", () => {
    expect(checkConfig("", true, {})).toEqual([]);
    expect(checkConfig("- a\n- b\n", true, {})[0]).toMatchObject({ code: "bad_config_yaml" });
  });
});

import { anchorParseError } from "../src/lint.js";
describe("anchorParseError", () => {
  const src = "STRATEGY a VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n    fx = BACKTEST: \n\nRULES\n";
  it("moves a next-line 'got' error to the end of the unfinished line", () => {
    const r = anchorParseError(src, { line: 7, col: 1, endCol: 2, message: "expected symbol after ':', got 'RULES'" });
    expect(r.line).toBe(5);
    expect(r.col).toBe("    fx = BACKTEST:".length + 1);
    expect(r.message).toMatch(/unfinished line 5/);
  });
  it("leaves errors inside a line, and other messages, alone", () => {
    const a = { line: 4, col: 12, endCol: 13, message: "expected symbol after ':', got 'X'" };
    expect(anchorParseError(src, a)).toEqual(a);
    const b = { line: 7, col: 1, endCol: 2, message: "Unknown indicator: foo" };
    expect(anchorParseError(src, b)).toEqual(b);
  });
});
