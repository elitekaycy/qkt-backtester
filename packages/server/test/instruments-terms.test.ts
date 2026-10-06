import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStudio } from "../src/main.js";
import { haveQkt, testConfig } from "./helpers.js";

// The terms a run uses are the workspace's instruments.yaml, entirely; the data source's file is only the fallback. The root
// dialog has to show the ones the next run will use, say where they come from, and flag where the two files disagree.
const FUT = path.resolve(import.meta.dirname, "fixtures/deriv/futures");
const d = describe.skipIf(!haveQkt);

d("which instruments.yaml a run uses", () => {
  let ws: string, studio: Awaited<ReturnType<typeof createStudio>>;
  const get = () => studio.app.inject({ method: "GET", url: "/api/instruments" }).then((r) => r.json());
  beforeAll(async () => {
    ws = mkdtempSync(path.join(os.tmpdir(), "terms-ws-"));
    mkdirSync(path.join(ws, "strategies"));
    writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 100000\n");
    studio = await createStudio(testConfig(ws, { dataRoot: FUT }));
  });
  afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

  it("falls back to the data source's file when the workspace has none", async () => {
    const i = await get();
    expect(i.effective).toBe("dataRoot");
    expect(i.workspace.exists).toBe(false);
    expect(i.differences).toEqual({});
    expect(i.catalog.futures[0]).toMatchObject({ root: "BINANCE_UM:BTCUSDT", multiplier: 1 });
  });
  it("uses the workspace's file entirely once it exists, and says where the two disagree", async () => {
    writeFileSync(path.join(ws, "instruments.yaml"), "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 5\n    tickSize: 0.1\n");
    const i = await get();
    expect(i.effective).toBe("workspace");
    expect(i.workspace.exists).toBe(true);
    expect(i.workspace.catalog.futures[0]).toMatchObject({ multiplier: 5 });
    expect(i.differences["BINANCE_UM:BTCUSDT"]).toContain("multiplier");
  });
  it("a workspace file with no futures section leaves its roots to the data source's terms: they are not the run's", async () => {
    writeFileSync(path.join(ws, "instruments.yaml"), "instruments:\n  - qktSymbol: BACKTEST:EURUSD\n    contractSize: 100000\n");
    const i = await get();
    expect(i.effective).toBe("workspace");
    expect(i.differences["BINANCE_UM:BTCUSDT"]).toEqual(["only in the data source"]);
  });
});
