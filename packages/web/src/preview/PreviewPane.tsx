import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { Tip } from "../ui/Tip.js";
import { DASH, fmtMoney, fmtNum, fmtPct, fmtRatio, glyph, fmtWindow } from "../util/format.js";
import { ChartColumn, CircleCheck, TriangleAlert } from "../ui/icons.js";
import { PaneControls } from "../ui/PaneControls.js";
import { ChartsBody } from "./Charts.js";

/** `d`: the change against the previous run of this strategy, with `better` saying whether it went the good way. */
function Kpi({ l, v, s, tone, d, onClick }: { l: string; v: string; s?: string; tone?: "gain" | "loss"; d?: { text: string; better: boolean | null } | null; onClick(): void }) {
  return (
    <button className="pkpi" onClick={onClick} title="Open in the Journal">
      <span className="l">{l}</span>
      <span className="kvrow"><span className={`v ${tone ?? ""}`}>{v}</span>{d && <span className={`kd ${d.better === null ? "" : d.better ? "up" : "down"}`} title="Change since your previous run of this strategy">{d.text}</span>}</span>
      {s && <span className="s" title={s}>{s}</span>}
    </button>
  );
}

/** The chart pane: headline numbers, the charts and the trade list. Click any number to open the Journal on it. */
export function PreviewPane({ maxed, onMax }: { maxed: boolean; onMax(): void }) {
  const ui = useUi();
  const results = useStore((s) => s.results), stale = useStore((s) => s.resultsStale), run = useStore((s) => s.run), running = useStore((s) => s.running);
  const s = results?.summary, meta = results?.meta;
  const failed = results?.integrity.checks.filter((c) => c.ok === false && !c.soft) ?? [];
  const soft = results?.integrity.checks.filter((c) => c.ok === false && c.soft) ?? [];
  const start = results?.equity.equity[0] ?? 0, cur = results?.meta.currency ?? undefined;
  const open = (sec: "overview" | "trades" | "monthly" = "overview") => ui.openJournal(sec);
  const prev = useStore((st) => st.previous)?.summary ?? null;
  const autoSkipped = useStore((st) => st.autoSkipped);
  // change since the previous run of this strategy: the answer to "did my edit help?"
  const delta = (cur: number | null, was: number | null | undefined, fmt: (x: number) => string, higherIsBetter: boolean) => {
    if (!prev || stale || cur === null || was === null || was === undefined || !Number.isFinite(cur) || !Number.isFinite(was)) return null;
    const dx = cur - was;
    if (Math.abs(dx) < 1e-9) return { text: "no change", better: null };
    return { text: `${dx > 0 ? "▲" : "▼"} ${fmt(Math.abs(dx))}`, better: higherIsBetter ? dx > 0 : dx < 0 };
  };

  return (
    <section className="pane grow" aria-label="Chart" style={{ flex: "1 1 0" }}>
      <div className="pane-head">
        <h3>Chart</h3>
        {meta && <span className={`badge ${meta.tier === "full" ? "accent" : ""}`}>{meta.tier === "full" ? "Ticks" : "Bars"}</span>}
        {results && (failed.length ? <span className="badge bad" title={failed.map((c) => c.detail).join("\n")}><TriangleAlert size={12} />integrity</span>
          : soft.length ? <Tip label="Some fills fall outside their bar: expected on bars for stops and targets. Verify on ticks." side="bottom"><span className="badge warn"><TriangleAlert size={12} />approximate</span></Tip>
          : <span className="badge ok"><CircleCheck size={12} />matches engine</span>)}
        {meta && <span className="muted hide-md nowrap" style={{ fontSize: "var(--fs-xs)" }} title={`Run window [${meta.from}, ${meta.to}) UTC`}>{fmtWindow(meta.from, meta.to)}</span>}
        {stale && <span className="badge warn">previous run</span>}
        <span className="grow" style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => open()} disabled={!results}><ChartColumn size={14} />Journal</button>
        <PaneControls pane="chart" />
      </div>
      {s && (
        <div className={`preview-kpis${stale ? " dim" : ""}`}>
          <Kpi l="Net P&L" v={`${glyph(s.totalPnl)} ${fmtMoney(s.totalPnl)}`} s={[start ? `${fmtPct(s.totalPnl / start)} on ${fmtNum(start, 0)}${cur ? ` ${cur}` : ""}` : cur ?? "", s.unrealized !== 0 ? `incl. ${fmtMoney(s.unrealized)} open` : ""].filter(Boolean).join(" · ") || undefined} tone={s.totalPnl >= 0 ? "gain" : "loss"} d={delta(s.totalPnl, prev?.totalPnl, (x) => fmtMoney(x).replace("+", ""), true)} onClick={() => open()} />
          <Kpi l="Win rate" v={s.trades ? fmtPct(s.winRate, 1) : DASH} s={`${s.wins}W · ${s.losses}L`} d={delta(s.trades ? s.winRate * 100 : null, prev?.trades ? prev.winRate * 100 : null, (x) => `${x.toFixed(1)} pts`, true)} onClick={() => open("trades")} />
          <Kpi l="Profit factor" v={s.profitFactor === null ? DASH : fmtRatio(s.profitFactor)} d={delta(s.profitFactor, prev?.profitFactor, (x) => x.toFixed(2), true)} s={s.blown ? "Sharpe: account blown" : `Sharpe ${fmtRatio(s.sharpe)}`} onClick={() => open()} />
          <Kpi l="Trades" v={String(s.trades)} d={delta(s.trades, prev?.trades, (x) => String(x), true) && { ...delta(s.trades, prev?.trades, (x) => String(x), true)!, better: null }} s={`${s.fills} fills${s.openTrades ? ` · ${s.openTrades} open` : ""}`} onClick={() => open("trades")} />
          <Kpi l="Max drawdown" v={fmtPct(s.maxDrawdown)} d={delta(Math.abs(s.maxDrawdown) * 100, prev ? Math.abs(prev.maxDrawdown) * 100 : null, (x) => `${x.toFixed(2)} pts`, false)} s={`expectancy ${fmtMoney(s.expectancy)}`} tone="loss" onClick={() => open("monthly")} />
        </div>
      )}
      {stale && !running && run && (run.status === "failed" || run.status === "cancelled") && (
        <div className="banner bad rejections" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>
          <b>{run.status === "failed" ? "The latest run failed" : "The latest run was stopped"}</b>{run.error?.message && run.status === "failed" ? `: ${run.error.message}` : "."}{" "}
          What you see is the previous run{results?.strategy ? ` of ${results.strategy.split("/").pop()}` : ""}, from before your last change. The Pipeline panel has the details.
        </span></div>
      )}
      {s?.blown && !stale && <div className="banner bad rejections" role="status"><TriangleAlert size={14} aria-hidden="true" /><span><b>The account went below zero in this run</b> (max drawdown {fmtPct(s.maxDrawdown, 0)}): it lost more than the starting balance, so Sharpe, Sortino and Calmar mean nothing here and are not shown. Trade a smaller size or raise the starting balance.</span></div>}
      {autoSkipped && <div className="banner warn rejections" role="status"><TriangleAlert size={14} aria-hidden="true" /><span><b>{autoSkipped}</b>. The results below are from the last version that ran; saving a fix runs it again.</span></div>}
      {meta?.rejections && meta.rejections.count > 0 && !stale && (() => {
        const rj = meta.rejections, top = rj.reasons[0]!, all = s ? s.fills === 0 : false;
        return (
          <div className="banner warn rejections" role="status" title={rj.reasons.map((x) => `${x.count.toLocaleString()} × ${x.example}`).join("\n")}>
            <TriangleAlert size={14} aria-hidden="true" />
            <span><b>qkt rejected {rj.count.toLocaleString()} order{rj.count === 1 ? "" : "s"}{all ? ", so this run made no trades" : ""}</b>
              {" "}· {rj.reasons.slice(0, 2).map((x) => `${x.count.toLocaleString()} × ${x.label}`).join(", ")}{rj.reasons.length > 2 ? ", …" : ""}
              {top.hint && <span className="ink2">. {top.hint}</span>}
              {" "}<button className="link" onClick={() => void useStore.getState().openFile("qkt.config.yaml")}>Open qkt.config.yaml</button></span>
          </div>
        );
      })()}
      <ChartsBody onOpenJournal={() => open()} />
      <span hidden>{run?.id}</span>
    </section>
  );
}
