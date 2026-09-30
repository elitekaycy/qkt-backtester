import { describe, expect, it } from "vitest";
import { autoSkippedNotice, rejectionDetail, rejectionNotice } from "./runNotices.js";

const rj = { count: 1234, reasons: [
  { kind: "cap", label: "position cap", count: 1000, example: "max 2 open", hint: "Raise max_positions in qkt.config.yaml" },
  { kind: "halt", label: "daily halt", count: 200, example: "halted" },
  { kind: "x", label: "other", count: 34, example: "?" },
] };

describe("rejectionNotice", () => {
  it("one notice per run, keyed by the run id", () => {
    const a = rejectionNotice({ runId: "r1", rejections: rj, fills: 10, stale: false })!;
    const b = rejectionNotice({ runId: "r1", rejections: rj, fills: 10, stale: false })!;
    expect(a.key).toBe("rejected:r1");
    expect(b.key).toBe(a.key);
    expect(rejectionNotice({ runId: "r2", rejections: rj, fills: 10, stale: false })!.key).toBe("rejected:r2");
  });
  it("says what was rejected, the top reasons and the hint", () => {
    const n = rejectionNotice({ runId: "r1", rejections: rj, fills: 10, stale: false })!;
    expect(n.kind).toBe("warn");
    expect(n.text).toBe("qkt rejected 1,234 orders");
    expect(n.description).toBe("1,000 × position cap, 200 × daily halt, … Raise max_positions in qkt.config.yaml");
  });
  it("says so when every order was rejected", () => {
    expect(rejectionNotice({ runId: "r1", rejections: { count: 1, reasons: [rj.reasons[1]!] }, fills: 0, stale: false })!.text).toBe("qkt rejected 1 order, so this run made no trades");
  });
  it("nothing for a clean run, stale results or no run", () => {
    expect(rejectionNotice({ runId: "r1", rejections: undefined, fills: 3, stale: false })).toBeNull();
    expect(rejectionNotice({ runId: "r1", rejections: { count: 0, reasons: [] }, fills: 3, stale: false })).toBeNull();
    expect(rejectionNotice({ runId: "r1", rejections: rj, fills: 3, stale: true })).toBeNull();
    expect(rejectionNotice({ runId: null, rejections: rj, fills: 3, stale: false })).toBeNull();
  });
  it("the Show dialog lists every reason with an example", () => {
    expect(rejectionDetail(rj)).toBe("1,000 × position cap (e.g. max 2 open); 200 × daily halt (e.g. halted); 34 × other (e.g. ?). Raise max_positions in qkt.config.yaml");
    expect(rejectionDetail(undefined)).toBe("");
  });
});

describe("autoSkippedNotice", () => {
  it("one notice per distinct skip, none once a save runs", () => {
    const n = autoSkippedNotice("Not run: line 3: unknown indicator")!;
    expect(n).toMatchObject({ key: "skipped:Not run: line 3: unknown indicator", kind: "warn", text: "Not run: line 3: unknown indicator" });
    expect(n.description).toMatch(/last version that ran/);
    expect(autoSkippedNotice(null)).toBeNull();
  });
});
