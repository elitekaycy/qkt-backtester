import { describe, it, expect } from "vitest";
import { endLabelShift, headroomText, legText, marginView } from "./derivatives.js";

describe("legs of a real structure, compact enough to fit beside the outcome and the premium", () => {
  it("shows the option as expiry, strike and right, and any other symbol without its venue", () => {
    const sell = { side: "SELL" as const, quantity: 0.1, symbol: "DERIBIT:BTC_USDC_4OCT26_83000_P", entry: 400 };
    expect(legText(sell)).toBe("Sell 0.1 · 4OCT26 83000 P @ 400");
    expect(legText({ ...sell, side: "BUY", symbol: "DERIBIT:BTC_USDC_4OCT26_81000_P", entry: 150 })).toBe("Buy 0.1 · 4OCT26 81000 P @ 150");
    expect(legText({ ...sell, symbol: "CME:ESH19" })).toBe("Sell 0.1 · ESH19 @ 400");
  });
  it("headroomText can be short for a narrow stat", () => {
    expect(headroomText(2085, true)).toBe("2,085 above");
    expect(headroomText(-1.4757, true)).toBe("1 below");
  });
});

// Real qkt 0.55.0 days: the structure held with just enough equity to open it (a margin call the same day), and ES@front held
// until the venue liquidated it.
const call = [{ date: "2026-10-01", marginUsed: 170.475651207, maintenance: 170.475651207, equity: 169, marginCall: true }];
const liq = [
  { date: "2020-02-24", marginUsed: 25713, maintenance: 23375, equity: 31722.77, marginCall: false },
  { date: "2020-02-26", marginUsed: 25713, maintenance: 23375, equity: 25460, marginCall: false },
];

describe("margin days of a real margin-call run and a real liquidation run", () => {
  it("counts the margin call and finds the tightest day, below maintenance", () => {
    const v = marginView(call);
    expect(v.calls).toBe(1);
    expect(v.tightest!.date).toBe("2026-10-01");
    expect(v.tightest!.headroom).toBeCloseTo(-1.4757, 3);
    expect(v.points[0]!.call).toBe(true);
  });
  it("a liquidation run's tightest day is the one closest to maintenance, still above it", () => {
    expect(marginView(liq).tightest).toEqual({ date: "2020-02-26", headroom: 2085 });
  });
});

describe("headroomText", () => {
  it("says above when equity clears maintenance and below when it does not (never a negative 'above')", () => {
    expect(headroomText(2085)).toBe("2,085 above maintenance");
    expect(headroomText(-1.4757)).toBe("1 below maintenance");
    expect(headroomText(0)).toBe("0 above maintenance");
  });
});

describe("endLabelShift: the labels of two lines that end on top of each other", () => {
  it("leaves them alone when they end apart", () => {
    expect(endLabelShift(50_000, 25_000, 50_000)).toEqual({ equity: 0, margin: 0 });
  });
  it("pushes them apart, the higher line's label up and the lower one's down, when they end close", () => {
    expect(endLabelShift(25_460, 25_713, 50_000)).toEqual({ equity: 7, margin: -7 });
    expect(endLabelShift(25_900, 25_713, 50_000)).toEqual({ equity: -7, margin: 7 });
  });
  it("does the same for a single day where equity and margin coincide", () => {
    expect(endLabelShift(169, 170.4, 180)).toEqual({ equity: 7, margin: -7 });
  });
});
