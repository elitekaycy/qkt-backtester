/** Calendar-day ranges. `to` is EXCLUSIVE, like qkt's `--to`. All dates are UTC `YYYY-MM-DD`. */
export interface DayRange { from: string; to: string }

const DAY = 86_400_000;
export const dayMs = (iso: string) => Date.parse(iso + "T00:00:00Z");
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const rangeDays = (r: DayRange) => Math.max(0, Math.round((dayMs(r.to) - dayMs(r.from)) / DAY));

/** Contiguous runs of consecutive calendar days where `ok` is true. `days` must be sorted, one entry per calendar day. */
export function runsOf(days: Array<{ day: string; ok: boolean }>): DayRange[] {
  const out: DayRange[] = [];
  let start: string | null = null, prev: string | null = null;
  for (const d of days) {
    if (d.ok) { if (start === null) start = d.day; prev = d.day; }
    else if (start !== null) { out.push({ from: start, to: isoDay(dayMs(prev!) + DAY) }); start = null; }
  }
  if (start !== null) out.push({ from: start, to: isoDay(dayMs(prev!) + DAY) });
  return out;
}

/** Ranges of `days` where `ok` is false (the gaps), same shape. */
export function gapsOf(days: Array<{ day: string; ok: boolean }>): DayRange[] {
  return runsOf(days.map((d) => ({ day: d.day, ok: !d.ok })));
}

function intersectTwo(a: DayRange[], b: DayRange[]): DayRange[] {
  const out: DayRange[] = [];
  for (const x of a) for (const y of b) {
    const from = x.from > y.from ? x.from : y.from, to = x.to < y.to ? x.to : y.to;
    if (from < to) out.push({ from, to });
  }
  return out.sort((p, q) => p.from.localeCompare(q.from));
}

/** Windows that lie inside every set. An empty list of sets intersects to nothing. */
export function intersectAll(sets: DayRange[][]): DayRange[] {
  if (!sets.length) return [];
  return sets.slice(1).reduce((acc, s) => intersectTwo(acc, s), sets[0]!);
}

export const longest = (rs: DayRange[]): DayRange | null => rs.reduce<DayRange | null>((best, r) => (!best || rangeDays(r) > rangeDays(best) ? r : best), null);

export type Completeness = "complete" | "mostly" | "incomplete" | "empty";
/** green / amber / red / grey: complete = no missing day; mostly = at most `tolerance` of the span missing. */
export function completeness(spanDays: number, missingDays: number, tolerance = 0.02): Completeness {
  if (spanDays <= 0) return "empty";
  if (missingDays === 0) return "complete";
  return missingDays / spanDays <= tolerance ? "mostly" : "incomplete";
}

export interface YearRow { year: number; days: number; ok: number; closed: number; thin: number; missing: number; status: Completeness; full: boolean }

/** Per-year rollup. `full` means the year lies entirely between first and last and has no missing day. */
export function yearRows(days: Array<{ day: string; status: "ok" | "closed" | "thin" | "missing" }>): YearRow[] {
  if (!days.length) return [];
  const first = days[0]!.day, last = days[days.length - 1]!.day;
  const map = new Map<number, YearRow>();
  for (const d of days) {
    const y = Number(d.day.slice(0, 4));
    const r = map.get(y) ?? { year: y, days: 0, ok: 0, closed: 0, thin: 0, missing: 0, status: "empty" as Completeness, full: false };
    r.days++; r[d.status]++;
    map.set(y, r);
  }
  return [...map.values()].sort((a, b) => a.year - b.year).map((r) => ({
    ...r, status: completeness(r.days, r.missing),
    full: r.missing === 0 && first <= `${r.year}-01-03` && last >= `${r.year}-12-28`,
  }));
}
