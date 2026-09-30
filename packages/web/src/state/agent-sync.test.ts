// packages/web/src/state/agent-sync.test.ts
import { describe, it, expect, vi } from "vitest";

const server = vi.hoisted(() => ({ variants: [] as unknown[], runs: new Set<string>() }));
vi.mock("../api/client.js", () => ({
  api: {
    variants: async () => ({ variants: server.variants }), proposals: async () => ({ proposals: [] }), split: async () => null,
    run: async (id: string) => { if (!server.runs.has(id)) throw new Error("404"); return { id, status: "done" }; },
  },
  withToken: (u: string) => u,
}));
const { useAgent } = await import("./agent.js");
const { useStore } = await import("./store.js");
const v = (id: string, runId: string, baseRunId: string) => ({ id, label: id, base: "strategies/ema.qkt", runId, baseRunId, diff: "", notes: [], created: "" });

describe("a variant discarded elsewhere (Stop purged its run)", () => {
  it("leaves the chart: back to the base run when it still exists, else just no variant showing", async () => {
    const selectRun = vi.fn(async () => undefined);
    useStore.setState({ selectRun });
    useAgent.setState({ showing: v("a", "run-a", "base-a") });
    server.variants = [v("b", "run-b", "base-b")];
    server.runs = new Set(["base-a"]);
    await useAgent.getState().refresh();
    await useAgent.getState().forgetGone();
    expect(useAgent.getState().showing).toBeNull();
    expect(selectRun).toHaveBeenCalledWith("base-a");

    selectRun.mockClear();
    useAgent.setState({ showing: v("c", "run-c", "base-c") }); // its base run was purged too
    await useAgent.getState().forgetGone();
    expect(useAgent.getState().showing).toBeNull();
    expect(selectRun).not.toHaveBeenCalled();

    useAgent.setState({ showing: v("b", "run-b", "base-b") }); // still kept: nothing changes
    await useAgent.getState().forgetGone();
    expect(useAgent.getState().showing?.id).toBe("b");
  });
});
