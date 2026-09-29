import { describe, it, expect } from "vitest";
import { excursion, whatIf, diagnoseExits, type PathBars } from "../src/diagnose.js";
import type { RoundTrip } from "../src/roundtrips.js";

const H = 3_600_000;
const trip = (o: Partial<RoundTrip>): RoundTrip => ({ id: 1, strategy: "s", symbol: "BACKTEST:XAUUSD", side: "long", entryTs: 0, entryPx: 100, exitTs: 4 * H, exitPx: 88, qty: 1, pnl: -12, fills: 2, holdMs: 4 * H, open: false, sl: 88, tp: 124, exit: "stop", ...o });
// entry bar at 0, then bars rising to +3, falling through the stop at 88
const bars: PathBars = { ts: [0, H, 2 * H, 3 * H, 4 * H, 5 * H], high: [100.5, 103, 101, 95, 90, 90], low: [99.5, 100, 96, 90, 87, 85] };

describe("excursion", () => {
  it("measures favourable and adverse moves from entry to exit, long and short", () => {
    expect(excursion(trip({}), bars)).toEqual({ mfe: 3, mae: 13, bars: 5 });
    const short = trip({ side: "short", entryPx: 100, sl: 112, tp: 76 });
    expect(excursion(short, bars)).toEqual({ mfe: 13, mae: 3, bars: 5 });
  });
  it("is null without bars inside the trade", () => {
    expect(excursion(trip({ entryTs: 99 * H, exitTs: 100 * H }), bars)).toBeNull();
  });
});

describe("whatIf", () => {
  it("a 2-point target is reached before the 12-point stop; a 24-point target is not", () => {
    expect(whatIf(trip({}), bars, 12, 2, 50)).toBe("target");
    expect(whatIf(trip({}), bars, 12, 24, 50)).toBe("stop");
  });
  it("a bar touching both counts as the stop, and no touch within the horizon is open", () => {
    const both: PathBars = { ts: [0, H], high: [100, 130], low: [100, 80] };
    expect(whatIf(trip({}), both, 12, 24, 50)).toBe("stop");
    expect(whatIf(trip({}), { ts: [0, H], high: [100, 101], low: [100, 99] }, 12, 24, 50)).toBe("open");
  });
});

describe("diagnoseExits", () => {
  it("summarises how trades ended and ranks bracket alternatives", () => {
    const trips = [trip({ id: 1 }), trip({ id: 2 }), trip({ id: 3, exit: "target", exitPx: 124, pnl: 24 })];
    const d = diagnoseExits(trips, () => bars, { stops: [12], targets: [2, 24] });
    expect(d.trades).toBe(3);
    expect(d.exits).toEqual({ stop: 2, target: 1, signal: 0, open: 0 });
    expect(d.bracket).toEqual({ medianStop: 12, medianTarget: 24 });
    expect(d.mfe.median).toBe(3);
    const t2 = d.whatIf.find((w) => w.target === 2)!;
    expect(t2).toMatchObject({ stop: 12, targetFirst: 3, stopFirst: 0, open: 0, netPoints: 6 });
    expect(d.note).toMatch(/estimate on bars/);
  });
  it("handles no trades without NaN", () => {
    const d = diagnoseExits([], () => null);
    expect(d.trades).toBe(0);
    expect(JSON.stringify(d)).not.toMatch(/NaN/);
  });
});
