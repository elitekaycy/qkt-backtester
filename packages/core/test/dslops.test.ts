import { describe, it, expect } from "vitest";
import { applyChanges, ChangeError, lineDiff, describeRules } from "../src/dslops.js";

const SRC = `STRATEGY xau_both VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m
    fx =  BACKTEST:NZDUSD EVERY 4h

PARAM fast = 9

RULES
    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1
        BRACKET {
          STOP_LOSS BY 2,
          TAKE_PROFIT BY 24
        }

    WHEN ema(gold.close, fast) CROSSES BELOW ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN SELL gold SIZING 0.1

    WHEN POSITION.gold > 0 AND gold.close < ema(gold.close, 50)
    THEN CLOSE gold
`;

describe("set_bracket", () => {
  it("changes every entry rule's stop, adds a BRACKET where missing, and leaves the exit-only rule alone", () => {
    const r = applyChanges(SRC, [{ op: "set_bracket", stop: "2%" }]);
    expect(r.source).toContain("BRACKET { STOP_LOSS BY 2 PCT, TAKE_PROFIT BY 24 }");
    expect(r.source).toMatch(/THEN SELL gold SIZING 0\.1\n\s+BRACKET \{ STOP_LOSS BY 2 PCT \}/);
    expect(r.source).toMatch(/THEN CLOSE gold\n$/);
    expect(r.notes.join(" ")).toMatch(/rule 1.*rule 2 \(added a BRACKET\)/);
  });
  it("targets one rule by number or text, and accepts BY / AT / plain numbers", () => {
    const r = applyChanges(SRC, [{ op: "set_bracket", rule: 1, target: 6 }, { op: "set_bracket", rule: "CROSSES BELOW", stop: "AT gold.close + 10" }]);
    expect(r.source).toContain("BRACKET { STOP_LOSS BY 2, TAKE_PROFIT BY 6 }");
    expect(r.source).toContain("BRACKET { STOP_LOSS AT gold.close + 10 }");
  });
  it("refuses a spec it cannot read, and a rule that does not exist", () => {
    expect(() => applyChanges(SRC, [{ op: "set_bracket", stop: "a lot" }])).toThrow(ChangeError);
    expect(() => applyChanges(SRC, [{ op: "set_bracket", rule: 9, stop: 2 }])).toThrow(/no rule 9; rules: 1: WHEN ema/);
  });
});

describe("params, sizing, conditions", () => {
  it("set_param replaces or adds", () => {
    expect(applyChanges(SRC, [{ op: "set_param", name: "fast", value: 12 }]).source).toContain("PARAM fast = 12");
    expect(applyChanges(SRC, [{ op: "set_param", name: "slow", value: 30 }]).source).toMatch(/PARAM fast = 9\nPARAM slow = 30\n/);
  });
  it("set_sizing changes entry rules only", () => {
    const r = applyChanges(SRC, [{ op: "set_sizing", sizing: "0.5 PCT RISK" }]).source;
    expect(r.match(/SIZING 0\.5 PCT RISK/g)!.length).toBe(2);
  });
  it("add_condition goes before THEN with the rule's indentation; remove_condition promotes the next line when WHEN goes", () => {
    const a = applyChanges(SRC, [{ op: "add_condition", rule: 1, expr: "ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)" }]).source;
    expect(a).toContain("     AND POSITION.gold = 0\n     AND ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)\n    THEN BUY");
    const b = applyChanges(SRC, [{ op: "remove_condition", rule: 1, match: "crosses above" }]).source;
    expect(b).toContain("    WHEN POSITION.gold = 0\n    THEN BUY gold");
    expect(() => applyChanges(SRC, [{ op: "remove_condition", rule: 3, match: "POSITION.gold > 0" }])).toThrow(/needs a condition/);
  });
});

describe("exclude", () => {
  it("turns dates, weekday names and hours into NOW conditions on entry rules", () => {
    const r = applyChanges(SRC, [{ op: "exclude", dates: ["2026-08-14", "2026/08/15"], weekdays: ["Friday"], hours_utc: [21, 22] }]).source;
    expect(r).toContain("AND NOT (NOW.date_utc IN [20679, 20680])");
    expect(r).toContain("AND NOT (NOW.weekday IN [4])");
    expect(r).toContain("AND NOT (NOW.hour_utc IN [21, 22])");
    expect(r.match(/NOW\.date_utc/g)!.length).toBe(2); // rules 1 and 2, not the exit rule
  });
  it("refuses an impossible date or weekday and changes nothing", () => {
    expect(() => applyChanges(SRC, [{ op: "exclude", dates: ["2026-02-30"] }])).toThrow(/2026-02-30/);
    expect(() => applyChanges(SRC, [{ op: "exclude", weekdays: ["funday"] }])).toThrow(/funday/);
  });
});

describe("rules, symbols, text", () => {
  it("add_rule appends with the file's indentation; remove_rule needs exactly one match", () => {
    const a = applyChanges(SRC, [{ op: "add_rule", source: "WHEN POSITION.gold < 0 AND gold.close > ema(gold.close, 50)\nTHEN CLOSE gold" }]).source;
    expect(a).toMatch(/THEN CLOSE gold\n\n    WHEN POSITION\.gold < 0 AND gold\.close > ema\(gold\.close, 50\)\n    THEN CLOSE gold\n$/);
    expect(() => applyChanges(SRC, [{ op: "remove_rule", match: "POSITION.gold = 0" }])).toThrow(/2 rules match/);
    expect(applyChanges(SRC, [{ op: "remove_rule", match: "THEN CLOSE" }]).source).not.toContain("CLOSE gold");
  });
  it("add_symbol adds a stream line; replace_text needs a unique match", () => {
    expect(applyChanges(SRC, [{ op: "add_symbol", alias: "silver", symbol: "XAGUSD", tf: "15m" }]).source).toContain("    silver = BACKTEST:XAGUSD EVERY 15m\n");
    expect(() => applyChanges(SRC, [{ op: "add_symbol", alias: "gold", symbol: "XAGUSD", tf: "15m" }])).toThrow(/already/);
    expect(() => applyChanges(SRC, [{ op: "replace_text", find: "SIZING 0.1", replace: "SIZING 0.2" }])).toThrow(/2 places/);
  });
  it("refuses portfolio files", () => {
    expect(() => applyChanges("PORTFOLIO p VERSION 1\n\nRULES\n    RUN a\n", [{ op: "set_param", name: "x", value: 1 }])).toThrow(/STRATEGY files/);
  });
});

describe("lineDiff and describeRules", () => {
  it("shows each changed block with its line number", () => {
    const d = lineDiff(SRC, applyChanges(SRC, [{ op: "set_param", name: "fast", value: 12 }]).source);
    expect(d).toBe("@@ line 7\n-PARAM fast = 9\n+PARAM fast = 12\n");
  });
  it("lists rules with whether they enter", () => {
    expect(describeRules(SRC).map((r) => [r.n, r.entry])).toEqual([[1, true], [2, true], [3, false]]);
  });
});
