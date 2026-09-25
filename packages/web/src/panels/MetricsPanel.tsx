import { baseOption, EChart, tok } from "../charts/EChart.js";
import type { MonthRow, Summary } from "../api/types.js";
import { useStore } from "../state/store.js";
import { DASH, fmtDur, fmtMoney, fmtNum, fmtPct, fmtRatio, glyph, polarity } from "../util/format.js";

function Kpi({ l, v, s, tone, title }: { l: string; v: string; s?: string; tone?: "gain" | "loss" | ""; title?: string }) {
  return <div className="kpi" title={title}><div className="l">{l}</div><div className={`v ${tone ?? ""}`}>{v}</div>{s && <div className="s">{s}</div>}</div>;
}

const tone = (n: number) => (polarity(n) === "gain" ? "gain" : polarity(n) === "loss" ? "loss" : "");

/** Year x month grid, diverging blue<->red on realised P&L. Values are printed, so colour is never the only channel. */
function MonthlyGrid({ rows }: { rows: MonthRow[] }) {
  if (!rows.length) return <div className="empty">No closed trades to aggregate.</div>;
  const years = [...new Set(rows.map((r) => r.month.slice(0, 4)))];
  const by = new Map(rows.map((r) => [r.month, r]));
  const max = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);
  const mid = tok("--mid");
  const shade = (p: number) => {
    const a = Math.min(1, Math.abs(p) / max);
    return `color-mix(in srgb, ${p >= 0 ? tok("--gain") : tok("--loss")} ${Math.round(12 + a * 58)}%, ${mid})`;
  };
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    <table className="grid" style={{ tableLayout: "fixed" }} aria-label="Monthly realised P&L by exit month">
      <thead><tr><th style={{ width: 44 }} />{months.map((m) => <th key={m} style={{ textAlign: "center", padding: "3px 2px", fontSize: 11 }}>{m}</th>)}</tr></thead>
      <tbody>
        {years.map((y) => (
          <tr key={y}>
            <td className="muted">{y}</td>
            {months.map((_, i) => {
              const r = by.get(`${y}-${String(i + 1).padStart(2, "0")}`);
              return <td key={i} className="num" title={r ? `${y}-${String(i + 1).padStart(2, "0")}: ${fmtMoney(r.pnl)} over ${r.trades} trade(s)` : ""}
                style={{ background: r ? shade(r.pnl) : "transparent", textAlign: "center", padding: "4px 1px", fontSize: 11 }}>{r ? `${glyph(r.pnl)}${fmtNum(Math.abs(r.pnl), 0)}` : ""}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function kpis(s: Summary, start: number) {
  const ret = start ? s.totalPnl / start : NaN;
  return [
    <Kpi key="np" l="Net P&L" v={`${glyph(s.totalPnl)} ${fmtMoney(s.totalPnl)}`} s={`realised ${fmtMoney(s.realized)}`} tone={tone(s.totalPnl)} title="Realised plus unrealised P&L at the end of the window" />,
    <Kpi key="ret" l="Return" v={fmtPct(ret)} s={`on ${fmtNum(start, 0)}`} tone={tone(ret)} />,
    <Kpi key="sh" l="Sharpe" v={fmtRatio(s.sharpe)} title="Engine-computed" />,
    <Kpi key="so" l="Sortino" v={fmtRatio(s.sortino)} />,
    <Kpi key="ca" l="Calmar" v={fmtRatio(s.calmar)} />,
    <Kpi key="pf" l="Profit factor" v={s.profitFactor === null ? DASH : fmtRatio(s.profitFactor)} s={`engine ${fmtRatio(s.engineProfitFactor)}`} />,
    <Kpi key="wr" l="Win rate" v={fmtPct(s.winRate, 1)} s={`${s.wins}W / ${s.losses}L`} title="Per closed round trip" />,
    <Kpi key="tr" l="Trades" v={String(s.trades)} s={`${s.fills} fills${s.openTrades ? ` · ${s.openTrades} open` : ""}`} title="Closed round trips. qkt's own tradeCount counts fills." />,
    <Kpi key="dd" l="Max drawdown" v={fmtPct(s.maxDrawdown)} s={`daily ${fmtPct(s.maxDailyDrawdown)}`} tone="loss" />,
    <Kpi key="ex" l="Expectancy" v={fmtMoney(s.expectancy)} s="per trade" tone={tone(s.expectancy)} />,
    <Kpi key="aw" l="Avg win" v={fmtMoney(s.avgWin)} s={`best ${fmtMoney(s.largestWin)}`} tone="gain" />,
    <Kpi key="al" l="Avg loss" v={fmtMoney(s.avgLoss)} s={`worst ${fmtMoney(s.largestLoss)}`} tone="loss" />,
    <Kpi key="ah" l="Avg hold" v={fmtDur(s.avgHoldMs)} s={`max losing run ${s.maxConsecutiveLosses}`} />,
    <Kpi key="lg" l="Long" v={`${s.long.trades}`} s={`${fmtMoney(s.long.pnl)} · ${fmtPct(s.long.winRate, 0)} win`} />,
    <Kpi key="sg" l="Short" v={`${s.short.trades}`} s={`${fmtMoney(s.short.pnl)} · ${fmtPct(s.short.winRate, 0)} win`} />,
    <Kpi key="un" l="Unrealised" v={fmtMoney(s.unrealized)} s={`costs ${fmtMoney(-(s.commission + s.swap))}`} tone={tone(s.unrealized)} />,
  ];
}

export function MetricsPanel() {
  const { results, resultsStale, running, run } = useStore();
  if (!results) return <div className="panel"><div className="panel-head"><span className="title">Metrics</span></div><div className="empty">{running ? <b>Running…</b> : run?.status === "failed" ? <><b>No results: the run failed.</b></> : <><b>No results yet.</b><br />Sharpe, profit factor, drawdown, monthly P&L and the equity curve appear here.</>}</div></div>;
  const { summary: s, equity, monthly, integrity, meta } = results;
  const start = equity.equity[0] ?? 0;
  const ts = equity.ts;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Results</span>
        <span className={`badge ${meta.tier}`}>{meta.tier === "draft" ? "Draft · bars" : "Full · ticks"}</span>
        <span className="muted">qkt {meta.qktVersion}</span>
        <span className="grow" />
        {resultsStale && <span className="badge warn">showing previous run</span>}
      </div>
      <div className={`panel-scroll${resultsStale ? " dim" : ""}`}>
        <div className="kpis">{kpis(s, start)}</div>

        <div className="section">
          <h4>Equity</h4>
          <EChart height={190} deps={[results.runId]} testId="equity-chart" build={() => baseOption({
            xAxis: { ...baseOption().xAxis as object, type: "time" },
            series: [{ type: "line", showSymbol: false, sampling: "lttb", lineStyle: { width: 2, color: tok("--series-1") }, itemStyle: { color: tok("--series-1") }, data: ts.map((t, i) => [t, equity.equity[i]]),
              markLine: { silent: true, symbol: "none", lineStyle: { color: tok("--axis"), type: "dashed" }, label: { show: false }, data: [{ yAxis: start }] } }],
            tooltip: { ...baseOption().tooltip as object, valueFormatter: (v: number) => fmtNum(v) },
          })} />
          <div className="legend"><span><i style={{ background: tok("--series-1") }} />Account equity</span><span className="muted">dashed: starting balance</span></div>
        </div>

        <div className="section">
          <h4>Drawdown</h4>
          <EChart height={110} deps={[results.runId]} testId="drawdown-chart" build={() => baseOption({
            grid: { left: 52, right: 12, top: 8, bottom: 22 },
            xAxis: { ...baseOption().xAxis as object, type: "time" },
            yAxis: { ...baseOption().yAxis as object, max: 0, axisLabel: { color: tok("--ink-3"), fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
            series: [{ type: "line", showSymbol: false, lineStyle: { width: 1.5, color: tok("--loss") }, areaStyle: { color: tok("--loss"), opacity: 0.18 }, data: ts.map((t, i) => [t, equity.drawdown[i]]) }],
            tooltip: { ...baseOption().tooltip as object, valueFormatter: (v: number) => fmtPct(v) },
          })} />
        </div>

        <div className="section"><h4>Monthly realised P&L (by exit month)</h4><div style={{ padding: "0 8px 8px" }}><MonthlyGrid rows={monthly} /></div></div>

        <div className="section">
          <h4>Integrity</h4>
          <div style={{ padding: "0 10px 8px" }}>
            {integrity.checks.map((c) => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "16px 1fr", gap: 6, padding: "2px 0" }} title={c.detail}>
                <span style={{ color: c.ok === null ? "var(--ink-3)" : c.ok ? "var(--ok)" : c.soft ? "var(--warn)" : "var(--bad)" }}>{c.ok === null ? "–" : c.ok ? "✓" : c.soft ? "!" : "✕"}</span>
                <span><span className="ink2">{c.label}</span><br /><span className="muted" style={{ fontSize: 11.5 }}>{c.detail}</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
