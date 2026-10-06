import { useEffect, useState } from "react";
import type { RunDerivatives } from "@qkt-studio/core";
import { api } from "../api/client.js";
import { useStore } from "../state/store.js";

// A run's derivatives are read once and shared by the journal's Derivatives view, the Overview cost bridge and the filter bar.
const cache = new Map<string, RunDerivatives>();

/**
 * The futures/options sections of the run on screen, or null when it has none. The server's 404 for a run without them is never
 * requested: `meta.derivatives` says first, so a CFD run makes no extra call at all.
 */
export function useDerivatives(): { data: RunDerivatives | null; loading: boolean; error: string | null } {
  const runId = useStore((s) => s.results?.runId ?? null), has = useStore((s) => (s.results?.meta.derivatives?.length ?? 0) > 0);
  const [state, setState] = useState<{ id: string | null; data: RunDerivatives | null; error: string | null }>({ id: null, data: null, error: null });
  useEffect(() => {
    if (!runId || !has) { setState({ id: runId, data: null, error: null }); return; }
    const hit = cache.get(runId);
    if (hit) { setState({ id: runId, data: hit, error: null }); return; }
    let live = true;
    api.derivatives(runId).then((d) => { cache.set(runId, d); if (live) setState({ id: runId, data: d, error: null }); })
      .catch((e: Error) => { if (live) setState({ id: runId, data: null, error: e.message }); });
    return () => { live = false; };
  }, [runId, has]);
  const current = state.id === runId;
  return { data: current ? state.data : null, loading: has && !(current && (state.data || state.error)), error: current ? state.error : null };
}
