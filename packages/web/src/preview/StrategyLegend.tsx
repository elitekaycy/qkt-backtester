import { useStore } from "../state/store.js";
import { strategyAlias } from "@qkt-studio/core/strategy";
import { strategyBadge, strategyColor } from "../util/strategyColor.js";

/**
 * Shown only for a portfolio run (more than one strategy). Toggles the SAME `filters.strategies` the whole app reads,
 * so hiding a strategy here also hides it in the Trades tab and the Journal: one filter, everywhere consistent.
 * Double-click solos a strategy; click again on a lone strategy shows everyone again.
 */
export function StrategyLegend({ ids }: { ids: string[] }) {
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  const shown = filters.strategies ?? ids;

  const toggle = (id: string) => {
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
    setFilters({ strategies: next.length === ids.length ? undefined : next.length ? next : [id] });
  };
  const solo = (id: string) => setFilters({ strategies: shown.length === 1 && shown[0] === id ? undefined : [id] });

  return (
    <div className="strategy-legend" role="group" aria-label="Strategies shown">
      {ids.map((id) => {
        const on = shown.includes(id);
        return (
          <button key={id} className={`strategy-chip${on ? " on" : ""}`} aria-pressed={on} title={`${strategyAlias(id)} · click to ${on ? "hide" : "show"}, double-click to solo`}
            onClick={() => toggle(id)} onDoubleClick={() => solo(id)}>
            <span className="swatch" style={{ background: strategyColor(id) }} aria-hidden="true">{strategyBadge(id)}</span>
            {strategyAlias(id)}
          </button>
        );
      })}
      {shown.length !== ids.length && <button className="btn ghost sm" onClick={() => setFilters({ strategies: undefined })}>Show all</button>}
    </div>
  );
}
