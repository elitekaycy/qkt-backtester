import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { Tip } from "../ui/Tip.js";
import { DASH, fmtMoney, fmtNum, fmtPct, fmtRatio, glyph } from "../util/format.js";
import { ChartColumn, CircleCheck, TriangleAlert } from "../ui/icons.js";
import { PaneControls } from "../ui/PaneControls.js";
import { ChartsBody } from "./Charts.js";

function Kpi({ l, v, s, tone, onClick }: { l: string; v: string; s?: string; tone?: "gain" | "loss"; onClick(): void }) {
  return <button className="pkpi" onClick={onClick} title="Open in the Journal"><span className="l">{l}</span><span className={`v ${tone ?? ""}`}>{v}</span>{s && <span className="s">{s}</span>}</button>;
}

/** The chart pane: headline numbers, the charts and the trade list. Click any number to open the Journal on it. */
export function PreviewPane({ maxed, onMax }: { maxed: boolean; onMax(): void }) {
  const ui = useUi();
  const results = useStore((s) => s.results), stale = useStore((s) => s.resultsStale), run = useStore((s) => s.run);
  const s = results?.summary, meta = results?.meta;
  const failed = results?.integrity.checks.filter((c) => c.ok === false && !c.soft) ?? [];
  const soft = results?.integrity.checks.filter((c) => c.ok === false && c.soft) ?? [];
  const start = results?.equity.equity[0] ?? 0;
  const open = (sec: "overview" | "trades" | "monthly" = "overview") => ui.openJournal(sec);

  return (
    <section className="pane grow" aria-label="Chart" style={{ flex: "1 1 0" }}>
      <div className="pane-head">
        <h3>Chart</h3>
        {meta && <span className={`badge ${meta.tier === "full" ? "accent" : ""}`}>{meta.tier === "full" ? "Ticks" : "Bars"}</span>}
        {results && (failed.length ? <span className="badge bad" title={failed.map((c) => c.detail).join("\n")}><TriangleAlert size={12} />integrity</span>
          : soft.length ? <Tip label="Some fills fall outside their bar: expected on bars for stops and targets. Verify on ticks." side="bottom"><span className="badge warn"><TriangleAlert size={12} />approximate</span></Tip>
          : <span className="badge ok"><CircleCheck size={12} />matches engine</span>)}
        {meta && <span className="muted hide-md" style={{ fontSize: "var(--fs-xs)" }}>{meta.from} → {meta.to}</span>}
        {stale && <span className="badge warn">previous run</span>}
        <span className="grow" style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => open()} disabled={!results}><ChartColumn size={14} />Journal</button>
        <PaneControls pane="chart" />
      </div>
      {s && (
        <div className={`preview-kpis${stale ? " dim" : ""}`}>
          <Kpi l="Net P&L" v={`${glyph(s.totalPnl)} ${fmtMoney(s.totalPnl)}`} s={start ? `${fmtPct(s.totalPnl / start)} on ${fmtNum(start, 0)}` : undefined} tone={s.totalPnl >= 0 ? "gain" : "loss"} onClick={() => open()} />
          <Kpi l="Win rate" v={fmtPct(s.winRate, 1)} s={`${s.wins}W · ${s.losses}L`} onClick={() => open("trades")} />
          <Kpi l="Profit factor" v={s.profitFactor === null ? DASH : fmtRatio(s.profitFactor)} s={`Sharpe ${fmtRatio(s.sharpe)}`} onClick={() => open()} />
          <Kpi l="Trades" v={String(s.trades)} s={`${s.fills} fills${s.openTrades ? ` · ${s.openTrades} open` : ""}`} onClick={() => open("trades")} />
          <Kpi l="Max drawdown" v={fmtPct(s.maxDrawdown)} s={`expectancy ${fmtMoney(s.expectancy)}`} tone="loss" onClick={() => open("monthly")} />
        </div>
      )}
      <ChartsBody onOpenJournal={() => open()} />
      <span hidden>{run?.id}</span>
    </section>
  );
}
