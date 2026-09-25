import { describe, it, expect } from "vitest";
import { parseFilters, parseToken, suggest, toChips, parseDuration, tokenize } from "./filterQuery.js";

const H = 3_600_000;
describe("parseToken", () => {
  it("side / outcome / exit with aliases", () => {
    expect(parseToken("side:long").patch).toEqual({ side: "long" });
    expect(parseToken("side:sell").patch).toEqual({ side: "short" });
    expect(parseToken("outcome:wins").patch).toEqual({ outcome: "win" });
    expect(parseToken("result:losers").patch).toEqual({ outcome: "loss" });
    expect(parseToken("exit:sl").patch).toEqual({ exit: "stop" });
    expect(parseToken("exit:tp").patch).toEqual({ exit: "target" });
  });
  it("bare words find their filter", () => {
    expect(parseToken("stop").patch).toEqual({ exit: "stop" });
    expect(parseToken("win").patch).toEqual({ outcome: "win" });
    expect(parseToken("long").patch).toEqual({ side: "long" });
    expect(parseToken("mon").patch).toEqual({ weekday: 1 });
    expect(parseToken("2024-10-07").patch).toEqual({ day: "2024-10-07" });
    expect(parseToken("xauusd", ["BACKTEST:XAUUSD"]).patch).toBeUndefined(); // symbols are matched on their full or bare name only when given that way
    expect(parseToken("BACKTEST:XAUUSD", ["BACKTEST:XAUUSD"]).error).toBeDefined(); // `BACKTEST` is not a filter key
    expect(parseToken("symbol:xauusd", ["BACKTEST:XAUUSD"]).patch).toEqual({ symbol: "BACKTEST:XAUUSD" });
  });
  it("R comparisons", () => {
    expect(parseToken("r:>=1").patch).toEqual({ minR: 1, maxR: undefined });
    expect(parseToken("risk:>2R").patch).toEqual({ minR: 2, maxR: undefined });
    expect(parseToken("r:<0").patch!.maxR!).toBeLessThan(0);
    expect(parseToken("r:<=-1").patch).toEqual({ minR: undefined, maxR: -1 });
    expect(parseToken("r:-1..2").patch).toEqual({ minR: -1, maxR: 2 });
  });
  it("hold durations", () => {
    expect(parseToken("held:<1h").patch).toEqual({ minHoldMs: undefined, maxHoldMs: H });
    expect(parseToken("held:1h..4h").patch).toEqual({ minHoldMs: H, maxHoldMs: 4 * H });
    expect(parseToken("held:>1d").patch).toEqual({ minHoldMs: 24 * H, maxHoldMs: undefined });
    expect(parseToken("held:90m").patch).toEqual({ minHoldMs: 90 * 60_000, maxHoldMs: 90 * 60_000 });
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });
  it("pnl, day, weekday, hour", () => {
    expect(parseToken("pnl:>100").patch).toEqual({ minPnl: 100, maxPnl: undefined });
    expect(parseToken("pnl:<-50").patch).toEqual({ minPnl: undefined, maxPnl: -50 });
    expect(parseToken("weekday:friday").patch).toEqual({ weekday: 5 });
    expect(parseToken("hour:14").patch).toEqual({ hour: 14 });
    expect(parseToken("hour:25").error).toBeDefined();
    expect(parseToken("day:2024-13-40").error).toBeDefined();
  });
  it("explains what is wrong", () => {
    expect(parseToken("colour:red").error).toMatch(/Unknown filter/);
    expect(parseToken("side:up").error).toMatch(/long or short/);
    expect(parseToken("held:").error).toMatch(/needs a value/);
    expect(parseToken("banana").error).toMatch(/not a filter/);
  });
});

describe("parseFilters", () => {
  it("combines tokens, keeps the valid ones, reports the rest", () => {
    const r = parseFilters("side:long exit:stop r:>=1 nonsense");
    expect(r.patch).toMatchObject({ side: "long", exit: "stop", minR: 1 });
    expect(r.errors).toHaveLength(1);
  });
  it("a later bound replaces an earlier one of the same filter", () => {
    const r = parseFilters("held:>4h held:<1h");
    expect(r.patch.minHoldMs).toBeUndefined();
    expect(r.patch.maxHoldMs).toBe(H);
  });
  it("tokenises quotes", () => {
    expect(tokenize('side:long symbol:"A B" x')).toEqual(["side:long", "symbol:A B", "x"]);
  });
});

describe("toChips", () => {
  it("round-trips through the parser", () => {
    const f = { side: "short" as const, exit: "stop" as const, minR: 1, minHoldMs: H, maxHoldMs: 4 * H, day: "2024-10-07", weekday: 1, hour: 14, minPnl: 100 };
    const chips = toChips(f);
    expect(chips.map((c) => c.text)).toEqual(["side:short", "exit:stop", "r:>=1", "held:1h..4h", "pnl:>=100", "day:2024-10-07", "weekday:mon", "hour:14"]);
    const back = parseFilters(chips.map((c) => c.text).join(" ")).patch;
    expect(back).toMatchObject(f);
  });
  it("each chip's clear patch removes exactly its filter", () => {
    const chips = toChips({ side: "long", minHoldMs: H });
    expect(chips.find((c) => c.id === "held")!.clear).toEqual({ minHoldMs: undefined, maxHoldMs: undefined });
    expect(chips.find((c) => c.id === "side")!.clear).toEqual({ side: undefined });
  });
  it("a strict negative R bound reads back as r:<0", () => {
    expect(toChips({ maxR: parseToken("r:<0").patch!.maxR }).map((c) => c.text)).toEqual(["r:<0"]);
  });
});

describe("suggest", () => {
  const texts = (s: string, ctx = {}) => suggest(s, ctx).map((x) => x.text);
  it("offers the common filters when empty", () => { expect(texts("")).toContain("side:long"); });
  it("finds filters by what they mean", () => {
    expect(texts("stop")[0]).toBe("exit:stop");
    expect(texts("win")[0]).toBe("outcome:win");
    expect(texts("sl")).toContain("exit:stop");
    expect(texts("tp")).toContain("exit:target");
    expect(texts("mon")).toContain("weekday:mon");
  });
  it("completes a key's values", () => {
    expect(texts("exit:")).toEqual(["exit:target", "exit:stop", "exit:signal"]);
    expect(texts("side:s")).toEqual(["side:short"]);
    expect(texts("held:")).toContain("held:<1h");
  });
  it("offers what the user is typing when it is a valid comparison", () => {
    expect(texts("held:<30m")[0]).toBe("held:<30m");
    expect(texts("r:>3")[0]).toBe("r:>3");
  });
  it("completes symbols and days from the run", () => {
    expect(texts("symbol:x", { symbols: ["BACKTEST:XAUUSD", "BACKTEST:EURUSD"] })).toEqual(["symbol:XAUUSD"]);
    expect(texts("day:2024-10-0", { days: ["2024-10-05", "2024-10-07", "2024-11-01"] })).toEqual(["day:2024-10-07", "day:2024-10-05"]);
  });
  it("does not suggest what is already applied", () => {
    expect(texts("side:", { active: { side: "long" } })).toEqual(["side:short"]);
  });
  it("only looks at the word being typed", () => { expect(texts("side:long exit:st")).toEqual(["exit:stop"]); });
  it("lists key templates while typing a key", () => { expect(suggest("we").map((s) => s.text)).toContain("weekday:"); });
});

describe("entry and exit time, size and trade number", () => {
  const ms = (s: string) => Date.parse(s + "T00:00:00Z");
  it("entry accepts a day, a month, comparisons and a range", () => {
    expect(parseFilters("entry:2024-10-07").patch).toMatchObject({ fromTs: ms("2024-10-07"), toTs: ms("2024-10-08") });
    expect(parseFilters("entry:2024-10").patch).toMatchObject({ fromTs: ms("2024-10-01"), toTs: ms("2024-11-01") });
    expect(parseFilters("entry:>=2024-10-15").patch).toMatchObject({ fromTs: ms("2024-10-15") });
    expect(parseFilters("entry:>2024-10-15").patch).toMatchObject({ fromTs: ms("2024-10-16") });
    expect(parseFilters("entry:<2024-10-01").patch).toMatchObject({ toTs: ms("2024-10-01") });
    expect(parseFilters("entry:2024-10-01..2024-10-15").patch).toMatchObject({ fromTs: ms("2024-10-01"), toTs: ms("2024-10-16") });
  });
  it("exited uses the exit-time fields and a bare month means entry", () => {
    expect(parseFilters("exited:2024-11").patch).toMatchObject({ exitFromTs: ms("2024-11-01"), exitToTs: ms("2024-12-01") });
    expect(parseFilters("2024-10").patch).toMatchObject({ fromTs: ms("2024-10-01") });
  });
  it("size, trade number and #n", () => {
    expect(parseFilters("size:>=0.5").patch).toMatchObject({ minQty: 0.5 });
    expect(parseFilters("size:0.1..0.5").patch).toMatchObject({ minQty: 0.1, maxQty: 0.5 });
    expect(parseFilters("trade:12").patch).toMatchObject({ id: 12 });
    expect(parseFilters("#7").patch).toMatchObject({ id: 7 });
  });
  it("rejects nonsense with a hint", () => {
    expect(parseFilters("entry:tomorrow").errors[0]).toMatch(/entry:/);
    expect(parseFilters("trade:abc").errors[0]).toMatch(/trade:/);
    expect(parseFilters("size:big").errors[0]).toMatch(/size:/);
  });
  it("chips round-trip a range and are removable", () => {
    const f = parseFilters("entry:2024-10-01..2024-10-15 size:>=1 trade:3").patch;
    const chips = toChips(f).map((c) => c.text);
    expect(chips).toEqual(expect.arrayContaining(["entry:2024-10-01..2024-10-15", "size:>=1", "trade:3"]));
    expect(parseFilters(chips.join(" ")).patch).toMatchObject({ fromTs: f.fromTs, toTs: f.toTs, minQty: 1, id: 3 });
  });
  it("suggests months and days of the run under entry:", () => {
    const s = suggest("entry:2024-1", { days: ["2024-10-01", "2024-10-02", "2024-11-03"] }).map((x) => x.text);
    expect(s).toContain("entry:2024-10");
    expect(s).toContain("entry:2024-11");
  });
});
