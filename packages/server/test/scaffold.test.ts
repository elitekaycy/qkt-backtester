import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStudio } from "../src/main.js";
import { scanStore } from "../src/data-scan.js";
import { instrumentsTemplate, scaffoldWorkspace, sampleStrategies } from "../src/scaffold.js";

const realData = path.join(os.homedir(), ".qkt", "data");
const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));

describe("scaffold templates", () => {
  it("instruments.yaml lists each symbol once, with tunable fields", () => {
    const t = instrumentsTemplate([{ broker: "BACKTEST", symbol: "BTCUSD" }, { broker: "BACKTEST", symbol: "BTCUSD" }, { broker: "BACKTEST", symbol: "ZZZ" }]);
    expect(t.match(/qktSymbol: BACKTEST:BTCUSD/g)).toHaveLength(1);
    expect(t).toMatch(/qktSymbol: BACKTEST:ZZZ.*GUESSED/);
    for (const k of ["contractSize", "volumeStep", "commissionPerLot", "slippagePoints", "swapLongPoints", "swapTripleDay"]) expect(t).toContain(k);
  });
  it("never overwrites an existing file", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sc-")));
    writeFileSync(path.join(ws, ".env"), "MINE=1\n");
    const r = await scaffoldWorkspace(ws, null);
    expect(r.skipped).toContain(".env");
    expect(readFileSync(path.join(ws, ".env"), "utf8")).toBe("MINE=1\n");
    expect(r.created).toEqual(expect.arrayContaining(["qkt.config.yaml", "instruments.yaml", ".env.example", ".gitignore"]));
    rmSync(ws, { recursive: true, force: true });
  });
});

describe.skipIf(!haveQkt || !haveData)("a scaffolded workspace runs out of the box on the real store", () => {
  let ws: string, studio: Awaited<ReturnType<typeof createStudio>>;
  beforeAll(async () => {
    ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sc2-")));
    const scan = await scanStore(realData);
    await scaffoldWorkspace(ws, scan);
    studio = await createStudio({ workspace: ws, dataRoot: realData, defaultDataRoot: realData, qktBin, port: 0, host: "127.0.0.1", maxParallel: 2, terminal: "restricted" });
  });
  afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

  it("the sample strategy targets a symbol that exists, and the full config + instruments file are accepted by qkt", async () => {
    const files = sampleStrategies(await scanStore(realData));
    expect(Object.keys(files)).toContain("strategies/ema_cross.qkt");
    const r = await studio.app.inject({ method: "POST", url: "/api/runs", payload: { strategy: "strategies/ema_cross.qkt", from: "2024-10-01", to: "2024-10-20", tier: "draft" } });
    expect(r.statusCode).toBe(202);
    const id = r.json().runId as string;
    let run: { status: string; error?: { message: string } } = { status: "queued" };
    for (let i = 0; i < 240 && !["done", "failed"].includes(run.status); i++) { await new Promise((x) => setTimeout(x, 250)); run = (await studio.app.inject({ url: `/api/runs/${id}` })).json(); }
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe("done");
  });

  it("missing-file report and scaffold endpoint", async () => {
    rmSync(path.join(ws, "instruments.yaml"));
    expect((await studio.app.inject({ url: "/api/workspace/missing" })).json().missing).toEqual(["instruments.yaml"]);
    const s = (await studio.app.inject({ method: "POST", url: "/api/workspace/scaffold", payload: { files: ["instruments.yaml"] } })).json();
    expect(s.created).toEqual(["instruments.yaml"]);
    expect(s.missing).toEqual([]);
  });
});

describe("scaffold endpoint defaults", () => {
  it("never creates sample strategies unless asked for by name", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sc3-")));
    const studio = await createStudio({ workspace: ws, dataRoot: os.tmpdir(), defaultDataRoot: os.tmpdir(), qktBin, port: 0, host: "127.0.0.1", maxParallel: 1, terminal: "restricted" });
    const r = (await studio.app.inject({ method: "POST", url: "/api/workspace/scaffold", payload: {} })).json();
    expect(r.created).not.toContain("strategies/ema_cross.qkt");
    expect(existsSync(path.join(ws, "strategies"))).toBe(false);
    await studio.app.close(); rmSync(ws, { recursive: true, force: true });
  });
});

import { checkConfig } from "@qkt-studio/core";
import { CONFIG_TEMPLATE } from "../src/scaffold.js";
describe("the starter config is clean", () => {
  it("the studio's own qkt.config.yaml template raises no findings", () => {
    expect(checkConfig(CONFIG_TEMPLATE, true, {}).filter((f) => f.severity !== "info")).toEqual([]);
  });
});

import { completeConfig, CONFIG_TEMPLATE } from "../src/scaffold.js";
import { haveQkt, qktBin } from "./helpers.js";
describe("completeConfig: the full reference around the user's own values", () => {
  it("keeps every value the user set and adds every other option", () => {
    const out = completeConfig("starting_balance: 25000\n");
    expect(out).toContain("starting_balance: 25000");
    expect(out).not.toContain("starting_balance: ${STARTING_BALANCE");
    for (const k of ["execution:", "risk:", "book_risk:", "brokers:", "insights:", "promotion:", "live_equity_basis"]) expect(out).toContain(k);
  });
  it("replaces a whole section the user wrote, and keeps sections the reference does not know", () => {
    const out = completeConfig("risk:\n  max_daily_loss: \"0\"\n\ncustom_thing:\n  a: 1\n");
    expect(out).toContain('risk:\n  max_daily_loss: "0"');
    expect(out).not.toContain('max_daily_loss: "1000"            # "0" disables');
    expect(out).toMatch(/# Your other settings\ncustom_thing:\n {2}a: 1/);
  });
  it("is stable: completing a complete file changes nothing", () => {
    expect(completeConfig(CONFIG_TEMPLATE)).toBe(CONFIG_TEMPLATE.replace(/\s+$/, "") + "\n");
    const once = completeConfig("starting_balance: 25000\n");
    expect(completeConfig(once)).toBe(once);
  });
});
