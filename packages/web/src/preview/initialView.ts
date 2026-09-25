import type { RoundTrip } from "../api/types.js";

export interface Range { from: number; to: number }

/**
 * The view a run opens on: the first few trades, with their entries and exits readable, instead of the whole window
 * squeezed into a strip. Between 80 and 400 bars wide; padding of a dozen bars either side.
 */
export function firstTradesRange(trips: RoundTrip[], tfMs: number, dataFirst: number, dataLast: number): Range {
  const pad = 12 * tfMs, minSpan = 80 * tfMs, maxSpan = 400 * tfMs;
  if (!trips.length) {
    const from = dataFirst;
    return { from, to: Math.min(dataLast + tfMs, from + 160 * tfMs) };
  }
  const start = trips[0]!.entryTs - pad;
  let k = Math.min(8, trips.length);
  let end = start;
  for (; k >= 1; k--) {
    end = Math.max(...trips.slice(0, k).map((t) => t.exitTs ?? t.entryTs)) + pad;
    if (end - start <= maxSpan) break;
  }
  const span = Math.min(maxSpan, Math.max(minSpan, end - start));
  return { from: Math.max(dataFirst - pad, start), to: Math.max(dataFirst - pad, start) + span };
}
