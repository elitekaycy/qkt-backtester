import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client.js";
import type { Analytics } from "../api/types.js";
import { useStore } from "../state/store.js";

interface Ctx {
  a: Analytics | null; loading: boolean; total: number;
  /** Same filters but ignoring the single-day drill-down, so the calendar keeps showing the whole month you clicked into. */
  base: Analytics | null;
}
const AnalyticsCtx = createContext<Ctx>({ a: null, loading: false, total: 0, base: null });
export const useAnalytics = () => useContext(AnalyticsCtx);

/**
 * One fetch of the aggregates for the current run and filters. The previous answer stays on screen while the next one
 * loads, so widgets animate from old to new values instead of flashing empty.
 */
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const runId = useStore((s) => s.results?.runId ?? null), filters = useStore((s) => s.filters), summary = useStore((s) => s.results?.summary);
  const [a, setA] = useState<Analytics | null>(null);
  const [baseA, setBaseA] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  const key = JSON.stringify(filters);
  useEffect(() => {
    if (!runId) { setA(null); return; }
    const g = ++gen.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.analytics(runId, filters).then((r) => { if (g === gen.current) { setA(r); setLoading(false); } }).catch(() => { if (g === gen.current) setLoading(false); });
      if (filters.day) api.analytics(runId, { ...filters, day: undefined }).then((r) => { if (g === gen.current) setBaseA(r); }).catch(() => undefined);
    }, 90);
    return () => clearTimeout(t);
  }, [runId, key]);
  const total = summary ? summary.trades + summary.openTrades : 0;
  return <AnalyticsCtx.Provider value={{ a, loading, total, base: filters.day ? baseA : a }}>{children}</AnalyticsCtx.Provider>;
}
