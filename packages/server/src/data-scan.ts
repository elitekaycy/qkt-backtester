import { promises as fs } from "node:fs";
import path from "node:path";
import {
  completeness, dayMs, gapsOf, intersectAll, isoDay, longest, parseStrategyInfo, rangeDays, runsOf, uniqueStreams, yearRows,
  type Completeness, type DayRange, type StreamDecl, type YearRow,
} from "@qkt-studio/core";
import type { DayStatus, ModeReadiness, Readiness, ScanReport, SymbolReport, TfReport, TickReport } from "@qkt-studio/core";
import { barCountOf } from "./barfile.js";
import { barsPicker, canonicalTf } from "@qkt-studio/core";
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
// What "complete" means here (the same question qkt asks at run time, answered per calendar day):
//   ok       the market was open and the store has data for the day
//   closed   the market was not open: an empty bar file (qkt writes one for a closed day), a weekend for a market that
//            closes on weekends, a fixed holiday (Dec 25, Jan 1) or a day that most other symbols in the store also lack
//   thin     open, but well under a normal day's bar count (early close, outage): usable, flagged, not a gap
//   missing  the market should have been open and the store has nothing (or an unreadable file): a real gap
// A window is COMPLETE when it contains no `missing` day. Weekends are never a gap for a Mon-Fri market, but ARE for a
// 24/7 market (crypto): there an empty or absent day is a hole in the data, not a closure.

interface RawDay { day: string; present: boolean; n: number | null }
interface RawSet {
  days: RawDay[]; first: string; last: string; median: number;
  /** Trades Saturdays overall (crypto). Some years of a 24/7 market may still follow a weekday schedule: see `alwaysYear`. */
  always: boolean; alwaysYear: Map<number, boolean>;
  /** Years in which the series is absent on (nearly) every US exchange holiday (commodity futures style): those absences are closures. */
  usClosedYear: Set<number>;
}

const isFixedHoliday = (iso: string) => iso.slice(5) === "12-25" || iso.slice(5) === "01-01";
const dow = (iso: string) => new Date(iso + "T00:00:00Z").getUTCDay();

/** US exchange holidays (weekend-shifted) for one year, plus the two habitual half-day closures. Used only for series that follow them. */
function usHolidays(year: number): string[] {
  const nth = (m: number, wd: number, n: number) => { const d = new Date(Date.UTC(year, m, 1)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d; };
  const last = (m: number, wd: number) => { const d = new Date(Date.UTC(year, m + 1, 0)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1); return d; };
  const shift = (m: number, day: number) => { const d = new Date(Date.UTC(year, m, day)); if (d.getUTCDay() === 6) d.setUTCDate(day - 1); else if (d.getUTCDay() === 0) d.setUTCDate(day + 1); return d; };
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = new Date(Date.UTC(year, Math.floor((h + l - 7 * mm + 114) / 31) - 1, ((h + l - 7 * mm + 114) % 31) + 1));
  const goodFriday = new Date(easter.getTime() - 2 * 86_400_000);
  const thanksgiving = nth(10, 4, 4);
  const list = [shift(0, 1), nth(0, 1, 3), nth(1, 1, 3), goodFriday, last(4, 1), ...(year >= 2022 ? [shift(5, 19)] : []), shift(6, 4), nth(8, 1, 1), thanksgiving, new Date(thanksgiving.getTime() + 86_400_000), shift(11, 25), new Date(Date.UTC(year, 11, 24))];
  return list.map((d) => d.toISOString().slice(0, 10)).filter((d) => d.startsWith(String(year)) && dow(d) !== 0 && dow(d) !== 6);
}

const usHolidayCache = new Map<number, Set<string>>();
const isUsHoliday = (iso: string) => { const y = Number(iso.slice(0, 4)); let s = usHolidayCache.get(y); if (!s) { s = new Set(usHolidays(y)); usHolidayCache.set(y, s); } return s.has(iso); };

function saturdayShare(days: RawDay[]): { n: number; live: number } {
  let n = 0, live = 0;
  for (const d of days) if (dow(d.day) === 6) { n++; if (d.present && d.n) live++; }
  return { n, live };
}

function rawSet(present: Map<string, number | null>): RawSet | null {
  const names = [...present.keys()].sort();
  if (!names.length) return null;
  const days = calendar(names[0]!, names[names.length - 1]!).map((day) => ({ day, present: present.has(day), n: present.get(day) ?? null }));
  const weekday = days.filter((d) => d.n && !isWeekend(d.day)).map((d) => d.n!).sort((x, y) => x - y);
  const all = saturdayShare(days);
  const always = all.n >= 8 && all.live / all.n >= 0.3;
  // a 24/7 market can still have whole years on a weekday schedule (older CFD feeds); judge each year on its own Saturdays
  const alwaysYear = new Map<number, boolean>();
  if (always) {
    const byYear = new Map<number, RawDay[]>();
    for (const d of days) { const y = Number(d.day.slice(0, 4)); (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(d); }
    for (const [y, ds] of byYear) { const s = saturdayShare(ds); alwaysYear.set(y, s.n < 8 ? true : s.live / s.n >= 0.3); }
  }
  // does the series follow the US exchange calendar? Learn it from its own data: absent on (nearly) every US holiday
  const usClosedYear = new Set<number>();
  if (!always) {
    const holByYear = new Map<number, RawDay[]>();
    for (const d of days) if (isUsHoliday(d.day)) { const y = Number(d.day.slice(0, 4)); (holByYear.get(y) ?? holByYear.set(y, []).get(y)!).push(d); }
    for (const [y, hs] of holByYear) if (hs.length >= 6 && hs.filter((d) => !d.present || !d.n).length / hs.length >= 0.8) usClosedYear.add(y);
  }
  return { days, first: names[0]!, last: names[names.length - 1]!, median: weekday.length ? weekday[weekday.length >> 1]! : 0, always, alwaysYear, usClosedYear };
}

/** A year that is partial (data ends mid-year) may not qualify on its own; a neighbouring qualifying year is enough. */
const followsUsCalendar = (set: RawSet, year: number) => set.usClosedYear.has(year) || set.usClosedYear.has(year - 1) || set.usClosedYear.has(year + 1);
const opensAllWeek = (set: RawSet, day: string) => set.always && (set.alwaysYear.get(Number(day.slice(0, 4))) ?? true);

function classifyDays(set: RawSet, holidays: ReadonlySet<string>, isBars: boolean): Array<{ day: string; status: DayStatus }> {
  return set.days.map(({ day, present, n }) => {
    const always = opensAllWeek(set, day);
    let status: DayStatus;
    if (present) {
      if (n === null) status = "missing"; // unreadable: cannot be used
      else if (n === 0) status = always ? "missing" : "closed"; // empty file: closed day, unless the market never closes
      else status = isBars && !isWeekend(day) && set.median > 0 && n < set.median * 0.5 ? "thin" : "ok";
    } else if (always) status = "missing";
    else status = isWeekend(day) || isFixedHoliday(day) || holidays.has(day) || (followsUsCalendar(set, Number(day.slice(0, 4))) && isUsHoliday(day)) ? "closed" : "missing";
    return { day, status };
  });
}

function reportBars(broker: string, tf: string, set: RawSet | null, holidays: ReadonlySet<string>): TfReport {
  const canon = canonicalTf(tf);
  const qktReads = canon && canon !== tf ? { qktReads: canon } : {};
  if (!set) return { broker, tf, files: 0, first: null, last: null, span: 0, ok: 0, closed: 0, thin: 0, missing: 0, status: "empty", usable: [], gaps: [], years: [], always: false, ...qktReads };
  const days = classifyDays(set, holidays, true);
  const tally = (s: DayStatus) => days.filter((d) => d.status === s).length;
  const flags = days.map((d) => ({ day: d.day, ok: d.status !== "missing" }));
  const missing = tally("missing");
  return {
    broker, tf, files: set.days.filter((d) => d.present).length, first: set.first, last: set.last, span: days.length,
    ok: tally("ok"), closed: tally("closed"), thin: tally("thin"), missing, status: completeness(days.length, missing),
    usable: runsOf(flags), gaps: gapsOf(flags).slice(0, MAX_GAPS_LISTED), years: yearRows(days), always: set.always, ...qktReads,
  };
}

function reportTicks(set: RawSet, holidays: ReadonlySet<string>, manifest: { source?: string; lastUpdated?: string } | null): TickReport {
  const days = classifyDays(set, holidays, false);
  const flags = days.map((d) => ({ day: d.day, ok: d.status !== "missing" }));
  const missing = days.filter((d) => d.status === "missing").length;
  const present = set.days.filter((d) => d.present).length;
  return {
    files: present, first: set.first, last: set.last, span: days.length, present, missing,
    status: completeness(days.length, missing), usable: runsOf(flags), gaps: gapsOf(flags).slice(0, MAX_GAPS_LISTED), years: yearRows(days),
    source: manifest?.source, lastUpdated: manifest?.lastUpdated, always: set.always,
  };
}

async function loadBarSet(dataRoot: string, broker: string, symbol: string, tf: string): Promise<RawSet | null> {
  const dir = path.join(dataRoot, "bars", broker, symbol, tf);
  const names = await listDays(dir, /^\d{4}-\d{2}-\d{2}\.bin$/);
  const counts = new Map<string, number | null>();
  await inChunks(names, 128, async (d) => { counts.set(d, await barCountOf(path.join(dir, `${d}.bin`))); });
  return rawSet(counts);
}

async function loadTickSet(dataRoot: string, symbol: string): Promise<{ set: RawSet; manifest: { source?: string; lastUpdated?: string } | null } | null> {
  const dir = path.join(dataRoot, "symbols", symbol);
  const names = await listDays(dir, /^\d{4}-\d{2}-\d{2}\.csv(\.gz)?$/);
  if (!names.length) return null;
  const set = rawSet(new Map(names.map((n) => [n, 1 as number | null])));
  if (!set) return null;
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "null")) as { source?: string; lastUpdated?: string } | null;
  return { set, manifest };
}

/**
 * Weekdays on which most Mon-Fri symbols in the store have no data are market holidays, not gaps in any one of them.
 * Needs at least three symbols covering the day, so a lone symbol keeps every unexplained weekday as missing.
 */
export function inferHolidays(sets: Array<{ set: RawSet }>): Set<string> {
  const cover = new Map<string, { n: number; none: number }>();
  for (const { set } of sets) {
    if (set.always) continue;
    for (const d of set.days) {
      if (isWeekend(d.day)) continue;
      const c = cover.get(d.day) ?? { n: 0, none: 0 };
      c.n++;
      if (!d.present || !d.n) c.none++;
      cover.set(d.day, c);
    }
  }
  const out = new Set<string>();
  for (const [day, c] of cover) if (c.n >= 3 && c.none / c.n >= 0.8) out.add(day);
  return out;
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
  // one representative series per symbol (the one with the most days) votes on market holidays
  const holidays = inferHolidays(loaded.flatMap((l) => {
    const best = [...l.bars.map((b) => b.set), l.ticks?.set ?? null].filter((x): x is RawSet => x !== null).sort((a, b) => b.days.length - a.days.length)[0];
    return best ? [{ set: best }] : [];
  }));
  if (only) { if (holidayCache) for (const d of holidayCache.holidays) holidays.add(d); } // market holidays are market-wide: borrow the last full scan's
  else holidayCache = { root: dataRoot, holidays };

  // pass 2: classify with the holiday set
  const symbols = loaded.map(({ symbol, ticks: t, bars: rawBars }): SymbolReport => {
    const ticks = t ? reportTicks(t.set, holidays, t.manifest) : null;
    const bars = rawBars.map((b) => reportBars(b.broker, b.tf, b.set, holidays));
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
    const market: SymbolReport["market"] = [...built, ...(ticks ? [ticks] : [])].some((x) => x.always) ? "24/7" : "Mon-Fri";
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

let holidayCache: { root: string; holidays: Set<string> } | null = null;

/** Day-by-day status for one series, for the calendar in the symbol dialog: one character per day from `first`. */
export async function seriesDays(dataRoot: string, symbol: string, kind: "ticks" | { broker: string; tf: string }): Promise<{ first: string; last: string; days: string } | null> {
  if (!NAME.test(symbol)) return null;
  if (!holidayCache || holidayCache.root !== dataRoot) await scanCached(dataRoot);
  const holidays = holidayCache?.root === dataRoot ? holidayCache.holidays : new Set<string>();
  let set: RawSet | null;
  if (kind === "ticks") set = (await loadTickSet(dataRoot, symbol))?.set ?? null;
  else { if (!NAME.test(kind.broker) || !NAME.test(kind.tf)) return null; set = await loadBarSet(dataRoot, kind.broker, symbol, kind.tf); }
  if (!set) return null;
  const code: Record<DayStatus, string> = { ok: "o", closed: "c", thin: "t", missing: "m" };
  return { first: set.first, last: set.last, days: classifyDays(set, holidays, kind !== "ticks").map((d) => code[d.status]).join("") };
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
export async function scanCached(dataRoot: string, refresh = false): Promise<ScanReport> {
  if (!refresh && cache && cache.root === dataRoot && Date.now() - cache.at < 30_000) return cache.report;
  const report = await scanStore(dataRoot);
  cache = { root: dataRoot, at: Date.now(), report };
  return report;
}
export const invalidateScan = () => { cache = null; };

/** One symbol's report from one source folder (null when the source has nothing for it). Uses the source's market holidays when a full scan of it is cached. */
export async function scanSymbolIn(dataRoot: string, symbol: string): Promise<SymbolReport | null> {
  if (!NAME.test(symbol)) return null;
  const r = await scanStore(dataRoot, symbol);
  return r.symbols[0] ?? null;
}
