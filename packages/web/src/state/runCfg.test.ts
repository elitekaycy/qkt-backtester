import { describe, expect, it } from "vitest";
import { runCfgPatch } from "./runCfg.js";

const cfg = { from: "2024-01-02", to: "2024-01-16", tier: "draft" as const };

describe("runCfgPatch", () => {
  it("takes the shown run's window and tier, as the top bar would set them", () => {
    expect(runCfgPatch({ from: "2024-01-02", to: "2024-03-29", tier: "full" }, cfg)).toEqual({ to: "2024-03-29", tier: "full" });
    expect(runCfgPatch({ from: "2023-11-01", to: "2023-12-01", tier: "draft" }, cfg)).toEqual({ from: "2023-11-01", to: "2023-12-01" });
  });
  it("changes nothing when the top bar already matches the run", () => {
    expect(runCfgPatch({ ...cfg }, cfg)).toBeNull();
  });
  it("never writes a missing or malformed value from an odd run record", () => {
    expect(runCfgPatch({ from: "", to: "2024/03/29", tier: "weird" as never }, cfg)).toBeNull();
    expect(runCfgPatch({ from: "2024-01-10", to: "", tier: "draft" }, cfg)).toEqual({ from: "2024-01-10" });
  });
  it("leaves a window whose end is not after its start alone", () => {
    expect(runCfgPatch({ from: "2024-05-01", to: "2024-04-01", tier: "draft" }, cfg)).toBeNull();
  });
});
