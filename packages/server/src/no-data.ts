import { promises as fs } from "node:fs";
import path from "node:path";
import { isTradingDay, qktCalendarFor, tfMs } from "@qkt-studio/core";
import { barCountOf } from "./barfile.js";

/**
 * "Accept as no data": the user's decision that a gap is real (the source recorded nothing that day: an outage, a
 * holiday qkt's calendar does not know) and a backtest may run through it. qkt accepts a day that has a bar file, and an
 * EMPTY bar file is how qkt itself marks a day without trading, so accepting writes exactly that file. Every accepted day
 * is recorded in `.studio-no-data.json` at the store's root, so the list can be shown and each day undone; undo removes
 * the file again only while it is still the empty one written here.
 *
 * Only bar days: qkt checks tick days by their ticks, so an empty tick file would still be refused.
 */
export interface NoDataEntry {
  broker: string; symbol: string; tf: string; day: string; at: string;
  /** The studio wrote the empty file (false: an empty file was already there, which undo leaves alone). */
  wrote: boolean;
}
export interface NoDataResult { accepted: string[]; skipped: Array<{ day: string; reason: string }> }

const RECORD = ".studio-no-data.json";
const NAME = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A year of days per request at most: accepting is meant for specific outages, not for papering over missing history. */
export const MAX_DAYS = 366;

export async function readAccepted(dataRoot: string): Promise<NoDataEntry[]> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(dataRoot, RECORD), "utf8")) as { entries?: NoDataEntry[] };
    return Array.isArray(j.entries) ? j.entries : [];
  } catch { return []; }
}
export const acceptedFor = (entries: NoDataEntry[], broker: string, symbol: string, tf: string): Set<string> =>
  new Set(entries.filter((e) => e.broker === broker && e.symbol === symbol && e.tf === tf).map((e) => e.day));

async function writeRecord(dataRoot: string, entries: NoDataEntry[]): Promise<void> {
  const file = path.join(dataRoot, RECORD), tmp = `${file}.${process.pid}.tmp`;
  entries.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.broker.localeCompare(b.broker) || a.tf.localeCompare(b.tf) || a.day.localeCompare(b.day));
  await fs.writeFile(tmp, JSON.stringify({ about: "Days accepted as having no data in the studio; each has an empty qkt bar file.", entries }, null, 2) + "\n");
  await fs.rename(tmp, file);
}

/** qkt's bar day file with no bars (BinaryBarFormat header: magic, version 1, scale 8, timeframe ms, "BROKER:SYMBOL", count 0). */
export function emptyBarDay(broker: string, symbol: string, timeframeMs: number): Buffer {
  const sym = Buffer.from(`${broker}:${symbol}`, "utf8");
  const b = Buffer.alloc(4 + 4 + 4 + 8 + 4 + sym.length + 4);
  let o = b.write("QKB1", 0, "latin1");
  o = b.writeInt32LE(1, o); o = b.writeInt32LE(8, o); o = b.writeBigInt64LE(BigInt(timeframeMs), o); o = b.writeInt32LE(sym.length, o);
  o += sym.copy(b, o); b.writeInt32LE(0, o);
  return b;
}

/**
 * A timeframe folder that is a link into another store (a read-only archive mounted beside this one) is replaced by a
 * real folder of links to the same files, so a day can be added here without writing to the archive.
 */
async function ownFolder(dir: string): Promise<void> {
  const st = await fs.lstat(dir).catch(() => null);
  if (!st) { await fs.mkdir(dir, { recursive: true }); return; }
  if (!st.isSymbolicLink()) return;
  const target = path.resolve(path.dirname(dir), await fs.readlink(dir));
  const tmp = `${dir}.studio-${process.pid}-${Date.now()}`;
  await fs.mkdir(tmp);
  try {
    for (const name of await fs.readdir(target)) await fs.symlink(path.join(target, name), path.join(tmp, name));
    await fs.unlink(dir);
    await fs.rename(tmp, dir);
  } catch (e) { await fs.rm(tmp, { recursive: true, force: true }); throw e; }
}

function check(broker: string, symbol: string, tf: string, days: string[]): string | null {
  if (!NAME.test(broker) || !NAME.test(symbol) || !NAME.test(tf)) return "bad broker, symbol or timeframe";
  if (tfMs(tf) === null) return `unknown timeframe ${tf}`;
  if (!Array.isArray(days) || !days.length) return "no days given";
  if (days.length > MAX_DAYS) return `at most ${MAX_DAYS} days at once`;
  if (days.some((d) => typeof d !== "string" || !DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) return "days are YYYY-MM-DD";
  return null;
}

export async function acceptNoData(dataRoot: string, req: { broker: string; symbol: string; tf: string; days: string[] }): Promise<NoDataResult | { error: string }> {
  const { broker, symbol, tf } = req;
  const bad = check(broker, symbol, tf, req.days);
  if (bad) return { error: bad };
  const dir = path.join(dataRoot, "bars", broker, symbol, tf);
  const entries = await readAccepted(dataRoot);
  const already = acceptedFor(entries, broker, symbol, tf);
  const out: NoDataResult = { accepted: [], skipped: [] };
  const todo: string[] = [];
  for (const day of [...new Set(req.days)].sort()) {
    const n = await barCountOf(path.join(dir, `${day}.bin`));
    const exists = await fs.lstat(path.join(dir, `${day}.bin`)).then(() => true, () => false);
    if (already.has(day)) out.skipped.push({ day, reason: "already accepted" });
    else if (!isTradingDay(qktCalendarFor(symbol), day)) out.skipped.push({ day, reason: "not a trading day for qkt: nothing is expected" });
    else if (n !== null && n > 0) out.skipped.push({ day, reason: "has bars" });
    else if (exists && n === null) out.skipped.push({ day, reason: "the file is unreadable or cut short: rebuild it instead" });
    else todo.push(day);
  }
  if (todo.length) {
    await ownFolder(dir);
    const body = emptyBarDay(broker, symbol, tfMs(tf)!);
    const at = new Date().toISOString();
    for (const day of todo) {
      const file = path.join(dir, `${day}.bin`);
      // an empty file already there (crypto) is kept as it is; only the record is added
      const wrote = await fs.writeFile(file, body, { flag: "wx" }).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "EEXIST") return false; throw e; });
      entries.push({ broker, symbol, tf, day, at, wrote });
      out.accepted.push(day);
    }
    await writeRecord(dataRoot, entries);
  }
  return out;
}

/** Undo: the day's file is removed only while it is still an empty day (bars built since are kept); the record goes either way. */
export async function undoNoData(dataRoot: string, req: { broker: string; symbol: string; tf: string; days: string[] }): Promise<{ undone: string[] } | { error: string }> {
  const { broker, symbol, tf } = req;
  const bad = check(broker, symbol, tf, req.days);
  if (bad) return { error: bad };
  const want = new Set(req.days);
  const entries = await readAccepted(dataRoot);
  const hit = (e: NoDataEntry) => e.broker === broker && e.symbol === symbol && e.tf === tf && want.has(e.day);
  const undone: string[] = [];
  for (const e of entries.filter(hit)) {
    const file = path.join(dataRoot, "bars", broker, symbol, tf, `${e.day}.bin`);
    if (e.wrote && (await barCountOf(file)) === 0) await fs.unlink(file).catch(() => undefined);
    undone.push(e.day);
  }
  if (undone.length) await writeRecord(dataRoot, entries.filter((e) => !hit(e)));
  return { undone };
}
