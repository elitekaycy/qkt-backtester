import { beforeEach, describe, expect, it, vi } from "vitest";

const sonner = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() });
  return { toast: fn, Toaster: () => null };
});
vi.mock("sonner", () => sonner);

const { notify, notifyId, onceGate, DURATION } = await import("./notify.js");
const { useStore } = await import("../state/store.js");
const t = sonner.toast;

beforeEach(() => { for (const f of [t.success, t.info, t.warning, t.error, t.dismiss]) f.mockClear(); });

describe("notify", () => {
  it("maps each kind to its sonner variant with that kind's duration", () => {
    notify.ok("saved"); notify.info("fyi"); notify.warn("careful"); notify.error("broke");
    expect(t.success).toHaveBeenCalledWith("saved", { id: "ok:saved", duration: DURATION.ok });
    expect(t.info).toHaveBeenCalledWith("fyi", { id: "info:fyi", duration: DURATION.info });
    expect(t.warning).toHaveBeenCalledWith("careful", { id: "warn:careful", duration: DURATION.warn });
    expect(t.error).toHaveBeenCalledWith("broke", { id: "error:broke", duration: DURATION.error });
  });
  it("errors stay up longer than good news", () => {
    expect(DURATION.error).toBeGreaterThan(DURATION.warn);
    expect(DURATION.warn).toBeGreaterThan(DURATION.ok);
  });
  it("the same message twice reuses one id, so sonner updates the toast instead of stacking a copy", () => {
    notify.error("Save failed"); notify.error("Save failed");
    const ids = t.error.mock.calls.map((c) => (c[1] as { id: string }).id);
    expect(ids).toEqual(["error:Save failed", "error:Save failed"]);
    expect(notifyId("error", "Save failed")).toBe(notifyId("error", "Save failed"));
    expect(notifyId("error", "a")).not.toBe(notifyId("info", "a"));
  });
  it("an explicit id wins, so changing text updates the same toast", () => {
    notify.warn("3 orders rejected", { id: "run-rejections" }); notify.warn("5 orders rejected", { id: "run-rejections" });
    expect(t.warning.mock.calls.map((c) => (c[1] as { id: string }).id)).toEqual(["run-rejections", "run-rejections"]);
  });
  it("passes description, duration and an action that calls back", () => {
    const onClick = vi.fn();
    const id = notify.info("Trades", { description: "network down", duration: Infinity, action: { label: "Retry", onClick } });
    expect(id).toBe("info:Trades");
    const data = t.info.mock.calls[0]![1] as { description: string; duration: number; action: { label: string; onClick(): void } };
    expect(data.description).toBe("network down");
    expect(data.duration).toBe(Infinity);
    expect(data.action.label).toBe("Retry");
    data.action.onClick(); expect(onClick).toHaveBeenCalledOnce();
  });
  it("dismisses one toast or all", () => {
    notify.dismiss("trades-load"); notify.dismiss();
    expect(t.dismiss.mock.calls).toEqual([["trades-load"], [undefined]]);
  });
});

describe("store.toast", () => {
  it("keeps its signature and delegates to notify", () => {
    useStore.getState().toast("ok", "Stopped.");
    useStore.getState().toast("info", "Deleted 2 runs");
    useStore.getState().toast("error", "Run not found");
    expect(t.success).toHaveBeenCalledWith("Stopped.", expect.objectContaining({ id: "ok:Stopped." }));
    expect(t.info).toHaveBeenCalledWith("Deleted 2 runs", expect.objectContaining({ id: "info:Deleted 2 runs" }));
    expect(t.error).toHaveBeenCalledWith("Run not found", expect.objectContaining({ id: "error:Run not found" }));
  });
  it("keeps no toast list in the store", () => {
    expect("toasts" in useStore.getState()).toBe(false);
    expect("dismissToast" in useStore.getState()).toBe(false);
  });
});

describe("onceGate", () => {
  it("lets each key through once", () => {
    const once = onceGate();
    expect(once("rejected:r1")).toBe(true);
    expect(once("rejected:r1")).toBe(false);
    expect(once("rejected:r2")).toBe(true);
  });
  it("is bounded: the oldest keys are forgotten first", () => {
    const once = onceGate(2);
    once("a"); once("b"); once("c");
    expect(once("a")).toBe(true);
    expect(once("c")).toBe(false);
  });
});
