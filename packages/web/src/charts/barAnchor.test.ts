import { describe, expect, it } from "vitest";
import { barAnchor, tradeSpan } from "./barAnchor.js";

const M = 60, H = 3600; // seconds, for readable fixtures (bar times are LWC seconds, trade times are ms)
const ms = (sec: number) => sec * 1000;
const M30 = 30 * 60_000;

describe("barAnchor", () => {
  it("returns null when there are no bars", () => {
    expect(barAnchor([], M30, 5_000)).toBeNull();
  });

  it("returns the bar a time falls exactly on", () => {
    expect(barAnchor([0, 30 * M, 60 * M], M30, ms(30 * M))).toEqual({ time: 30 * M });
  });

  it("finds a time inside a merged bar that starts off the epoch grid (the :15 phase left by count-grouped bars)", () => {
    // 30m bars starting at :15 and :45: flooring 11:10 to the 30m grid (11:00) would name no bar at all
    const times = [10 * H + 15 * M, 10 * H + 45 * M, 11 * H + 15 * M, 11 * H + 45 * M];
    expect(barAnchor(times, M30, ms(11 * H + 10 * M))).toEqual({ time: 10 * H + 45 * M });
    expect(barAnchor(times, M30, ms(11 * H + 44 * M))).toEqual({ time: 11 * H + 15 * M });
  });

  it("finds the containing bar of a merged (LOD) series of any width", () => {
    const H4 = 4 * H * 1000, times = [0, 4 * H, 8 * H, 12 * H];
    expect(barAnchor(times, H4, ms(9 * H + 59 * M))).toEqual({ time: 8 * H });
  });

  it("puts a time in a gap (a weekend, a missing bar) on the bar before the gap", () => {
    const times = [8 * H, 9 * H, 10 * H, 20 * H, 21 * H]; // hourly bars, nothing from 11:00 to 20:00
    expect(barAnchor(times, 3_600_000, ms(15 * H))).toEqual({ time: 10 * H });
  });

  it("says \"before\" for a time before the first bar", () => {
    expect(barAnchor([10 * H, 11 * H], 3_600_000, ms(9 * H))).toBe("before");
  });

  it("says \"after\" for a time at or past the end of the last bar, and anchors a time inside it", () => {
    const times = [0, H, 2 * H];
    expect(barAnchor(times, 3_600_000, ms(2 * H + 59 * M))).toEqual({ time: 2 * H });
    expect(barAnchor(times, 3_600_000, ms(3 * H))).toBe("after");
    expect(barAnchor(times, 3_600_000, ms(30 * H))).toBe("after");
  });

  it("treats exactly the first and exactly the last bar as bars, not outside", () => {
    const times = [0, H, 2 * H];
    expect(barAnchor(times, 3_600_000, 0)).toEqual({ time: 0 });
    expect(barAnchor(times, 3_600_000, ms(2 * H))).toEqual({ time: 2 * H });
  });
});

describe("tradeSpan", () => {
  const times = [10 * H, 11 * H, 12 * H, 20 * H, 21 * H], tf = 3_600_000;
  const closed = (entry: number, exit: number) => ({ entryTs: ms(entry), exitTs: ms(exit), open: false });

  it("anchors a closed trade's entry and exit on the bars that hold them", () => {
    expect(tradeSpan(times, tf, closed(10 * H + 20 * M, 11 * H + 40 * M), null)).toEqual({ entry: 10 * H, exit: 11 * H });
  });

  it("keeps a closed trade whose exit falls off every bar (a gap) on its own bars, never the chart's right edge", () => {
    expect(tradeSpan(times, tf, closed(11 * H, 15 * H), ms(22 * H))).toEqual({ entry: 11 * H, exit: 12 * H });
  });

  it("clips a trade that starts before the data to the first bar, and one that ends after it to the last bar", () => {
    expect(tradeSpan(times, tf, closed(5 * H, 11 * H + 5 * M), null)).toEqual({ entry: 10 * H, exit: 11 * H });
    expect(tradeSpan(times, tf, closed(20 * H + 5 * M, 30 * H), null)).toEqual({ entry: 20 * H, exit: 21 * H });
  });

  it("drops a trade that lies wholly outside the data", () => {
    expect(tradeSpan(times, tf, closed(2 * H, 3 * H), null)).toBeNull();
    expect(tradeSpan(times, tf, closed(40 * H, 41 * H), null)).toBeNull();
    expect(tradeSpan([], tf, closed(10 * H, 11 * H), null)).toBeNull();
  });

  it("extends an open trade to the bar holding the data's end, or the last bar", () => {
    const open = { entryTs: ms(11 * H), exitTs: null, open: true };
    expect(tradeSpan(times, tf, open, ms(12 * H + 30 * M))).toEqual({ entry: 11 * H, exit: 12 * H });
    expect(tradeSpan(times, tf, open, ms(40 * H))).toEqual({ entry: 11 * H, exit: 21 * H });
    expect(tradeSpan(times, tf, open, null)).toEqual({ entry: 11 * H, exit: 21 * H });
  });

  it("draws a closed trade with no exit time as a point at its entry", () => {
    expect(tradeSpan(times, tf, { entryTs: ms(11 * H), exitTs: null, open: false }, ms(40 * H))).toEqual({ entry: 11 * H, exit: 11 * H });
  });
});
