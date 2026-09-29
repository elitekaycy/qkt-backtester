import { describe, it, expect } from "vitest";
import { parseSplit, splitCut, partsOf, describeSplit } from "../src/split.js";
import type { RoundTrip } from "../src/roundtrips.js";

const t = (id: number, exitIso: string, pnl: number): RoundTrip => ({ id, strategy: "s", symbol: "X", side: "long", entryTs: Date.parse(exitIso) - 3_600_000, entryPx: 1, exitTs: Date.parse(exitIso), exitPx: 1, qty: 1, pnl, fills: 2, holdMs: 3_600_000, open: false, exit: pnl > 0 ? "target" : "stop", r: pnl > 0 ? 2 : -1 });

describe("split", () => {
  it("parses the four forms and refuses the rest", () => {
    expect(parseSplit({ test_pct: 25 })).toEqual({ test_pct: 25 });
    expect(parseSplit({ test_last: "3 months" })).toEqual({ test_last: "3 months" });
    expect(parseSplit({ test_from: "2026-07-01" })).toEqual({ test_from: "2026-07-01" });
    expect(parseSplit({ none: true })).toEqual({ none: true });
    expect(() => parseSplit({ test_pct: 99 })).toThrow(/5 and 95/);
    expect(() => parseSplit({ test_last: "soon" })).toThrow(/days, weeks or months/);
  });
  it("finds the cut inside the window", () => {
    expect(new Date(splitCut({ test_pct: 25 }, "2026-01-01", "2026-05-01")!).toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(new Date(splitCut({ test_last: "1 months" }, "2026-01-01", "2026-05-01")!).toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(splitCut({ none: true }, "2026-01-01", "2026-05-01")).toBeNull();
    // a month back from a month's last day lands on the shorter month's last day, never overflows into the next month
    expect(new Date(splitCut({ test_last: "1 months" }, "2026-01-01", "2026-03-31")!).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(new Date(splitCut({ test_last: "1 months" }, "2024-01-01", "2024-03-31")!).toISOString().slice(0, 10)).toBe("2024-02-29");
    expect(new Date(splitCut({ test_last: "3 months" }, "2025-01-01", "2025-05-31")!).toISOString().slice(0, 10)).toBe("2025-02-28");
    expect(splitCut({ test_from: "2027-01-01" }, "2026-01-01", "2026-05-01")).toBeNull();
  });
  it("splits trades by exit time, and a part with no trades has zeros and nulls, never NaN", () => {
    const trips = [t(1, "2026-01-10T10:00:00Z", 5), t(2, "2026-02-10T10:00:00Z", -2), t(3, "2026-04-10T10:00:00Z", 4)];
    const p = partsOf(trips, "2026-01-01", "2026-05-01", { test_last: "1 months" });
    expect(p.first).toMatchObject({ trades: 2, net: 3, winRate: 0.5 });
    expect(p.test).toMatchObject({ trades: 1, net: 4, winRate: 1 });
    const empty = partsOf(trips.slice(0, 2), "2026-01-01", "2026-05-01", { test_last: "1 months" });
    expect(empty.test).toEqual({ from: "2026-04-01", to: "2026-05-01", trades: 0, net: 0, winRate: null, profitFactor: null, avgR: null });
    expect(JSON.stringify(empty)).not.toMatch(/NaN/);
    expect(describeSplit({ test_last: "3 months" })).toBe("test = last 3 months");
  });
});
