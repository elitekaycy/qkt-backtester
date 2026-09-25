import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { decodeBarDay, lodAggregate, readBars, QktFormatError, resampleTo, packBars, tfToMs, availableTimeframes } from "../src/bars.js";

const fx = (n: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n);
const day = () => new Uint8Array(readFileSync(fx("bars-2024-10-02.bin")));

describe("decodeBarDay", () => {
  it("decodes the real 2024-10-02 XAUUSD 15m day file", () => {
    const b = decodeBarDay(day());
    expect(b.tfMs).toBe(900_000);
    expect(b.ts.length).toBe(92); // 96 bars minus the one-hour daily break
    expect(b.ts[0]! % 900_000).toBe(0);
    for (let i = 1; i < b.ts.length; i++) expect(b.ts[i]!).toBeGreaterThan(b.ts[i - 1]!);
    for (let i = 0; i < b.ts.length; i++) {
      expect(b.high[i]!).toBeGreaterThanOrEqual(Math.max(b.open[i]!, b.close[i]!));
      expect(b.low[i]!).toBeLessThanOrEqual(Math.min(b.open[i]!, b.close[i]!));
    }
    expect(b.close[0]!).toBeGreaterThan(2000); // gold, scaled-int decode sanity
    expect(b.close[0]!).toBeLessThan(4000);
  });
  it("rejects a bad magic", () => {
    const d = day().slice(); d[0] = 0x58;
    expect(() => decodeBarDay(d)).toThrow(QktFormatError);
  });
  it("rejects an unsupported version", () => {
    const d = day().slice(); new DataView(d.buffer).setInt32(4, 2, true);
    expect(() => decodeBarDay(d)).toThrow(/version 2/);
  });
  it("rejects truncated files", () => {
    expect(() => decodeBarDay(day().slice(0, 100))).toThrow(QktFormatError);
    expect(() => decodeBarDay(new Uint8Array(5))).toThrow(QktFormatError);
  });
});

describe("lodAggregate", () => {
  it("merges into correct OHLCV buckets and keeps real bar times", () => {
    const b = decodeBarDay(day());
    const a = lodAggregate(b, 23);
    expect(a.ts.length).toBeLessThanOrEqual(23);
    expect(a.open[0]).toBe(b.open[0]);
    expect(a.close[a.close.length - 1]).toBe(b.close[b.close.length - 1]);
    expect(Math.max(...a.high)).toBe(Math.max(...b.high));
    expect(Math.min(...a.low)).toBe(Math.min(...b.low));
    expect(a.volume.reduce((x, y) => x + y, 0)).toBeCloseTo(b.volume.reduce((x, y) => x + y, 0), 6);
    for (let i = 1; i < a.ts.length; i++) expect(a.ts[i]!).toBeGreaterThan(a.ts[i - 1]!);
  });
  it("is the identity when already small enough", () => {
    const b = decodeBarDay(day());
    expect(lodAggregate(b, 1000)).toBe(b);
  });
});

describe("resampleTo", () => {
  it("builds hourly bars from 15m without changing the price range", () => {
    const b = decodeBarDay(day());
    const h = resampleTo(b, 3_600_000);
    expect(h.ts.length).toBeLessThan(b.ts.length);
    expect(h.ts.every((t) => t % 3_600_000 === 0)).toBe(true);
    expect(Math.max(...h.high)).toBe(Math.max(...b.high));
  });
});

describe("packBars", () => {
  it("packs n, tfMs and six columns", () => {
    const b = decodeBarDay(day());
    const p = packBars(b);
    const dv = new DataView(p.buffer);
    expect(dv.getUint32(0, true)).toBe(92);
    expect(dv.getFloat64(8, true)).toBe(900_000);
    expect(p.byteLength).toBe(16 + 92 * 6 * 8);
  });
});

describe("tfToMs / readBars on the real store", () => {
  it("parses timeframes", () => {
    expect(tfToMs("15m")).toBe(900_000);
    expect(tfToMs("1h")).toBe(3_600_000);
    expect(tfToMs("nonsense")).toBe(Number.MAX_SAFE_INTEGER);
  });
  const root = path.join(os.homedir(), ".qkt", "data");
  const have = existsSync(path.join(root, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));
  it.skipIf(!have)("October 2024 with an exclusive upper bound equals the engine's liveCandles (2021)", async () => {
    const from = Date.UTC(2024, 9, 1), to = Date.UTC(2024, 9, 31);
    const r = await readBars(root, "BACKTEST", "XAUUSD", "15m", from, to);
    expect(r.cols.ts.length).toBe(2021);
    expect(r.cols.ts[r.cols.ts.length - 1]!).toBeLessThan(to);
  });
  it.skipIf(!have)("separates closed days (empty file) from unbuilt days (no file); never invents bars", async () => {
    const r = await readBars(root, "BACKTEST", "XAUUSD", "15m", Date.UTC(2024, 9, 5), Date.UTC(2024, 9, 8));
    expect(r.emptyDays).toContain("2024-10-05"); // Saturday: qkt writes a 0-bar file
    expect(r.missingDays).toEqual([]);
    const future = await readBars(root, "BACKTEST", "XAUUSD", "15m", Date.UTC(2031, 0, 5), Date.UTC(2031, 0, 7));
    expect(future.missingDays).toEqual(["2031-01-05", "2031-01-06"]);
    expect(future.cols.ts.length).toBe(0);
  });
  it.skipIf(!have)("lists timeframes present for a symbol", async () => {
    expect(await availableTimeframes(root, "BACKTEST", "XAUUSD")).toContain("15m");
    expect(await availableTimeframes(root, "BACKTEST", "NOPE")).toEqual([]);
  });
});
