import { describe, it, expect } from "vitest";
import { viewReport } from "./agent.js";

describe("viewReport", () => {
  it("maps what the user looks at into the server's view state", () => {
    const v = viewReport({ activePath: "strategies/ema.qkt", cursorLine: 12, selection: "", runId: "r1", cfg: { from: "2026-08-01", to: "2026-09-01", tier: "draft" }, visible: { from: 1, to: 2 }, selectedTripId: 7, variantId: null });
    expect(v).toEqual({ openFile: "strategies/ema.qkt", cursorLine: 12, selection: null, runId: "r1", runWindow: { from: "2026-08-01", to: "2026-09-01", tier: "draft" }, visibleFrom: 1, visibleTo: 2, selectedTrade: 7, variantId: null });
  });
});
