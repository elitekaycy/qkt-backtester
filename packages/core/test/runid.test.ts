import { describe, it, expect } from "vitest";
import { canonicalJson, runHash, makeRunId, safeName, dataFingerprint, hashOfRunId, type RunHashInput } from "../src/runid.js";
import { transition, isTerminal, isActive, IllegalTransition, newRunJson, STEP_ORDER } from "../src/runjson.js";

const base: RunHashInput = {
  strategySources: { "strategies/a.qkt": "STRATEGY a VERSION 1" }, config: "starting_balance: 10000\n", params: { fast: "9" },
  from: "2024-10-01", to: "2024-11-01", tier: "draft", engine: { version: "0.53.0", gitSha: "6bf944f0" }, flags: [], dataFingerprint: "abc",
};

describe("canonicalJson / runHash", () => {
  it("ignores key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
    expect(runHash(base)).toBe(runHash({ ...base, params: { fast: "9" }, strategySources: { "strategies/a.qkt": "STRATEGY a VERSION 1" } }));
  });
  it("does not mistake undefined for a value", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
  it.each([
    ["tier", { tier: "full" as const }],
    ["a param", { params: { fast: "10" } }],
    ["the window", { to: "2024-11-02" }],
    ["the data", { dataFingerprint: "abd" }],
    ["the engine version", { engine: { version: "0.54.0", gitSha: "6bf944f0" } }],
    ["the source", { strategySources: { "strategies/a.qkt": "STRATEGY a VERSION 2" } }],
    ["the config", { config: "starting_balance: 20000\n" }],
    ["flags", { flags: ["--seed", "1"] }],
  ])("changes when %s changes", (_n, patch) => {
    expect(runHash({ ...base, ...patch })).not.toBe(runHash(base));
  });
  it("is a 64-char hex digest", () => expect(runHash(base)).toMatch(/^[0-9a-f]{64}$/));
});

describe("makeRunId / safeName", () => {
  const h = runHash(base);
  it("has the documented shape and sorts by time", () => {
    const a = makeRunId(new Date("2026-09-25T14:12:03Z"), "strategies/xau-ema.qkt", h);
    const b = makeRunId(new Date("2026-09-25T14:12:04Z"), "strategies/xau-ema.qkt", h);
    expect(a).toBe(`20260925T141203Z_xau-ema_${h.slice(0, 8)}`);
    expect(a < b).toBe(true);
    expect(hashOfRunId(a)).toBe(h.slice(0, 8));
  });
  it("neutralises path tricks and odd characters", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("..\\..\\win.qkt")).toBe("win");
    expect(safeName("my strat (v2).qkt")).toBe("my-strat-v2");
    expect(safeName("....")).toBe("run");
    expect(safeName("")).toBe("run");
    expect(safeName("x".repeat(200)).length).toBe(40);
    expect(safeName("a\u0000b")).toBe("a-b");
  });
});

describe("dataFingerprint", () => {
  const files = [{ path: "b", size: 2, mtimeMs: 2 }, { path: "a", size: 1, mtimeMs: 1 }];
  it("is order-independent and change-sensitive", () => {
    expect(dataFingerprint(files)).toBe(dataFingerprint([...files].reverse()));
    expect(dataFingerprint(files)).not.toBe(dataFingerprint([{ path: "b", size: 3, mtimeMs: 2 }, files[1]!]));
    expect(dataFingerprint(files)).not.toBe(dataFingerprint([{ path: "b", size: 2, mtimeMs: 3 }, files[1]!]));
  });
  it("handles no files", () => expect(dataFingerprint([])).toMatch(/^[0-9a-f]{64}$/));
});

describe("run state machine", () => {
  it("walks the happy path", () => {
    let s = "queued" as const as ReturnType<typeof transition>;
    for (const n of ["checking", "running", "postprocessing", "done"] as const) s = transition(s, n);
    expect(s).toBe("done");
  });
  it("terminal states admit nothing", () => {
    for (const t of ["done", "failed", "cancelled", "interrupted"] as const) {
      expect(isTerminal(t)).toBe(true);
      expect(() => transition(t, "running")).toThrow(IllegalTransition);
    }
  });
  it("cannot skip steps or go backwards", () => {
    expect(() => transition("queued", "running")).toThrow(IllegalTransition);
    expect(() => transition("running", "checking")).toThrow(IllegalTransition);
    expect(() => transition("checking", "done")).toThrow(IllegalTransition);
  });
  it("any active state can be cancelled, failed or interrupted", () => {
    for (const s of ["queued", "checking", "running", "postprocessing"] as const) {
      expect(isActive(s)).toBe(true);
      for (const t of ["cancelled", "failed", "interrupted"] as const) expect(transition(s, t)).toBe(t);
    }
  });
  it("newRunJson starts queued with every step pending", () => {
    const r = newRunJson({ id: "x", hash: "h", tier: "draft", strategy: "s", from: "a", to: "b", params: {}, engine: { version: "1" }, seq: 1 });
    expect(r.status).toBe("queued");
    expect(r.steps.map((s) => s.id)).toEqual(STEP_ORDER);
    expect(r.steps.every((s) => s.status === "pending")).toBe(true);
  });
});
