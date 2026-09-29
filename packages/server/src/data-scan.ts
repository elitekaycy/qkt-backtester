import { promises as fs } from "node:fs";
import path from "node:path";
import {
  completeness, dayMs, gapsOf, intersectAll, isoDay, longest, parseStrategyInfo, rangeDays, runsOf, uniqueStreams, yearRows,
  type Completeness, type DayRange, type StreamDecl, type YearRow,
} from "@qkt-studio/core";
import type { DayStatus, ModeReadiness, Readiness, ScanReport, SymbolReport, TfReport, TickReport } from "@qkt-studio/core";
import { barCountOf } from "./barfile.js";
import { acceptedFor, readAccepted } from "./no-data.js";
import { gunzipSync } from "node:zlib";
import { barsPicker, canonicalTf, isTradingDay, qktCalendarFor, tickDayComplete, type QktCalendar } from "@qkt-studio/core";
import type { ResolvedStrategy } from "./portfolio.js";
export type { DayStatus, ModeReadiness, Readiness, ScanReport, SymbolReport, TfReport, TickReport } from "@qkt-studio/core";

const DAY = 86_400_000;
const NAME = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;
const MAX_GAPS_LISTED = 40;











async function inChunks<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const listDays = async (dir: string, ext: RegExp) => (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => ext.test(f)).map((f) => f.slice(0, 10)).sort();

function calendar(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = dayMs(first); d <= dayMs(last); d += DAY) out.push(isoDay(d));
  return out;
}
const isWeekend = (iso: string) => { const g = new Date(iso + "T00:00:00Z").getUTCDay(); return g === 0 || g === 6; };

// ---- day classification -------------------------------------------------------------------------------------------
//
// The rule is qkt's own (BarCompletenessValidator, TickCompletenessValidator), so what the studio calls complete is
// exactly what qkt agrees to run:
//   a day is EXPECTED when the symbol's qkt calendar has a session hour in it (qktCalendarFor: fx is Sunday 22:00 to
//   Friday 22:00 UTC with no holidays, crypto every day, SPX/NDX/DJI/RUT the NYSE week less its holidays);
//   an expected day with no bar file is a gap qkt refuses; any bar file, even an empty one, satisfies it.
// Statuses:
//   ok       the day has data
//   closed   not a trading day in qkt's calendar, or an empty bar file (qkt writes one for a day with no trading)
//   thin     a trading day well under a normal day's bar count (early close, outage): usable, flagged, not a gap
//   missing  an expected day with no file, an unreadable or truncated file, or a tick file qkt would reject (no ticks,
//            or session hours left empty: see tickDayUsable)
// One deliberate difference: on a crypto symbol an empty bar file is `missing` unless the user accepted the day as having
// no data (acceptedDays). Crypto never closes, so an empty day there is usually a failed download that qkt would
// silently run through; the studio shows it until someone decides it is real.

interface RawDay { day: string; present: boolean; n: number | null }
interface RawSet { days: RawDay[]; first: string; last: string; median: number; cal: QktCalendar }

function rawSet(present: Map<string, number | null>, cal: QktCalendar): RawSet | null {
  const names = [...present.keys()].sort();
  if (!names.length) return null;
  const days = calendar(names[0]!, names[names.length - 1]!).map((day) => ({ day, present: present.has(day), n: present.get(day) ?? null }));
  // a normal day's bar count, from full weekdays (Sunday and Friday are short sessions on the fx calendar)
  const full = days.filter((d) => d.n && !isWeekend(d.day) && isTradingDay(cal, d.day)).map((d) => d.n!).sort((x, y) => x - y);
  return { days, first: names[0]!, last: names[names.length - 1]!, median: full.length ? full[full.length >> 1]! : 0, cal };
}

function classifyDays(set: RawSet, isBars: boolean, accepted: ReadonlySet<string> = new Set()): Array<{ day: string; status: DayStatus }> {
  return set.days.map(({ day, present, n }) => {
    let status: DayStatus;
    if (!isTradingDay(set.cal, day)) status = present && n ? "ok" : "closed";
    else if (!present || n === null) status = "missing";
    else if (n === 0) status = isBars && (set.cal !== "crypto" || accepted.has(day)) ? "closed" : "missing";
    else status = isBars && !isWeekend(day) && set.median > 0 && n < set.median * 0.5 ? "thin" : "ok";
    return { day, status };
  });
}

function reportBars(broker: string, tf: string, set: RawSet | null, accepted: ReadonlySet<string>): TfReport {
  const canon = canonicalTf(tf);
  const qktReads = canon && canon !== tf ? { qktReads: canon } : {};
  if (!set) return { broker, tf, files: 0, first: null, last: null, span: 0, ok: 0, closed: 0, thin: 0, missing: 0, status: "empty", usable: [], gaps: [], years: [], always: false, ...qktReads };
  const days = classifyDays(set, true, accepted);
  const tally = (s: DayStatus) => days.filter((d) => d.status === s).length;
  const flags = days.map((d) => ({ day: d.day, ok: d.status !== "missing" }));
  const missing = tally("missing");
  return {
    broker, tf, files: set.days.filter((d) => d.present).length, first: set.first, last: set.last, span: days.length,
    ok: tally("ok"), closed: tally("closed"), thin: tally("thin"), missing, status: completeness(days.length, missing),
    usable: runsOf(flags), gaps: gapsOf(flags).slice(0, MAX_GAPS_LISTED), years: yearRows(days), always: set.cal === "crypto", ...qktReads,
  };
}

function reportTicks(set: RawSet, manifest: { source?: string; lastUpdated?: string } | null): TickReport {
  const days = classifyDays(set, false);
  const flags = days.map((d) => ({ day: d.day, ok: d.status !== "missing" }));
  const missing = days.filter((d) => d.status === "missing").length;
  const present = set.days.filter((d) => d.present).length;
  return {
    files: present, first: set.first, last: set.last, span: days.length, present, missing,
    status: completeness(days.length, missing), usable: runsOf(flags), gaps: gapsOf(flags).slice(0, MAX_GAPS_LISTED), years: yearRows(days),
    source: manifest?.source, lastUpdated: manifest?.lastUpdated, always: set.cal === "crypto",
  };
}

async function loadBarSet(dataRoot: string, broker: string, symbol: string, tf: string): Promise<RawSet | null> {
  const dir = path.join(dataRoot, "bars", broker, symbol, tf);
  const names = await listDays(dir, /^\d{4}-\d{2}-\d{2}\.bin$/);
  const counts = new Map<string, number | null>();
  await inChunks(names, 128, async (d) => { counts.set(d, await barCountOf(path.join(dir, `${d}.bin`))); });
  return rawSet(counts, qktCalendarFor(symbol));
}

/**
 * 1 when a tick day passes qkt's check, 0 when it does not: a header-only file (the source had nothing that day), or a
 * sparse one that leaves session hours empty (a feed of one row per day or per few hours), judged by qkt's own hourly
 * rule (tickDayComplete). Only small files are opened; a day of real ticks is far larger than SPARSE_BYTES, and its
 * hours are left to qkt's Coverage step at run time.
 */
const SPARSE_BYTES = 4096;
async function tickDayUsable(file: string, cal: QktCalendar, day: string): Promise<number> {
  const size = (await fs.stat(file).catch(() => null))?.size ?? 0;
  if (size > SPARSE_BYTES) return 1;
  const raw = await fs.readFile(file).catch(() => Buffer.alloc(0));
  let text = "";
  try { text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"); } catch { return 0; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const col = Math.max(0, (lines[0] ?? "").split(",").indexOf("timestamp"));
  const t0 = Date.parse(`${day}T00:00:00Z`), hours = new Set<number>();
  for (const l of lines.slice(1)) { const t = Number(l.split(",")[col]); if (Number.isFinite(t)) hours.add(Math.floor((t - t0) / 3_600_000)); }
  return tickDayComplete(cal, day, hours) ? 1 : 0;
}

async function loadTickSet(dataRoot: string, symbol: string): Promise<{ set: RawSet; manifest: { source?: string; lastUpdated?: string } | null } | null> {
  const dir = path.join(dataRoot, "symbols", symbol);
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv(\.gz)?$/.test(f)).sort();
  if (!files.length) return null;
  const counts = new Map<string, number | null>(), cal = qktCalendarFor(symbol);
  await inChunks(files, 128, async (f) => { const d = f.slice(0, 10); counts.set(d, Math.max(counts.get(d) ?? 0, await tickDayUsable(path.join(dir, f), cal, d))); });
  const set = rawSet(counts, cal);
  if (!set) return null;
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "null")) as { source?: string; lastUpdated?: string } | null;
  return { set, manifest };
}

const RANK: Record<Completeness, number> = { complete: 3, mostly: 2, incomplete: 1, empty: 0 };

export async function scanStore(dataRoot: string, only?: string): Promise<ScanReport> {
  const t0 = Date.now();
  const barNames = new Map<string, Array<{ broker: string; tfs: string[] }>>();
  const brokers = (await fs.readdir(path.join(dataRoot, "bars")).catch(() => [] as string[])).filter((b) => NAME.test(b));
  for (const broker of brokers) {
    for (const symbol of (await fs.readdir(path.join(dataRoot, "bars", broker)).catch(() => [] as string[])).filter((s) => NAME.test(s))) {
      const tfs = (await fs.readdir(path.join(dataRoot, "bars", broker, symbol), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
      barNames.set(symbol, [...(barNames.get(symbol) ?? []), { broker, tfs }]);
    }
  }
  const tickSymbols = (await fs.readdir(path.join(dataRoot, "symbols")).catch(() => [] as string[])).filter((s) => NAME.test(s));
  const all = [...new Set([...barNames.keys(), ...tickSymbols])].filter((x) => !only || x === only).sort();

  // pass 1: read every day file once
  const loaded = await inChunks(all, 4, async (symbol) => {
    const ticks = await loadTickSet(dataRoot, symbol);
    const bars: Array<{ broker: string; tf: string; set: RawSet | null }> = [];
    for (const { broker, tfs } of barNames.get(symbol) ?? []) for (const tf of tfs) bars.push({ broker, tf, set: await loadBarSet(dataRoot, broker, symbol, tf) });
    return { symbol, ticks, bars };
  });
  const accepted = await readAccepted(dataRoot);

  // pass 2: classify
  const symbols = loaded.map(({ symbol, ticks: t, bars: rawBars }): SymbolReport => {
    const ticks = t ? reportTicks(t.set, t.manifest) : null;
    const bars = rawBars.map((b) => reportBars(b.broker, b.tf, b.set, acceptedFor(accepted, b.broker, symbol, b.tf)));
    bars.sort((a, b) => a.broker.localeCompare(b.broker) || a.tf.localeCompare(b.tf, undefined, { numeric: true }));
    // bars in a folder qkt does not read (e.g. 1440m, which qkt calls 1d) exist on disk but can never be used
    const unreadable = bars.filter((b) => b.files > 0 && b.qktReads);
    const built = bars.filter((b) => b.files > 0 && !b.qktReads);
    const notes: string[] = unreadable.map((b) => `The ${b.tf} bars (${b.broker}) are not read by qkt, which looks for "${b.qktReads}". Rename the folder bars/${b.broker}/${symbol}/${b.tf} to ${b.qktReads}, or rebuild them as ${b.qktReads}.`);
    let status: SymbolReport["status"];
    if (built.length) status = built.reduce((best, b) => (RANK[b.status] > RANK[best] ? b.status : best), "empty" as Completeness);
    else if (ticks) { status = "ticks-only"; notes.push("Ticks are present but no bars are built. Bars runs need them: use Build bars."); }
    else status = unreadable.length ? "incomplete" : "empty";
    if (ticks && built.length && ticks.last && built.every((b) => b.last && b.last < ticks.last!)) notes.push("Ticks extend past the last built bar. Rebuild bars to include the newest days.");
    const market: SymbolReport["market"] = qktCalendarFor(symbol) === "crypto" ? "24/7" : "Mon-Fri";
    const yrs = [...built.map((b) => b.years), ...(ticks ? [ticks.years] : [])];
    const spanDays = Math.max(0, ...built.map((b) => b.span), ticks?.span ?? 0);
    return { symbol, ticks, bars, status, market, completeYears: Math.max(0, ...yrs.map((y) => y.filter((r) => r.full).length)), spanYears: Math.round((spanDays / 365.25) * 10) / 10, notes };
  });

  const count = (s: SymbolReport["status"]) => symbols.filter((x) => x.status === s).length;
  return {
    dataRoot, scannedAt: new Date().toISOString(), ms: Date.now() - t0, looksLikeStore: barNames.size > 0 || tickSymbols.length > 0, symbols,
    totals: {
      symbols: symbols.length, complete: count("complete"), mostly: count("mostly"), incomplete: count("incomplete"), ticksOnly: count("ticks-only"), empty: count("empty"),
      barFiles: symbols.reduce((n, s) => n + s.bars.reduce((m, b) => m + b.files, 0), 0), tickFiles: symbols.reduce((n, s) => n + (s.ticks?.files ?? 0), 0),
    },
  };
}

/** Day-by-day status for one series, for the calendar in the symbol dialog: one character per day from `first`. */
export async function seriesDays(dataRoot: string, symbol: string, kind: "ticks" | { broker: string; tf: string }): Promise<{ first: string; last: string; days: string } | null> {
  if (!NAME.test(symbol)) return null;
  let set: RawSet | null;
  if (kind === "ticks") set = (await loadTickSet(dataRoot, symbol))?.set ?? null;
  else { if (!NAME.test(kind.broker) || !NAME.test(kind.tf)) return null; set = await loadBarSet(dataRoot, kind.broker, symbol, kind.tf); }
  if (!set) return null;
  const code: Record<DayStatus, string> = { ok: "o", closed: "c", thin: "t", missing: "m" };
  const accepted = kind === "ticks" ? new Set<string>() : acceptedFor(await readAccepted(dataRoot), kind.broker, symbol, kind.tf);
  return { first: set.first, last: set.last, days: classifyDays(set, kind !== "ticks", accepted).map((d) => code[d.status]).join("") };
}

// ---- strategy readiness: which strategies can run on this data, and on which windows ------------------------------




function mode(streams: StreamDecl[], pick: (s: StreamDecl) => { ranges: DayRange[] } | { blocked: string; fix?: "build-bars" | "fetch" }): ModeReadiness {
  const sets: DayRange[][] = [], blocked: ModeReadiness["blocked"] = [];
  for (const s of streams) {
    const r = pick(s);
    if ("blocked" in r) blocked.push({ stream: `${s.broker}:${s.symbol} ${s.tf}`, reason: r.blocked, fix: r.fix });
    else sets.push(r.ranges);
  }
  const ranges = blocked.length || !sets.length ? [] : intersectAll(sets);
  return { runnable: ranges.length > 0, ranges, longest: longest(ranges), blocked };
}

export function readinessFor(report: ScanReport, strategy: string, source: string, resolved?: ResolvedStrategy): Readiness {
  const info = parseStrategyInfo(source);
  // a portfolio reads its children's streams too: use the union, with the imports followed
  const streams = uniqueStreams(resolved && resolved.streams.length ? resolved.streams : info.streams);
  const bySymbol = new Map(report.symbols.map((s) => [s.symbol, s]));
  const barsPickFor = (group: StreamDecl[]) => barsPicker(group, (sym) => bySymbol.get(sym));
  const ticksPick = (s: StreamDecl) => {
    const sym = bySymbol.get(s.symbol);
    if (!sym?.ticks) return { blocked: sym ? "no tick files for this symbol" : "symbol is not in the data source", fix: "fetch" as const };
    return { ranges: sym.ticks.usable };
  };
  const bars = mode(streams, barsPickFor(streams)), ticks = mode(streams, ticksPick);
  const out: Readiness = { strategy, kind: info.kind, streams, bars, ticks };
  if (resolved && resolved.members.length) {
    // which children need each blocked stream, and whether each child could run alone
    const key = (s: StreamDecl) => `${s.broker}:${s.symbol} ${s.tf}`;
    for (const m of [bars, ticks]) for (const b of m.blocked) b.members = resolved.members.filter((x) => x.streams.some((s) => key(s) === b.stream)).map((x) => x.alias);
    out.members = resolved.members.map((x) => ({
      alias: x.alias, rel: x.rel, exists: x.exists, hold: x.hold, streams: uniqueStreams(x.streams),
      bars: x.exists && x.streams.length > 0 && mode(uniqueStreams(x.streams), barsPickFor(uniqueStreams(x.streams))).runnable,
      ticks: x.exists && x.streams.length > 0 && mode(uniqueStreams(x.streams), ticksPick).runnable,
    }));
  }
  return out;
}

/** `.qkt` files under the workspace (skipping runs and studio state), for the readiness list. */
export async function listStrategies(workspace: string, max = 300): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || out.length >= max) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || e.name === "runs" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.endsWith(".qkt") && out.length < max) out.push(path.relative(workspace, p).split(path.sep).join("/"));
    }
  };
  await walk(workspace, 0);
  return out.sort();
}

export { rangeDays };

let cache: { root: string; at: number; report: ScanReport } | null = null;
/** Scans are cheap but not free; reuse one for 30 s unless forced or invalidated by a data job. */
/**
 * The store scan, shared: concurrent callers (a grid's runs starting together) wait for one scan instead of each walking
 * every file, and a report up to 10 minutes old is served at once while a fresh one runs in the background (older than
 * 30 s). Everything that changes the data here (bar builds, fetches, a new source) calls invalidateScan, so a run never
 * reads a report older than the data it was changed by; files changed outside the studio show up on the next refresh.
 */
let inflight: { root: string; p: Promise<ScanReport> } | null = null;
let generation = 0;
function rescan(dataRoot: string): Promise<ScanReport> {
  if (inflight && inflight.root === dataRoot) return inflight.p;
  const gen = generation;
  const p = scanStore(dataRoot).then((report) => { if (gen === generation) cache = { root: dataRoot, at: Date.now(), report }; return report; })
    .finally(() => { if (inflight?.p === p) inflight = null; });
  inflight = { root: dataRoot, p };
  return p;
}
export async function scanCached(dataRoot: string, refresh = false): Promise<ScanReport> {
  const age = cache && cache.root === dataRoot ? Date.now() - cache.at : Infinity;
  // fresh for ten times what the scan cost (30 s at least): a large store (hundreds of thousands of files, minutes to
  // scan) is not rescanned in the background every half minute next to whatever else the machine runs
  const fresh = Math.max(30_000, 10 * (cache?.report.ms ?? 0));
  if (!refresh && age < fresh) return cache!.report;
  if (!refresh && age < Math.max(10 * 60_000, 3 * fresh)) { void rescan(dataRoot).catch(() => undefined); return cache!.report; }
  return rescan(dataRoot);
}
export const invalidateScan = () => { cache = null; inflight = null; generation++; };

/** One symbol's report from one source folder (null when the source has nothing for it). */
export async function scanSymbolIn(dataRoot: string, symbol: string): Promise<SymbolReport | null> {
  if (!NAME.test(symbol)) return null;
  const r = await scanStore(dataRoot, symbol);
  return r.symbols[0] ?? null;
}
