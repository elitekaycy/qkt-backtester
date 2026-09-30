import { describe, it, expect } from "vitest";
import { textHash } from "@qkt-studio/core/texthash";
import { decideAdoptAction, decideAdoptPlan, decideApplyProposalAction, shouldShowRun, variantMayTakeOver, variantSide, viewReport } from "./agent.js";

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

describe("decideApplyProposalAction", () => {
  it("does nothing when the file is not open", () => {
    expect(decideApplyProposalAction(undefined)).toBe("none");
  });
  it("reloads a clean tab", () => {
    expect(decideApplyProposalAction({ content: "same", saved: "same" })).toBe("reload");
  });
  it("flags a conflict instead of discarding unsaved edits", () => {
    expect(decideApplyProposalAction({ content: "edited", saved: "same" })).toBe("conflict");
  });
});

describe("decideAdoptPlan", () => {
  const base = "STRATEGY ema VERSION 1\n", newer = "STRATEGY ema VERSION 1\n-- my edit\n";
  it("adopts as is when neither the buffer nor the saved text changed since the variant was made", () => {
    expect(decideAdoptPlan({ baseHash: textHash(base), current: base, saved: base, canRebase: true })).toBe("adopt");
    expect(decideAdoptPlan({ baseHash: textHash(base), current: base, saved: null, canRebase: false })).toBe("adopt");
  });
  it("re-applies the variant's changes when the user saved newer text, or has unsaved edits", () => {
    expect(decideAdoptPlan({ baseHash: textHash(base), current: newer, saved: newer, canRebase: true })).toBe("rebase");
    expect(decideAdoptPlan({ baseHash: textHash(base), current: newer, saved: base, canRebase: true })).toBe("rebase");
    expect(decideAdoptPlan({ baseHash: textHash(base), current: base, saved: newer, canRebase: true })).toBe("rebase");
  });
  it("asks when the text changed and the variant cannot be rebased (a whole-file replacement)", () => {
    expect(decideAdoptPlan({ baseHash: textHash(base), current: newer, saved: newer, canRebase: false })).toBe("confirm");
  });
});

describe("variantMayTakeOver", () => {
  const showing = { runId: "v1", baseRunId: "b1" };
  it("takes over an idle tab", () => {
    expect(variantMayTakeOver({ running: false, runId: "x", showing: null })).toBe(true);
  });
  it("never takes over while the tab follows the user's own live run", () => {
    expect(variantMayTakeOver({ running: true, runId: "mine", showing: null })).toBe(false);
    expect(variantMayTakeOver({ running: true, runId: "mine", showing })).toBe(false);
  });
  it("may replace a variant run the tab was following", () => {
    expect(variantMayTakeOver({ running: true, runId: "v1", showing })).toBe(true);
  });
});

describe("variantSide", () => {
  const fmt = (n: number) => `$${n}`;
  it("says running and keeps polling until the run ends", () => {
    expect(variantSide(null, null, fmt)).toEqual({ text: "running…", final: false });
    expect(variantSide({ status: "running" }, null, fmt)).toEqual({ text: "running…", final: false });
    expect(variantSide({ status: "done" }, null, fmt).final).toBe(false);
  });
  it("stops on a terminal status and says why", () => {
    expect(variantSide({ status: "done" }, 12, fmt)).toEqual({ text: "$12", final: true });
    expect(variantSide({ status: "done" }, "none", fmt)).toEqual({ text: "no trades", final: true });
    expect(variantSide({ status: "failed", error: { message: "no bars for XAUUSD 15m" } }, null, fmt)).toEqual({ text: "failed: no bars for XAUUSD 15m", final: true });
    expect(variantSide({ status: "cancelled" }, null, fmt)).toEqual({ text: "cancelled", final: true });
    expect(variantSide("gone", null, fmt).final).toBe(true);
  });
});
