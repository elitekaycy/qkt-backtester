import { describe, it, expect } from "vitest";
import { textHash } from "@qkt-studio/core/texthash";
import { baseChanged, countLines, diffEditorOptions, diffLayout, diffShouldClose, diffTitle, diffVisible, SIDE_BY_SIDE_MIN_WIDTH, toggledMode } from "./variantDiff.js";

const base = "strategies/ema_cross.qkt";

describe("diffVisible", () => {
  it("shows the diff for the variant on screen while its base is the active tab", () => {
    expect(diffVisible({ diffOf: "v1", showingId: "v1", showingBase: base, activePath: base })).toBe(true);
  });
  it("shows the normal editor when no diff is open, or it belongs to another variant", () => {
    expect(diffVisible({ diffOf: null, showingId: "v1", showingBase: base, activePath: base })).toBe(false);
    expect(diffVisible({ diffOf: "v1", showingId: "v2", showingBase: base, activePath: base })).toBe(false);
    expect(diffVisible({ diffOf: "v1", showingId: null, showingBase: null, activePath: base })).toBe(false);
  });
  it("shows another tab's own editor while the diff stays open for the base tab", () => {
    expect(diffVisible({ diffOf: "v1", showingId: "v1", showingBase: base, activePath: "qkt.config.yaml" })).toBe(false);
    expect(diffVisible({ diffOf: "v1", showingId: "v1", showingBase: base, activePath: null })).toBe(false);
  });
});

describe("diffShouldClose", () => {
  it("closes when the variant stops showing (adopted, discarded, Back) or another takes the chart", () => {
    expect(diffShouldClose("v1", null)).toBe(true);
    expect(diffShouldClose("v1", "v2")).toBe(true);
  });
  it("stays while its variant shows, and has nothing to close when none is open", () => {
    expect(diffShouldClose("v1", "v1")).toBe(false);
    expect(diffShouldClose(null, null)).toBe(false);
  });
});

describe("diffTitle", () => {
  it("names the base file, then the variant", () => {
    expect(diffTitle(base, "1% / 2%")).toBe("ema_cross.qkt ← 1% / 2%");
    expect(diffTitle("top.qkt", "x")).toBe("top.qkt ← x");
  });
});

describe("baseChanged", () => {
  const text = "STRATEGY a VERSION 1\n";
  it("is false while the current text is what the variant was made from", () => {
    expect(baseChanged(textHash(text), text)).toBe(false);
  });
  it("is true once the current text differs", () => {
    expect(baseChanged(textHash(text), text + "-- edit\n")).toBe(true);
  });
  it("is false while the current text or the hash is not known yet", () => {
    expect(baseChanged(textHash(text), null)).toBe(false);
    expect(baseChanged(textHash(text), undefined)).toBe(false);
    expect(baseChanged("", text)).toBe(false);
  });
});

describe("layout", () => {
  it("auto is side by side when wide (or not measured yet), inline when narrow", () => {
    expect(diffLayout("auto", SIDE_BY_SIDE_MIN_WIDTH + 100)).toBe("split");
    expect(diffLayout("auto", 0)).toBe("split");
    expect(diffLayout("auto", SIDE_BY_SIDE_MIN_WIDTH - 1)).toBe("inline");
  });
  it("an explicit choice holds whatever the width", () => {
    expect(diffLayout("split", 300)).toBe("split");
    expect(diffLayout("inline", 3000)).toBe("inline");
  });
  it("the toggle switches to the opposite of what is on screen", () => {
    expect(toggledMode("auto", 2000)).toBe("inline");
    expect(toggledMode("auto", 400)).toBe("split");
    expect(toggledMode("inline", 2000)).toBe("split");
  });
  it("only auto lets Monaco fall back to inline, at the same breakpoint", () => {
    expect(diffEditorOptions("auto", 2000)).toEqual({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true, renderSideBySideInlineBreakpoint: SIDE_BY_SIDE_MIN_WIDTH });
    expect(diffEditorOptions("split", 300)).toMatchObject({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false });
    expect(diffEditorOptions("inline", 3000)).toMatchObject({ renderSideBySide: false, useInlineViewWhenSpaceIsLimited: false });
  });
});

describe("countLines", () => {
  it("counts added and removed lines like git's +/- (an end line of 0 = nothing on that side)", () => {
    expect(countLines([
      { originalStartLineNumber: 5, originalEndLineNumber: 0, modifiedStartLineNumber: 6, modifiedEndLineNumber: 7 }, // 2 added
      { originalStartLineNumber: 10, originalEndLineNumber: 10, modifiedStartLineNumber: 12, modifiedEndLineNumber: 12 }, // 1 changed
      { originalStartLineNumber: 20, originalEndLineNumber: 22, modifiedStartLineNumber: 23, modifiedEndLineNumber: 0 }, // 3 removed
    ])).toEqual({ added: 3, removed: 4 });
    expect(countLines(null)).toEqual({ added: 0, removed: 0 });
  });
});
