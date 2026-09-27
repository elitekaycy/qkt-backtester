/** min/max without spreading: `Math.max(...a)` overflows the call stack at ~150k elements. */
export function minOf(a: readonly number[], init = Infinity): number { let m = init; for (const v of a) if (v < m) m = v; return m; }
export function maxOf(a: readonly number[], init = -Infinity): number { let m = init; for (const v of a) if (v > m) m = v; return m; }
