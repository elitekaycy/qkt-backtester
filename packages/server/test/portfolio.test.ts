import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createStudio } from "../src/main.js";
import { listPortfolios, resolveStrategy } from "../src/portfolio.js";
import { scanStore, readinessFor } from "../src/data-scan.js";
import type { ServerConfig } from "../src/config.js";

const realData = path.join(os.homedir(), ".qkt", "data");
const haveQkt = (() => { try { execSync("qkt --version", { stdio: "ignore" }); return true; } catch { return false; } })();
const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin")) && existsSync(path.join(realData, "bars", "BACKTEST", "BTCUSD", "15m", "2024-10-30.bin"));

const child = (name: string, sym: string, tf: string, extra = "") => `STRATEGY ${name} VERSION 1

SYMBOLS
    px = BACKTEST:${sym} EVERY ${tf}

RULES
    WHEN ema(px.close, 9) CROSSES ABOVE ema(px.close, 21)
     AND POSITION.px = 0
    THEN BUY px SIZING 0.1
        BRACKET { STOP_LOSS BY ${extra || "12"}, TAKE_PROFIT BY 24 }
`;
const BOOK = `PORTFOLIO book VERSION 1

IMPORT 'xau_a.qkt' AS a
IMPORT 'xau_b.qkt' AS b HOLD
IMPORT 'sub/btc.qkt' AS btc

RULES
    RUN a
    RUN b
    RUN btc
`;

function make(): string {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pf-")));
  mkdirSync(path.join(ws, "strategies", "sub"), { recursive: true });
  writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 10000\n");
  writeFileSync(path.join(ws, "strategies", "xau_a.qkt"), child("xau_a", "XAUUSD", "15m"));
  writeFileSync(path.join(ws, "strategies", "xau_b.qkt"), child("xau_b", "XAUUSD", "1h", "15"));
  writeFileSync(path.join(ws, "strategies", "sub", "btc.qkt"), child("btc", "BTCUSD", "15m", "300").replace("TAKE_PROFIT BY 24", "TAKE_PROFIT BY 600"));
  writeFileSync(path.join(ws, "strategies", "book.qkt"), BOOK);
  writeFileSync(path.join(ws, "strategies", "solo.qkt"), child("solo", "XAUUSD", "15m"));
  return ws;
}

describe("resolving a portfolio (no qkt needed)", () => {
  let ws: string;
  beforeAll(() => { ws = make(); });
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  it("follows imports inside the workspace and unions the streams", async () => {
    const r = await resolveStrategy(ws, "strategies/book.qkt");
    expect(r.kind).toBe("portfolio");
    expect(r.members.map((m) => [m.alias, m.rel, m.hold, m.exists])).toEqual([
      ["a", "strategies/xau_a.qkt", false, true], ["b", "strategies/xau_b.qkt", true, true], ["btc", "strategies/sub/btc.qkt", false, true],
    ]);
    expect(r.streams.map((s) => `${s.symbol} ${s.tf}`).sort()).toEqual(["BTCUSD 15m", "XAUUSD 15m", "XAUUSD 1h"]);
  });
  it("reports a missing or escaping import on the member instead of throwing", async () => {
    writeFileSync(path.join(ws, "strategies", "broken.qkt"), "PORTFOLIO broken VERSION 1\n\nIMPORT 'nope.qkt' AS x\nIMPORT '../../../etc/passwd' AS y\n\nRULES\n    RUN x\n");
    const r = await resolveStrategy(ws, "strategies/broken.qkt");
    expect(r.members[0]).toMatchObject({ alias: "x", exists: false });
    expect(r.members[1]!.exists).toBe(false);
    expect(r.members[1]!.error ?? r.members[1]!.rel).toBeTruthy();
    expect(r.members[1]!.rel).toBeNull();
  });
  it("lists portfolios and where each strategy is used", async () => {
    const l = await listPortfolios(ws, ["strategies/book.qkt", "strategies/solo.qkt", "strategies/xau_a.qkt"]);
    expect(l.portfolios.map((p) => p.path)).toEqual(["strategies/book.qkt"]);
    expect(l.usedIn["strategies/xau_a.qkt"]).toEqual(["strategies/book.qkt"]);
    expect(l.usedIn["strategies/solo.qkt"]).toBeUndefined();
  });
  it.skipIf(!haveData)("readiness uses the union and names the children that block a stream", async () => {
    const scan = await scanStore(realData);
    const rd = readinessFor(scan, "strategies/book.qkt", readFileSync(path.join(ws, "strategies", "book.qkt"), "utf8"), await resolveStrategy(ws, "strategies/book.qkt"));
    expect(rd.streams).toHaveLength(3);
    expect(rd.members).toHaveLength(3);
    // XAUUSD 1h bars are not built in the real store: the child that reads them is named
    const blocked = rd.bars.blocked.find((b) => b.stream.includes("XAUUSD 1h"));
    if (blocked) expect(blocked.members).toEqual(["b"]);
    expect(rd.members!.find((m) => m.alias === "a")!.bars).toBe(true);
  });
});

describe.skipIf(!haveQkt || !haveData)("a portfolio run through the studio (real qkt)", () => {
  let ws: string, studio: Awaited<ReturnType<typeof createStudio>>, cfg: ServerConfig;
  const get = (url: string) => studio.app.inject({ url });
  const post = (url: string, body: unknown = {}) => studio.app.inject({ method: "POST", url, payload: body as object });
  const done = async (id: string) => { for (let i = 0; i < 480; i++) { const r = (await get(`/api/runs/${id}`)).json(); if (["done", "failed", "cancelled"].includes(r.status)) return r; await new Promise((x) => setTimeout(x, 250)); } throw new Error("timeout"); };
  const run = async (strategy = "strategies/book.qkt") => { const r = await post("/api/runs", { strategy, from: "2024-10-01", to: "2024-10-20", tier: "draft" }); expect([200, 202]).toContain(r.statusCode); return { ...r.json(), run: await done(r.json().runId) }; };

  beforeAll(async () => {
    ws = make();
    // 1h bars of XAUUSD are not in every store: give child b the 15m stream so the run is possible everywhere
    writeFileSync(path.join(ws, "strategies", "xau_b.qkt"), child("xau_b", "XAUUSD", "15m", "15").replace("EMA", "ema"));
    cfg = { workspace: ws, dataRoot: realData, defaultDataRoot: realData, qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted" };
    studio = await createStudio(cfg);
  });
  afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

  let first: { runId: string };
  it("runs, pairs trips per strategy and reconciles with the engine", async () => {
    const r = await run();
    expect(r.run.status).toBe("done");
    first = r;
    const meta = (await get(`/api/runs/${r.runId}/derived/meta`)).json();
    expect(meta.strategies.sort()).toEqual(["book:a", "book:b", "book:btc"]);
    const trades = (await get(`/api/runs/${r.runId}/trades?limit=1000`)).json();
    expect(new Set(trades.rows.map((t: { strategy: string }) => t.strategy)).size).toBeGreaterThan(1);
    const integ = (await get(`/api/runs/${r.runId}/derived/integrity`)).json();
    expect(integ.checks.find((c: { id: string }) => c.id === "reconcile").ok).toBe(true);
  });
  it("writes the per-strategy derived files and the book file", async () => {
    const rows = (await get(`/api/runs/${first.runId}/derived/strategies`)).json();
    expect(rows.map((s: { id: string }) => s.id).sort()).toEqual(["book:a", "book:b", "book:btc"]);
    const sum = (await get(`/api/runs/${first.runId}/derived/summary`)).json();
    expect(rows.reduce((a: number, s: { totalPnl: number }) => a + s.totalPnl, 0)).toBeCloseTo(sum.totalPnl, 3);
    const eq = (await get(`/api/runs/${first.runId}/derived/equity-by-strategy`)).json();
    expect(Object.keys(eq.series).sort()).toEqual(["book:a", "book:b", "book:btc"]);
    expect(eq.series["book:a"].ts.length).toBeGreaterThan(10);
    const book = (await get(`/api/runs/${first.runId}/derived/book`)).json();
    expect(book.maxGrossExposure).toBeGreaterThan(0);
  });
  it("the strategies filter narrows trades and analytics", async () => {
    const all = (await get(`/api/runs/${first.runId}/analytics`)).json();
    expect(all.byStrategy).toHaveLength(3);
    const two = (await get(`/api/runs/${first.runId}/analytics?strategies=book:a,book:btc`)).json();
    expect(two.byStrategy.map((s: { strategy: string }) => s.strategy).sort()).toEqual(["book:a", "book:btc"]);
    expect(two.count).toBeLessThan(all.count);
    const one = (await get(`/api/runs/${first.runId}/trades?strategy=book:btc&limit=1000`)).json();
    expect(one.rows.every((t: { strategy: string }) => t.strategy === "book:btc")).toBe(true);
  });
  it("the runs list badges it as a portfolio with its member count", async () => {
    const list = (await get("/api/runs")).json().runs as Array<{ id: string; kind: string; members: number }>;
    expect(list.find((r) => r.id === first.runId)).toMatchObject({ kind: "portfolio", members: 3 });
  });
  it("editing a CHILD changes the run identity: no stale cached result", async () => {
    const again = await post("/api/runs", { strategy: "strategies/book.qkt", from: "2024-10-01", to: "2024-10-20", tier: "draft" });
    expect(again.statusCode).toBe(200);            // identical inputs: instant cache hit
    expect(again.json().runId).toBe(first.runId);
    writeFileSync(path.join(ws, "strategies", "sub", "btc.qkt"), child("btc", "BTCUSD", "15m", "250").replace("TAKE_PROFIT BY 24", "TAKE_PROFIT BY 500"));
    const changed = await post("/api/runs", { strategy: "strategies/book.qkt", from: "2024-10-01", to: "2024-10-20", tier: "draft" });
    expect(changed.statusCode).toBe(202);          // a fresh run, not the cached one
    expect(changed.json().runId).not.toBe(first.runId);
    await done(changed.json().runId);
  });
  it("a plain strategy writes none of the portfolio files and is badged as a strategy", async () => {
    const r = await run("strategies/solo.qkt");
    expect(r.run.status).toBe("done");
    expect((await get(`/api/runs/${r.runId}/derived/strategies`)).statusCode).toBe(404);
    expect((await get(`/api/runs/${r.runId}/derived/equity-by-strategy`)).statusCode).toBe(404);
    const list = (await get("/api/runs")).json().runs as Array<{ id: string; kind: string; members: number }>;
    expect(list.find((x) => x.id === r.runId)).toMatchObject({ kind: "strategy", members: 1 });
    expect((await get(`/api/runs/${r.runId}/analytics`)).json().byStrategy).toEqual([]);
  });
  it("/api/portfolios and readiness see the children", async () => {
    const p = (await get("/api/portfolios")).json();
    expect(p.portfolios).toHaveLength(1);
    expect(p.portfolios[0].members.map((m: { alias: string }) => m.alias)).toEqual(["a", "b", "btc"]);
    const rd = (await get("/api/data/readiness")).json().strategies.find((s: { strategy: string }) => s.strategy === "strategies/book.qkt");
    expect(rd.members).toHaveLength(3);
    expect(rd.kind).toBe("portfolio");
  });
});
