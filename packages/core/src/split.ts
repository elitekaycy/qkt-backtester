import type { RoundTrip } from "./roundtrips.js";

export type Split = { none: true } | { test_pct: number } | { test_last: string } | { test_from: string };
export const DEFAULT_SPLIT: Split = { test_pct: 25 };
export interface PartStats { from: string; to: string; trades: number; net: number; winRate: number | null; profitFactor: number | null; avgR: number | null }

const DAY = 86_400_000;
const LAST = /^(\d{1,3})\s*(day|week|month)s?$/i;

export function parseSplit(x: unknown): Split {
  const o = (x ?? {}) as Record<string, unknown>;
  if (o.none === true) return { none: true };
  if (typeof o.test_pct === "number") { if (o.test_pct < 5 || o.test_pct > 95) throw new Error("test_pct must be between 5 and 95"); return { test_pct: o.test_pct }; }
  if (typeof o.test_last === "string") { if (!LAST.test(o.test_last.trim())) throw new Error(`test_last "${o.test_last}": use a number of days, weeks or months, e.g. "3 months"`); return { test_last: o.test_last.trim() }; }
  if (typeof o.test_from === "string") { if (!/^\d{4}-\d{2}-\d{2}$/.test(o.test_from) || Number.isNaN(Date.parse(`${o.test_from}T00:00:00Z`))) throw new Error(`test_from "${o.test_from}" is not a YYYY-MM-DD date`); return { test_from: o.test_from }; }
  throw new Error('a split is {"none": true}, {"test_pct": 25}, {"test_last": "3 months"} or {"test_from": "2026-07-01"}');
}

export function splitCut(split: Split, from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`), z = Date.parse(`${to}T00:00:00Z`);
  let cut: number | null = null;
  if ("test_pct" in split) cut = a + Math.round(((z - a) * (100 - split.test_pct)) / 100 / DAY) * DAY;
  else if ("test_last" in split) {
    const [, n, unit] = LAST.exec(split.test_last)!;
    const d = new Date(z);
    if (/month/i.test(unit!)) {
      // clamp the day: a month back from 03-31 is 02-28 (or 29), not 03-03 as a bare setUTCMonth would give
      const day = d.getUTCDate();
      d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - Number(n));
      d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    } else d.setUTCDate(d.getUTCDate() - Number(n) * (/week/i.test(unit!) ? 7 : 1));
    cut = d.getTime();
  } else if ("test_from" in split) cut = Date.parse(`${split.test_from}T00:00:00Z`);
  return cut !== null && cut > a && cut < z ? cut : null;
}

function stats(trips: RoundTrip[], from: string, to: string): PartStats {
  const closed = trips.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const rs = closed.filter((t) => typeof t.r === "number").map((t) => t.r!);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { from, to, trades: closed.length, net: r6(closed.reduce((s, t) => s + t.pnl, 0)),
    winRate: closed.length ? r6(wins.length / closed.length) : null, profitFactor: gl > 0 ? r6(gw / gl) : null, avgR: rs.length ? r6(rs.reduce((s, x) => s + x, 0) / rs.length) : null };
}

export function partsOf(trips: RoundTrip[], from: string, to: string, split: Split): { split: Split; cut: string | null; first: PartStats; test: PartStats | null } {
  const cut = splitCut(split, from, to);
  if (cut === null) return { split, cut: null, first: stats(trips, from, to), test: null };
  const cutIso = new Date(cut).toISOString().slice(0, 10);
  const at = (t: RoundTrip) => t.exitTs ?? t.entryTs;
  return { split, cut: cutIso, first: stats(trips.filter((t) => at(t) < cut), from, cutIso), test: stats(trips.filter((t) => at(t) >= cut), cutIso, to) };
}

/** "1 weeks" -> "1 week", "2 month" -> "2 months": the unit agrees with the number (parseSplit accepts either spelling). */
function lastText(s: string): string {
  const m = LAST.exec(s.trim());
  if (!m) return s;
  const n = Number(m[1]), unit = m[2]!.toLowerCase();
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function describeSplit(split: Split): string {
  if ("none" in split) return "no split";
  if ("test_pct" in split) return `test = last ${split.test_pct} %`;
  if ("test_last" in split) return `test = last ${lastText(split.test_last)}`;
  return `test from ${split.test_from}`;
}
