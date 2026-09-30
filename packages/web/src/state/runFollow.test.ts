// packages/web/src/state/runFollow.test.ts
// A run put on screen by any path (history, Lab, chat cards, the agent's run event, a variant) sets the top bar's
// window and tier from the run, through the real store (no stubbed selectRun), without starting a run.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Run = { id: string; status: string; strategy: string; from: string; to: string; tier: "draft" | "full" };
const server = vi.hoisted(() => ({ runs: new Map<string, Run>(), submit: [] as unknown[], events: new Map<string, (e: unknown) => void>(), gate: null as Promise<void> | null }));
const saved = vi.hoisted(() => new Map<string, string>());
vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });

vi.mock("../api/client.js", () => {
  class ApiError extends Error { status = 0; }
  const notLoaded = async () => { throw new Error("not in this test"); };
  return {
    ApiError,
    withToken: (u: string) => u,
    openRunEvents: (id: string, on: (e: unknown) => void) => { server.events.set(id, on); return () => server.events.delete(id); },
    api: {
      run: async (id: string) => { if (server.gate) await server.gate; const r = server.runs.get(id); if (!r) throw new Error("404"); return r; },
      submit: async (b: unknown) => { server.submit.push(b); return { runId: "never" }; },
      summary: notLoaded, integrity: notLoaded, monthly: notLoaded, equity: notLoaded, meta: notLoaded,
      runs: async () => ({ runs: [] }), variants: async () => ({ variants: [] }), proposals: async () => ({ proposals: [] }), split: async () => null,
    },
  };
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  onopen: (() => void) | null = null;
  constructor() { FakeEventSource.last = this; }
  addEventListener(t: string, f: (m: { data: string }) => void) { this.listeners.set(t, f); }
  close() { /* nothing to close */ }
  emit(t: string, data: unknown) { this.listeners.get(t)?.({ data: JSON.stringify(data) }); }
}
vi.stubGlobal("EventSource", FakeEventSource);

const { useStore } = await import("./store.js");
const { useAgent, viewReport } = await import("./agent.js");

const USER = { tier: "draft" as const, from: "2024-01-02", to: "2024-01-16" };
const run = (id: string, over: Partial<Run> = {}): Run => ({ id, status: "failed", strategy: "strategies/ema.qkt", from: "2024-01-02", to: "2024-03-29", tier: "full", ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));
const prefs = () => JSON.parse(saved.get("qkt-studio-prefs-v1") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  server.runs.clear(); server.submit = []; saved.clear(); server.gate = null;
  useStore.setState((s) => ({ cfg: { ...s.cfg, ...USER }, running: false, runId: null, run: null, activePath: "strategies/ema.qkt", submitError: "old refusal" }));
  useAgent.setState({ showing: null });
});

describe("selectRun: the one path that puts a run on screen", () => {
  it("sets the top bar's window and tier from the run, saved like a user's pick, without starting a run", async () => {
    server.runs.set("r1", run("r1"));
    await useStore.getState().selectRun("r1");
    const s = useStore.getState();
    expect(s.run?.id).toBe("r1");
    expect({ from: s.cfg.from, to: s.cfg.to, tier: s.cfg.tier }).toEqual({ from: "2024-01-02", to: "2024-03-29", tier: "full" });
    expect(prefs()).toMatchObject({ from: "2024-01-02", to: "2024-03-29", tier: "full" });
    expect(s.submitError).toBeNull(); // the same outcome as picking that window in the top bar
    expect(s.running).toBe(false);
    expect(server.submit).toEqual([]);
  });

  it("leaves the top bar alone when the run cannot be read", async () => {
    useStore.setState({ toast: () => undefined });
    await useStore.getState().selectRun("gone");
    expect(useStore.getState().cfg).toMatchObject(USER);
  });

  it("a top-bar edit made while the run's record loads wins over the run's window", async () => {
    server.runs.set("r1", run("r1"));
    let open!: () => void; server.gate = new Promise((r) => { open = r; });
    const pending = useStore.getState().selectRun("r1");
    useStore.getState().setCfg({ from: "2024-05-01", to: "2024-05-20" }); // the user picks a window meanwhile
    server.gate = null; open(); await pending;
    const s = useStore.getState();
    expect(s.run?.id).toBe("r1");
    expect({ from: s.cfg.from, to: s.cfg.to }).toEqual({ from: "2024-05-01", to: "2024-05-20" });
  });

  it("a newer run put on screen while an older record loads keeps the screen", async () => {
    server.runs.set("old", run("old"));
    let open!: () => void; server.gate = new Promise((r) => { open = r; });
    const pending = useStore.getState().selectRun("old");
    useStore.getState().attachRun("mine"); // e.g. the user's own run starts
    server.gate = null; open(); await pending;
    const s = useStore.getState();
    expect(s.runId).toBe("mine");
    expect(s.cfg).toMatchObject(USER);
  });

  it("gives the agent's view report the run's window", async () => {
    server.runs.set("r1", run("r1", { from: "2024-02-01", to: "2024-02-20", tier: "draft" }));
    await useStore.getState().selectRun("r1");
    const s = useStore.getState();
    const v = viewReport({ activePath: s.activePath, cursorLine: null, selection: "", runId: s.runId, cfg: s.cfg, visible: null, selectedTripId: null, variantId: null });
    expect(v.runId).toBe("r1");
    expect(v.runWindow).toEqual({ from: "2024-02-01", to: "2024-02-20", tier: "draft" });
  });
});

describe("the agent's paths go through it", () => {
  it("a tool run (SSE run event) on the open strategy moves the top bar to the run's window", async () => {
    server.runs.set("tool", run("tool"));
    const stop = useAgent.getState().start();
    FakeEventSource.last!.emit("run", { runId: "tool" });
    await flush(); await flush();
    expect(useStore.getState().runId).toBe("tool");
    expect(useStore.getState().cfg).toMatchObject({ from: "2024-01-02", to: "2024-03-29", tier: "full" });
    stop();
  });

  it("a tool run never takes the window of a user whose own run is in progress", async () => {
    server.runs.set("tool", run("tool"));
    useStore.setState({ running: true, runId: "mine" });
    const stop = useAgent.getState().start();
    FakeEventSource.last!.emit("run", { runId: "tool" });
    await flush(); await flush();
    expect(useStore.getState().runId).toBe("mine");
    expect(useStore.getState().cfg).toMatchObject(USER);
    stop();
  });

  it("a tool run that finishes after the user pressed Run leaves their window alone", async () => {
    let answer: (r: Run) => void = () => undefined;
    server.runs.set("tool", run("tool"));
    const { api } = await import("../api/client.js");
    const real = api.run;
    let first = true; // only the event handler's own read is held back; selectRun's read answers at once
    (api as { run: typeof api.run }).run = (id: string) => (id === "tool" && first ? (first = false, new Promise((r) => { answer = r as (r: Run) => void; })) : real(id)) as ReturnType<typeof api.run>;
    const stop = useAgent.getState().start();
    FakeEventSource.last!.emit("run", { runId: "tool" });
    useStore.setState({ running: true, runId: "mine" }); // the user starts a run while the tool run's record is loading
    answer(run("tool"));
    await flush(); await flush();
    (api as { run: typeof api.run }).run = real;
    expect(useStore.getState().runId).toBe("mine");
    expect(useStore.getState().cfg).toMatchObject(USER);
    stop();
  });

  it("show() of a finished variant selects its run and takes its window", async () => {
    server.runs.set("v-run", run("v-run", { strategy: "strategies/.variants/ema-1.qkt", from: "2024-03-01", to: "2024-04-01", tier: "draft" }));
    await useAgent.getState().show({ id: "v1", label: "v1", base: "strategies/ema.qkt", runId: "v-run", baseRunId: null, diff: "", notes: [], created: "" });
    expect(useStore.getState().runId).toBe("v-run");
    expect(useStore.getState().cfg).toMatchObject({ from: "2024-03-01", to: "2024-04-01", tier: "draft" });
  });

  it("show() of a variant still running takes its window before following it live", async () => {
    server.runs.set("v-live", run("v-live", { status: "running", from: "2024-05-01", to: "2024-06-01" }));
    await useAgent.getState().show({ id: "v2", label: "v2", base: "strategies/ema.qkt", runId: "v-live", baseRunId: null, diff: "", notes: [], created: "" });
    const s = useStore.getState();
    expect(s.runId).toBe("v-live");
    expect(s.running).toBe(true);
    expect(server.events.has("v-live")).toBe(true);
    expect(s.cfg).toMatchObject({ from: "2024-05-01", to: "2024-06-01", tier: "full" });
    expect(server.submit).toEqual([]);
  });
});
