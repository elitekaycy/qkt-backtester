import { describe, expect, it } from "vitest";
import { splitAnchor } from "./SplitPrimitive.js";

const H = 3600; // one hour, in seconds, for readable fixtures

describe("splitAnchor", () => {
  it("returns null when there are no bars", () => {
    expect(splitAnchor([], 5_000)).toBeNull();
  });

  it("returns the bar time exactly matching the cut", () => {
    const times = [0, H, 2 * H, 3 * H];
    expect(splitAnchor(times, 2 * H * 1000)).toEqual({ time: 2 * H });
  });

  it("returns the next bar time when the cut falls in a gap (e.g. a weekend)", () => {
    // Friday close at 10H, next bar (Monday open) at 20H: a cut anywhere in between lands on the Monday bar.
    const times = [8 * H, 9 * H, 10 * H, 20 * H, 21 * H];
    expect(splitAnchor(times, 15 * H * 1000)).toEqual({ time: 20 * H });
  });

  it("returns \"start\" when the cut is before the first bar", () => {
    const times = [10 * H, 11 * H, 12 * H];
    expect(splitAnchor(times, 5 * H * 1000)).toBe("start");
  });

  it("returns null when the cut is after the last bar", () => {
    const times = [0, H, 2 * H];
    expect(splitAnchor(times, 10 * H * 1000)).toBeNull();
  });

  it("treats a cut exactly on the first bar as an exact match, not \"start\"", () => {
    const times = [0, H, 2 * H];
    expect(splitAnchor(times, 0)).toEqual({ time: 0 });
  });

  it("treats a cut exactly on the last bar as an exact match, not \"after last\"", () => {
    const times = [0, H, 2 * H];
    expect(splitAnchor(times, 2 * H * 1000)).toEqual({ time: 2 * H });
  });
});
