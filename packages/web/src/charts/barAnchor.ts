import type { UTCTimestamp } from "lightweight-charts";

export type BarAnchor = { time: UTCTimestamp } | "before" | "after" | null;

/**
 * The displayed bar that holds the time `ms`, given the series' bar times in LWC seconds (ascending, as the chart has
 * them) and the displayed bar width `tfMs`:
 *  - `ms` on or inside a bar: that bar (the last bar starting at or before `ms`), whatever phase the bars have.
 *  - `ms` in a gap between bars (a weekend, a missing bar): the bar before the gap.
 *  - `ms` before the first bar: `"before"`; at or past the end of the last bar (its start + `tfMs`): `"after"`.
 *  - no bars: `null`.
 * `timeToCoordinate` returns null for any time that is not exactly a bar's, so screen positions must always be taken
 * from the anchor's bar time, never from a raw or floored time (a merged or shifted bar would not match it).
 */
export function barAnchor(times: readonly number[], tfMs: number, ms: number): BarAnchor {
  const n = times.length;
  if (n === 0) return null;
  const sec = ms / 1000;
  if (sec < times[0]!) return "before";
  if (sec >= times[n - 1]! + tfMs / 1000) return "after";
  let lo = 0, hi = n; // first bar starting after `sec`; the one before it holds `sec`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= sec) lo = mid + 1; else hi = mid;
  }
  return { time: times[lo - 1]! as UTCTimestamp };
}

/**
 * The bars a trade is drawn between, clipped to the loaded data:
 *  - entry before the data: the first bar; exit after the data: the last bar;
 *  - a trade wholly before or after the data (or no data): `null`, not drawn;
 *  - an open trade runs to the bar holding `dataEndMs` (the run's end), else the last bar: that is what "open" means;
 *  - a closed trade always ends on the bar holding its exit (or at its entry if it has no exit time), never at the
 *    chart's right edge.
 */
export function tradeSpan(
  times: readonly number[], tfMs: number, t: { entryTs: number; exitTs: number | null; open: boolean }, dataEndMs: number | null,
): { entry: UTCTimestamp; exit: UTCTimestamp } | null {
  const n = times.length;
  if (n === 0) return null;
  const first = times[0]! as UTCTimestamp, last = times[n - 1]! as UTCTimestamp;
  const clip = (a: BarAnchor): UTCTimestamp => (a === "before" ? first : a === "after" || a === null ? last : a.time);
  const a1 = barAnchor(times, tfMs, t.entryTs);
  if (a1 === "after") return null;
  const entry = clip(a1);
  if (t.open) return { entry, exit: dataEndMs === null ? last : clip(barAnchor(times, tfMs, dataEndMs)) };
  if (t.exitTs === null) return { entry, exit: entry };
  const a2 = barAnchor(times, tfMs, t.exitTs);
  if (a2 === "before") return null;
  return { entry, exit: clip(a2) };
}
