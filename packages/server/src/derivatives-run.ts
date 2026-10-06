import { continuousOf, dayMs, isOptionStream, isoDay, rootOfContract, tierProblem, type DerivativesReport } from "@qkt-studio/core";
import type { DPick } from "./derivatives-readiness.js";

/** A strategy that follows a futures root (`CME:ES@front`, `@next`) instead of one contract. */
export const hasContinuous = (streams: ReadonlyArray<{ symbol: string }>): boolean => streams.some((s) => continuousOf(s.symbol) !== null);

/**
 * Whether qkt's own bar coverage check is waived because the studio has already judged the windows, per stream:
 *  - a continuous stream: qkt looks for `bars/<V>/<ROOT>@front` and reports 0/N days [probed];
 *  - a listed contract of a root that declares an exchange calendar (cme_globex...): qkt's day rule is the FX week, so it calls
 *    every Sunday and exchange holiday a hole (ESH19 over Oct 2018 - Mar 2019: 26 "missing" days, all closures) [probed], while
 *    Data readiness judges the same days by the root's own calendar and still reports real gaps.
 * A root with no calendar, or on the fx/crypto rules qkt shares, keeps qkt's own check.
 */
export function waivesEngineCoverage(streams: ReadonlyArray<{ broker: string; symbol: string }>, d: DerivativesReport | undefined): boolean {
  if (hasContinuous(streams)) return true;
  if (!d) return false;
  const roots = new Map(d.futures.map((f) => [f.key, f.terms?.calendar]));
  return streams.some((s) => {
    const root = rootOfContract(s.broker, s.symbol, new Set(roots.keys()));
    const cal = root ? roots.get(`${s.broker}:${root}`) : undefined;
    return cal !== undefined && cal !== "fx" && cal !== "crypto";
  });
}

// The tier rules live in core: the studio's tier control reads the same function the run refuses with.
export { isOptionStream, tierProblem };

/** What fills a run's orders when it holds futures or options: qkt's exchange simulator, whatever `--broker` says. */
export const EXCHANGE_SIM_NOTE = "futures and options fill on qkt's exchange simulator (executable price plus the run's slippage, the root's fees per fill), so the broker and execution options do not change their fills";

/**
 * The days of [from, to) a derivatives stream's verdict does not cover, capped at what a message can list. A blocked stream has
 * no usable window at all: its reason stands for the whole window, so every day of it is a gap.
 */
export function windowGaps(pick: DPick, from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = dayMs(from); d < dayMs(to); d += 86_400_000) days.push(isoDay(d));
  if ("blocked" in pick) return days;
  const covered = (day: string) => pick.ranges.some((r) => day >= r.from && day < r.to);
  return days.filter((d) => !covered(d));
}
