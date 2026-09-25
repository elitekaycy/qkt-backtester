import { describe, it, expect } from "vitest";
import type { Readiness, ScanReport, SymbolReport, YearRow } from "@qkt-studio/core";
import { clipRanges, defaultWindow, gapDaysIn, insideRanges, monthGrids, recomputeReadiness, yearChip } from "./datawindow.js";

const yr = (o: Partial<YearRow>): YearRow => ({ year: 2020, days: 366, ok: 250, closed: 116, thin: 0, missing: 0, status: "complete", full: true, ...o });

describe("yearChip", () => {
  it("a full clean year is ok and not partial", () => {
    const c = yearChip(yr({}), "2017-01-02", "2026-06-26");
    expect(c).toMatchObject({ tone: "ok", full: true, partial: null, span: null });
  });
  it("the first and last calendar years are partial, and stay green when nothing is missing inside the span", () => {
    const first = yearChip(yr({ year: 2017, days: 200, full: false }), "2017-06-01", "2026-06-26");
    expect(first).toMatchObject({ tone: "ok", partial: "start", span: "from Jun", full: false });
    expect(first.title).toMatch(/Partial year/);
    const last = yearChip(yr({ year: 2026, days: 177, full: false }), "2017-06-01", "2026-06-26");
    expect(last).toMatchObject({ tone: "ok", partial: "end", span: "to Jun" });
    expect(yearChip(yr({ year: 2021, days: 60, full: false }), "2021-03-01", "2021-04-30")).toMatchObject({ partial: "both", span: "Mar–Apr" });
  });
  it("a start on Jan 2 (first trading day) is not partial", () => {
    expect(yearChip(yr({ year: 2017, full: true }), "2017-01-02", "2026-06-26").partial).toBeNull();
  });
  it("tone follows the missing share inside the year, not the calendar", () => {
    expect(yearChip(yr({ missing: 3 }), null, null).tone).toBe("warn");    // 3/366 < 2%
    expect(yearChip(yr({ missing: 40 }), null, null).tone).toBe("bad");
    expect(yearChip(yr({ days: 0, ok: 0, closed: 0 }), null, null).tone).toBe("empty");
  });
});

describe("windows", () => {
  const ranges = [{ from: "2020-01-01", to: "2024-01-01" }, { from: "2024-03-01", to: "2026-01-01" }];
  it("clips to the per-symbol from/to of the symbols a strategy reads, and ignores others", () => {
    const prefs = { A: { from: "2021-01-01", to: "2025-01-01" }, B: { from: "2022-01-01" }, C: { from: "2030-01-01" } };
    expect(clipRanges(ranges, prefs, ["A", "B"])).toEqual([{ from: "2022-01-01", to: "2024-01-01" }, { from: "2024-03-01", to: "2025-01-01" }]);
    expect(clipRanges(ranges, prefs, ["Z"])).toBe(ranges);
    expect(clipRanges(ranges, { A: { from: "2027-01-01" } }, ["A"])).toEqual([]);
  });
  it("insideRanges needs one range to contain the whole window (end exclusive)", () => {
    expect(insideRanges("2020-06-01", "2020-07-01", ranges)).toBe(true);
    expect(insideRanges("2023-12-01", "2024-02-01", ranges)).toBe(false);
    expect(insideRanges("2024-03-01", "2026-01-01", ranges)).toBe(true);
    expect(insideRanges("2024-03-01", "2024-03-01", ranges)).toBe(false);
  });
  it("defaultWindow is the last 30 days of the latest range, or the whole range when shorter", () => {
    expect(defaultWindow(ranges)).toEqual({ from: "2025-12-02", to: "2026-01-01" });
    expect(defaultWindow([{ from: "2025-12-20", to: "2026-01-01" }])).toEqual({ from: "2025-12-20", to: "2026-01-01" });
    expect(defaultWindow([])).toBeNull();
  });
  it("gapDaysIn counts only the overlap", () => {
    expect(gapDaysIn([{ from: "2021-01-05", to: "2021-01-08" }, { from: "2021-02-01", to: "2021-02-02" }], "2021-01-06", "2021-02-01")).toBe(2);
  });
});

describe("recomputeReadiness", () => {
  const tf = (usable: Array<{ from: string; to: string }>) => ({ broker: "BACKTEST", tf: "15m", files: 10, first: usable[0]!.from, last: usable.at(-1)!.to, span: 10, ok: 10, closed: 0, thin: 0, missing: 0, status: "complete" as const, usable, gaps: [], years: [], always: false });
  const sym = (symbol: string, usable: Array<{ from: string; to: string }>): SymbolReport => ({ symbol, ticks: null, bars: [tf(usable)], status: "complete", market: "Mon-Fri", completeYears: 1, spanYears: 1, notes: [] });
  const scan = { dataRoot: "/d", scannedAt: "", ms: 1, looksLikeStore: true, symbols: [sym("A", [{ from: "2020-01-01", to: "2022-01-01" }])], totals: {} } as unknown as ScanReport;
  const r = { strategy: "s.qkt", kind: "strategy", streams: [{ alias: "a", broker: "BACKTEST", symbol: "A", tf: "15m" }], bars: { runnable: false, ranges: [], longest: null, blocked: [] }, ticks: { runnable: false, ranges: [], longest: null, blocked: [] } } as unknown as Readiness;
  it("uses the report of the chosen source and the per-symbol window", () => {
    const other = sym("A", [{ from: "2018-01-01", to: "2024-01-01" }]);
    const out = recomputeReadiness(r, scan, { A: { from: "2019-01-01", to: "2023-01-01" } }, { A: other });
    expect(out.bars.ranges).toEqual([{ from: "2019-01-01", to: "2023-01-01" }]);
    expect(out.bars.runnable).toBe(true);
    expect(out.ticks.runnable).toBe(false);
    expect(out.ticks.blocked[0]!.reason).toMatch(/no tick files/);
  });
  it("a symbol missing from the store blocks with a fetch fix", () => {
    const out = recomputeReadiness({ ...r, streams: [{ alias: "z", broker: "BACKTEST", symbol: "Z", tf: "15m" }] } as Readiness, scan, {}, {});
    expect(out.bars.blocked[0]).toMatchObject({ fix: "fetch" });
  });
});

describe("monthGrids", () => {
  it("groups a status string into years and months with the weekday offset and missing counts", () => {
    const g = monthGrids("2024-01-30", "ommo");   // Jan 30, Jan 31, Feb 1, Feb 2
    expect(g).toHaveLength(1);
    expect(g[0]!.months.map((m) => [m.label, m.cells.length, m.missing])).toEqual([["Jan", 2, 1], ["Feb", 2, 1]]);
    expect(g[0]!.months[0]!.lead).toBe(1);   // Jan 30 2024 is a Tuesday: Monday-first offset 1
  });
});
