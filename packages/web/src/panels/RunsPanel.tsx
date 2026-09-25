import { useEffect, useState } from "react";
import { api, type Equity, type RunRow } from "../api/client.js";
import type { Summary } from "../api/types.js";
import { baseOption, EChart, tok } from "../charts/EChart.js";
import { useStore } from "../state/store.js";
import { DASH, fmtDur, fmtMoney, fmtNum, fmtPct, fmtRatio, fmtTs, glyph } from "../util/format.js";

const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4"];

export function RunsPanel() {
  const { runs, runId } = useStore();
  const store = useStore.getState;
  const [picked, setPicked] = useState<string[]>([]);
  const [data, setData] = useState<Record<string, { eq: Equity; s: Summary }>>({});
  useEffect(() => { void store().refreshRuns(); }, []);
  useEffect(() => {
    let live = true;
    for (const id of picked) if (!data[id]) Promise.all([api.equity(id), api.summary(id)]).then(([eq, s]) => live && setData((d) => ({ ...d, [id]: { eq, s } }))).catch(() => undefined);
    return () => { live = false; };
  }, [picked]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-4)));
  const label = (r: RunRow) => `${r.strategy.replace(/^strategies\//, "").replace(/\.qkt$/, "")} · ${r.from_d}→${r.to_d}`;
  const cmp = picked.filter((id) => data[id]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Run history</span><span className="badge">{runs.length}</span>
        <span className="muted">Tick up to 4 runs to compare.</span><span className="grow" />
        <button className="btn sm" onClick={() => void store().refreshRuns()}>Refresh</button>
      </div>
      <div className="panel-scroll">
        {cmp.length >= 2 && (
          <div className="section">
            <h4>Comparison</h4>
            <EChart height={170} deps={[cmp.join(",")]} testId="compare-chart" build={() => baseOption({
              xAxis: { ...baseOption().xAxis as object, type: "value", axisLabel: { show: false } },
              tooltip: { ...baseOption().tooltip as object, trigger: "axis" },
              series: cmp.map((id, i) => {
                const d = data[id]!, t0 = d.eq.ts[0] ?? 0;
                return { name: id, type: "line", showSymbol: false, lineStyle: { width: 2, color: tok(SERIES[i]!) }, itemStyle: { color: tok(SERIES[i]!) }, data: d.eq.ts.map((t, k) => [(t - t0) / 86_400_000, d.eq.equity[k]]),
                  endLabel: { show: true, formatter: `${String.fromCharCode(65 + i)}`, color: tok("--ink") } };
              }),
            })} />
            <div className="legend">{cmp.map((id, i) => <span key={id}><i style={{ background: tok(SERIES[i]!) }} /><b>{String.fromCharCode(65 + i)}</b> {label(runs.find((r) => r.id === id)!)}</span>)}<span className="muted">x: days since each run's start</span></div>
            <table className="grid">
              <thead><tr><th /><th className="num">Net P&L</th><th className="num">Sharpe</th><th className="num">PF</th><th className="num">Win rate</th><th className="num">Trades</th><th className="num">Max DD</th></tr></thead>
              <tbody>{cmp.map((id, i) => { const s = data[id]!.s, b = data[cmp[0]!]!.s; const d = (a: number, c: number, f: (v: number) => string) => i === 0 ? "" : ` (${a - c >= 0 ? "+" : "−"}${f(Math.abs(a - c))})`;
                return <tr key={id}><td><b>{String.fromCharCode(65 + i)}</b></td>
                  <td className="num">{glyph(s.totalPnl)} {fmtMoney(s.totalPnl)}<span className="muted">{d(s.totalPnl, b.totalPnl, (v) => fmtNum(v))}</span></td>
                  <td className="num">{fmtRatio(s.sharpe)}<span className="muted">{d(s.sharpe, b.sharpe, (v) => v.toFixed(2))}</span></td>
                  <td className="num">{s.profitFactor === null ? DASH : fmtRatio(s.profitFactor)}</td><td className="num">{fmtPct(s.winRate, 1)}</td><td className="num">{s.trades}</td><td className="num">{fmtPct(s.maxDrawdown, 1)}</td></tr>; })}</tbody>
            </table>
          </div>
        )}
        {runs.length === 0 && <div className="empty"><b>No runs yet.</b></div>}
        <table className="grid">
          <thead><tr><th style={{ width: 24 }} /><th>Started (UTC)</th><th>Strategy</th><th>Tier</th><th>Window</th><th>Status</th><th className="num">Trades</th><th className="num">Net P&L</th><th className="num">Sharpe</th><th className="num">Took</th><th /></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={`click${r.id === runId ? " sel" : ""}`} onClick={() => void store().selectRun(r.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" disabled={r.status !== "done"} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} aria-label="compare" /></td>
                <td className="mono">{fmtTs(Date.parse(r.created_at))}</td>
                <td>{label(r).split(" · ")[0]}</td>
                <td><span className={`badge ${r.tier}`}>{r.tier}</span></td>
                <td className="mono muted">{r.from_d} → {r.to_d}</td>
                <td><span className={`badge ${r.status === "done" ? "ok" : r.status === "failed" ? "bad" : ""}`}>{r.status}</span></td>
                <td className="num">{r.trades ?? DASH}</td>
                <td className={`num ${(r.total_pnl ?? 0) >= 0 ? "gain" : "loss"}`}>{r.total_pnl === null ? DASH : `${glyph(r.total_pnl)} ${fmtMoney(r.total_pnl)}`}</td>
                <td className="num">{r.sharpe === null ? DASH : fmtRatio(r.sharpe)}</td>
                <td className="num muted">{r.duration_ms ? fmtDur(r.duration_ms) : DASH}</td>
                <td onClick={(e) => e.stopPropagation()}><button className="btn ghost sm" title="Delete this run and its files" onClick={() => { if (window.confirm("Delete this run and all of its files?")) void api.deleteRun(r.id).then(() => { setPicked((p) => p.filter((x) => x !== r.id)); return store().refreshRuns(); }); }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
