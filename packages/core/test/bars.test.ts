import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { type BarCols, decodeBarDay, lodAggregate, readBars, QktFormatError, resampleTo, packBars, tfToMs, availableTimeframes } from "../src/bars.js";

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

  // bars on the 15m grid, from `start` for `n` bars, minus the bar indexes in `drop` (a missing bar: a gap in the data)
  const grid = (start: number, n: number, drop: number[] = []): BarCols => {
    const idx = [...Array(n).keys()].filter((i) => !drop.includes(i));
    const col = (f: (i: number) => number) => Float64Array.from(idx, f);
    return { tfMs: M15, ts: col((i) => start + i * M15), open: col((i) => 100 + i), high: col((i) => 101 + i), low: col((i) => 99 + i), close: col((i) => 100.5 + i), volume: col(() => 1) };
  };
  const M15 = 900_000, H = 3_600_000, T0 = Date.UTC(2024, 1, 5);

  it("puts merged bars on regular clock boundaries, even after a gap of an odd number of bars", () => {
    // 2000 bars with one bar missing after the first 101: grouping by count would start every later bucket at :15 or :45
    const b = grid(T0, 2000, [101]);
    const a = lodAggregate(b, 600);
    expect(a.ts.length).toBeLessThanOrEqual(600);
    expect(a.tfMs % M15).toBe(0);
    for (const t of a.ts) expect(t % a.tfMs).toBe(0);
    // every source bar lies inside exactly the merged bar that starts at floor(ts / tfMs) * tfMs
    const starts = new Set(a.ts);
    for (const t of b.ts) expect(starts.has(Math.floor(t / a.tfMs) * a.tfMs)).toBe(true);
  });

  it("picks the smallest familiar timeframe that fits: 15m bars capped at a quarter merge into 1h bars at :00", () => {
    const b = grid(T0, 4000);
    const a = lodAggregate(b, 1000);
    expect(a.tfMs).toBe(H);
    expect(a.ts.length).toBe(1000);
    expect(a.ts[0]).toBe(T0);
    expect(a.open[0]).toBe(b.open[0]); expect(a.close[0]).toBe(b.close[3]);
    expect(a.high[0]).toBe(b.high[3]); expect(a.low[0]).toBe(b.low[0]); expect(a.volume[0]).toBe(4);
  });

  it("starts the first merged bar on the grid when the data starts mid-bucket, and keeps OHLCV totals", () => {
    const b = grid(T0 + 2 * M15, 3000, [7, 8, 9, 500]); // starts at :30, a 45-minute gap, then a lone missing bar
    const a = lodAggregate(b, 900);
    expect(a.ts.length).toBeLessThanOrEqual(900);
    expect(a.ts[0]).toBe(Math.floor(b.ts[0]! / a.tfMs) * a.tfMs);
    expect(a.open[0]).toBe(b.open[0]);
    expect(a.close[a.close.length - 1]).toBe(b.close[b.close.length - 1]);
    expect(Math.max(...a.high)).toBe(Math.max(...b.high));
    expect(Math.min(...a.low)).toBe(Math.min(...b.low));
    expect(a.volume.reduce((x, y) => x + y, 0)).toBe(b.ts.length);
  });

  it("stays under the cap however sparse or long the data is", () => {
    for (const [n, max] of [[20_001, 20_000], [70_000, 20_000], [5000, 100], [3, 1]] as const) {
      const a = lodAggregate(grid(T0, n), max);
      expect(a.ts.length).toBeLessThanOrEqual(max);
      for (const t of a.ts) expect(t % a.tfMs).toBe(0);
    }
  });

  it("uses a whole multiple of an unusual base timeframe when no familiar one divides it", () => {
    const b: BarCols = { ...grid(0, 1000), tfMs: 7 * 60_000, ts: Float64Array.from({ length: 1000 }, (_, i) => i * 7 * 60_000) };
    const a = lodAggregate(b, 300);
    expect(a.tfMs % b.tfMs).toBe(0);
    expect(a.ts.length).toBeLessThanOrEqual(300);
    for (const t of a.ts) expect(t % a.tfMs).toBe(0);
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

import { dropUnclosedTail } from "../src/bars.js";
describe("dropUnclosedTail: the chart shows the candles qkt closed", () => {
  const H = 3_600_000, cols = (tfMs: number, ts: number[]) => ({ tfMs, ts: Float64Array.from(ts), open: Float64Array.from(ts.map(() => 1)), high: Float64Array.from(ts.map(() => 2)), low: Float64Array.from(ts.map(() => 0.5)), close: Float64Array.from(ts.map(() => 1.5)), volume: Float64Array.from(ts.map(() => 1)) });
  it("drops a last 4h candle whose data stops before its end (the market closed)", () => {
    const src = cols(H / 4, [16 * H, 16.25 * H, 20 * H, 20.75 * H]);   // data ends 21:00
    const agg = cols(4 * H, [16 * H, 20 * H]);
    expect(Array.from(dropUnclosedTail(agg, src).ts)).toEqual([16 * H]);
  });
  it("keeps a last candle whose data reaches its end", () => {
    const src = cols(H / 4, [20 * H, 23.75 * H]);                        // last bar closes 24:00
    const agg = cols(4 * H, [20 * H]);
    expect(dropUnclosedTail(agg, src).ts.length).toBe(1);
  });
});

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
describe("availableTimeframes follows folder links, as qkt does", () => {
  it("lists a timeframe folder that is a link into another store, and ignores a link to a file", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tfs-"));
    try {
      mkdirSync(path.join(tmp, "archive", "60m"), { recursive: true });
      mkdirSync(path.join(tmp, "bars", "BACKTEST", "ES", "15m"), { recursive: true });
      symlinkSync(path.join(tmp, "archive", "60m"), path.join(tmp, "bars", "BACKTEST", "ES", "1h"));
      writeFileSync(path.join(tmp, "archive", "note.txt"), "x");
      symlinkSync(path.join(tmp, "archive", "note.txt"), path.join(tmp, "bars", "BACKTEST", "ES", "note"));
      expect(await availableTimeframes(tmp, "BACKTEST", "ES")).toEqual(["15m", "1h"]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
