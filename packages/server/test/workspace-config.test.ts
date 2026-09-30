import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createStudio } from "../src/main.js";
import { parseDotEnv } from "../src/workspace-env.js";
import type { ServerConfig } from "../src/config.js";
import { haveQkt, qktBin } from "./helpers.js";

const realData = path.join(os.homedir(), ".qkt", "data");
const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));

describe("parseDotEnv", () => {
  it("handles comments, export, quotes and inline comments", () => {
    expect(parseDotEnv("# c\nA=1\nexport B=two words # note\nC=\"x y\\nz\"\nD='q #not comment'\n\nbad line\nE=\n")).toEqual({ A: "1", B: "two words", C: "x y\nz", D: "q #not comment", E: "" });
  });
});

describe.skipIf(!haveQkt || !haveData)("workspace .env, instruments.yaml and per-symbol sources reach qkt", () => {
  let ws: string, studio: Awaited<ReturnType<typeof createStudio>>, cfg: ServerConfig;
  const post = (url: string, body: unknown = {}) => studio.app.inject({ method: "POST", url, payload: body as object });
  const put = (url: string, body: unknown) => studio.app.inject({ method: "PUT", url, payload: body as object });
  const get = (url: string) => studio.app.inject({ url });
  const done = async (id: string) => { for (let i = 0; i < 240; i++) { const r = (await get(`/api/runs/${id}`)).json(); if (["done", "failed", "cancelled"].includes(r.status)) return r; await new Promise((x) => setTimeout(x, 250)); } throw new Error("timeout"); };
  const run = async (extra: object = {}) => { const r = await post("/api/runs", { strategy: "strategies/a.qkt", from: "2024-10-01", to: "2024-10-15", tier: "draft", ...extra }); expect(r.statusCode).toBe(202); return done(r.json().runId); };
  const pnl = async (id: string) => (await get(`/api/runs/${id}/derived/summary`)).json().totalPnl as number;
  const start = async (id: string) => (await get(`/api/runs/${id}/derived/equity`)).json().equity[0] as number;

  beforeAll(async () => {
    ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wsenv-")));
    mkdirSync(path.join(ws, "strategies"));
    writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: ${STUDIO_TEST_BALANCE:-10000}\n");
    writeFileSync(path.join(ws, "strategies", "a.qkt"), "STRATEGY a VERSION 1\n\nSYMBOLS\n    g = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN ema(g.close, 9) CROSSES ABOVE ema(g.close, 21)\n     AND POSITION.g = 0\n    THEN BUY g SIZING 0.1\n\n    WHEN ema(g.close, 9) CROSSES BELOW ema(g.close, 21)\n     AND POSITION.g > 0\n    THEN CLOSE g\n");
    cfg = { workspace: ws, dataRoot: realData, defaultDataRoot: realData, qktBin, port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted" };
    studio = await createStudio(cfg);
  });
  afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

  let base: { id: string; pnl: number };
  it("baseline: the ${VAR:-default} in qkt.config.yaml falls back without a .env", async () => {
    const r = await run();
    expect(r.status).toBe("done");
    expect(await start(r.id)).toBe(10000);
    base = { id: r.id, pnl: await pnl(r.id) };
  });

  it("a workspace .env is read by qkt.config.yaml substitution, and editing it changes the run instead of hitting the cache", async () => {
    writeFileSync(path.join(ws, ".env"), "STUDIO_TEST_BALANCE=25000\n");
    const r = await run();
    expect(r.status).toBe("done");
    expect(r.id).not.toBe(base.id);
    expect(await start(r.id)).toBe(25000);
    // secrets in .env never land in the run's files
    const files = execSync(`grep -rl "25000" ${path.join(ws, "runs", r.id)}/source ${path.join(ws, "runs", r.id)}/run.json || true`).toString();
    expect(files).not.toContain(".env");
  });

  it("instruments.yaml in the workspace changes contract sizing for the run", async () => {
    writeFileSync(path.join(ws, ".env"), "");
    writeFileSync(path.join(ws, "instruments.yaml"), "instruments:\n  - qktSymbol: BACKTEST:XAUUSD\n    contractSize: 1\n    volumeStep: 0.01\n    volumeMin: 0.01\n    volumeMax: 100\n    pointSize: 0.01\n    digits: 2\n    tradeStopsLevelPoints: 0\n");
    const r = await run();
    expect(r.status).toBe("done");
    const p = await pnl(r.id);
    expect(Math.abs(p)).toBeGreaterThan(0);
    expect(Math.abs(p / base.pnl)).toBeCloseTo(0.01, 2); // standard XAUUSD is 100 oz per lot; 1 oz is a hundredth of the P&L
    rmSync(path.join(ws, "instruments.yaml"));
  });

  it("a symbol can be pointed at another source; the run reads from it and the window is enforced", async () => {
    const alt = realpathSync(mkdtempSync(path.join(os.tmpdir(), "altsrc-")));
    mkdirSync(path.join(alt, "bars", "BACKTEST", "XAUUSD"), { recursive: true });
    symlinkSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m"), path.join(alt, "bars", "BACKTEST", "XAUUSD", "15m"));
    try {
      const bad = await put("/api/settings/symbol/XAUUSD", { source: "/definitely/not/here" });
      expect(bad.statusCode).toBe(400);
      const noSym = await put("/api/settings/symbol/NOSUCH", { source: alt });
      expect(noSym.statusCode).toBe(400);
      const ok = await put("/api/settings/symbol/XAUUSD", { source: alt, from: "2024-10-01", to: "2024-10-31" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().symbolPrefs.XAUUSD).toMatchObject({ source: alt, from: "2024-10-01", to: "2024-10-31" });
      expect(ok.json().sources).toContain(alt);
      const r = await run();
      expect(r.status).toBe("done");
      expect(await pnl(r.id)).toBeCloseTo(base.pnl, 6);            // same bars through the symlinked source
      expect(existsSync(path.join(ws, ".qkt-studio", "views"))).toBe(true);
      expect(readdirSync(path.join(ws, ".qkt-studio", "views")).length).toBeGreaterThan(0);
      // outside the window set for the symbol: refused with a message naming the symbol
      const out = await post("/api/runs", { strategy: "strategies/a.qkt", from: "2024-09-01", to: "2024-10-15", tier: "draft" });
      expect(out.statusCode).toBe(400);
      expect(out.json().error).toMatch(/XAUUSD/);
      // reset all
      const reset = await post("/api/settings/reset-symbols");
      expect(reset.json().symbolPrefs).toEqual({});
      const after = await run({ from: "2024-09-02", to: "2024-09-13" });
      expect(after.status).toBe("done");
    } finally { rmSync(alt, { recursive: true, force: true }); }
  });

  it("symbol detail lists every source and auto-find picks the best one", async () => {
    const d = (await get("/api/data/symbol/XAUUSD")).json();
    expect(d.sources[0]).toMatchObject({ isDefault: true });
    expect(d.sources[0].report.symbol).toBe("XAUUSD");
    const days = (await get("/api/data/symbol/XAUUSD/days?kind=BACKTEST:15m")).json();
    expect(days.days.length).toBeGreaterThan(3000);
    expect(days.days).toMatch(/^[octm]+$/);
    const af = (await post("/api/data/auto-find")).json();
    expect(af.symbolPrefs).toEqual({});   // the default source already has the most for every symbol
  });
});
