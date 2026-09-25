import { describe, it, expect } from "vitest";
import { runsOf, gapsOf, intersectAll, longest, rangeDays, completeness, yearRows, isoDay, dayMs } from "../src/ranges.js";

const seq = (start: string, pattern: string) => [...pattern].map((c, i) => ({ day: isoDay(dayMs(start) + i * 86_400_000), ok: c === "x" }));

describe("runsOf / gapsOf", () => {
  it("finds contiguous runs with an exclusive end", () => {
    expect(runsOf(seq("2024-01-01", "xxx.xx"))).toEqual([{ from: "2024-01-01", to: "2024-01-04" }, { from: "2024-01-05", to: "2024-01-07" }]);
    expect(gapsOf(seq("2024-01-01", "xxx.xx"))).toEqual([{ from: "2024-01-04", to: "2024-01-05" }]);
  });
  it("handles all-ok, all-bad, empty and month/year boundaries", () => {
    expect(runsOf(seq("2023-12-30", "xxxx"))).toEqual([{ from: "2023-12-30", to: "2024-01-03" }]);
    expect(runsOf(seq("2024-01-01", "...."))).toEqual([]);
    expect(runsOf([])).toEqual([]);
    expect(gapsOf(seq("2024-02-28", "x..x"))).toEqual([{ from: "2024-02-29", to: "2024-03-02" }]); // leap day
  });
});

describe("intersectAll", () => {
  const a = [{ from: "2024-01-01", to: "2024-02-01" }, { from: "2024-03-01", to: "2024-04-01" }];
  const b = [{ from: "2024-01-15", to: "2024-03-15" }];
  it("keeps only windows inside every set", () => {
    expect(intersectAll([a, b])).toEqual([{ from: "2024-01-15", to: "2024-02-01" }, { from: "2024-03-01", to: "2024-03-15" }]);
    expect(intersectAll([a])).toEqual(a);
  });
  it("is empty when nothing overlaps, when a set is empty, or when there are no sets", () => {
    expect(intersectAll([a, [{ from: "2025-01-01", to: "2025-02-01" }]])).toEqual([]);
    expect(intersectAll([a, []])).toEqual([]);
    expect(intersectAll([])).toEqual([]);
  });
  it("touching ranges do not overlap (exclusive end)", () => {
    expect(intersectAll([[{ from: "2024-01-01", to: "2024-01-10" }], [{ from: "2024-01-10", to: "2024-01-20" }]])).toEqual([]);
  });
  it("longest and rangeDays", () => {
    expect(rangeDays({ from: "2024-01-01", to: "2024-03-01" })).toBe(60);
    expect(longest(a)).toEqual(a[0]);
    expect(longest([])).toBeNull();
  });
});

describe("completeness", () => {
  it("green / amber / red / empty", () => {
    expect(completeness(100, 0)).toBe("complete");
    expect(completeness(100, 2)).toBe("mostly");
    expect(completeness(100, 3)).toBe("incomplete");
    expect(completeness(0, 0)).toBe("empty");
  });
});

describe("yearRows", () => {
  const mk = (year: number, from: string, to: string, missingDay?: string) => {
    const out: Array<{ day: string; status: "ok" | "closed" | "thin" | "missing" }> = [];
    for (let d = dayMs(from); d < dayMs(to); d += 86_400_000) { const day = isoDay(d); out.push({ day, status: day === missingDay ? "missing" : "ok" }); }
    return out;
  };
  it("marks a whole year with no missing day as full, and a broken or partial year as not", () => {
    const rows = yearRows([...mk(2023, "2023-01-02", "2024-01-01"), ...mk(2024, "2024-01-01", "2024-07-01", "2024-03-05")]);
    expect(rows.map((r) => [r.year, r.status, r.full])).toEqual([[2023, "complete", true], [2024, "mostly", false]]);
    expect(rows[1]!.missing).toBe(1);
  });
  it("a store that starts mid-year never claims that year is full", () => {
    expect(yearRows(mk(2023, "2023-06-01", "2024-01-01"))[0]!.full).toBe(false);
  });
  it("empty input", () => expect(yearRows([])).toEqual([]));
});
