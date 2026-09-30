import { describe, it, expect } from "vitest";
import { localCompletions } from "./completions.js";
import type { ScanReport } from "../api/types.js";
import { setVocabulary } from "./vocabulary.js";
import { parseVocabulary } from "@qkt-studio/core/vocabulary";
import { readFileSync } from "node:fs";

// the vocabulary of the qkt the studio runs, captured with `qkt dsl vocabulary --json`
const vocab = parseVocabulary(JSON.parse(readFileSync(new URL("../../../core/test/fixtures/qkt-vocabulary.json", import.meta.url), "utf8")));
setVocabulary(vocab);

const SRC = `STRATEGY s VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m
    btc = BACKTEST:BTCUSD EVERY 1h

RULES
    WHEN ema(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1
`;
const scan = { symbols: [
  { symbol: "XAUUSD", market: "Mon-Fri", status: "mostly", bars: [{ broker: "BACKTEST", tf: "15m", files: 10, first: "2017-01-02", last: "2026-06-26" }, { broker: "BACKTEST", tf: "1h", files: 3, first: "2020-01-01", last: "2021-01-01" }] },
  { symbol: "BTCUSD", market: "24/7", status: "mostly", bars: [{ broker: "BACKTEST", tf: "15m", files: 10, first: "2018-01-01", last: "2026-09-05" }] },
] } as unknown as ScanReport;
/** Complete `SRC` + `tail` and ask at the very end of `tail`. */
const at = (tail: string, s: ScanReport | null = scan) => { const t = SRC + tail; const lines = t.split("\n"); return localCompletions(t, lines.length, lines[lines.length - 1]!.length + 1, s); };
const labels = (r: { items: Array<{ label: string }> }) => r.items.map((i) => i.label);

describe("local completions", () => {
  it("offers the stream fields right after `alias.` (qkt's own server returns nothing here)", () => {
    const r = at("    WHEN gold.");
    expect(r.exclusive).toBe(true);
    expect(labels(r)).toEqual(expect.arrayContaining(["close", "open", "high", "low", "volume"]));
    expect(labels(r)[0]).toBe("close");
  });
  it("offers declared aliases after POSITION. and qkt's own POSITION members after POSITION.alias.", () => {
    expect(labels(at("    WHEN POSITION."))).toEqual(["gold", "btc"]);
    expect(labels(at("    WHEN POSITION.gold."))).toEqual(vocab.members.POSITION);
  });
  it("offers every stream and meta field the vocabulary has after `alias.`, close first", () => {
    const l = labels(at("    WHEN gold."));
    expect([...l].sort()).toEqual([...vocab.streamFields, ...vocab.metaFields].sort());
    expect(l[0]).toBe("close");
  });
  it("lists the symbols found in the data source under a broker, with their span", () => {
    const r = localCompletions("SYMBOLS\n    x = BACKTEST:", 2, "    x = BACKTEST:".length + 1, scan);
    expect(labels(r)).toEqual(["XAUUSD", "BTCUSD"]);
    expect(r.items[0]!.detail).toContain("Mon-Fri");
  });
  it("offers the timeframes built for that symbol first after EVERY", () => {
    const r = localCompletions("SYMBOLS\n    x = BACKTEST:XAUUSD EVERY ", 2, "    x = BACKTEST:XAUUSD EVERY ".length + 1, scan);
    expect(labels(r).slice(0, 2)).toEqual(["15m", "1h"]);
    expect(r.items.find((i) => i.label === "4h")!.detail).toMatch(/not built/);
  });
  it("offers qkt's actions after THEN, the aliases after BUY, SIZING forms and a bracket snippet", () => {
    expect(labels(at("    THEN ")).filter((l) => /^[A-Z_]+$/.test(l))).toEqual(vocab.keywordCategories.ACTION);
    expect(labels(at("    THEN BUY "))).toEqual(["gold", "btc"]);
    expect(labels(at("    THEN BUY gold SIZING "))).toEqual(expect.arrayContaining(["0.1", "0.5 PCT RISK"]));
    const b = at("    THEN BUY gold SIZING 0.1 ");
    expect(labels(b)).toEqual(["BRACKET"]);
    expect(b.items[0]!.snippet).toBe(true);
  });
  it("starts a condition with the aliases but keeps qkt's functions (not exclusive)", () => {
    const r = at("    WHEN ");
    expect(labels(r)).toEqual(expect.arrayContaining(["gold", "btc", "POSITION"]));
    expect(r.exclusive).toBe(false);
  });
  it("still works with no scan yet, and gives nothing where it has nothing to add", () => {
    expect(labels(at("    WHEN gold.", null))).toContain("close");
    expect(at("-- a comment").items).toEqual([]);
  });
});

describe("portfolio completions", () => {
  const src = "PORTFOLIO book VERSION 1\n\nIMPORT 'trend.qkt' AS trend\nIMPORT 'fade.qkt' AS fade\n\nRULES\n    RUN trend\n";
  const at = (extra: string, files: string[] = ["strategies/book.qkt", "strategies/trend.qkt", "strategies/fade.qkt", "strategies/btc.qkt"], self = "strategies/book.qkt") => {
    const t = src + extra; const lines = t.split("\n");
    return localCompletions(t, lines.length, lines[lines.length - 1]!.length + 1, null, files, self);
  };
  it("offers the workspace's other .qkt files after IMPORT '", () => {
    const r = at("IMPORT '");
    expect(labels(r)).toEqual(["btc.qkt"]); // trend.qkt and fade.qkt are already imported; book.qkt is itself
    expect(r.exclusive).toBe(true);
  });
  it("inserts the closing quote and ` AS `", () => {
    const r = at("IMPORT '");
    expect(r.items[0]!.insert).toBe("btc.qkt' AS ");
  });
  it("offers the declared aliases after RUN, not qkt's keyword dump", () => {
    const r = at("    RUN ");
    expect(labels(r)).toEqual(["trend", "fade"]);
    expect(r.exclusive).toBe(true);
  });
  it("does not offer aliases after RUN ... OVERRIDE", () => {
    expect(at("    RUN trend OVERRIDE { x = 1 } RUN ").items).toEqual([]);
  });
  it("a plain strategy file never sees portfolio completions", () => {
    const r = localCompletions("STRATEGY s VERSION 1\n\nRULES\n    RUN ", 4, 9, null, ["a.qkt"], "s.qkt");
    expect(r.items).toEqual([]);
  });
});

describe("the studio's own context rules and snippets", () => {
  // Names that are not DSL: sample venues and symbols, and the module's own constants.
  const NOT_DSL = new Set(["BACKTEST", "XAUUSD", "EURUSD", "BTCUSD", "DEMOUSD", "TFS", "FIELD_DOC", "ACTION_DOC", "POSITION_DOC", "FIELD_ORDER"]);
  it("embed no keyword the vocabulary does not have", () => {
    for (const file of ["completions.ts", "snippets.ts"]) {
      // code only: comments and the prose of labels and descriptions are not DSL
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "")
        .replace(/\b(label|detail|doc|filter):\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g, "");
      const words = new Set([...src.matchAll(/\b[A-Z][A-Z_]+\b/g)].map((m) => m[0]).filter((w) => !NOT_DSL.has(w)));
      const unknown = [...words].filter((w) => !vocab.keywords.includes(w));
      expect(unknown, file).toEqual([]);
    }
  });
});
