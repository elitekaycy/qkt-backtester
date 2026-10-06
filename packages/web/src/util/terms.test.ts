import { describe, it, expect } from "vitest";
import { parseInstruments } from "@qkt-studio/core/instruments";
import { differenceNote, termsFor } from "./derivatives.js";
import type { InstrumentsInfo } from "../api/client.js";

const data = parseInstruments("futures:\n  - root: CME:ES\n    multiplier: 50\n    tickSize: 0.25\n");
const info = (over: Partial<InstrumentsInfo> = {}): InstrumentsInfo => ({
  exists: true, catalog: data, workspace: { exists: false, catalog: parseInstruments("") }, effective: "dataRoot", differences: {},
  futureRoots: ["CME:ES"], perpetuals: [], optionRoots: [], ...over,
});

describe("the terms a root's dialog shows are the ones the next run uses", () => {
  it("the data source's, named as such, when the workspace has no instruments.yaml", () => {
    expect(termsFor(info(), "CME:ES")).toMatchObject({ source: "dataRoot", terms: { multiplier: 50 }, differs: [] });
  });
  it("the workspace's once it exists, with the fields where the data source disagrees", () => {
    const ws = parseInstruments("futures:\n  - root: CME:ES\n    multiplier: 5\n    tickSize: 0.25\n");
    const t = termsFor(info({ workspace: { exists: true, catalog: ws }, effective: "workspace", differences: { "CME:ES": ["multiplier"] } }), "CME:ES");
    expect(t).toMatchObject({ source: "workspace", terms: { multiplier: 5 }, differs: ["multiplier"] });
  });
  it("no terms, and the reason, for a root the workspace file does not declare", () => {
    const ws = parseInstruments("instruments:\n  - qktSymbol: BACKTEST:EURUSD\n");
    const t = termsFor(info({ workspace: { exists: true, catalog: ws }, effective: "workspace", differences: { "CME:ES": ["only in the data source"] } }), "CME:ES");
    expect(t.terms).toBeNull();
    expect(t.source).toBe("workspace");
    expect(t.differs).toEqual(["only in the data source"]);
  });
  it("words each disagreement and says nothing when the files agree", () => {
    expect(differenceNote("workspace", [])).toBeNull();
    expect(differenceNote("workspace", ["only in the data source"])).toContain("will not know it");
    expect(differenceNote("workspace", ["margin", "multiplier"])).toContain("margin, multiplier");
    expect(differenceNote("dataRoot", ["only in the workspace"])).toContain("Only the workspace's");
  });
  it("is not known before the first load", () => {
    expect(termsFor(null, "CME:ES")).toEqual({ source: "none", terms: null, differs: [] });
  });
});
