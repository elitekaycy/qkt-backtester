import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStudio } from "../src/main.js";
import { haveQkt, testConfig } from "./helpers.js";

const FUT = path.resolve(import.meta.dirname, "fixtures/deriv/futures");
const d = describe.skipIf(!haveQkt);

const strat = (stream: string, cond: string) => `STRATEGY t VERSION 1\n\nSYMBOLS\n    x = ${stream}\n\nRULES\n    WHEN ${cond} AND POSITION.x = 0\n    THEN BUY x SIZING 0.01\n`;

d("derivatives over HTTP, on a store with a Binance futures root", () => {
  let ws: string, studio: Awaited<ReturnType<typeof createStudio>>;
  const get = (url: string) => studio.app.inject({ method: "GET", url });
  const post = (url: string, payload: unknown) => studio.app.inject({ method: "POST", url, payload: payload as object });
  const check = async (content: string) => (await post("/api/check", { kind: "qkt", content })).json().diagnostics as Array<{ code: string; message: string; line: number }>;

  beforeAll(async () => {
    ws = mkdtempSync(path.join(os.tmpdir(), "deriv-ws-"));
    mkdirSync(path.join(ws, "strategies"));
    writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 100000\n");
    studio = await createStudio(testConfig(ws, { dataRoot: FUT }));
  });
  afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

  it("serves the derivatives report and the catalog the browser lint needs", async () => {
    const r = (await get("/api/data/derivatives")).json();
    expect(r.futures[0]).toMatchObject({ key: "BINANCE_UM:BTCUSDT", rolls: { count: 2 } });
    const i = (await get("/api/instruments")).json();
    expect(i.exists).toBe(true);
    expect(i.catalog.futures[0]).toMatchObject({ root: "BINANCE_UM:BTCUSDT", multiplier: 1 });
    expect(i.futureRoots).toEqual(["BINANCE_UM:BTCUSDT"]);
    expect(i.perpetuals).toEqual([]);
  });

  it("the scan lists no futures contract as a symbol and the readiness carries the stream kinds", async () => {
    const scan = (await get("/api/data/scan?refresh=1")).json();
    expect(scan.symbols).toEqual([]);
    expect(scan.derivatives.futures).toHaveLength(1);
    writeFileSync(path.join(ws, "strategies", "f.qkt"), strat("BINANCE_UM:BTCUSDT@front EVERY 15m", "x.close > 0"));
    const rd = (await get("/api/data/readiness?refresh=1")).json().strategies.find((s: { strategy: string }) => s.strategy === "strategies/f.qkt");
    expect(rd.kinds).toEqual({ x: "continuous" });
    expect(rd.needsAllowIncomplete).toBe(true);
    expect(rd.bars.ranges).toEqual([{ from: "2024-09-16", to: "2024-09-23" }]);
  });

  it("a CFD stream reading a derivatives field is an error qkt itself would never raise", async () => {
    const bad = await check(strat("BACKTEST:XAUUSD EVERY 15m", "x.dte > 1"));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ code: "field_not_for_kind", line: 7 });
    expect(bad[0]!.message).toMatch(/CFD/);
  });

  it("the same field is fine on a futures contract and on a continuous stream, and an option field is not", async () => {
    expect(await check(strat("BINANCE_UM:BTCUSDT_241227 EVERY 15m", "x.dte > 1"))).toEqual([]);
    expect(await check(strat("BINANCE_UM:BTCUSDT@front EVERY 15m", "x.days_to_roll > 1"))).toEqual([]);
    const opt = await check(strat("BINANCE_UM:BTCUSDT_241227 EVERY 15m", "x.iv > 1"));
    expect(opt.map((x) => x.code)).toEqual(["field_not_for_kind"]);
  });

  it("a run is refused at the parse step for it, with the position", async () => {
    writeFileSync(path.join(ws, "strategies", "bad.qkt"), strat("BACKTEST:XAUUSD EVERY 15m", "x.mark > 1"));
    const { runId } = await studio.runner.submit({ strategy: "strategies/bad.qkt", from: "2024-10-01", to: "2024-10-02", tier: "draft" });
    const run = await studio.runner.waitFor(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ kind: "field_not_for_kind", line: 7, file: "strategies/bad.qkt" });
    expect(run.steps.find((s) => s.id === "parse")!.status).toBe("failed");
    expect(run.steps.find((s) => s.id === "coverage")!.status).toBe("skipped");
  });

  it("derivatives fetch jobs validate their request before anything runs", async () => {
    const bad = async (body: unknown) => (await post("/api/data/fetch-derivatives", body)).statusCode;
    expect(await bad({ target: "not a target", kind: "catalog" })).toBe(400);
    expect(await bad({ target: "CME:ES", kind: "nonsense" })).toBe(400);
    expect(await bad({ target: "BINANCE_UM:BTCUSDT", kind: "funding" })).toBe(400);               // needs a window
    expect(await bad({ target: "BINANCE_UM:BTCUSDT", kind: "funding", from: "2024-02-02", to: "2024-02-01" })).toBe(400);
    expect(await bad({ target: "BINANCE_UM:BTCUSDT", kind: "marks", from: "2024-02-01", to: "2024-02-02" })).toBe(400); // needs a tf
  });
});
