import { continuousOf, isOptionStream, tierProblem } from "@qkt-studio/core";

/** A strategy that follows a futures root (`CME:ES@front`, `@next`) instead of one contract. */
export const hasContinuous = (streams: ReadonlyArray<{ symbol: string }>): boolean => streams.some((s) => continuousOf(s.symbol) !== null);

// The tier rules live in core: the studio's tier control reads the same function the run refuses with.
export { isOptionStream, tierProblem };

/** What fills a run's orders when it holds futures or options: qkt's exchange simulator, whatever `--broker` says. */
export const EXCHANGE_SIM_NOTE = "futures and options fill on qkt's exchange simulator (executable price plus the run's slippage, the root's fees per fill), so the broker and execution options do not change their fills";
