import { dayMs, intersectAll, isoDay, longest, rangeDays, type DayRange } from "@qkt-studio/core/ranges";
import type { ModeReadiness, Readiness, ScanReport, SymbolReport, YearRow } from "@qkt-studio/core";
import type { SymbolPref } from "../api/client.js";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Tone = "ok" | "warn" | "bad" | "empty";
export interface YearChip {
  year: number; tone: Tone;
  /** Whole calendar year present with no missing day. */
  full: boolean;
  /** Data starts or ends inside this calendar year: not a gap, just where the store begins or stops. */
  partial: "start" | "end" | "both" | null;
  /** "from Jun" / "to Sep" / "Jun–Sep" for partial years. */
  span: string | null;
  title: string;
}

/**
 * How one calendar year of a series is shown. The tone comes ONLY from missing days inside the years the data covers:
 * a year the store merely starts or stops in is partial, never red because the rest of the calendar year is absent.
 */
export function yearChip(y: YearRow, first: string | null, last: string | null): YearChip {
  const startsInside = !!first && Number(first.slice(0, 4)) === y.year && first > `${y.year}-01-03`;
  const endsInside = !!last && Number(last.slice(0, 4)) === y.year && last < `${y.year}-12-28`;
  const partial = startsInside && endsInside ? "both" : startsInside ? "start" : endsInside ? "end" : null;
  const share = y.days > 0 ? y.missing / y.days : 0;
  const tone: Tone = y.days === 0 ? "empty" : y.missing === 0 ? "ok" : share <= 0.02 ? "warn" : "bad";
  const mon = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1]!;
  const span = partial === "start" ? `from ${mon(first!)}` : partial === "end" ? `to ${mon(last!)}` : partial === "both" ? `${mon(first!)}–${mon(last!)}` : null;
  const bits = [`${y.year}: ${y.days} days`, `${y.ok} ok`, `${y.closed} closed`, `${y.thin} thin`, `${y.missing} missing`];
  const note = partial ? `Partial year: the data ${partial === "start" ? `starts ${first}` : partial === "end" ? `ends ${last}` : `runs ${first} → ${last}`}. Days outside it are not counted as missing.` : y.full ? "Whole year present." : "";
  return { year: y.year, tone, full: y.full, partial, span, title: [bits.join(" · "), note].filter(Boolean).join("\n") };
}

/** Clip ranges to the per-symbol windows the user set (`from` inclusive, `to` exclusive) for the symbols a strategy reads. */
export function clipRanges(ranges: DayRange[], prefs: Record<string, SymbolPref>, symbols: string[]): DayRange[] {
  let from: string | null = null, to: string | null = null;
  for (const s of new Set(symbols)) {
    const p = prefs[s];
    if (p?.from && (!from || p.from > from)) from = p.from;
    if (p?.to && (!to || p.to < to)) to = p.to;
  }
  if (!from && !to) return ranges;
  return ranges.flatMap((r) => {
    const f = from && from > r.from ? from : r.from, t = to && to < r.to ? to : r.to;
    return f < t ? [{ from: f, to: t }] : [];
  });
}

export const insideRanges = (from: string, to: string, ranges: DayRange[]) => !!from && !!to && from < to && ranges.some((r) => r.from <= from && to <= r.to);

/** The window a run should start with: the most recent `days` days of the latest allowed range (fast), or the whole range when shorter. */
export function defaultWindow(ranges: DayRange[], days = 30): DayRange | null {
  if (!ranges.length) return null;
  const last = [...ranges].sort((a, b) => a.to.localeCompare(b.to)).at(-1)!;
  const from = isoDay(Math.max(dayMs(last.from), dayMs(last.to) - days * DAY));
  return { from, to: last.to };
}

/** Days of `gaps` (exclusive-end ranges) that fall inside [from, to). */
export function gapDaysIn(gaps: DayRange[], from: string, to: string): number {
  let n = 0;
  for (const g of gaps) { const f = g.from > from ? g.from : from, t = g.to < to ? g.to : to; if (f < t) n += rangeDays({ from: f, to: t }); }
  return n;
}

/**
 * Strategy readiness recomputed on the client from the scan: the server's answer knows only the default source, so a symbol
 * pointed at another source (or windowed) must be re-evaluated against the report it actually reads.
 */
export function recomputeReadiness(r: Readiness, scan: ScanReport, prefs: Record<string, SymbolPref>, bySource: Record<string, SymbolReport | undefined>): Readiness {
  const symOf = (sym: string) => bySource[sym] ?? scan.symbols.find((s) => s.symbol === sym);
  const symbols = r.streams.map((s) => s.symbol);
  const mode = (kind: "bars" | "ticks"): ModeReadiness => {
    const sets: DayRange[][] = [], blocked: ModeReadiness["blocked"] = [];
    for (const s of r.streams) {
      const sym = symOf(s.symbol);
      const label = `${s.broker}:${s.symbol} ${s.tf}`;
      if (!sym) { blocked.push({ stream: label, reason: "symbol is not in the data source", fix: "fetch" }); continue; }
      if (kind === "bars") {
        const tf = sym.bars.find((b) => b.broker === s.broker && b.tf === s.tf && b.files > 0 && !b.qktReads);
        if (tf) sets.push(tf.usable);
        else blocked.push({ stream: label, reason: sym.ticks ? `no ${s.tf} bars built for ${s.broker}` : `no ${s.tf} bars for ${s.broker}`, fix: sym.ticks ? "build-bars" : "fetch" });
      } else if (sym.ticks) sets.push(sym.ticks.usable);
      else blocked.push({ stream: label, reason: "no tick files for this symbol", fix: "fetch" });
    }
    const raw = blocked.length || !sets.length ? [] : intersectAll(sets);
    const ranges = clipRanges(raw, prefs, symbols);
    return { runnable: ranges.length > 0, ranges, longest: longest(ranges), blocked };
  };
  return { ...r, bars: mode("bars"), ticks: mode("ticks") };
}

/** Calendar cells for one year of a day-status string that starts at `first` (one char per day). */
export function monthGrids(first: string, days: string): Array<{ year: number; months: Array<{ month: number; label: string; lead: number; cells: Array<{ day: string; s: string }>; missing: number }> }> {
  const byYear = new Map<number, Map<number, Array<{ day: string; s: string }>>>();
  const t0 = dayMs(first);
  for (let i = 0; i < days.length; i++) {
    const day = isoDay(t0 + i * DAY);
    const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    const ym = byYear.get(y) ?? new Map<number, Array<{ day: string; s: string }>>();
    (ym.get(m) ?? ym.set(m, []).get(m)!).push({ day, s: days[i]! });
    byYear.set(y, ym);
  }
  return [...byYear].sort(([a], [b]) => a - b).map(([year, ms]) => ({
    year,
    months: [...ms].sort(([a], [b]) => a - b).map(([month, cells]) => ({
      month, label: MONTHS[month - 1]!, lead: (new Date(cells[0]!.day + "T00:00:00Z").getUTCDay() + 6) % 7, cells, missing: cells.filter((c) => c.s === "m").length,
    })),
  }));
}
