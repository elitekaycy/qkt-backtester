import { useEffect, useMemo, useRef, useState } from "react";
import type { ExitReason, RoundTrip } from "../api/types.js";
import { FilterBar } from "../journal/FilterBar.js";
import { useStore } from "../state/store.js";
import { fmtDur, fmtMoney, fmtNum, fmtPrice, fmtTs } from "../util/format.js";

const ROW = 27;
const EXIT_GLYPH: Record<ExitReason, string> = { target: "◆", stop: "✕", signal: "●", open: "○" };

/** Compact, windowed list of the run's trades. Uses the same filters as the charts and the Journal, so all three agree. */
export function TradesTab({ rows, selectedId, onSelect, truncated, total }: { rows: RoundTrip[]; selectedId: number | null; onSelect(t: RoundTrip): void; truncated: boolean; total: number }) {
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters), clear = useStore((s) => s.clearFilters);
  const host = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0), [h, setH] = useState(300);
  const multi = useMemo(() => new Set(rows.map((r) => r.symbol)).size > 1, [rows]);
  const active = Object.values(filters).some((v) => v !== undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight || 300));
    ro.observe(el); setH(el.clientHeight || 300);
    return () => ro.disconnect();
  }, []);
  // the selected row follows the selection when it was made on the chart
  useEffect(() => {
    const el = host.current;
    if (!el || selectedId === null) return;
    const i = rows.findIndex((r) => r.id === selectedId);
    if (i < 0) return;
    const y = i * ROW;
    if (y < el.scrollTop || y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 2);
  }, [selectedId, rows]);

  const from = Math.max(0, Math.floor(top / ROW) - 8), to = Math.min(rows.length, Math.ceil((top + h) / ROW) + 8);
  const seg = (label: string, cur: string | undefined, opts: Array<[string, string | undefined]>, set: (v: string | undefined) => void) => (
    <div className="seg sm" role="group" aria-label={label}>{opts.map(([l, v]) => <button key={l} aria-pressed={cur === v} onClick={() => set(v)}>{l}</button>)}</div>
  );

  return (
    <div className={`trades-tab${multi ? " multi" : ""}`}>
      <div className="trades-filters">
        <FilterBar compact count={{ shown: rows.length, total: truncated ? total : rows.length }} />
      </div>
      <div className="trades-head" role="row">
        <span>#</span><span>Side</span>{multi && <span>Symbol</span>}<span>Entry (UTC)</span><span className="r" title="Position size in lots">Size</span><span className="r" title="Money at stake at entry: distance to the stop × size">Risk</span><span className="r">Entry px</span><span className="r">Exit px</span><span className="r">Held</span><span>Exit</span><span className="r">P&amp;L</span><span className="r">R</span>
      </div>
      {rows.length === 0 ? <div className="empty" style={{ flex: 1 }}><b>No trades match</b>{active ? "Clear the filters to see every trade." : "This run made no trades."}</div> : (
        <div className="trades-scroll" ref={host} onScroll={(e) => setTop(e.currentTarget.scrollTop)} role="grid" aria-rowcount={rows.length}>
          <div style={{ height: rows.length * ROW, position: "relative" }}>
            {rows.slice(from, to).map((t, k) => {
              const i = from + k, sel = t.id === selectedId;
              return (
                <div key={t.id} role="row" tabIndex={-1} aria-selected={sel} aria-rowindex={i + 1} className={`trow${sel ? " sel" : ""}`} style={{ top: i * ROW, height: ROW }} onClick={() => onSelect(t)}>
                  <span className="muted num">{i + 1}</span>
                  <span className={t.side}>{t.side === "long" ? "▲ Long" : "▼ Short"}</span>
                  {multi && <span className="ink2">{t.symbol.split(":").pop()}</span>}
                  <span className="num">{fmtTs(t.entryTs)}</span>
                  <span className="r num">{fmtNum(t.qty, 2)}</span>
                  <span className={`r num${t.risk === undefined ? " muted" : ""}`} title={t.risk === undefined ? "No stop was set on this entry, so its risk is not measured" : undefined}>{t.risk === undefined ? "no stop" : fmtMoney(t.risk).replace("+", "")}</span>
                  <span className="r num">{fmtPrice(t.entryPx)}</span>
                  <span className="r num">{t.exitPx === null ? "—" : fmtPrice(t.exitPx)}</span>
                  <span className="r num">{t.open ? "open" : fmtDur(t.holdMs)}</span>
                  <span title={t.exit}><span aria-hidden="true">{EXIT_GLYPH[t.exit]}</span> {t.exit}</span>
                  <span className={`r num ${t.pnl > 0 ? "gain" : t.pnl < 0 ? "loss" : ""}`}>{fmtMoney(t.pnl)}</span>
                  <span className={`r num ${t.pnl > 0 ? "gain" : t.pnl < 0 ? "loss" : ""}`}>{t.r === undefined ? "—" : `${t.r >= 0 ? "+" : "−"}${Math.abs(t.r).toFixed(2)}`}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
