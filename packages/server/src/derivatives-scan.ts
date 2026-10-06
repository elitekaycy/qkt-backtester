import { promises as fs } from "node:fs";
import path from "node:path";
import {
  contextFromCatalog, dayMs, isoDay, isTradingDay, parseInstruments, qktCalendarFor, runsOf,
  type ContractBars, type ContractReport, type DayRange, type DerivativesReport, type FutureRootReport, type InstrumentCatalog, type KindContext,
  type OptionRootReport, type PerpetualReport, type SeriesReport,
} from "@qkt-studio/core";

/**
 * The derivatives side of the store: contract catalogs, measured rolls, per-contract bars, funding, open interest, marks and
 * option chains. Everything is read from directory listings and a handful of small files; a bar file is never opened (a
 * store such as CME has hundreds of contract folders). Layout is qkt's (docs/how-to/backtest-data.md, "Store layout").
 */

const NAME = /^(?!\.+$)[A-Za-z0-9_.\-]{1,60}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.(?:bin|csv)(?:\.gz)?$/;
const DAY = 86_400_000;

async function names(dir: string): Promise<string[]> { return (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => NAME.test(n)); }
async function dirs(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && NAME.test(e.name)).map((e) => e.name);
}
async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}
async function inChunks<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Day names of a folder of per-day files, sorted. An empty file counts: qkt writes one for a closed day. */
export async function listDayFiles(dir: string): Promise<string[]> {
  const days = new Set<string>();
  for (const n of await fs.readdir(dir).catch(() => [] as string[])) { const m = DAY_FILE.exec(n); if (m) days.add(m[1]!); }
  return [...days].sort();
}

// The calendar rules live in core: the Data section's contract calendars read the same ones.
export { calendarOf, futuresDayExpected } from "@qkt-studio/core";
import { calendarOf, futuresDayExpected } from "@qkt-studio/core";

/**
 * Runs of days that are covered (exclusive end): a day with a file, or a day the calendar says is closed. Runs start and end on
 * a day that has a file, so closed days at the edge never lengthen a window.
 */
export function runsOfDays(days: string[], calendar?: string): DayRange[] {
  if (!days.length) return [];
  const have = new Set(days);
  const flags: Array<{ day: string; ok: boolean }> = [];
  for (let t = dayMs(days[0]!); t <= dayMs(days[days.length - 1]!); t += DAY) { const d = isoDay(t); flags.push({ day: d, ok: have.has(d) || (calendar !== undefined && !futuresDayExpected(calendar, d)) }); }
  return runsOf(flags).map((r) => {
    let a = dayMs(r.from), b = dayMs(r.to) - DAY;
    while (a < b && !have.has(isoDay(a))) a += DAY;
    while (b > a && !have.has(isoDay(b))) b -= DAY;
    return { from: isoDay(a), to: isoDay(b + DAY) };
  });
}

/** Windows covered by a series of timestamps, split wherever two consecutive points are further apart than `maxGapMs`. */
export function rangesFromTimestamps(ts: number[], maxGapMs: number): DayRange[] {
  const out: DayRange[] = [];
  if (!ts.length) return out;
  let start = ts[0]!, prev = ts[0]!;
  const close = (a: number, b: number) => out.push({ from: isoDay(a), to: isoDay(b + DAY) });
  for (let i = 1; i < ts.length; i++) { if (ts[i]! - prev > maxGapMs) { close(start, prev); start = ts[i]!; } prev = ts[i]!; }
  close(start, prev);
  return out;
}

const MAX_SERIES_BYTES = 80_000_000;

/** First column of every data row, as numbers. Reads the whole file once: funding is thousands of rows, open interest a few hundred thousand. */
async function firstColumn(file: string): Promise<number[] | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st || !st.isFile() || st.size > MAX_SERIES_BYTES) return null;
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const out: number[] = [];
  let i = text.indexOf("\n") + 1; // header
  while (i > 0 && i < text.length) {
    let j = text.indexOf("\n", i); if (j < 0) j = text.length;
    const c = text.indexOf(",", i);
    const t = Number(text.slice(i, c > 0 && c < j ? c : j));
    if (Number.isFinite(t)) out.push(t);
    i = j + 1;
  }
  return out;
}

const cache = new Map<string, { sig: string; value: SeriesReport | null }>();
async function timeSeries(file: string, gapOf: (ts: number[]) => number): Promise<SeriesReport | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  const sig = `${st.size}:${st.mtimeMs}`, hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.value;
  const ts = await firstColumn(file);
  const value: SeriesReport = ts && ts.length
    ? { files: 1, first: isoDay(ts[0]!), last: isoDay(ts[ts.length - 1]!), rows: ts.length, present: rangesFromTimestamps(ts, gapOf(ts)) }
    : { files: 1, first: null, last: null, rows: 0, present: [] };
  cache.set(file, { sig, value });
  return value;
}

/** qkt refuses stored funding rates that leave a gap over a day. */
const fundingSeries = (file: string) => timeSeries(file, () => DAY);
/** Open interest: no gap over three of the series' own intervals (the median step). */
const openInterestSeries = (file: string) => timeSeries(file, (ts) => {
  const steps: number[] = [];
  for (let i = 1; i < ts.length && steps.length < 2000; i++) steps.push(ts[i]! - ts[i - 1]!);
  steps.sort((a, b) => a - b);
  return 3 * (steps[steps.length >> 1] ?? DAY);
});

async function daySeries(dir: string, calendar?: string): Promise<SeriesReport | null> {
  const days = await listDayFiles(dir);
  return days.length ? { files: days.length, first: days[0]!, last: days[days.length - 1]!, present: runsOfDays(days, calendar) } : null;
}

async function barsOf(dir: string, calendar?: string): Promise<ContractBars[]> {
  const out: ContractBars[] = [];
  for (const tf of await dirs(dir)) {
    const days = await listDayFiles(path.join(dir, tf));
    if (days.length) out.push({ tf, files: days.length, first: days[0]!, last: days[days.length - 1]!, present: runsOfDays(days, calendar) });
  }
  return out.sort((a, b) => a.tf.localeCompare(b.tf, undefined, { numeric: true }));
}

interface CatalogFile { root?: string; contracts?: Array<{ symbol?: string; expiryMs?: number; deliveryPrice?: string | number | null }> }
interface RollsFile { root?: string; policy?: string; rolls?: Array<{ atMs?: number; from?: string; to?: string }> }
interface OptionsFile { root?: string; contracts?: Array<{ symbol?: string; expiryMs?: number }> }

const stripVenue = (sym: string) => { const i = sym.indexOf(":"); return i >= 0 ? sym.slice(i + 1) : sym; };

const MAX_CONTRACTS_LISTED = 4000;

export async function scanDerivatives(dataRoot: string): Promise<DerivativesReport> {
  const instrPath = path.join(dataRoot, "instruments.yaml");
  const instrText = await fs.readFile(instrPath, "utf8").catch(() => null);
  const catalog: InstrumentCatalog = instrText === null ? { cfds: [], futures: [], options: [], errors: [] } : parseInstruments(instrText);
  const instruments = { path: instrPath, exists: instrText !== null, errors: catalog.errors };

  const futureTerms = new Map(catalog.futures.map((f) => [f.root, f]));
  const optionTerms = new Map(catalog.options.map((o) => [o.root, o]));

  // root key -> files found for it under contracts/
  const futureCat = new Map<string, { catalog?: CatalogFile; rolls?: RollsFile }>();
  const optionCat = new Map<string, OptionsFile>();
  for (const venue of await dirs(path.join(dataRoot, "contracts"))) {
    for (const f of await names(path.join(dataRoot, "contracts", venue))) {
      if (!f.endsWith(".json")) continue;
      const stem = f.slice(0, -5);
      const file = path.join(dataRoot, "contracts", venue, f);
      if (stem.endsWith(".options")) { const j = await readJson<OptionsFile>(file); if (j) optionCat.set(`${venue}:${stem.slice(0, -8)}`, j); }
      else if (stem.endsWith(".rolls")) { const k = `${venue}:${stem.slice(0, -6)}`; futureCat.set(k, { ...futureCat.get(k), rolls: (await readJson<RollsFile>(file)) ?? undefined }); }
      else { const k = `${venue}:${stem}`; futureCat.set(k, { ...futureCat.get(k), catalog: (await readJson<CatalogFile>(file)) ?? undefined }); }
    }
  }

  // perpetuals are known by what is stored for them: funding rates under funding/<VENUE>/<NAME>.csv
  const funding = new Map<string, string>(); // `${venue}:${name}` -> file
  for (const venue of await dirs(path.join(dataRoot, "funding"))) for (const f of await names(path.join(dataRoot, "funding", venue))) if (f.endsWith(".csv")) funding.set(`${venue}:${f.slice(0, -4)}`, path.join(dataRoot, "funding", venue, f));

  const futureKeys = new Set<string>([...futureCat.keys(), ...futureTerms.keys()]);
  // a perpetual that has funding but no declared root still gets a root entry, so the Data section and readiness can see it
  for (const key of funding.keys()) { const [v, n] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]; if (![...futureKeys].some((k) => k === key || futureTerms.get(k)?.perpetual === n && k.startsWith(`${v}:`))) futureKeys.add(key); }

  const barsDirs = new Map<string, Set<string>>();
  const venueBars = async (venue: string) => { if (!barsDirs.has(venue)) barsDirs.set(venue, new Set(await dirs(path.join(dataRoot, "bars", venue)))); return barsDirs.get(venue)!; };

  const futures = await inChunks([...futureKeys].sort(), 4, async (key): Promise<FutureRootReport> => {
    const venue = key.slice(0, key.indexOf(":")), root = key.slice(key.indexOf(":") + 1);
    const terms = futureTerms.get(key) ?? null;
    const files = futureCat.get(key);
    const cal = calendarOf(root, terms?.calendar);
    const notes: string[] = [];
    const cat = files?.catalog;
    const listed = (cat?.contracts ?? []).filter((c) => typeof c.symbol === "string") as Array<{ symbol: string; expiryMs?: number; deliveryPrice?: string | number | null }>;
    const have = await venueBars(venue);
    const contracts: ContractReport[] = await inChunks(listed.slice(0, MAX_CONTRACTS_LISTED), 24, async (c) => ({
      symbol: c.symbol, expiry: typeof c.expiryMs === "number" ? isoDay(c.expiryMs) : null,
      deliveryPrice: c.deliveryPrice === undefined || c.deliveryPrice === null ? null : String(c.deliveryPrice),
      bars: have.has(c.symbol) ? await barsOf(path.join(dataRoot, "bars", venue, c.symbol), cal) : [],
    }));
    const expiries = contracts.map((c) => c.expiry).filter((d): d is string => d !== null).sort();
    const rollList = (files?.rolls?.rolls ?? []).filter((r) => typeof r.atMs === "number" && r.from && r.to) as Array<{ atMs: number; from: string; to: string }>;
    rollList.sort((a, b) => a.atMs - b.atMs);

    // the perpetual: a declared `perpetual:` name, or the root's own name when funding is stored for it
    const perpName = terms?.perpetual ?? (funding.has(key) ? root : null);
    let perpetual: PerpetualReport | null = null;
    if (perpName) {
      const pk = `${venue}:${perpName}`;
      const marksDir = path.join(dataRoot, "marks", venue, perpName);
      const marks = await inChunks(await dirs(marksDir), 4, async (tf) => { const s = await daySeries(path.join(marksDir, tf), "crypto"); return s ? { tf, ...s } : null; });
      const daily = (kind: string) => daySeries(path.join(dataRoot, kind, venue, perpName), "crypto");
      perpetual = {
        name: perpName,
        bars: have.has(perpName) ? await barsOf(path.join(dataRoot, "bars", venue, perpName), cal) : [],
        funding: funding.has(pk) ? await fundingSeries(funding.get(pk)!) : null,
        openInterest: await openInterestSeries(path.join(dataRoot, "open_interest", venue, `${perpName}.csv`)),
        marks: marks.filter((m): m is NonNullable<typeof m> => m !== null),
        tape: await daily("tape"), liquidations: await daily("liquidations"), depth: await daily("depth"),
      };
    }
    if (!terms) notes.push(`No \`futures:\` entry for ${key} in instruments.yaml: the engine needs its multiplier, tick size and fees before it will run it.`);
    if (cat && !files?.rolls) notes.push(`No measured rolls for ${key}: a continuous stream (@front) needs \`qkt fetch ${key} --rolls\` and a \`roll:\` policy.`);
    if (!cat && !perpetual) notes.push(`No contract catalog for ${key}: \`qkt fetch ${key} --catalog\`.`);
    return {
      key, venue, root, terms,
      catalog: cat ? { contracts: listed.length, first: expiries[0] ?? null, last: expiries[expiries.length - 1] ?? null, delivered: listed.filter((c) => c.deliveryPrice !== undefined && c.deliveryPrice !== null).length } : null,
      rolls: files?.rolls ? { count: rollList.length, first: rollList[0] ? isoDay(rollList[0].atMs) : null, last: rollList.length ? isoDay(rollList[rollList.length - 1]!.atMs) : null, policy: files.rolls.policy ?? null, schedule: rollList.map((r) => ({ atMs: r.atMs, from: stripVenue(r.from), to: stripVenue(r.to) })) } : null,
      contracts, perpetual, notes,
    };
  });

  const optionKeys = new Set<string>([...optionCat.keys(), ...optionTerms.keys()]);
  const options = await inChunks([...optionKeys].sort(), 4, async (key): Promise<OptionRootReport> => {
    const venue = key.slice(0, key.indexOf(":")), root = key.slice(key.indexOf(":") + 1);
    const terms = optionTerms.get(key) ?? null, cat = optionCat.get(key);
    const listed = (cat?.contracts ?? []).filter((c) => typeof c.expiryMs === "number");
    const exp = listed.map((c) => isoDay(c.expiryMs!)).sort();
    const base = path.join(dataRoot, "chains", venue, root);
    const [trade, book] = await Promise.all([daySeries(path.join(base, "trade"), "crypto"), daySeries(path.join(base, "book"), "crypto")]);
    const notes: string[] = [];
    if (!terms) notes.push(`No \`options:\` entry for ${key} in instruments.yaml.`);
    else if (!terms.chains) notes.push(`${key} declares no chain series to trade on: add \`chains: trade\` or \`chains: book\`.`);
    if (!cat) notes.push(`No contract catalog for ${key}: \`qkt fetch ${key} --catalog\`.`);
    return { key, venue, root, terms, catalog: cat ? { contracts: (cat.contracts ?? []).length, first: exp[0] ?? null, last: exp[exp.length - 1] ?? null } : null, chains: { trade, book }, notes };
  });

  return { futures, options, instruments };
}

/**
 * What `kindOf` needs, from a derivatives report: roots and perpetuals the store or instruments.yaml know, plus the bare
 * names of listed contracts (so `BTCUSDT_241227` and `ESZ24` are futures, not CFDs).
 */
export function kindContextOf(d: DerivativesReport | undefined): KindContext {
  if (!d) return contextFromCatalog({ cfds: [], futures: [], options: [], errors: [] });
  const base = contextFromCatalog(
    { cfds: [], futures: d.futures.map((f) => f.terms ?? { root: f.key }), options: d.options.map((o) => o.terms ?? { root: o.key }), errors: [] },
    { futureRoots: d.futures.map((f) => f.key), perpetuals: d.futures.flatMap((f) => (f.perpetual ? [`${f.venue}:${f.perpetual.name}`] : [])) },
  );
  return { ...base, futureRoots: new Set([...(base.futureRoots ?? []), ...d.futures.map((f) => f.key)]), optionRoots: new Set([...(base.optionRoots ?? []), ...d.options.map((o) => o.key)]) };
}

/** `VENUE:CONTRACT` of every catalogued contract, so the plain symbol list can leave them under their root. */
export function contractKeys(d: DerivativesReport): Set<string> {
  const out = new Set<string>();
  for (const f of d.futures) {
    for (const c of f.contracts) out.add(`${f.venue}:${c.symbol}`);
    // a perpetual whose bars the root shows is listed once, there; with no bars to show it stays where it is
    if (f.perpetual?.bars.length) out.add(`${f.venue}:${f.perpetual.name}`);
  }
  return out;
}

// the scan is cheap but the editor asks on every keystroke-check: keep one for a few seconds
let cached: { root: string; at: number; p: Promise<DerivativesReport> } | null = null;
export function derivativesCached(dataRoot: string, maxAgeMs = 10_000): Promise<DerivativesReport> {
  if (cached && cached.root === dataRoot && Date.now() - cached.at < maxAgeMs) return cached.p;
  const p = scanDerivatives(dataRoot);
  cached = { root: dataRoot, at: Date.now(), p };
  p.catch(() => { if (cached?.p === p) cached = null; });
  return p;
}
export const invalidateDerivatives = () => { cached = null; };
