import { useEffect, useState } from "react";
import { strategyAlias } from "@qkt-studio/core/strategy";
import type { BookInfo, StrategyRow } from "@qkt-studio/core";
import { api } from "../api/client.js";
import { useStore } from "../state/store.js";
import { DASH, fmtMoney, fmtNum, fmtPct, fmtRatio, glyph } from "../util/format.js";
import { strategyColor } from "../util/strategyColor.js";
import { Layers, ShieldCheck, TrendingUp } from "../ui/icons.js";
import { useAnalytics } from "./useAnalytics.js";
import { Chart, chartBase, tok, Widget } from "./widgets.js";

type EquityMode = "book" | "by" | "both";

/** Loads the portfolio-only derived files once per run; null (not undefined) means "checked, this run has none". */
function usePortfolioData(runId: string | undefined) {
  const [rows, setRows] = useState<StrategyRow[] | null | undefined>(undefined);
  const [book, setBook] = useState<BookInfo | null | undefined>(undefined);
  const [equity, setEquity] = useState<{ ids: string[]; series: Record<string, { ts: number[]; equity: number[] }> } | null | undefined>(undefined);
  useEffect(() => {
    setRows(undefined); setBook(undefined); setEquity(undefined);
    if (!runId) return;
    let live = true;
    api.strategies(runId).then((r) => live && setRows(r)).catch(() => live && setRows(null));
    api.book(runId).then((r) => live && setBook(r)).catch(() => live && setBook(null));
    api.equityByStrategy(runId).then((r) => live && setEquity(r)).catch(() => live && setEquity(null));
    return () => { live = false; };
  }, [runId]);
  return { rows, book, equity };
}

/**
 * Per-strategy view of a portfolio run: contribution, an equity chart per strategy, and the book's own risk numbers.
 * Only reachable when a run has more than one strategy (the nav item is hidden otherwise).
 */
export function Strategies() {
  const results = useStore((s) => s.results), filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  const { a } = useAnalytics();
  const { rows, book, equity } = usePortfolioData(results?.runId);
  const [mode, setMode] = useState<EquityMode>("by");
  if (!results || !a) return <div className="empty"><span className="spin" />Loading…</div>;
  if (rows === undefined) return <div className="empty"><span className="spin" />Loading…</div>;

  const ids = rows?.map((r) => r.id) ?? a.byStrategy.map((r) => r.strategy);
  const active = filters.strategies?.[0] ?? null;

  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      {/* Always the whole book's own numbers (never the active drill filter): this table is what composes the book, not a
          view of it, so a strategy's row does not change when you click it to filter the rest of the journal. */}
      <Widget title="Strategies" icon={<Layers size={15} />} right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>click a row to filter the journal to it</span>} className="flush">
        <table className="tbl strat-table" aria-label="Strategies in this book: select one to filter the journal">
          <thead><tr><th /><th>Strategy</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">Net P&amp;L</th><th className="r">Profit factor</th><th className="r">Contribution</th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const src = rows?.find((x) => x.id === id);
              const bkt = !rows ? a.byStrategy.find((x) => x.strategy === id) : undefined;
              const pnl = src?.totalPnl ?? bkt?.pnl ?? 0;
              const wr = src?.winRate ?? (bkt && bkt.trades ? bkt.wins / bkt.trades : 0);
              const trades = src?.trades ?? bkt?.trades ?? 0;
              const pf = src?.profitFactor ?? (bkt && bkt.grossLoss < 0 ? bkt.grossWin / -bkt.grossLoss : null);
              const on = active === id;
              return (
                <tr key={id} className={on ? "on" : ""} tabIndex={0} aria-current={on ? "true" : undefined} onClick={() => setFilters({ strategies: on ? undefined : [id] })}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilters({ strategies: on ? undefined : [id] }); } }}>
                  <td><span className="swatch sm" style={{ background: strategyColor(id) }} aria-hidden="true" /></td>
                  <td><b>{strategyAlias(id)}</b>{src && <span className="muted" style={{ marginLeft: 6, fontSize: "var(--fs-xs)" }}>{src.symbols.map((s) => s.split(":").pop()).join(", ")}</span>}</td>
                  <td className="r num">{trades}</td>
                  <td className="r num">{fmtPct(wr, 0)}</td>
                  <td className={`r num ${pnl >= 0 ? "gain" : "loss"}`}>{glyph(pnl)} {fmtMoney(pnl)}</td>
                  <td className="r num">{pf === null ? DASH : fmtRatio(pf)}</td>
                  <td className="r num">{src?.contribution === null || src?.contribution === undefined ? DASH : fmtPct(src.contribution, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {active && <div className="row" style={{ padding: "var(--s2) var(--s3)" }}><button className="btn ghost sm" onClick={() => setFilters({ strategies: undefined })}>Show every strategy</button></div>}
      </Widget>

      <Widget title="Equity" icon={<TrendingUp size={15} />} right={
        <div className="seg sm" role="group" aria-label="Equity view">
          <button aria-pressed={mode === "book"} onClick={() => setMode("book")}>Book</button>
          <button aria-pressed={mode === "by"} onClick={() => setMode("by")}>By strategy</button>
          <button aria-pressed={mode === "both"} onClick={() => setMode("both")}>Both</button>
        </div>
      }>
        {equity === undefined ? <div className="empty"><span className="spin" /></div>
          : equity === null || !equity.ids.length ? <div className="empty muted">No per-strategy equity was recorded for this run.</div>
          : <EquityByStrategy ids={equity.ids} series={equity.series} bookTs={results.equity.ts} bookEq={results.equity.equity} mode={mode} />}
      </Widget>

      {book && (
        <Widget title="Book risk" icon={<ShieldCheck size={15} />}>
          <div className="grid cols-3" style={{ gap: "var(--s3)" }}>
            {book.bookVol !== null && <div><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>Book volatility</span><div className="big" style={{ fontSize: "var(--fs-xl)" }}>{fmtPct(book.bookVol, 1)}</div></div>}
            {book.maxGrossExposure !== null && <div><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>Max gross exposure</span><div className="big" style={{ fontSize: "var(--fs-xl)" }}>{fmtMoney(book.maxGrossExposure, 0)}</div></div>}
            {book.maxNetExposure !== null && <div><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>Max net exposure</span><div className="big" style={{ fontSize: "var(--fs-xl)" }}>{fmtMoney(book.maxNetExposure, 0)}</div></div>}
          </div>
          {book.correlation.length > 0 && (
            <div style={{ marginTop: "var(--s3)" }}>
              <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>Return correlation</span>
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {book.correlation.map((c) => <span key={`${c.a}-${c.b}`} className="badge" title={`${fmtNum(c.correlation, 2)} correlation between ${strategyAlias(c.a)} and ${strategyAlias(c.b)}`}>{strategyAlias(c.a)} · {strategyAlias(c.b)} <b className={Math.abs(c.correlation) < 0.3 ? "" : c.correlation > 0 ? "loss" : "gain"}>{c.correlation >= 0 ? "+" : ""}{c.correlation.toFixed(2)}</b></span>)}
              </div>
            </div>
          )}
        </Widget>
      )}
    </div>
  );
}

function EquityByStrategy({ ids, series, bookTs, bookEq, mode }: { ids: string[]; series: Record<string, { ts: number[]; equity: number[] }>; bookTs: number[]; bookEq: number[]; mode: EquityMode }) {
  const build = () => {
    const byStrat = ids.map((id) => ({ name: strategyAlias(id), color: strategyColor(id), data: series[id]!.ts.map((t, i) => [t, series[id]!.equity[i]]) }));
    const book = { name: "Book", color: tok("--ink-2"), data: bookTs.map((t, i) => [t, bookEq[i]]) };
    const lines = mode === "book" ? [book] : mode === "by" ? byStrat : [book, ...byStrat];
    return chartBase({
      xAxis: { type: "time" }, yAxis: { type: "value" },
      legend: { top: 0, right: 0, textStyle: { color: tok("--ink-2"), fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      series: lines.map((l) => ({ type: "line", name: l.name, data: l.data, showSymbol: false, lineStyle: { color: l.color, width: l.name === "Book" ? 2.5 : 1.75 }, itemStyle: { color: l.color } })),
      tooltip: { trigger: "axis", valueFormatter: (v: unknown) => fmtMoney(Number(v)) },
    });
  };
  return <Chart build={build} height={260} deps={[ids, series, bookTs, bookEq, mode]} label="Equity by strategy" />;
}
