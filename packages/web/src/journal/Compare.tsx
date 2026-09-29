import { useEffect, useState } from "react";
import { api, type Equity } from "../api/client.js";
import type { Summary } from "../api/types.js";
import { useStore } from "../state/store.js";
import { DASH, fmtMoney, fmtNum, fmtPct, fmtRatio, glyph } from "../util/format.js";
import { Chart, chartBase, Widget, tok } from "./widgets.js";

const SERIES = ["--s1c", "--s2c", "--s3c", "--s4c"];

export function Compare() {
  const runs = useStore((s) => s.runs), compare = useStore((s) => s.compare), toggle = useStore((s) => s.toggleCompare);
  const [data, setData] = useState<Record<string, { eq: Equity; s: Summary }>>({});
  useEffect(() => {
    let live = true;
    for (const id of compare) if (!data[id]) Promise.all([api.equity(id), api.summary(id)]).then(([eq, s]) => live && setData((d) => ({ ...d, [id]: { eq, s } }))).catch(() => undefined);
    return () => { live = false; };
  }, [compare]);
  const label = (id: string) => { const r = runs.find((x) => x.id === id); return r ? `${r.strategy.replace(/^strategies\//, "").replace(/\.qkt$/, "")} · ${r.from_d}→${r.to_d} · ${r.tier === "full" ? "ticks" : "bars"}` : id; };
  const cmp = compare.filter((id) => data[id]);
  const done = runs.filter((r) => r.status === "done");

  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      <Widget title="Choose runs to compare" right={<span className="muted">up to 4</span>}>
        {done.length === 0 && <div className="muted">No finished runs yet.</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
          {done.slice(0, 40).map((r) => <button key={r.id} className="chip" aria-pressed={compare.includes(r.id)} onClick={() => toggle(r.id)}>{label(r.id)}</button>)}
        </div>
      </Widget>
      {cmp.length >= 2 ? (
        <>
          <Widget title="Equity, aligned to each run's start">
            <Chart height={260} label="Equity curves of the selected runs" deps={[cmp.join(",")]} build={() => chartBase({
              xAxis: { ...(chartBase().xAxis as object), type: "value", axisLabel: { color: tok("--ink-3"), formatter: (v: number) => `${v.toFixed(0)}d` } },
              series: cmp.map((id, i) => { const d = data[id]!, t0 = d.eq.ts[0] ?? 0; return { name: id, type: "line", showSymbol: false, lineStyle: { width: 2, color: tok(SERIES[i]!) }, itemStyle: { color: tok(SERIES[i]!) }, data: d.eq.ts.map((t, k) => [(t - t0) / 86_400_000, d.eq.equity[k]]), endLabel: { show: true, formatter: String.fromCharCode(65 + i), color: tok("--ink") } }; }),
            })} />
            <div className="legend">{cmp.map((id, i) => <span key={id}><i style={{ background: tok(SERIES[i]!) }} /><b>{String.fromCharCode(65 + i)}</b> {label(id)}</span>)}</div>
          </Widget>
          <Widget title="Metrics" className="flush" style={{ padding: 0 }}>
            <table className="tbl"><thead><tr><th><span className="sr-only">Run</span></th><th className="r">Net P&L</th><th className="r">Sharpe</th><th className="r">Profit factor</th><th className="r">Win rate</th><th className="r">Trades</th><th className="r">Max DD</th></tr></thead>
              <tbody>{cmp.map((id, i) => {
                const s = data[id]!.s, b = data[cmp[0]!]!.s;
                const dlt = (x: number | null, y: number | null, f: (v: number) => string) => (i === 0 || x === null || y === null ? "" : ` (${x - y >= 0 ? "+" : "−"}${f(Math.abs(x - y))})`);
                return (
                  <tr key={id}><td><b>{String.fromCharCode(65 + i)}</b></td>
                    <td className="r num">{glyph(s.totalPnl)} {fmtMoney(s.totalPnl)}<span className="muted">{dlt(s.totalPnl, b.totalPnl, (v) => fmtNum(v))}</span></td>
                    <td className="r num">{fmtRatio(s.sharpe)}<span className="muted">{dlt(s.sharpe, b.sharpe, (v) => v.toFixed(2))}</span></td>
                    <td className="r num">{s.profitFactor === null ? DASH : fmtRatio(s.profitFactor)}</td><td className="r num">{fmtPct(s.winRate, 1)}</td><td className="r num">{s.trades}</td><td className="r num">{fmtPct(s.maxDrawdown, 1)}</td></tr>);
              })}</tbody></table>
          </Widget>
        </>
      ) : <div className="empty"><b>Pick two or more runs above.</b>Compare bars against ticks, or two versions of a strategy, on one chart.</div>}
    </div>
  );
}
