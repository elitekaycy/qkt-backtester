import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import type { RoundTrip, TripQuery } from "../api/types.js";
import { useStore } from "../state/store.js";
import { DASH, fmtDur, fmtMoney, fmtNum, fmtPrice, fmtTs, glyph, polarity } from "../util/format.js";

const ROW = 24, PAGE = 200, OVERSCAN = 6;
type SortKey = NonNullable<TripQuery["sort"]>;
const COLS: Array<{ key: string; label: string; w: string; sort?: SortKey; align?: "right" }> = [
  { key: "id", label: "#", w: "48px", align: "right" }, { key: "symbol", label: "Symbol", w: "136px" }, { key: "side", label: "Side", w: "84px" },
  { key: "entry", label: "Entry (UTC)", w: "150px", sort: "entryTs" }, { key: "entryPx", label: "Entry px", w: "88px", align: "right" },
  { key: "exit", label: "Exit (UTC)", w: "150px", sort: "exitTs" }, { key: "exitPx", label: "Exit px", w: "88px", align: "right" },
  { key: "qty", label: "Qty", w: "60px", sort: "qty", align: "right" }, { key: "pnl", label: "P&L", w: "116px", sort: "pnl", align: "right" },
  { key: "hold", label: "Held", w: "80px", sort: "holdMs", align: "right" }, { key: "fills", label: "Fills", w: "48px", align: "right" },
];
const TEMPLATE = COLS.map((c) => c.w).join(" ");

function Seg<T extends string | undefined>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([v, l]) => <button key={String(v)} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

export function TradesPanel() {
  const { results, resultsStale, filters, selectedTrip } = useStore();
  const store = useStore.getState;
  const runId = results?.runId ?? null;
  const [sort, setSort] = useState<SortKey>("entryTs");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [total, setTotal] = useState(0);
  const [, tick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const cache = useRef(new Map<number, RoundTrip[]>());
  const inflight = useRef(new Set<number>());
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 400 });
  const gen = useRef(0);
  const fkey = JSON.stringify(filters);

  const loadPage = (p: number) => {
    if (!runId || cache.current.has(p) || inflight.current.has(p)) return;
    inflight.current.add(p);
    const g = gen.current;
    api.trades(runId, { ...filters, sort, dir, offset: p * PAGE, limit: PAGE }).then((r) => {
      if (g !== gen.current) return;
      cache.current.set(p, r.rows); setTotal(r.total); setErr(null); tick((n) => n + 1);
    }).catch((e: Error) => g === gen.current && setErr(e.message)).finally(() => inflight.current.delete(p));
  };

  useEffect(() => {
    gen.current++; cache.current.clear(); inflight.current.clear(); setTotal(0);
    if (scroller.current) scroller.current.scrollTop = 0;
    setView((v) => ({ ...v, top: 0 }));
    loadPage(0);
  }, [runId, fkey, sort, dir]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(Math.max(total - 1, 0), Math.ceil((view.top + view.h) / ROW) + OVERSCAN);
  useEffect(() => { for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) loadPage(p); }, [first, last, total]);

  if (!results) return <div className="panel"><div className="panel-head"><span className="title">Trades</span></div><div className="empty"><b>No trades yet.</b><br />Each row is one round trip (entry to exit), not one fill.</div></div>;

  const set = (patch: Partial<TripQuery>) => store().setFilters(patch);
  const mins = (v: string) => (v === "" ? undefined : Math.max(0, Number(v)) * 60_000);
  const active = Object.values(filters).some((v) => v !== undefined);
  const rows: Array<[number, RoundTrip | undefined]> = [];
  for (let i = first; i <= last && total > 0; i++) rows.push([i, cache.current.get(Math.floor(i / PAGE))?.[i % PAGE]]);

  return (
    <div className="panel">
      <div className="panel-head" style={{ flexWrap: "wrap", rowGap: 4 }}>
        <span className="title">Trades</span>
        <span className="badge" title="Engine tradeCount counts fills; a trade here is one entry-to-exit round trip">{total.toLocaleString()}{active ? " matching" : ""} of {results.summary.trades + results.summary.openTrades} round trips</span>
        <Seg label="Side" value={filters.side} options={[[undefined, "All"], ["long", "Long"], ["short", "Short"]]} onChange={(v) => set({ side: v })} />
        <Seg label="Outcome" value={filters.outcome} options={[[undefined, "All"], ["win", "Wins"], ["loss", "Losses"], ["open", "Open"]]} onChange={(v) => set({ outcome: v })} />
        <label className="field">held ≥ <input className="narrow" type="number" min={0} placeholder="min" value={filters.minHoldMs === undefined ? "" : filters.minHoldMs / 60_000} onChange={(e) => set({ minHoldMs: mins(e.target.value) })} /></label>
        <label className="field">≤ <input className="narrow" type="number" min={0} placeholder="min" value={filters.maxHoldMs === undefined ? "" : filters.maxHoldMs / 60_000} onChange={(e) => set({ maxHoldMs: mins(e.target.value) })} /></label>
        <label className="field">P&L ≥ <input className="narrow" type="number" placeholder="any" value={filters.minPnl ?? ""} onChange={(e) => set({ minPnl: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        <label className="field">from <input type="date" value={filters.fromTs ? new Date(filters.fromTs).toISOString().slice(0, 10) : ""} onChange={(e) => set({ fromTs: e.target.value ? Date.parse(e.target.value + "T00:00:00Z") : undefined })} /></label>
        <label className="field">to <input type="date" value={filters.toTs ? new Date(filters.toTs).toISOString().slice(0, 10) : ""} onChange={(e) => set({ toTs: e.target.value ? Date.parse(e.target.value + "T00:00:00Z") : undefined })} /></label>
        {active && <button className="btn sm" onClick={() => store().clearFilters()}>Clear filters</button>}
        <span className="muted">Filters also filter the charts.</span>
      </div>
      <div className={resultsStale ? "dim" : ""} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: TEMPLATE, background: "var(--surface-2)", borderBottom: "1px solid var(--border)", fontWeight: 600, paddingRight: 12 }}>
          {COLS.map((c) => (
            <div key={c.key} className={c.sort ? "sortable" : ""} style={{ padding: "4px 8px", textAlign: c.align, cursor: c.sort ? "pointer" : "default", userSelect: "none" }}
              onClick={() => { if (!c.sort) return; if (sort === c.sort) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(c.sort); setDir("asc"); } }}>
              {c.label}{c.sort === sort ? (dir === "asc" ? " ▲" : " ▼") : ""}
            </div>
          ))}
        </div>
        <div ref={scroller} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })} style={{ overflow: "auto", flex: 1, position: "relative", minHeight: 0 }}>
          {err && <div className="banner bad">{err}</div>}
          {total === 0 && !err && <div className="empty">{active ? "No trades match these filters." : "This run made no closed trades."}</div>}
          <div style={{ height: total * ROW, position: "relative" }}>
            {rows.map(([i, t]) => (
              <div key={i} className={`tr${t && selectedTrip?.id === t.id ? " sel" : ""}`} role="row"
                style={{ position: "absolute", top: i * ROW, height: ROW, left: 0, right: 0, display: "grid", gridTemplateColumns: TEMPLATE, alignItems: "center", borderBottom: "1px solid var(--grid)", cursor: t ? "pointer" : "default",
                  background: t && selectedTrip?.id === t.id ? "color-mix(in srgb, var(--accent) 16%, transparent)" : undefined }}
                onClick={() => t && store().selectTrip(t)}>
                {t ? <TradeCells t={t} /> : <div style={{ gridColumn: "1 / -1", padding: "0 8px" }} className="muted">…</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TradeCells({ t }: { t: RoundTrip }) {
  const p = polarity(t.pnl);
  const cell = (v: React.ReactNode, align?: "right", cls = "") => <div className={`${cls}${align ? " num" : ""} nowrap`} style={{ padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>;
  return (
    <>
      {cell(t.id, "right", "muted")}
      {cell(t.symbol)}
      {cell(t.side === "long" ? "▲ Long" : "▼ Short")}
      {cell(fmtTs(t.entryTs), undefined, "mono")}
      {cell(fmtPrice(t.entryPx), "right")}
      {cell(t.open ? "open" : fmtTs(t.exitTs), undefined, t.open ? "muted" : "mono")}
      {cell(t.open ? DASH : fmtPrice(t.exitPx), "right")}
      {cell(fmtNum(t.qty, 2), "right")}
      {cell(<>{t.open ? "" : glyph(t.pnl) + " "}{fmtMoney(t.pnl)}{t.open ? " realised" : ""}</>, "right", p === "gain" ? "gain" : p === "loss" ? "loss" : "")}
      {cell(t.open ? DASH : fmtDur(t.holdMs), "right")}
      {cell(t.fills, "right", "muted")}
    </>
  );
}
