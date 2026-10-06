import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { Runner } from "../src/runner.js";
import { qktBin, haveQkt } from "./helpers.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { realData } from "./helpers.js";
import { scanDerivatives } from "../src/derivatives-scan.js";
import { readinessFor } from "../src/data-scan.js";
import type { ScanReport } from "@qkt-studio/core";

// the maintainer's real store (CME futures 2000-2022 with measured rolls, Binance perpetuals with funding); skipped without it
const have = existsSync(path.join(realData, "contracts", "CME", "ES.rolls.json"));
const d = describe.skipIf(!have);

d("the real futures store", () => {
  it("scans hundreds of contract folders from listings alone, in seconds", async () => {
    const t0 = Date.now();
    const r = await scanDerivatives(realData);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const es = r.futures.find((f) => f.key === "CME:ES")!;
    expect(es.contracts.length).toBeGreaterThan(80);
    expect(es.rolls!.count).toBeGreaterThan(80);
    expect(es.terms).toMatchObject({ multiplier: 50, calendar: "cme_globex" });
  });

  it("ES@front on daily bars has a long complete window, with weekends and holidays closed", async () => {
    const derivatives = await scanDerivatives(realData);
    const report = { derivatives, symbols: [] } as unknown as ScanReport;
    const src = "STRATEGY t VERSION 1\n\nSYMBOLS\n    es = CME:ES@front EVERY 1d\n\nRULES\n    WHEN es.close > 0 AND POSITION.es = 0\n    THEN BUY es SIZING 1\n";
    const r = readinessFor(report, "es.qkt", src);
    expect(r.kinds).toEqual({ es: "continuous" });
    expect(r.bars.runnable).toBe(true);
    const longest = r.bars.longest!;
    expect(longest.from <= "2005-01-01" && longest.to >= "2021-01-01").toBe(true);
  });
});

// qkt counts every Sunday and exchange holiday of a listed CME contract as a missing day (it applies the FX week), so such a
// run only starts with --allow-incomplete once the studio has judged the days by the root's calendar [probed: ESH19, Oct 2018 - Mar 2019]
const haveH19 = existsSync(path.join(realData, "bars", "CME", "ESH19", "1d", "2019-01-15.bin"));
describe.skipIf(!have || !haveH19 || !haveQkt)("a listed futures contract through the runner", () => {
  const H19 = "STRATEGY h19 VERSION 1\n\nSYMBOLS\n    x = CME:ESH19 EVERY 1d\n\nRULES\n    WHEN ema(x.close, 5) CROSSES ABOVE ema(x.close, 10) AND POSITION.x = 0\n    THEN BUY x SIZING 1\n\n    WHEN ema(x.close, 5) CROSSES BELOW ema(x.close, 10) AND POSITION.x > 0\n    THEN CLOSE x\n";
  const run = async (from: string, to: string) => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "h19-")));
    mkdirSync(path.join(ws, "strategies"));
    writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 500000\nrisk:\n  max_order_notional: \"10000000\"\n  max_order_qty: \"1000\"\n  max_daily_loss: \"100000\"\n");
    writeFileSync(path.join(ws, "strategies", "h19.qkt"), H19);
    const runner = new Runner({ workspace: ws, dataRoot: realData, qktBin, port: 0, host: "127.0.0.1", maxParallel: 1, terminal: "restricted" } as never);
    await runner.init();
    try { const { runId } = await runner.submit({ strategy: "strategies/h19.qkt", from, to, tier: "draft" }); return await runner.waitFor(runId); }
    finally { await runner.close(); rmSync(ws, { recursive: true, force: true }); }
  };
  it("runs over a window whose only 'missing' days are Sundays and holidays", async () => {
    const r = await run("2018-10-01", "2019-03-01");
    expect(r.status).toBe("done");
    expect(r.steps.find((s) => s.id === "coverage")!.status).toBe("ok");
  }, 120_000);
  it("still refuses a window past the contract's last bar, naming the days", async () => {
    const r = await run("2019-03-10", "2019-04-10");
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("incomplete_data");
  }, 120_000);
});
