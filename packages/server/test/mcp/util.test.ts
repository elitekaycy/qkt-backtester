import { describe, it, expect } from "vitest";
import { MAX_CHARS, ok, toolPathRefusal, ToolBudget } from "../../src/mcp/util.js";

describe("ok()", () => {
  it("keeps a JSON-heavy result under the cap after serializing (quotes and backslashes are escaped again)", () => {
    const heavy = Array.from({ length: 900 }, (_, i) => ({ q: `"quoted" \\ ${i}`, s: '{"a":"b"}' }));
    expect(JSON.stringify(heavy).length).toBeGreaterThan(MAX_CHARS);
    const text = (ok(heavy).content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
    const body = JSON.parse(text) as { truncated: boolean; head: string };
    expect(body.truncated).toBe(true);
    expect(JSON.stringify(heavy).startsWith(body.head)).toBe(true);
    expect(body.head.length).toBeGreaterThan(MAX_CHARS / 3);
  });
  it("leaves a result that fits untouched", () => {
    expect((ok({ a: 1 }).content[0] as { text: string }).text).toBe('{"a":1}');
  });
});

describe("toolPathRefusal", () => {
  it("refuses secrets, hidden folders and the run store; allows strategies, the config and .env.example", () => {
    for (const p of [".env", "sub/.env", ".env.local", ".ENV.prod", ".qkt-studio/settings.json", ".qkt-studio/variants/x/a.qkt", "runs/abc/source/a.qkt", ".git/config", "strategies/.hidden/a.qkt"]) expect(toolPathRefusal(p), p).not.toBeNull();
    for (const p of ["strategies/ema.qkt", "qkt.config.yaml", "instruments.yaml", ".env.example", "notes/.keep", "runs.qkt"]) expect(toolPathRefusal(p), p).toBeNull();
    expect(toolPathRefusal(".qkt-studio", true)).not.toBeNull();
    expect(toolPathRefusal("strategies", true)).toBeNull();
    expect(toolPathRefusal(".env")).not.toMatch(/=/);
  });
});

describe("ToolBudget", () => {
  const active = new Set<string>();
  const running = new Set<string>();
  const deps = { isActive: (id: string) => active.has(id), jobRunning: (id: string) => running.has(id) };

  it("allows at most maxRuns active-or-queued tool runs, counting reservations made before any await", () => {
    const b = new ToolBudget(deps, 4);
    const r1 = b.reserve(3);
    expect(() => b.reserve(2)).toThrow(/^busy: 3 runs queued; wait or cancel/);
    active.add("a"); active.add("b"); active.add("c");
    for (const id of active) b.track(id);
    r1();
    r1(); // releasing twice is harmless
    expect(b.inFlight()).toBe(3);
    expect(() => b.reserve(2)).toThrow(/busy: 3 runs queued/);
    active.delete("a"); active.delete("b");   // finished runs stop counting
    expect(b.reserve(2)).toBeTypeOf("function");
    active.clear();
  });

  it("runs one tool job at a time", async () => {
    const b = new ToolBudget(deps, 4);
    let finish!: (j: { id: string }) => void;
    const first = b.startJob(() => new Promise<{ id: string }>((r) => { finish = r; }));
    await expect(b.startJob(async () => ({ id: "j2" }))).rejects.toThrow(/^busy: a tool-started job/);
    running.add("j1"); finish({ id: "j1" });
    await first;
    await expect(b.startJob(async () => ({ id: "j2" }))).rejects.toThrow(/j1/);
    running.delete("j1");
    expect((await b.startJob(async () => ({ id: "j3" }))).id).toBe("j3");
    // a job that fails to start does not hold the slot
    await expect(b.startJob(async () => { throw new Error("bad params"); })).rejects.toThrow("bad params");
    expect((await b.startJob(async () => ({ id: "j4" }))).id).toBe("j4");
  });
});
