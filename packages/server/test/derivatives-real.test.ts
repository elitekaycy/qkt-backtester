import { describe, it, expect } from "vitest";
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
