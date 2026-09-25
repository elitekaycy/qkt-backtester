import { describe, it, expect } from "vitest";
import { runMonteCarlo, mulberry32, TooFewTrades, MC_MIN_TRADES, type McOptions } from "../src/montecarlo.js";

// 60 trades: 35 wins of +100, 25 losses of -60 in a fixed scrambled order.
const pnls = Array.from({ length: 60 }, (_, i) => ((i * 7) % 12 < 7 ? 100 : -60));
const base: McOptions = { method: "shuffle", sims: 500, seed: 42, startEquity: 10_000 };
const total = pnls.reduce((a, b) => a + b, 0);

describe("mulberry32", () => {
  it("is deterministic and uniform-ish", () => {
    const a = mulberry32(1), b = mulberry32(1), c = mulberry32(2);
    const xs = Array.from({ length: 5 }, () => a()), ys = Array.from({ length: 5 }, () => b());
    expect(xs).toEqual(ys);
    expect(xs).not.toEqual(Array.from({ length: 5 }, () => c()));
    const big = Array.from({ length: 20000 }, () => a());
    expect(big.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(big.reduce((s, v) => s + v, 0) / big.length).toBeGreaterThan(0.48);
    expect(big.reduce((s, v) => s + v, 0) / big.length).toBeLessThan(0.52);
  });
});

describe("runMonteCarlo", () => {
  it("is reproducible for a seed and different for another", () => {
    const a = runMonteCarlo(pnls, base), b = runMonteCarlo(pnls, base), c = runMonteCarlo(pnls, { ...base, seed: 43 });
    expect(a).toEqual(b);
    expect(c.maxDrawdown.p50).not.toBe(a.maxDrawdown.p50);
  });
  it("shuffle preserves the final equity of every path but changes drawdowns", () => {
    const r = runMonteCarlo(pnls, base);
    expect(r.finalEquity.p5).toBeCloseTo(10_000 + total, 6);
    expect(r.finalEquity.p95).toBeCloseTo(10_000 + total, 6);
    expect(r.maxDrawdown.p95).toBeGreaterThan(r.maxDrawdown.p5);
    expect(r.probNegative).toBe(0);
  });
  it("bootstrap varies the final equity", () => {
    const r = runMonteCarlo(pnls, { ...base, method: "bootstrap" });
    expect(r.finalEquity.p95).toBeGreaterThan(r.finalEquity.p5);
  });
  it("block bootstrap runs with the default and an explicit block length", () => {
    const d = runMonteCarlo(pnls, { ...base, method: "block" });
    const e = runMonteCarlo(pnls, { ...base, method: "block", blockLen: 10 });
    expect(d.trades).toBe(60);
    expect(e.finalEquity.p95).toBeGreaterThanOrEqual(e.finalEquity.p5);
  });
  it("skip 0% reproduces the original path; skipping more lowers a winning strategy's median", () => {
    const none = runMonteCarlo(pnls, { ...base, method: "skip", skipPct: 0 });
    expect(none.finalEquity.p5).toBeCloseTo(10_000 + total, 6);
    expect(none.finalEquity.p95).toBeCloseTo(10_000 + total, 6);
    const half = runMonteCarlo(pnls, { ...base, method: "skip", skipPct: 0.5 });
    expect(half.finalEquity.p50).toBeLessThan(10_000 + total);
  });
  it("quantiles are ordered and the fan starts at the start equity and ends at the final bands", () => {
    const r = runMonteCarlo(pnls, { ...base, method: "bootstrap" });
    for (const k of ["finalEquity", "maxDrawdown"] as const) {
      const q = r[k];
      expect(q.p5).toBeLessThanOrEqual(q.p25); expect(q.p25).toBeLessThanOrEqual(q.p50);
      expect(q.p50).toBeLessThanOrEqual(q.p75); expect(q.p75).toBeLessThanOrEqual(q.p95);
    }
    expect(r.fanIndex[0]).toBe(0); expect(r.fanIndex[r.fanIndex.length - 1]).toBe(60);
    expect(r.fan.p50[0]).toBe(10_000);
    expect(r.fan.p50[r.fan.p50.length - 1]).toBeCloseTo(r.finalEquity.p50, 6);
  });
  it("reports the observed path so the UI can place the real result inside the distribution", () => {
    const r = runMonteCarlo(pnls, base);
    expect(r.observed.finalEquity).toBe(10_000 + total);
    expect(r.observed.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
  it("drawdown histogram counts every path", () => {
    const r = runMonteCarlo(pnls, { ...base, method: "bootstrap" });
    expect(r.drawdownHistogram.counts.reduce((a, b) => a + b, 0)).toBe(500);
    expect(r.drawdownHistogram.edges.length).toBe(21);
  });
  it("probRuin responds to the threshold", () => {
    const loose = runMonteCarlo(pnls, { ...base, method: "bootstrap", ruinDrawdown: 0.9 });
    const tight = runMonteCarlo(pnls, { ...base, method: "bootstrap", ruinDrawdown: 0.001 });
    expect(tight.probRuin).toBe(1);
    expect(loose.probRuin).toBeLessThanOrEqual(tight.probRuin);
  });
  it("caps the fan at ~200 points for long trade lists", () => {
    const long = Array.from({ length: 5000 }, (_, i) => (i % 3 ? 10 : -12));
    const r = runMonteCarlo(long, { ...base, sims: 50 });
    expect(r.fanIndex.length).toBeLessThanOrEqual(201);
    expect(r.fanIndex[r.fanIndex.length - 1]).toBe(5000);
  });
  it("refuses too few trades with a typed error the UI can explain", () => {
    expect(() => runMonteCarlo(pnls.slice(0, MC_MIN_TRADES - 1), base)).toThrow(TooFewTrades);
    try { runMonteCarlo([], base); } catch (e) { expect((e as TooFewTrades).have).toBe(0); }
  });
  it("rejects nonsense options", () => {
    expect(() => runMonteCarlo(pnls, { ...base, sims: 0 })).toThrow(RangeError);
    expect(() => runMonteCarlo(pnls, { ...base, sims: 1e9 })).toThrow(RangeError);
    expect(() => runMonteCarlo(pnls, { ...base, method: "skip", skipPct: 2 })).toThrow(RangeError);
  });
});
