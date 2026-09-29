import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStudio } from "../../src/main.js";
import { testConfig, haveQkt } from "../helpers.js";
import { mcpClient, call } from "./client.js";

// The tools' path policy, redaction, and the proposal/variant guards: none of this needs market data.
const ENV = "MT5_PASSWORD=hunter2\nAPI_KEY=abc123secret\n";
const EMA = "STRATEGY ema VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN gold.close > 0\n    THEN BUY gold SIZING 0.1\n";
const BOOK = "PORTFOLIO book VERSION 1\n\nIMPORT 'ema.qkt' AS ema\n\nRULES\n    RUN ema\n";
const CONFIG = "starting_balance: 10000\nbrokers:\n  exness:\n    password: s3cretpw\n";

let studio: Awaited<ReturnType<typeof createStudio>>, base: string, ws: string;
const hdr = { Authorization: "Bearer t0k" };
beforeAll(async () => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-policy-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "qkt.config.yaml"), CONFIG);
  writeFileSync(path.join(ws, ".env"), ENV);
  writeFileSync(path.join(ws, ".env.local"), ENV);
  writeFileSync(path.join(ws, ".env.example"), "MT5_PASSWORD=\n");
  writeFileSync(path.join(ws, "strategies", "ema.qkt"), EMA);
  writeFileSync(path.join(ws, "strategies", "book.qkt"), BOOK);
  studio = await createStudio(testConfig(ws, { token: "t0k" }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
  symlinkSync(path.join(ws, ".qkt-studio"), path.join(ws, "strategies", "studio-link"));
});
afterAll(async () => { await studio.app.close(); });

const secretLines = ENV.trim().split("\n");
const leaks = (text: string) => secretLines.some((l) => text.includes(l)) || /hunter2|abc123secret/.test(text);

describe("the tools' path policy", () => {
  it("propose_strategy_edit on .env is an error that shows no line of the file, and makes no proposal", async () => {
    const c = await mcpClient(base, "t0k");
    const before = studio.proposals.list().length;
    for (const changes of [[{ op: "source", text: EMA }], [{ op: "replace_text", find: "abc", replace: "x" }], [{ op: "set_param", name: "x", value: 1 }]]) {
      for (const p of [".env", "./.env", "strategies/../.env", ".env.local"]) {
        const r = await call(c, "propose_strategy_edit", { path: p, changes });
        expect(r.isError, `${p} ${changes[0]!.op}`).toBe(true);
        expect(leaks(r.text), r.text).toBe(false);
      }
    }
    // a non-strategy file that is not a secret is refused too, and the refusal quotes none of it
    const cfg = await call(c, "propose_strategy_edit", { path: "qkt.config.yaml", changes: [{ op: "source", text: EMA }] });
    expect(cfg.isError).toBe(true);
    expect(cfg.text).not.toMatch(/s3cretpw|starting_balance/);
    expect(studio.proposals.list().length).toBe(before);
    expect(readFileSync(path.join(ws, ".env"), "utf8")).toBe(ENV);
    await c.close();
  });

  it("read_file refuses every .env variant, hidden folders, runs/ and a symlink into .qkt-studio; .env.example is readable", async () => {
    const c = await mcpClient(base, "t0k");
    for (const p of [".env", ".env.local", "strategies/../.env.local", ".qkt-studio/settings.json", ".qkt-studio/variants/index.json", "runs/x/run.json", "strategies/studio-link/index.sqlite"]) {
      const r = await call(c, "read_file", { path: p });
      expect(r.isError, p).toBe(true);
      expect(leaks(r.text)).toBe(false);
    }
    expect((await call(c, "read_file", { path: ".env.example" })).json.text).toBe("MT5_PASSWORD=\n");
    expect((await call(c, "list_files", { dir: ".qkt-studio" })).isError).toBe(true);
    await c.close();
  });

  it("create_strategy refuses hidden folders and runs/, and creates nothing there", async () => {
    const c = await mcpClient(base, "t0k");
    for (const dir of [".qkt-studio", ".qkt-studio/variants/abc", "runs/abc/source", "strategies/studio-link"]) {
      const r = await call(c, "create_strategy", { name: "sneaky", source: EMA.replace("ema", "sneaky"), dir });
      expect(r.isError, dir).toBe(true);
    }
    expect(existsSync(path.join(ws, ".qkt-studio", "sneaky.qkt"))).toBe(false);
    expect(existsSync(path.join(ws, "runs", "abc"))).toBe(false);
    await c.close();
  });

  it("run and try tools refuse a path outside the policy before doing anything", async () => {
    const c = await mcpClient(base, "t0k");
    for (const [tool, args] of [
      ["run_backtest", { path: ".qkt-studio/x.qkt", from: "2024-10-01", to: "2024-10-15" }],
      ["sweep", { path: "runs/x/source/a.qkt", params: { fast: ["1"] }, from: "2024-10-01", to: "2024-10-15" }],
      ["run_walkforward", { path: ".qkt-studio/x.qkt", params: { fast: ["1"] }, from: "2024-10-01", to: "2024-10-15", train: "5d", test: "5d", step: "5d" }],
      ["try_change", { base: ".qkt-studio/x.qkt", changes: [{ op: "set_param", name: "x", value: 1 }], from: "2024-10-01", to: "2024-10-15" }],
      ["try_variants", { base: "strategies/studio-link/x.qkt", variants: [{ label: "a", changes: [{ op: "set_param", name: "x", value: 1 }] }, { label: "b", changes: [{ op: "set_param", name: "x", value: 2 }] }], from: "2024-10-01", to: "2024-10-15" }],
      ["check_strategy", { source: EMA, path: ".qkt-studio/x.qkt" }],
    ] as const) {
      const r = await call(c, tool, args as unknown as Record<string, unknown>);
      expect(r.isError, `${tool}: ${r.text}`).toBe(true);
      expect(r.text).toMatch(/hidden folder|run store|leads to/);
    }
    await c.close();
  });

  it("propose_config and propose_instrument still target their own files, and apply", async () => {
    const c = await mcpClient(base, "t0k");
    const pc = await call(c, "propose_config", { set: { starting_balance: 20000 } });
    expect(pc.isError, pc.text).toBe(false);
    const pi = await call(c, "propose_instrument", { symbol: "XAGUSD", fields: { contractSize: 5000 } });
    expect(pi.isError, pi.text).toBe(false);
    for (const id of [pc.json.proposalId, pi.json.proposalId]) expect((await fetch(`${base}/api/proposals/${id}/apply`, { method: "POST", headers: hdr })).status).toBe(200);
    expect(readFileSync(path.join(ws, "qkt.config.yaml"), "utf8")).toMatch(/starting_balance: 20000/);
    expect(readFileSync(path.join(ws, "qkt.config.yaml"), "utf8")).toMatch(/password: s3cretpw/); // apply writes the real text
    expect(readFileSync(path.join(ws, "instruments.yaml"), "utf8")).toMatch(/BACKTEST:XAGUSD/);
    await c.close();
  });

  it("Proposals.apply re-checks the target: a hand-edited proposal aimed at .env or .qkt-studio is refused", async () => {
    for (const target of [".env", ".qkt-studio/settings.json", "runs/x.qkt", "notes.txt"]) {
      const p = await studio.proposals.create({ kind: "file", title: "x", path: target, before: "", after: "PWNED\n", diff: "" });
      const r = await fetch(`${base}/api/proposals/${p.id}/apply`, { method: "POST", headers: hdr });
      expect(r.status, target).toBe(400);
      expect(studio.proposals.get(p.id)!.status).toBe("open");
    }
    expect(readFileSync(path.join(ws, ".env"), "utf8")).toBe(ENV);
    expect(existsSync(path.join(ws, "notes.txt"))).toBe(false);
  });
});

describe("redaction and list payloads", () => {
  it("get_config, read_file qkt.config.yaml and propose_config diffs never show a secret value", async () => {
    writeFileSync(path.join(ws, "qkt.config.yaml"), CONFIG);
    const c = await mcpClient(base, "t0k");
    const g = await call(c, "get_config");
    expect(g.isError).toBe(false);
    expect(g.json.text).toMatch(/password: \*\*\*/);
    expect(g.text).not.toMatch(/s3cretpw/);
    const rf = await call(c, "read_file", { path: "qkt.config.yaml" });
    expect(rf.json.text).toMatch(/password: \*\*\*/);
    expect(rf.text).not.toMatch(/s3cretpw/);
    const pc = await call(c, "propose_config", { set: { "brokers.exness.password": "newpw99" } });
    expect(pc.isError, pc.text).toBe(false);
    expect(pc.text).not.toMatch(/s3cretpw|newpw99/);
    const list = await (await fetch(`${base}/api/proposals`, { headers: hdr })).json() as { proposals: Array<Record<string, unknown>> };
    expect(JSON.stringify(list)).not.toMatch(/s3cretpw|newpw99/);
    for (const p of list.proposals) { expect(p).not.toHaveProperty("before"); expect(p).not.toHaveProperty("after"); }
    await c.close();
  });
});

describe.skipIf(!haveQkt)("proposal apply is claimed before it awaits", () => {
  it("two concurrent applies write once, and the proposal ends applied (not stale)", async () => {
    const c = await mcpClient(base, "t0k");
    const p = await call(c, "propose_strategy_edit", { path: "strategies/ema.qkt", changes: [{ op: "set_param", name: "n", value: 3 }] });
    expect(p.isError, p.text).toBe(false);
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`${base}/api/proposals/${p.json.proposalId}/apply`, { method: "POST", headers: hdr })));
    expect([a!.status, b!.status].sort()).toEqual([200, 400]);
    expect(studio.proposals.get(p.json.proposalId)!.status).toBe("applied");
    expect(readFileSync(path.join(ws, "strategies", "ema.qkt"), "utf8")).toMatch(/PARAM n = 3/);
    writeFileSync(path.join(ws, "strategies", "ema.qkt"), EMA);
    await c.close();
  });
});

describe("change operations on portfolios and variants", () => {
  it("refuse a portfolio with the exact message, for try_change and propose_strategy_edit (source op too)", async () => {
    const c = await mcpClient(base, "t0k");
    const msg = "change operations work on STRATEGY files; open the child strategy";
    const t = await call(c, "try_change", { base: "strategies/book.qkt", changes: [{ op: "source", text: EMA }], from: "2024-10-01", to: "2024-10-15" });
    expect(t.isError).toBe(true);
    expect(t.text).toContain(msg);
    const p = await call(c, "propose_strategy_edit", { path: "strategies/book.qkt", changes: [{ op: "source", text: EMA }] });
    expect(p.text).toContain(msg);
    await c.close();
  });

  it.skipIf(!haveQkt)("try_variants builds and checks every variant before writing any: one bad variant leaves nothing behind", async () => {
    const c = await mcpClient(base, "t0k");
    const before = studio.variants.list().length;
    const dirs = () => (existsSync(path.join(ws, ".qkt-studio", "variants")) ? readdirSync(path.join(ws, ".qkt-studio", "variants")).filter((d) => d !== "index.json") : []);
    const dirsBefore = dirs().length;
    const r = await call(c, "try_variants", { base: "strategies/ema.qkt", from: "2024-10-01", to: "2024-10-15", variants: [
      { label: "ok", changes: [{ op: "set_param", name: "fast", value: 5 }] },
      { label: "broken", changes: [{ op: "add_condition", expr: "nosuchthing(gold.close, 3) > 1 AND AND" }] },
    ] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/variant "broken"/);
    expect(studio.variants.list().length).toBe(before);
    expect(dirs().length).toBe(dirsBefore);
    await c.close();
  });

  it("a tool gets 'busy' when the tools' run budget is full, and no variant is made", async () => {
    const c = await mcpClient(base, "t0k");
    const hold = studio.budget.reserve(studio.budget.maxRuns);
    try {
      const before = studio.variants.list().length;
      const t = await call(c, "try_change", { base: "strategies/ema.qkt", changes: [{ op: "set_param", name: "fast", value: 5 }], from: "2024-10-01", to: "2024-10-15" });
      expect(t.text).toMatch(/^busy: \d+ runs queued; wait or cancel/);
      expect(studio.variants.list().length).toBe(before);
      const rb = await call(c, "run_backtest", { path: "strategies/ema.qkt", from: "2024-10-01", to: "2024-10-15", tier: "full" });
      expect(rb.text).toMatch(/^busy: \d+ runs queued/);
    } finally { hold(); }
    // one grid / walk-forward job at a time
    let finish!: (j: { id: string }) => void;
    const held = studio.budget.startJob(() => new Promise<{ id: string }>((r) => { finish = r; }));
    const sw = await call(c, "sweep", { path: "strategies/ema.qkt", params: { fast: ["1"] }, from: "2024-10-01", to: "2024-10-15" });
    expect(sw.text).toMatch(/^busy: a tool-started job/);
    finish({ id: "done-job" }); await held;
    await c.close();
  });
});
