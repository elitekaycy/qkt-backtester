import { useEffect, useMemo, useRef, useState } from "react";
import { strategyAlias } from "@qkt-studio/core/strategy";
import { api } from "../api/client.js";
import type { RoundTrip, TripQuery } from "../api/types.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { DASH, fmtDur, fmtR, fmtMoney, fmtNum, fmtPrice, fmtTs, glyph } from "../util/format.js";
import { ArrowUpRight } from "../ui/icons.js";
import { notify } from "../ui/notify.js";
import { useNotice } from "../ui/useNotice.js";
import { strategyColor } from "../util/strategyColor.js";
import { useAnalytics } from "./useAnalytics.js";
import { SignedBars, Widget } from "./widgets.js";

/** The id of the one "cannot load trades" toast: a repeat failure updates it rather than stacking. */
const TRADES_TOAST = "trades-load";

const ROW = 34, PAGE = 200, OVERSCAN = 6;
type SortKey = NonNullable<TripQuery["sort"]>;
const BASE_COLS: Array<{ key: string; label: string; w: string; sort?: SortKey; right?: boolean }> = [
  { key: "id", label: "#", w: "52px", right: true }, { key: "symbol", label: "Symbol", w: "112px" }, { key: "side", label: "Side", w: "82px" },
  { key: "entry", label: "Entry (UTC)", w: "144px", sort: "entryTs" }, { key: "entryPx", label: "Entry", w: "88px", right: true },
  { key: "exit", label: "Exit (UTC)", w: "144px", sort: "exitTs" }, { key: "exitPx", label: "Exit", w: "88px", right: true },
  { key: "size", label: "Size", w: "64px", right: true }, { key: "risk", label: "Risk", w: "84px", right: true },
  { key: "how", label: "Ended by", w: "92px" }, { key: "r", label: "R", w: "64px", right: true },
  { key: "pnl", label: "P&L", w: "108px", sort: "pnl", right: true }, { key: "hold", label: "Held", w: "84px", sort: "holdMs", right: true },
];
/** A portfolio run (more than one strategy) inserts a Strategy column right after Symbol; a plain run's columns are untouched. */
const STRAT_COL: (typeof BASE_COLS)[number] = { key: "strategy", label: "Strategy", w: "96px" };
/** A continuous-futures run adds the contract(s) each trade really traded and the rolls it carried, right after Symbol. */
const CONTRACT_COL: (typeof BASE_COLS)[number] = { key: "contract", label: "Contract", w: "150px" };
const colsFor = (strat: boolean, contract = false) => {
  const head = [BASE_COLS[0]!, BASE_COLS[1]!, ...(contract ? [CONTRACT_COL] : []), ...(strat ? [STRAT_COL] : [])];
  return strat || contract ? [...head, ...BASE_COLS.slice(2)] : BASE_COLS;
};
const H = 3_600_000;
const VENUE_LABEL = { expiry: "expiry", liquidation: "liquidated", roll_failed: "roll failed" } as const;
const VENUE_TITLE = { expiry: "The contract expired and the venue settled the position", liquidation: "Equity fell below maintenance margin and the venue closed the position", roll_failed: "The next contract refused the roll, so the position was closed" } as const;

function TradeCells({ t, strat, contract }: { t: RoundTrip; strat: boolean; contract: boolean }) {
  const c = (v: React.ReactNode, right?: boolean, cls = "") => <div role="cell" className={`${cls}${right ? " num" : ""} nowrap`} style={{ padding: "0 var(--s3)", overflow: "hidden", textOverflow: "ellipsis", textAlign: right ? "right" : "left" }}>{v}</div>;
  return (
    <>
      {c(t.id, true, "muted")}{c(t.symbol.split(":").pop())}
      {contract && c(t.contract ? <span title={`Entered on ${t.contract}${t.exitContract && t.exitContract !== t.contract ? `, exited on ${t.exitContract}` : ""}${t.rolls ? `; carried across ${t.rolls} roll${t.rolls === 1 ? "" : "s"}` : ""}`}>{t.contract.replace(/^[A-Za-z0-9_]+:/, "")}{t.exitContract && t.exitContract !== t.contract ? ` → ${t.exitContract.replace(/^[A-Za-z0-9_]+:/, "")}` : ""}{t.rolls ? <span className="muted"> · {t.rolls}×</span> : null}</span> : <span className="muted">{DASH}</span>)}
      {strat && c(<span style={{ color: strategyColor(t.strategy), fontWeight: 600 }}>{strategyAlias(t.strategy)}</span>)}
      {c(t.side === "long" ? "▲ Long" : "▼ Short")}
      {c(fmtTs(t.entryTs), false, "mono")}{c(fmtPrice(t.entryPx), true)}{c(t.open ? <span className="badge">open</span> : fmtTs(t.exitTs), false, "mono")}{c(t.open ? DASH : fmtPrice(t.exitPx), true)}
      {c(fmtNum(t.qty, 2), true)}{c(t.risk === undefined ? <span title="No stop was set on this entry, so its risk is not measured">no stop</span> : fmtMoney(t.risk).replace("+", ""), true, t.risk === undefined ? "muted" : "")}
      {c(t.venueExit ? <span className={`badge ${t.venueExit === "expiry" ? "" : "bad"}`} title={VENUE_TITLE[t.venueExit]}>{VENUE_LABEL[t.venueExit]}</span> : <span className={`badge ${t.exit === "target" ? "ok" : t.exit === "stop" ? "bad" : ""}`}>{t.exit === "signal" ? "signal" : t.exit}</span>)}
      {c(fmtR(t.r, 2, false), true, t.r === undefined ? "muted" : t.r >= 0 ? "gain" : "loss")}
      {c(<>{t.open ? "" : glyph(t.pnl) + " "}{fmtMoney(t.pnl)}</>, true, t.pnl >= 0 ? "gain" : "loss")}{c(t.open ? DASH : fmtDur(t.holdMs), true)}
    </>
  );
}

/** Server-paged, virtualised trade table. Rows are fetched by the page as you scroll, so a million trades cost nothing. */
export function TradesTable() {
  const runId = useStore((s) => s.results?.runId ?? null), filters = useStore((s) => s.filters), selected = useStore((s) => s.selectedTrip), selectTrip = useStore((s) => s.selectTrip);
  const strat = useStore((s) => (s.results?.meta.strategies.length ?? 0) > 1);
  const contract = useStore((s) => !!s.results?.meta.derivatives?.includes("contracts"));
  const cols = useMemo(() => colsFor(strat, contract), [strat, contract]);
  const template = useMemo(() => cols.map((c) => c.w).join(" "), [cols]);
  const ui = useUi();
  const [sort, setSort] = useState<SortKey>("entryTs"), [dir, setDir] = useState<"asc" | "desc">("desc");
  const [total, setTotal] = useState(0), [, tick] = useState(0), [err, setErr] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<number, RoundTrip[]>()), inflight = useRef(new Set<number>()), gen = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 360 });
  const fkey = JSON.stringify(filters);

  const load = (p: number) => {
    if (!runId || cache.current.has(p) || inflight.current.has(p)) return;
    inflight.current.add(p);
    const g = gen.current;
    api.trades(runId, { ...filters, sort, dir, offset: p * PAGE, limit: PAGE }).then((r) => { if (g !== gen.current) return; cache.current.set(p, r.rows); setTotal(r.total); setErr(null); tick((n) => n + 1); })
      .catch((e: Error) => g === gen.current && setErr(e.message)).finally(() => inflight.current.delete(p));
  };
  useEffect(() => { gen.current++; cache.current.clear(); inflight.current.clear(); setTotal(0); if (scroller.current) scroller.current.scrollTop = 0; setView((v) => ({ ...v, top: 0 })); load(0); }, [runId, fkey, sort, dir, attempt]);
  // a failed page load is a toast with Retry (one toast, updated in place), not a banner inside the table
  useNotice(TRADES_TOAST, err ? { key: `trades:${err}`, kind: "error", text: "Cannot load trades", description: err, action: { label: "Retry", onClick: () => { setErr(null); setAttempt((n) => n + 1); } } } : null);
  useEffect(() => () => notify.dismiss(TRADES_TOAST), []);
  useEffect(() => { const el = scroller.current; if (!el) return; const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: el.clientHeight }))); ro.observe(el); return () => ro.disconnect(); }, []);
  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN), last = Math.min(Math.max(total - 1, 0), Math.ceil((view.top + view.h) / ROW) + OVERSCAN);
  useEffect(() => { for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) load(p); }, [first, last, total]);
  const rows: Array<[number, RoundTrip | undefined]> = [];
  for (let i = first; i <= last && total > 0; i++) rows.push([i, cache.current.get(Math.floor(i / PAGE))?.[i % PAGE]]);

  return (
    <Widget title="Trades" className="flush" right={<>
      {selected && <button className="btn sm primary" onClick={() => { selectTrip(selected, true); ui.set({ journalOpen: false }); }}><ArrowUpRight size={14} />Show #{selected.id} on the chart</button>}
      <span className="muted">{total.toLocaleString()} round trips · one row per entry-to-exit</span></>} style={{ padding: 0 }}>
      <div style={{ overflowX: "auto" }}><div style={{ minWidth: (strat ? 1316 : 1220) + (contract ? 150 : 0) }}>
      <div role="table" aria-label="Round trips" aria-rowcount={total}>
      <div style={{ display: "grid", gridTemplateColumns: template, borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", background: "var(--card)", paddingRight: 10 }} role="row">
        {cols.map((c) => (
          <div key={c.key} role="columnheader" aria-sort={c.sort === sort ? (dir === "asc" ? "ascending" : "descending") : undefined} tabIndex={c.sort ? 0 : undefined}
            style={{ padding: "8px var(--s3)", textAlign: c.right ? "right" : "left", cursor: c.sort ? "pointer" : "default", color: "var(--ink-3)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500, userSelect: "none" }}
            onClick={() => { if (!c.sort) return; if (sort === c.sort) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(c.sort); setDir("desc"); } }}
            onKeyDown={(e) => { if (c.sort && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); if (sort === c.sort) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(c.sort); setDir("desc"); } } }}>
            {c.label}{c.sort === sort ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </div>
        ))}
      </div>
      <div ref={scroller} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })} style={{ overflow: "auto", height: 420, position: "relative" }}>
        {err && total === 0 && <div className="empty">Trades could not be loaded.</div>}
        {total === 0 && !err && <div className="empty">No trades match these filters.</div>}
        <div style={{ height: total * ROW, position: "relative" }}>
          {rows.map(([i, t]) => (
            <div key={i} className="vrow" role="row" data-row={i} tabIndex={i === first || (!!t && selected?.id === t.id) ? 0 : -1} aria-selected={!!t && selected?.id === t.id} style={{ top: i * ROW, height: ROW, gridTemplateColumns: template }} onClick={() => t && selectTrip(t, false)} onDoubleClick={() => { if (t) { selectTrip(t, true); ui.set({ journalOpen: false }); } }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && t) { e.preventDefault(); selectTrip(t, true); ui.set({ journalOpen: false }); }
                else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = Math.min(total - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))), nt = cache.current.get(Math.floor(n / PAGE))?.[n % PAGE];
                  if (nt) selectTrip(nt, false);
                  const el = scroller.current; if (el) { const top = n * ROW; if (top < el.scrollTop) el.scrollTop = top; else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight; }
                  requestAnimationFrame(() => el?.querySelector<HTMLElement>(`[data-row="${n}"]`)?.focus({ preventScroll: true }));
                }
              }}>
              {t ? <TradeCells t={t} strat={strat} contract={contract} /> : <div role="cell" style={{ gridColumn: "1 / -1", padding: "0 var(--s3)" }} className="muted">…</div>}
            </div>
          ))}
        </div>
      </div>
      </div>
      </div></div>
    </Widget>
  );
}

export function TradesView() {
  const { a } = useAnalytics();
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  const held = (lo?: number, hi?: number) => { const on = filters.minHoldMs === lo && filters.maxHoldMs === hi; setFilters({ minHoldMs: on ? undefined : lo, maxHoldMs: on ? undefined : hi }); };
  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      {a && (
        <div className="grid cols-3">
          <Widget title="Side"><SignedBars items={[{ key: "long", label: "Long", value: a.side.long.pnl, count: a.side.long.trades }, { key: "short", label: "Short", value: a.side.short.pnl, count: a.side.short.trades }]} active={filters.side ?? null} onPick={(k) => setFilters({ side: filters.side === k ? undefined : (k as never) })} /></Widget>
          <Widget title="Ended by">{a.exit.length ? <SignedBars items={a.exit.map((e) => ({ key: e.reason, label: e.reason === "target" ? "Target" : e.reason === "stop" ? "Stop" : "Signal", value: e.pnl, count: e.trades }))} active={filters.exit ?? null} onPick={(k) => setFilters({ exit: filters.exit === k ? undefined : (k as never) })} /> : <div className="muted">No closed trades.</div>}</Widget>
          <Widget title="Held for"><SignedBars items={a.hold.map((h) => ({ key: h.label, label: h.label, value: h.pnl, count: h.trades }))}
            active={a.hold.find((h) => filters.minHoldMs === (h.minMs || undefined) && filters.maxHoldMs === (h.maxMs === Infinity ? undefined : h.maxMs))?.label ?? null}
            onPick={(k) => { const h = a.hold.find((x) => x.label === k)!; held(h.minMs || undefined, h.maxMs === Infinity ? undefined : h.maxMs); }} /></Widget>
        </div>
      )}
      <TradesTable />
      <span hidden>{fmtNum(H)}</span>
    </div>
  );
}
