import { continuousOf, type Tier } from "@qkt-studio/core";

/** A strategy that follows a futures root (`CME:ES@front`, `@next`) instead of one contract. */
export const hasContinuous = (streams: ReadonlyArray<{ symbol: string }>): boolean => streams.some((s) => continuousOf(s.symbol) !== null);

/** An option contract by its qkt code (the venue name with each `-` written `_`: `BTC_USDC_26SEP26_84500_P`), a chain or a chain analytic. */
export const isOptionStream = (s: { broker: string; symbol: string }): boolean =>
  s.broker === "OPTIONS" || s.broker === "CHAIN" || /_\d{1,2}[A-Z]{3}\d{2}_[\d.]+_[CP]$/.test(s.symbol);

/**
 * Which data tier a strategy's streams can run on, probed on qkt 0.55:
 *  - a continuous stream is built from each contract's bars: `Full` (ticks) fails with "no market data for ROOT@front";
 *  - an option contract, chain or analytic is read from stored chains: `Draft` (`--bars`) fails asking for bars that cannot exist;
 *  - listed contracts and perpetuals run on both (they are bars either way; futures fill on qkt's exchange simulator whatever the tier).
 * Returns the sentence to refuse the run with, or null when the tier is fine.
 */
export function tierProblem(streams: ReadonlyArray<{ broker: string; symbol: string }>, tier: Tier): string | null {
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

/** What fills a run's orders when it holds futures or options: qkt's exchange simulator, whatever `--broker` says. */
export const EXCHANGE_SIM_NOTE = "futures and options fill on qkt's exchange simulator (executable price plus the run's slippage, the root's fees per fill), so the broker and execution options do not change their fills";
