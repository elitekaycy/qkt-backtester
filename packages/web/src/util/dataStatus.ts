import type { SymbolReport, TfReport } from "../api/types.js";

/** The widest built bar series qkt can read for a symbol: what its summary line describes. */
export const mainSeries = (s: SymbolReport): TfReport | null =>
  s.bars.filter((b) => b.files > 0 && !b.qktReads).reduce<TfReport | null>((b, x) => (!b || x.span > b.span ? x : b), null);

/**
 * Why a symbol needs attention, in a few words, or null when nothing needs doing. The one definition the Data list, its
 * "Needs attention" filter and the status bar all count. e.g. "12 missing days in 15m", "ticks only: build bars to run on bars".
 */
export function attentionOf(s: SymbolReport): string | null {
  const unread = s.bars.find((b) => b.files > 0 && b.qktReads);
  if (unread && !mainSeries(s)) return `folder ${unread.tf} is not read by qkt: rename it ${unread.qktReads}`;
  if (s.status === "ticks-only") return "ticks only: build bars to run on bars";
  if (s.status === "empty") return "no data files";
  const main = mainSeries(s);
  if (main?.missing) return `${main.missing.toLocaleString()} missing day${main.missing === 1 ? "" : "s"} in ${main.tf}`;
  if (s.status !== "complete" && s.ticks?.missing) return `${s.ticks.missing.toLocaleString()} missing tick days`;
  return null;
}
