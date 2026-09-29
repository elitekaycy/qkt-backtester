import { describe, it, expect } from "vitest";
import { decideAdoptAction, shouldShowRun, viewReport } from "./agent.js";

describe("viewReport", () => {
  it("maps what the user looks at into the server's view state", () => {
    const v = viewReport({ activePath: "strategies/ema.qkt", cursorLine: 12, selection: "", runId: "r1", cfg: { from: "2026-08-01", to: "2026-09-01", tier: "draft" }, visible: { from: 1, to: 2 }, selectedTripId: 7, variantId: null });
    expect(v).toEqual({ openFile: "strategies/ema.qkt", cursorLine: 12, selection: null, runId: "r1", runWindow: { from: "2026-08-01", to: "2026-09-01", tier: "draft" }, visibleFrom: 1, visibleTo: 2, selectedTrade: 7, variantId: null });
  });
});

describe("shouldShowRun", () => {
  it("shows a finished tool run only for the strategy open right now, with no variant on screen", () => {
    expect(shouldShowRun({ runStrategy: "strategies/ema.qkt", activePath: "strategies/ema.qkt", variantShowing: false })).toBe(true);
  });
  it("ignores a run of a different strategy", () => {
    expect(shouldShowRun({ runStrategy: "strategies/other.qkt", activePath: "strategies/ema.qkt", variantShowing: false })).toBe(false);
  });
  it("never yanks the chart while a variant is being reviewed", () => {
    expect(shouldShowRun({ runStrategy: "strategies/ema.qkt", activePath: "strategies/ema.qkt", variantShowing: true })).toBe(false);
  });
  it("ignores a run with no strategy on record", () => {
    expect(shouldShowRun({ runStrategy: null, activePath: "strategies/ema.qkt", variantShowing: false })).toBe(false);
  });
  it("ignores a run when nothing is open", () => {
    expect(shouldShowRun({ runStrategy: "strategies/ema.qkt", activePath: null, variantShowing: false })).toBe(false);
  });
});

describe("decideAdoptAction", () => {
  it("reports a failed save instead of running", () => {
    expect(decideAdoptAction(false, true)).toBe("saveFailed");
    expect(decideAdoptAction(false, false)).toBe("saveFailed");
  });
  it("relies on the save's own auto-run when autoRun is on, rather than starting a second run", () => {
    expect(decideAdoptAction(true, true)).toBe("autoRun");
  });
  it("starts the run itself when autoRun is off", () => {
    expect(decideAdoptAction(true, false)).toBe("startRun");
  });
});
