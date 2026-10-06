import { continuousOf } from "./instruments.js";

/** The two data tiers as the UI names them: `draft` runs on bars, `full` on ticks. */
export type TierName = "draft" | "full";

/** An option contract by its qkt code (the venue name with each `-` written `_`: `BTC_USDC_26SEP26_84500_P`), a chain or a chain analytic. */
export const isOptionStream = (s: { broker: string; symbol: string }): boolean =>
  s.broker === "OPTIONS" || s.broker === "CHAIN" || /_\d{1,2}[A-Z]{3}\d{2}_[\d.]+_[CP]$/.test(s.symbol);

/**
 * Which data tier a strategy's streams can run on, probed on qkt 0.55:
 *  - a continuous stream is built from each contract's bars: `Full` (ticks) fails with "no market data for ROOT@front";
 *  - an option contract, chain or analytic is read from stored chains: `Draft` (`--bars`) fails asking for bars that cannot exist;
 *  - listed contracts and perpetuals run on Draft; Full needs a tick store under symbols/<NAME> (a venue archive of bars has none, and qkt then
 *    stops with "No data for <NAME>", which the run reports as it is). Futures fill on qkt's exchange simulator whatever the tier.
 * Returns the sentence to refuse the run with, or null when the tier is fine.
 */
export function tierProblem(streams: ReadonlyArray<{ broker: string; symbol: string }>, tier: TierName): string | null {
  const cont = streams.find((s) => continuousOf(s.symbol) !== null);
  if (cont && tier === "full") {
    return `${cont.broker}:${cont.symbol} is a continuous futures stream: it is built from each contract's bars and has no ticks, so a Full (tick) run has nothing to read. Run it as Draft (bars).`;
  }
  const opt = streams.find(isOptionStream);
  if (opt && tier === "draft") {
    return `${opt.broker}:${opt.symbol} is read from stored option chains, not bars, so a Draft (bars) run cannot use it. Run it as Full.`;
  }
  return null;
}

