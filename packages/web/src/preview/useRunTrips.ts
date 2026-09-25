import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import type { RoundTrip } from "../api/types.js";
import { useStore } from "../state/store.js";

export interface RunTrips { rows: RoundTrip[]; total: number; truncated: boolean; ready: boolean }

/** Every trade of the run that passes the shared filters, oldest first. One request feeds the charts, the stepper and the Trades tab. */
export function useRunTrips(runId: string | undefined, win: { from: number; to: number } | null): RunTrips {
  const filters = useStore((s) => s.filters);
  const [state, setState] = useState<RunTrips>({ rows: [], total: 0, truncated: false, ready: false });
  const key = JSON.stringify(filters);
  useEffect(() => {
    if (!runId || !win) { setState({ rows: [], total: 0, truncated: false, ready: false }); return; }
    let live = true;
    const t = setTimeout(() => {
      api.overlay(runId, { ...filters, symbol: undefined }, win.from, win.to, 20000)
        .then((o) => live && setState({ rows: [...o.rows].sort((a, b) => a.entryTs - b.entryTs || a.id - b.id), total: o.total, truncated: o.truncated, ready: true }))
        .catch(() => live && setState({ rows: [], total: 0, truncated: false, ready: true }));
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [runId, key, win?.from, win?.to]);
  return useMemo(() => state, [state]);
}
