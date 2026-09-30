// packages/web/src/chat/results.ts
/** A tool's result text as an object, or null (plain-text errors, lists, results cut at the 8k cap). */
export function parseResult(text: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) && !(j as { truncated?: unknown }).truncated ? (j as Record<string, unknown>) : null;
  } catch { return null; }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
/** Sweep rows better than the median on the first part but below the median on the test part: likely over-fitted (spec 6). */
export function overfitFlags(rows: Array<{ first: number | null; test: number | null }>): boolean[] {
  const f = rows.flatMap((r) => (r.first === null ? [] : [r.first])), t = rows.flatMap((r) => (r.test === null ? [] : [r.test]));
  if (f.length < 3 || t.length < 3) return rows.map(() => false);
  const mf = median(f), mt = median(t);
  return rows.map((r) => r.first !== null && r.test !== null && r.first > mf && r.test < mt);
}
