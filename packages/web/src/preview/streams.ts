/** `base`: the bar folder qkt read this stream from in a bars run (a finer timeframe it aggregates from), when known. */
export type Stream = { broker: string; symbol: string; tf: string; base?: string | null };
export const keyOf = (s: Stream) => `${s.broker}:${s.symbol}:${s.tf}`;
