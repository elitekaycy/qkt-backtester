import { binRange } from "@qkt-studio/core/analytics";
import { useStore } from "../state/store.js";
import { useAnalytics } from "./useAnalytics.js";
import { Chart, chartBase, Gauge, Ring, SignedBars, Spark, Stat, tipHtml, Widget, tok, zoomOptions } from "./widgets.js";
import { DASH, fmtDay, fmtDur, fmtR, fmtMoney, fmtNum, fmtPct, fmtRatio, glyph } from "../util/format.js";
import { costLines } from "../util/derivatives.js";
import { Activity, Gauge as GaugeIcon, Percent, Scale, Target, TrendingUp, Layers } from "../ui/icons.js";

export function Overview() {
  const { a } = useAnalytics();
  const results = useStore((s) => s.results), setFilters = useStore((s) => s.setFilters), filters = useStore((s) => s.filters);
  if (!a || !results) return <div className="empty"><span className="spin" />Loading…</div>;
  const s = results.summary, start = results.equity.equity[0] ?? 0, cur = results.meta.currency ?? null;
  const gain = tok("--gain"), loss = tok("--loss");
  const up = a.pnl >= 0;
  const filtered = Object.values(filters).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));
  const H = a.pnlHistogram;
  const mid = (i: number) => (H.edges[i]! + H.edges[i + 1]!) / 2;

  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      <div className="grid cols-5">
        {/* The journal works on round trips, so this is the P&L of the (filtered) closed trades. "Net P&L" is reserved for the
            engine's realised + unrealised total, shown here too whenever an open position makes the two differ. */}
        <Widget title="Realised P&L" icon={<TrendingUp size={15} />} className="kcard">
          <div className={`big ${up ? "gain" : "loss"}`}>{glyph(a.pnl)} {fmtMoney(a.pnl)}</div>
          <div className="sub">{start ? `${fmtPct(a.pnl / start)} on ${fmtNum(start, 0)}${cur ? ` ${cur}` : ""}` : `${a.closed} closed trades`}</div>
          {!filtered && s.unrealized !== 0 && <div className="sub">Net {glyph(s.totalPnl)} {fmtMoney(s.totalPnl)} incl. {fmtMoney(s.unrealized)} on {s.openTrades} open</div>}
          <Spark values={a.cumulative.pnl} color={up ? gain : loss} />
        </Widget>
        <Widget title="Win rate" icon={<Percent size={15} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)", alignItems: "flex-start" }}>
            <Ring size={76} center={fmtPct(a.winRate, 0)} parts={[{ value: a.wins, color: gain, label: "wins" }, { value: a.breakeven, color: tok("--ink-4"), label: "breakeven" }, { value: a.losses, color: loss, label: "losses" }]} />
            <div className="sub nowrap"><span className="gain">▲ {a.wins}</span> · <span className="loss">▼ {a.losses}</span>{a.breakeven > 0 && <> · {a.breakeven} even</>}</div>
          </div>
        </Widget>
        <Widget title="Profit factor" icon={<GaugeIcon size={15} />}>
          <Gauge value={a.profitFactor} label="Profit factor" />
          <div className="sub nowrap" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{fmtMoney(a.grossWin, 0)} / {fmtMoney(a.grossLoss, 0)}</div>
        </Widget>
        <Widget title="Avg win / loss" icon={<Scale size={15} />}>
          <div className="big">{a.payoff === null ? DASH : fmtRatio(a.payoff)}<span className="muted" style={{ fontSize: "var(--fs-md)", fontWeight: 400 }}> payoff</span></div>
          <SignedBars compact items={[{ key: "w", label: "Win", value: a.avgWin }, { key: "l", label: "Loss", value: a.avgLoss }]} />
        </Widget>
        <Widget title="Expectancy" icon={<Target size={15} />}>
          <div className={`big ${a.expectancy >= 0 ? "gain" : "loss"}`}>{fmtMoney(a.expectancy)}</div>
          <div className="sub">per trade{a.avgR !== null ? ` · avg ${fmtR(a.avgR)} over ${a.rTrades}` : " · no stop, so no R"}</div>
        </Widget>
      </div>

      <div className="grid cols-3">
        <Widget title="Cumulative P&L" icon={<Activity size={15} />} className="span-2" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>scroll to zoom · drag to pan</span>}>
          <Chart height={262} label="Cumulative profit and loss over the filtered trades" deps={[a.cumulative, up]} build={() => chartBase({
            ...zoomOptions(a.cumulative.ts.length, 60),
            xAxis: { ...(chartBase().xAxis as object), type: "time" },
            series: [{ type: "line", showSymbol: false, smooth: 0.15, data: a.cumulative.ts.map((t, i) => [t, a.cumulative.pnl[i]]), lineStyle: { width: 2, color: up ? gain : loss }, itemStyle: { color: up ? gain : loss },
              areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: up ? gain : loss }, { offset: 1, color: "transparent" }] }, opacity: 0.18 },
              markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: tok("--axis"), type: "dashed" }, data: [{ yAxis: 0 }] } }],
            tooltip: { ...(chartBase().tooltip as object), formatter: (p: Array<{ dataIndex: number }>) => { const i = p[0]!.dataIndex, prev = i > 0 ? a.cumulative.pnl[i - 1]! : 0, v = a.cumulative.pnl[i]!; return tipHtml(fmtDay(a.cumulative.ts[i]!), { value: v, text: fmtMoney(v) }, [["Since previous point", `${glyph(v - prev)} ${fmtMoney(v - prev)}`]], "Running realised P&L of the filtered trades"); } },
          })} />
        </Widget>
        <Widget title="P&L per trade" icon={<Layers size={15} />} right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>click a bar to filter</span>}>
          <Chart height={262} label="Distribution of profit and loss per trade" deps={[H, filters.minPnl, filters.maxPnl]}
            onClick={(p) => { if (!H.edges.length) return; const r = binRange(H, p.dataIndex); setFilters(filters.minPnl === r.min && filters.maxPnl === r.max ? { minPnl: undefined, maxPnl: undefined } : { minPnl: r.min, maxPnl: r.max }); }}
            build={() => chartBase({
              xAxis: { ...(chartBase().xAxis as object), type: "category", data: H.counts.map((_, i) => fmtNum(mid(i), 0)), axisLabel: { color: tok("--ink-3"), fontSize: 10, interval: Math.max(0, Math.floor(H.counts.length / 5)) } },
              series: [{ type: "bar", barCategoryGap: "12%", data: H.counts.map((v, i) => ({ value: v, itemStyle: { color: mid(i) >= 0 ? gain : loss, borderRadius: [3, 3, 0, 0], opacity: filters.minPnl === undefined || filters.minPnl === H.edges[i] ? 1 : 0.35 } })) }],
              tooltip: { ...(chartBase().tooltip as object), axisPointer: { type: "shadow", shadowStyle: { color: tok("--hover") } }, formatter: (p: Array<{ dataIndex: number; value: number }>) => tipHtml(`${fmtMoney(H.edges[p[0]!.dataIndex]!, 0)} to ${fmtMoney(H.edges[p[0]!.dataIndex + 1]!, 0)}`, null, [["Trades", String(p[0]!.value)], ["Share", fmtPct(p[0]!.value / Math.max(1, a.closed), 0)]], "Click to filter to this range") },
            })} />
        </Widget>
      </div>

      <div className="grid cols-3">
        <Widget title="How trades ended" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>P&L by exit</span>}>
          {a.exit.length ? <SignedBars items={a.exit.map((e) => ({ key: e.reason, label: e.reason === "target" ? "Target hit" : e.reason === "stop" ? "Stop hit" : "Signal exit", value: e.pnl, count: e.trades }))} active={filters.exit ?? null} onPick={(k) => setFilters({ exit: filters.exit === k ? undefined : (k as never) })} /> : <div className="muted">No closed trades.</div>}
          <div className="hint muted" style={{ fontSize: "var(--fs-xs)" }}>Stop and target need a bracket on the entry. Everything else is a rule closing the trade.</div>
        </Widget>
        <Widget title="Long vs short">
          <SignedBars items={[{ key: "long", label: "Long", value: a.side.long.pnl, count: a.side.long.trades }, { key: "short", label: "Short", value: a.side.short.pnl, count: a.side.short.trades }]} active={filters.side ?? null} onPick={(k) => setFilters({ side: filters.side === k ? undefined : (k as never) })} />
          <Stat label="Long win rate" value={a.side.long.trades ? fmtPct(a.side.long.wins / a.side.long.trades, 0) : DASH} />
          <Stat label="Short win rate" value={a.side.short.trades ? fmtPct(a.side.short.wins / a.side.short.trades, 0) : DASH} />
        </Widget>
        <Widget title="Streaks and extremes">
          <Stat label="Best trade" value={fmtMoney(a.largestWin)} tone="gain" />
          <Stat label="Worst trade" value={fmtMoney(a.largestLoss)} tone="loss" />
          <Stat label="Longest winning streak" value={String(a.maxWinStreak)} />
          <Stat label="Longest losing streak" value={String(a.maxLossStreak)} />
          <Stat label="Average hold" value={fmtDur(a.avgHoldMs)} />
        </Widget>
      </div>

      {/* Futures and options only: a CFD run has neither a cost bridge nor venue closes, so nothing is added to its Overview. */}
      {(s.costs || a.venue) && (
        <div className="grid cols-3">
          {s.costs && (
            <Widget title="From P&L to cost" className="span-2" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>whole run · ignores filters</span>}>
              <div className="tbl-scroll"><table className="tbl">
                <thead><tr><th>Step</th><th className="r">Amount</th><th>What it is</th></tr></thead>
                <tbody>{costLines(s.costs).map((r) => (
                  <tr key={r.key} style={r.key === "pnl" || r.key === "preCost" ? { fontWeight: 600 } : undefined}>
                    <td>{r.key === "pnl" ? "Net P&L" : r.key === "preCost" ? "= Before costs" : `+ ${r.label}`}</td>
                    <td className={`r num ${r.key === "pnl" || r.key === "preCost" ? (r.value >= 0 ? "gain" : "loss") : ""}`}>{r.key === "pnl" || r.key === "preCost" ? fmtMoney(r.value) : fmtNum(r.value, 2)}</td>
                    <td className="muted">{r.key === "pnl" ? "what the account made" : r.key === "preCost" ? "what the same trades make with no costs" : r.note}</td></tr>
                ))}</tbody>
              </table></div>
              <div className="hint muted" style={{ fontSize: "var(--fs-xs)" }}>Costs are added back to net P&L to show what the strategy makes before the market takes its share. Rolls and funding are booked outside the fills, so they appear here and in Futures &amp; options.</div>
            </Widget>
          )}
          {a.venue && (
            <Widget title="Closed by the venue" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>P&L by cause</span>}>
              <SignedBars items={a.venue.map((e) => ({ key: e.reason, label: { expiry: "Expiry settlement", liquidation: "Liquidation", roll_failed: "Roll failed" }[e.reason], value: e.pnl, count: e.trades }))} active={filters.venueExit ?? null}
                onPick={(k) => setFilters({ venueExit: filters.venueExit === k ? undefined : (k as NonNullable<typeof filters.venueExit>), exit: undefined })} />
              <div className="hint muted" style={{ fontSize: "var(--fs-xs)" }}>These trades also count in How trades ended: the exchange closed them, not a rule or an order.</div>
            </Widget>
          )}
        </div>
      )}

      <Widget title="Engine metrics" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>whole run · ignores filters</span>}>
        <div className="grid cols-4" style={{ gap: "var(--s2) var(--s5)" }}>
          <Stat label="Sharpe" value={fmtRatio(s.sharpe)} /><Stat label="Sortino" value={fmtRatio(s.sortino)} /><Stat label="Calmar" value={fmtRatio(s.calmar)} /><Stat label="Max drawdown" value={fmtPct(s.maxDrawdown)} tone="loss" />
          <Stat label="Max daily drawdown" value={fmtPct(s.maxDailyDrawdown)} tone="loss" /><Stat label="Engine profit factor" value={fmtRatio(s.engineProfitFactor)} /><Stat label="Fills" value={String(s.fills)} /><Stat label="Unrealised P&L" value={fmtMoney(s.unrealized)} />
        </div>
      </Widget>
    </div>
  );
}
