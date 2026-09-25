export type Stream = { broker: string; symbol: string; tf: string };
export const keyOf = (s: Stream) => `${s.broker}:${s.symbol}:${s.tf}`;
