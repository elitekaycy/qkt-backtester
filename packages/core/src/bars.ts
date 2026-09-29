import { promises as fs } from "node:fs";
import path from "node:path";

/** Columnar bars. Prices are decoded floats (scaled ints / 10^scale). Times are epoch ms (bar start, UTC). */
export interface BarCols {
  tfMs: number;
  ts: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

export class QktFormatError extends Error {}

const MAGIC = "QKB1";

export function emptyBars(tfMs = 0): BarCols {
  const z = () => new Float64Array(0);
  return { tfMs, ts: z(), open: z(), high: z(), low: z(), close: z(), volume: z() };
}

/** Decode one qkt `qkt-bar-bin-v1` day file (little-endian header + six int64 columns). */
export function decodeBarDay(buf: Uint8Array): BarCols {
  if (buf.byteLength < 28) throw new QktFormatError("bar file too short");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
  if (magic !== MAGIC) throw new QktFormatError(`bad magic '${magic}': not a qkt bar file`);
  let o = 4;
  const version = dv.getInt32(o, true); o += 4;
  if (version !== 1) throw new QktFormatError(`unsupported bar format version ${version}`);
  const scale = dv.getInt32(o, true); o += 4;
  const tfMs = Number(dv.getBigInt64(o, true)); o += 8;
  const symLen = dv.getInt32(o, true); o += 4 + symLen;
  const n = dv.getInt32(o, true); o += 4;
  if (n < 0 || o + n * 6 * 8 > buf.byteLength) throw new QktFormatError("bar file truncated");
  const div = 10 ** scale;
  const col = (scaled: boolean) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++, o += 8) {
      const v = Number(dv.getBigInt64(o, true));
      a[i] = scaled ? v / div : v;
    }
    return a;
  };
  const ts = col(false);
  const open = col(true), high = col(true), low = col(true), close = col(true), volume = col(true);
  return { tfMs, ts, open, high, low, close, volume };
}

export function concatBars(parts: BarCols[]): BarCols {
  const nonEmpty = parts.filter((p) => p.ts.length);
  if (!nonEmpty.length) return emptyBars(parts[0]?.tfMs ?? 0);
  const total = nonEmpty.reduce((a, p) => a + p.ts.length, 0);
  const out = emptyBars(nonEmpty[0]!.tfMs);
  const alloc = () => new Float64Array(total);
  out.ts = alloc(); out.open = alloc(); out.high = alloc(); out.low = alloc(); out.close = alloc(); out.volume = alloc();
  let off = 0;
  for (const p of nonEmpty) {
    for (const k of ["ts", "open", "high", "low", "close", "volume"] as const) out[k].set(p[k], off);
    off += p.ts.length;
  }
  return out;
}

const DAY_MS = 86_400_000;
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Directory of one symbol/timeframe in the qkt bar store: `<root>/bars/<broker>/<symbol>/<tf>`. */
export const barDir = (dataRoot: string, broker: string, symbol: string, tf: string) =>
  path.join(dataRoot, "bars", broker, symbol, tf);

export interface ReadBarsResult {
  cols: BarCols;
  /** UTC days in [from,to) whose day file has at least one bar. */
  days: string[];
  /** Day file exists but holds 0 bars: qkt wrote it for a closed (non-trading) day, e.g. Saturdays. */
  emptyDays: string[];
  /** No day file at all: bars were never built for this day (unknown, not proven closed). */
  missingDays: string[];
}

/** Read bars for the half-open window [fromMs, toMs) — qkt's `--to` is exclusive, so are we. */
export async function readBars(
  dataRoot: string, broker: string, symbol: string, tf: string, fromMs: number, toMs: number,
): Promise<ReadBarsResult> {
  const dir = barDir(dataRoot, broker, symbol, tf);
  const parts: BarCols[] = [];
  const days: string[] = [];
  const emptyDays: string[] = [];
  const missingDays: string[] = [];
  const startDay = Math.floor(fromMs / DAY_MS) * DAY_MS;
  for (let d = startDay; d < toMs; d += DAY_MS) {
    const name = dayStr(d);
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(dir, `${name}.bin`));
    } catch {
      missingDays.push(name);
      continue;
    }
    const day = decodeBarDay(buf);
    if (day.ts.length === 0) { emptyDays.push(name); continue; }
    const keep: number[] = [];
    for (let i = 0; i < day.ts.length; i++) if (day.ts[i]! >= fromMs && day.ts[i]! < toMs) keep.push(i);
    days.push(name);
    if (keep.length === day.ts.length) parts.push(day);
    else parts.push(pick(day, keep));
  }
  return { cols: concatBars(parts), days, emptyDays, missingDays };
}

function pick(b: BarCols, idx: number[]): BarCols {
  const out = emptyBars(b.tfMs);
  const mk = (src: Float64Array) => Float64Array.from(idx, (i) => src[i]!);
  out.ts = mk(b.ts); out.open = mk(b.open); out.high = mk(b.high); out.low = mk(b.low); out.close = mk(b.close); out.volume = mk(b.volume);
  return out;
}

/** Timeframes with a bar directory for the symbol (e.g. ['15m','30m']), sorted by duration. */
export async function availableTimeframes(dataRoot: string, broker: string, symbol: string): Promise<string[]> {
  try {
    const dir = path.join(dataRoot, "bars", broker, symbol);
    const ents = await fs.readdir(dir, { withFileTypes: true });
    // a folder may be a link to another store (qkt follows links, Files.isDirectory)
    const dirs = await Promise.all(ents.map(async (e) => e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(path.join(dir, e.name)).then((st) => st.isDirectory(), () => false)))));
    return ents.filter((_, i) => dirs[i]).map((e) => e.name).sort((a, b) => tfToMs(a) - tfToMs(b));
  } catch {
    return [];
  }
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
export function tfToMs(tf: string): number {
  const m = /^(\d+)([smhdw])$/.exec(tf);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

/**
 * Reduce to at most `maxBars` by merging consecutive bars into OHLCV buckets (first open, max high,
 * min low, last close, summed volume). Bucket start = first bar's start, so times stay real bar times.
 */
export function lodAggregate(b: BarCols, maxBars: number): BarCols {
  const n = b.ts.length;
  if (n <= maxBars || maxBars < 1) return b;
  const step = Math.ceil(n / maxBars);
  const m = Math.ceil(n / step);
  const out = emptyBars(b.tfMs * step);
  out.ts = new Float64Array(m); out.open = new Float64Array(m); out.high = new Float64Array(m);
  out.low = new Float64Array(m); out.close = new Float64Array(m); out.volume = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const s = j * step, e = Math.min(n, s + step) - 1;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let i = s; i <= e; i++) { hi = Math.max(hi, b.high[i]!); lo = Math.min(lo, b.low[i]!); vol += b.volume[i]!; }
    out.ts[j] = b.ts[s]!; out.open[j] = b.open[s]!; out.high[j] = hi; out.low[j] = lo; out.close[j] = b.close[e]!; out.volume[j] = vol;
  }
  return out;
}

/** Aggregate bars into a coarser timeframe on UTC-aligned boundaries (used only when a real store tf is absent). */
export function resampleTo(b: BarCols, tfMs: number): BarCols {
  if (b.tfMs === tfMs || !b.ts.length) return b;
  const rows: number[][] = [];
  for (let i = 0; i < b.ts.length; i++) {
    const t = Math.floor(b.ts[i]! / tfMs) * tfMs;
    const last = rows[rows.length - 1];
    if (last && last[0] === t) {
      last[2] = Math.max(last[2]!, b.high[i]!); last[3] = Math.min(last[3]!, b.low[i]!); last[4] = b.close[i]!; last[5]! += b.volume[i]!;
    } else rows.push([t, b.open[i]!, b.high[i]!, b.low[i]!, b.close[i]!, b.volume[i]!]);
  }
  const out = emptyBars(tfMs);
  const col = (k: number) => Float64Array.from(rows, (r) => r[k]!);
  out.ts = col(0); out.open = col(1); out.high = col(2); out.low = col(3); out.close = col(4); out.volume = col(5);
  return out;
}

/** Bars of `tf` built from the `base` folder (resampled on qkt's UTC-aligned windows when base is finer). */
export async function readBarsVia(dataRoot: string, broker: string, symbol: string, tf: string, base: string, fromMs: number, toMs: number): Promise<ReadBarsResult> {
  const r = await readBars(dataRoot, broker, symbol, base, fromMs, toMs);
  return base === tf ? r : { ...r, cols: dropUnclosedTail(resampleTo(r.cols, tfToMs(tf)), r.cols) };
}

/**
 * qkt closes an aggregated candle when the data it replays reaches the candle's end. The last candle of a range whose
 * source bars stop short of its end (Friday's 20:00 4h candle when the market closes at 21:00 and the run ends before
 * Monday) is never closed, so no strategy ever sees it; drop it so the chart shows exactly the candles qkt evaluated.
 */
export function dropUnclosedTail(agg: BarCols, src: BarCols): BarCols {
  const n = agg.ts.length, m = src.ts.length;
  if (!n || !m) return agg;
  const sourceEnd = src.ts[m - 1]! + src.tfMs, candleEnd = agg.ts[n - 1]! + agg.tfMs;
  if (sourceEnd >= candleEnd) return agg;
  const cut = (a: Float64Array) => a.slice(0, n - 1);
  return { ...agg, ts: cut(agg.ts), open: cut(agg.open), high: cut(agg.high), low: cut(agg.low), close: cut(agg.close), volume: cut(agg.volume) };
}

/** Serialise to a compact binary payload for the browser: [n:u32][tfMs:f64] then 6 Float64 columns. */
export function packBars(b: BarCols): Uint8Array {
  const n = b.ts.length;
  const buf = new ArrayBuffer(4 + 4 + 8 + n * 6 * 8);
  const dv = new DataView(buf);
  dv.setUint32(0, n, true); dv.setUint32(4, 0, true); dv.setFloat64(8, b.tfMs, true);
  const f = new Float64Array(buf, 16, n * 6);
  f.set(b.ts, 0); f.set(b.open, n); f.set(b.high, 2 * n); f.set(b.low, 3 * n); f.set(b.close, 4 * n); f.set(b.volume, 5 * n);
  return new Uint8Array(buf);
}
