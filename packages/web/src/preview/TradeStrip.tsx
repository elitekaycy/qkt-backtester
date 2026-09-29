import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { strategyAlias } from "@qkt-studio/core/strategy";
import type { RoundTrip } from "../api/types.js";
import { fmtDur, fmtR, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtTs } from "../util/format.js";
import { strategyColor } from "../util/strategyColor.js";

const EXIT_LABEL: Record<string, string> = { target: "◆ Target hit", stop: "✕ Stop hit", signal: "● Rule exit", open: "Still open" };

const NO_LEVEL = "None was recorded on this trade's entry fill. Strategies without a BRACKET (or with only rule-based exits) have no stop or target.";
/** One level, or, for a trade that scaled in with different levels on each entry, how many distinct ones. */
function levels(t: RoundTrip, k: "sl" | "tp"): React.ReactNode {
  const distinct = [...new Set((t.entries ?? []).map((e) => e[k]).filter((v): v is number => v !== undefined))];
  if (distinct.length > 1) return <span className={`num ${k === "sl" ? "loss" : "gain"}`}>{distinct.length} levels</span>;
  const v = t[k];
  return v === undefined ? <span className="muted">none</span> : <span className={`num ${k === "sl" ? "loss" : "gain"}`}>{fmtPrice(v)}</span>;
}

function Field({ l, v, tone, title, wide }: { l: string; v: React.ReactNode; tone?: "gain" | "loss"; title?: string; wide?: boolean }) {
  return <div className={`tf${wide ? " wide" : ""}`} title={title}><span className="l">{l}</span><span className={`v ${tone ?? ""}`}>{v}</span></div>;
}

/** The selected trade in plain numbers: everything an analyst needs to explain the entry, the risk and the exit. */
export function TradeStrip({ trip: t, index, count, startBalance, multi, onPrev, onNext, onClose }: { trip: RoundTrip | null; index: number; count: number; startBalance: number; multi?: boolean; onPrev(): void; onNext(): void; onClose(): void }) {
  if (!t) return <div className="trade-strip empty-strip"><span className="muted">Click an entry marker or a trade box, or use ◀ ▶ to walk through the trades one by one.</span><span className="legend" aria-label="Legend"><span>▲ long entry</span><span>▼ short entry</span><span>◆ target</span><span>■✕ stop</span><span>● rule exit</span></span></div>;
  const long = t.side === "long";
  const rr = t.sl !== undefined && t.tp !== undefined && t.entryPx !== t.sl ? Math.abs(t.tp - t.entryPx) / Math.abs(t.entryPx - t.sl) : null;
  const tone = t.pnl > 0 ? "gain" : t.pnl < 0 ? "loss" : undefined;
  return (
    <div className="trade-strip" role="group" aria-label="Selected trade">
      <div className="head">
        <b className="side">{long ? "▲ Long" : "▼ Short"}</b><span className="ink2">{t.symbol.split(":").pop()}</span>
        {multi && <span className="badge" style={{ color: strategyColor(t.strategy) }}>{strategyAlias(t.strategy)}</span>}
        <span className="muted">{index >= 0 ? `trade ${index + 1} of ${count}` : `trade #${t.id}`}</span>
        <span className={`badge ${t.exit === "target" ? "ok" : t.exit === "stop" ? "bad" : ""}`}>{EXIT_LABEL[t.open ? "open" : t.exit] ?? t.exit}</span>
        <span className="grow" />
        <button className="btn ghost icon sm" aria-label="Previous trade" onClick={onPrev}><ChevronLeft size={15} /></button>
        <button className="btn ghost icon sm" aria-label="Next trade" onClick={onNext}><ChevronRight size={15} /></button>
        <button className="btn ghost icon sm" aria-label="Deselect trade" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="fields">
        <Field wide l="Entry" v={<><span className="num">{fmtPrice(t.entryPx)}</span> <span className="muted">{fmtTs(t.entryTs)}</span></>} />
        <Field wide l="Exit" v={t.open ? "open" : <><span className="num">{fmtPrice(t.exitPx)}</span> <span className="muted">{fmtTs(t.exitTs)}</span></>} />
        <Field l="Held" v={t.open ? "—" : fmtDur(t.holdMs)} />
        <Field l="Stop loss" v={levels(t, "sl")} title={t.sl === undefined ? NO_LEVEL : t.entries ? "This trade scaled in: each entry has its own stop (listed below)" : "Protective stop price set at entry"} />
        <Field l="Take profit" v={levels(t, "tp")} title={t.tp === undefined ? NO_LEVEL : t.entries ? "This trade scaled in: each entry has its own target (listed below)" : "Target price set at entry"} />
        <Field l="Size" v={<><span className="num">{fmtNum(t.qty, 2)}</span> <span className="muted">lots</span></>} title="Largest position size held during the trade" />
        <Field l="Risk" v={t.risk !== undefined ? <><span className="num">{fmtMoney(t.risk).replace("+", "")}</span>{startBalance > 0 && <span className="muted"> · {fmtPct(t.risk / startBalance)} of start</span>}{rr !== null && <span className="muted"> · R:R {rr.toFixed(1)}</span>}</> : <span className="muted">no stop</span>} title={t.risk !== undefined ? "Money at stake at entry: distance to the stop × size" : "No stop was set on this entry, so risk and R are not measured. Add a BRACKET with STOP_LOSS to see them."} wide />
        <Field l="P&L" tone={tone} v={<span className="num">{fmtMoney(t.pnl)}</span>} />
        <Field l="R" tone={tone} v={t.r !== undefined ? <span className="num">{fmtR(t.r)}</span> : "—"} title="P&L divided by the risk at entry" />
        <Field l="% of start" tone={tone} v={startBalance > 0 ? <span className="num">{fmtPct(t.pnl / startBalance)}</span> : "—"} title="P&L as a share of the starting balance" />
      </div>
      {t.entries && (
        <table className="entries" aria-label={`The ${t.entries.length} entries of this trade`}>
          <thead><tr><th>Entry</th><th>Time (UTC)</th><th className="r">Price</th><th className="r">Size</th><th className="r">Stop</th><th className="r">Target</th><th className="r">Risk</th></tr></thead>
          <tbody>{t.entries.map((e, i) => (
            <tr key={i}><td>{i + 1}</td><td className="num">{fmtTs(e.ts)}</td><td className="r num">{fmtPrice(e.px)}</td><td className="r num">{fmtNum(e.qty, 2)}</td>
              <td className="r num loss">{e.sl === undefined ? "—" : fmtPrice(e.sl)}</td><td className="r num gain">{e.tp === undefined ? "—" : fmtPrice(e.tp)}</td><td className="r num">{e.risk === undefined ? "—" : fmtMoney(e.risk).replace("+", "")}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
