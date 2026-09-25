import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadResult, summarize, monthlyPnl, integrity, verifyManifest, UnsupportedResultError } from "../src/results.js";
import { parseTradesCsv, pairRoundTrips } from "../src/roundtrips.js";
import { decodeBarDay } from "../src/bars.js";

const fx = (n: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n);
const raw = JSON.parse(readFileSync(fx("result-oct.json"), "utf8"));
const fills = parseTradesCsv(readFileSync(fx("trades-oct.csv"), "utf8"));
const trips = pairRoundTrips(fills);
const result = loadResult(raw);

describe("loadResult gate", () => {
  it("loads the real result", () => expect(result.global.tradeCount).toBe(81));
  it("rejects unknown schema and version and junk", () => {
    expect(() => loadResult({ ...raw, schema: "other" })).toThrow(UnsupportedResultError);
    expect(() => loadResult({ ...raw, schemaVersion: 2 })).toThrow(/schemaVersion 2/);
    expect(() => loadResult(null)).toThrow(UnsupportedResultError);
    expect(() => loadResult({ schema: "qkt-backtest-result-v1", schemaVersion: 1 })).toThrow(/missing/);
  });
});

describe("summarize", () => {
  const s = summarize(result, trips);
  it("distinguishes fills from trades", () => {
    expect(s.fills).toBe(81);
    expect(s.trades).toBe(40);
    expect(s.openTrades).toBe(1);
  });
  it("derived win rate equals the engine's, and PF agrees closely", () => {
    expect(s.winRate).toBeCloseTo(s.engineWinRate, 6);
    expect(s.profitFactor!).toBeCloseTo(s.engineProfitFactor, 4);
  });
  it("separates realised from unrealised", () => {
    expect(s.realized).toBeCloseTo(376.85, 6);
    expect(s.unrealized).toBeCloseTo(6.55, 6);
    expect(s.totalPnl).toBeCloseTo(383.4, 6);
  });
  it("long/short split adds up", () => {
    expect(s.long.trades + s.short.trades).toBe(40);
    expect(s.short.trades).toBe(0);
    expect(s.expectancy).toBeCloseTo(376.85 / 40, 6);
  });
});

describe("monthlyPnl", () => {
  it("sums to the realised total", () => {
    const m = monthlyPnl(trips);
    expect(m.reduce((a, r) => a + r.pnl, 0)).toBeCloseTo(376.85, 6);
    expect(m.every((r) => /^\d{4}-\d{2}$/.test(r.month))).toBe(true);
  });
  it("is empty with no closed trips", () => expect(monthlyPnl([])).toEqual([]));
});

describe("integrity", () => {
  const day = decodeBarDay(new Uint8Array(readFileSync(fx("bars-2024-10-02.bin"))));
  const d0 = Date.UTC(2024, 9, 2), d1 = Date.UTC(2024, 9, 3);
  const dayFills = fills.filter((f) => f.ts >= d0 && f.ts < d1);

  it("passes on the real run", () => {
    const rep = integrity({ result, trips, fills: dayFills, bars: { "BACKTEST:XAUUSD:15m": day }, barCounts: { "BACKTEST:XAUUSD:15m": 2021 } });
    expect(dayFills.length).toBeGreaterThan(0);
    expect(rep.checks.find((c) => c.id === "reconcile")!.ok).toBe(true);
    expect(rep.checks.find((c) => c.id === "barCount")!.ok).toBe(true);
    expect(rep.checks.find((c) => c.id === "fillsInBars")!.ok).toBe(true);
    expect(rep.ok).toBe(true);
  });
  it("flags a bar-count mismatch with both numbers in the detail", () => {
    const rep = integrity({ result, trips, fills: [], barCounts: { "BACKTEST:XAUUSD:15m": 2000 } });
    const c = rep.checks.find((x) => x.id === "barCount")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/chart 2000 vs engine 2021/);
    expect(rep.ok).toBe(false);
  });
  it("flags a fill outside its bar, and the tolerance forgives a spread", () => {
    const f0 = dayFills[0]!;
    const bad = [{ ...f0, price: f0.price + 500 }];
    const strict = integrity({ result, trips, fills: bad, bars: { "BACKTEST:XAUUSD:15m": day } });
    expect(strict.checks.find((c) => c.id === "fillsInBars")!.ok).toBe(false);
    const loose = integrity({ result, trips, fills: bad, bars: { "BACKTEST:XAUUSD:15m": day }, priceTol: 1000 });
    expect(loose.checks.find((c) => c.id === "fillsInBars")!.ok).toBe(true);
  });
  it("flags tampered P&L", () => {
    const tampered = trips.map((t, i) => (i === 0 ? { ...t, pnl: t.pnl + 50 } : t));
    const rep = integrity({ result, trips: tampered, fills: [] });
    expect(rep.checks.find((c) => c.id === "reconcile")!.ok).toBe(false);
    expect(rep.ok).toBe(false);
  });
  it("unevaluated checks are null and do not fail the report", () => {
    const rep = integrity({ result, trips, fills: [] });
    expect(rep.checks.filter((c) => c.ok === null).map((c) => c.id).sort()).toEqual(["barCount", "fillsInBars", "manifest"]);
    expect(rep.ok).toBe(true);
  });
});

describe("verifyManifest", () => {
  const mk = (content: string, sha?: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "man-"));
    writeFileSync(path.join(dir, "a.csv"), content);
    const h = "sha256:" + createHash("sha256").update(content).digest("hex");
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ artifacts: [{ path: "a.csv", sha256: sha ?? h, bytes: content.length }] }));
    return dir;
  };
  it("accepts matching artifacts", async () => expect((await verifyManifest(mk("hello"))).ok).toBe(true));
  it("rejects a tampered artifact", async () => {
    const dir = mk("hello");
    writeFileSync(path.join(dir, "a.csv"), "HELLO");
    const r = await verifyManifest(dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/a\.csv/);
  });
  it("reports a missing manifest instead of throwing", async () => {
    expect((await verifyManifest(mkdtempSync(path.join(os.tmpdir(), "man-")))).ok).toBe(false);
  });
});
