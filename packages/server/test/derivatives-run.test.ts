import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newRunJson } from "@qkt-studio/core";
import { postprocess } from "../src/postprocess.js";
import { hasContinuous, isOptionStream, tierProblem } from "../src/derivatives-run.js";
import { optionArgs, validateOptions } from "../src/run-options.js";

const fixture = (n: string) => new URL(`../../core/test/fixtures/futures/${n}/`, import.meta.url).pathname;
const ES_YAML = "futures:\n  - root: CME:ES\n    multiplier: 50\n    tickSize: 0.25\n";

/** A run directory holding a real qkt 0.55 bundle (trimmed) as engine/, derived by the studio's own post-processing. */
async function derive(name: string, instrumentsText = "", dataRoot?: string) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "drv-")));
  cpSync(fixture(name), path.join(dir, "engine"), { recursive: true });
  const run = newRunJson({ id: "r1", hash: "h", tier: "draft", strategy: "s.qkt", from: "2019-01-01", to: "2021-01-01", params: {}, engine: { version: "0.55.0" }, seq: 1 });
  const root = dataRoot ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "dat-")));
  const res = await postprocess({ runDir: dir, run, dataRoot: root, instrumentsText });
  const read = (f: string) => JSON.parse(readFileSync(path.join(dir, "derived", f), "utf8"));
  return { dir, res, read, has: (f: string) => existsSync(path.join(dir, "derived", f)) };
}

describe("derived files of a futures run", () => {
  it("continuous futures: derivatives.json, contracts on the trips, kinds and sections in meta", async () => {
    const d = await derive("es-front", ES_YAML);
    const meta = d.read("meta.json");
    expect(meta.derivatives).toEqual(["rolls", "contracts", "margin", "costs"]);
    expect(meta.streams[0]).toMatchObject({ key: "CME:ES@front:1d", symbol: "ES@front", kind: "continuous", base: null });
    const dv = d.read("derivatives.json");
    expect(dv.rolls[0]).toMatchObject({ from: "CME:ESH19", to: "CME:ESM19", rollCost: 8.92 });
    expect(dv.costs.rollCosts).toBeCloseTo(62.44, 6);
    const trips = d.read("roundtrips.json");
    expect(trips[0]).toMatchObject({ contract: "CME:ESH19", exitContract: "CME:ESM19", rolls: 1 });
    expect(d.read("summary.json").costs.preCostPnl).toBeCloseTo(d.read("summary.json").totalPnl + 57.98 + 62.44, 6);
  });
  it("the reconcile check passes: roll costs are not in any fill", async () => {
    const d = await derive("es-front", ES_YAML);
    const chk = d.read("integrity.json").checks.find((c: { id: string }) => c.id === "reconcile");
    expect(chk.ok, chk.detail).toBe(true);
  });
  it("a continuous stream has no bar folder: it says so instead of claiming a missing one", async () => {
    const d = await derive("es-front", ES_YAML);
    const note = d.read("integrity.json").checks.find((c: { id: string }) => c.id === "streams");
    expect(note.detail).toContain("continuous futures stream is built from each contract's bars");
    expect(note.detail).not.toContain("no bar folder qkt can read");
  });
  it("a liquidation is a warning and a venue exit", async () => {
    const d = await derive("liquidation");
    expect(d.res.warnings.join(" ")).toContain("liquidated 1 position");
    expect(d.read("roundtrips.json")[0].venueExit).toBe("liquidation");
    expect(d.read("derivatives.json").liquidations[0].equity).toBeCloseTo(22335.27, 2);
  });
  it("an option held to expiry settles; its structure legs list", async () => {
    const opt = await derive("option-expiry");
    expect(opt.read("derivatives.json").settlements[0].price).toBe(457.17);
    expect(opt.read("meta.json").streams[0].kind).toBe("option");
    expect((await derive("structure")).read("derivatives.json").structures).toHaveLength(2);
  });
  it("funding shows as a cost on a perpetual", async () => {
    const d = await derive("perp-funding");
    expect(d.read("derivatives.json").financing[0]).toMatchObject({ component: "funding" });
    expect(d.read("meta.json").derivatives).toContain("costs");
  });
});

describe("a CFD run is untouched", () => {
  it("writes no derivatives.json, no derivatives key in meta, no kind on its streams, no cost bridge", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cfd-")));
    mkdirSync(path.join(dir, "engine"));
    const core = (f: string) => new URL(`../../core/test/fixtures/${f}`, import.meta.url).pathname;
    cpSync(core("result-oct.json"), path.join(dir, "engine", "result.json"));
    cpSync(core("trades-oct.csv"), path.join(dir, "engine", "trades.csv"));
    writeFileSync(path.join(dir, "engine", "equity_global.csv"), "timestamp,equity\n1,10000\n2,10001\n");
    writeFileSync(path.join(dir, "engine", "financing.csv"), "component,paid,netPnlImpact\nswap,0.00000000,0.00000000\n");
    const run = newRunJson({ id: "r2", hash: "h", tier: "draft", strategy: "s.qkt", from: "2024-10-01", to: "2024-11-01", params: {}, engine: { version: "0.55.0" }, seq: 1 });
    await postprocess({ runDir: dir, run, dataRoot: realpathSync(mkdtempSync(path.join(os.tmpdir(), "dat-"))), instrumentsText: "" });
    const derived = path.join(dir, "derived");
    expect(existsSync(path.join(derived, "derivatives.json"))).toBe(false);
    const meta = JSON.parse(readFileSync(path.join(derived, "meta.json"), "utf8"));
    expect(meta).not.toHaveProperty("derivatives");
    expect(meta.streams.every((s: object) => !("kind" in s))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(derived, "summary.json"), "utf8"))).not.toHaveProperty("costs");
    expect(readFileSync(path.join(derived, "roundtrips.json"), "utf8")).not.toMatch(/venueExit|exitContract|"contract"/);
  });
});

describe("tiers and flags", () => {
  const es = { broker: "CME", symbol: "ES@front" }, opt = { broker: "DERIBIT", symbol: "BTC_USDC_26SEP26_84500_P" }, cfd = { broker: "BACKTEST", symbol: "XAUUSD" };
  it("a continuous stream needs bars (Draft); an option needs its chain (Full); everything else runs on both", () => {
    expect(tierProblem([es], "full")).toMatch(/Draft/);
    expect(tierProblem([es], "draft")).toBeNull();
    expect(tierProblem([opt], "draft")).toMatch(/Full/);
    expect(tierProblem([opt], "full")).toBeNull();
    expect(tierProblem([{ broker: "OPTIONS", symbol: "DERIBIT.BTC_USDC" }], "draft")).toMatch(/Full/);
    expect(tierProblem([cfd], "draft")).toBeNull();
    expect(tierProblem([cfd], "full")).toBeNull();
    expect(tierProblem([{ broker: "BINANCE_UM", symbol: "BTCUSDT" }], "full")).toBeNull();
  });
  it("recognises the streams", () => {
    expect(hasContinuous([es])).toBe(true);
    expect(hasContinuous([cfd, opt])).toBe(false);
    expect(isOptionStream(opt)).toBe(true);
    expect(isOptionStream(cfd)).toBe(false);
  });
  it("--funding off is passed only when asked, in both tiers, and 'on' adds nothing", () => {
    expect(optionArgs(validateOptions("draft", { funding: "off" }))).toEqual(["--funding", "off"]);
    expect(optionArgs(validateOptions("full", { funding: "off", seed: 2 }))).toEqual(["--seed", "2", "--funding", "off"]);
    expect(validateOptions("draft", { funding: "on" })).toEqual({});
    expect(() => validateOptions("draft", { funding: "maybe" })).toThrow(/funding/);
  });
});

