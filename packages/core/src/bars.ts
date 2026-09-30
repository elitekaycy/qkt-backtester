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

const MIN_MS = 60_000;
/** Familiar chart timeframes, tried first when merging bars for display so a merged candle is one a trader recognises. */
const NICE_MS = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440].map((m) => m * MIN_MS);

/** Number of buckets of `bucketMs` (on the UTC grid from the epoch) that sorted times `ts` fall into. */
function bucketCount(ts: Float64Array, bucketMs: number): number {
  let n = 0, prev = Number.NaN;
  for (let i = 0; i < ts.length; i++) { const k = Math.floor(ts[i]! / bucketMs); if (k !== prev) { n++; prev = k; } }
  return n;
}

/**
 * The merged timeframe for showing `b` in at most `maxBars` bars: a whole multiple of `b.tfMs`, preferring the familiar
 * timeframes (1h, 4h, 1d...) and then whole days, else the smallest multiple that fits. Gaps in the data only mean
 * fewer buckets, so the first candidate that fits is taken; at worst one bucket spans the data.
 */
export function lodBucketMs(b: BarCols, maxBars: number): number {
  const tf = b.tfMs, n = b.ts.length;
  if (n <= maxBars || maxBars < 1 || tf <= 0) return tf;
  const minMs = Math.ceil(n / maxBars) * tf; // fewer bars per bucket than this can never fit
  for (const ms of NICE_MS) if (ms >= minMs && ms % tf === 0 && bucketCount(b.ts, ms) <= maxBars) return ms;
  const unit = DAY_MS % tf === 0 ? DAY_MS : tf; // whole days when the base tf divides a day, else multiples of the base
  const span = b.ts[n - 1]! - b.ts[0]! + tf;
  for (let k = Math.ceil(minMs / unit); ; ) {
    const ms = unit * k;
    if (bucketCount(b.ts, ms) <= maxBars) return ms;
    k = ms < span ? k + 1 : k * 2; // past the span only a grid boundary inside the data is left to escape
  }
}

/**
 * Reduce to at most `maxBars` by merging bars into OHLCV buckets (first open, max high, min low, last close, summed
 * volume) on regular UTC clock boundaries: bucket start = floor(ts / bucketMs) * bucketMs, like qkt's own aggregated
 * bars. So a merged bar is a real candle (a merged "1h" bar starts at :00), and the bar holding any time is found by
 * flooring it, whatever gaps the data has (a gap only means fewer buckets). The result's `tfMs` is the bucket size.
 */
export function lodAggregate(b: BarCols, maxBars: number): BarCols {
  const bucket = lodBucketMs(b, maxBars);
  return bucket === b.tfMs ? b : resampleTo(b, bucket);
}

/** Aggregate bars into a coarser timeframe on UTC-aligned boundaries (a tf the store lacks, and lodAggregate's display merge). */
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
