import { useStore } from "../state/store.js";
import { fmtMoney, fmtNum, fmtPct, glyph } from "../util/format.js";
import { Clock, Scale } from "../ui/icons.js";
import { useAnalytics } from "./useAnalytics.js";
import { Chart, chartBase, SignedBars, Stat, tipHtml, Widget, tok } from "./widgets.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export function TimeRisk() {
  const { a } = useAnalytics();
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  if (!a) return <div className="empty"><span className="spin" />Loading…</div>;
  if (!a.closed) return <div className="empty"><b>No closed trades in this selection.</b></div>;
  const gain = tok("--gain"), loss = tok("--loss");
  const R = a.rHistogram;
  const rmid = (i: number) => (R!.edges[i]! + R!.edges[i + 1]!) / 2;
  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      <div className="grid cols-2">
        <Widget title="By entry weekday" icon={<Clock size={15} />} right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>click to filter</span>}>
          <SignedBars items={ORDER.map((d) => ({ key: String(d), label: DOW[d]!, value: a.weekday[d]!.pnl, count: a.weekday[d]!.trades }))}
            active={filters.weekday !== undefined ? String(filters.weekday) : null} onPick={(k) => setFilters({ weekday: filters.weekday === Number(k) ? undefined : Number(k) })} />
        </Widget>
        <Widget title="By entry hour (UTC)" icon={<Clock size={15} />} right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>click a bar to filter</span>}>
          <Chart height={210} label="Profit and loss by hour of entry" deps={[a.hour, filters.hour]} onClick={(p) => setFilters({ hour: filters.hour === p.dataIndex ? undefined : p.dataIndex })}
            build={() => chartBase({
              xAxis: { ...(chartBase().xAxis as object), type: "category", data: a.hour.map((_, h) => String(h).padStart(2, "0")), axisLabel: { color: tok("--ink-3"), fontSize: 10, interval: 2 } },
              series: [{ type: "bar", barCategoryGap: "20%", data: a.hour.map((h, i) => ({ value: h.pnl, itemStyle: { color: h.pnl >= 0 ? gain : loss, borderRadius: h.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3], opacity: filters.hour === undefined || filters.hour === i ? 1 : 0.35 } })) }],
              tooltip: { ...(chartBase().tooltip as object), axisPointer: { type: "shadow", shadowStyle: { color: tok("--hover") } }, formatter: (p: Array<{ dataIndex: number }>) => { const h = a.hour[p[0]!.dataIndex]!; return tipHtml(`Entered ${String(p[0]!.dataIndex).padStart(2, "0")}:00–${String(p[0]!.dataIndex).padStart(2, "0")}:59 UTC`, { value: h.pnl, text: fmtMoney(h.pnl) }, [["Trades", String(h.trades)], ["Win rate", h.trades ? fmtPct(h.wins / h.trades, 0) : "—"]], filters.hour === p[0]!.dataIndex ? "Click to clear" : "Click to filter to this hour"); } },
            })} />
        </Widget>
      </div>
      <div className="grid cols-3">
        <Widget title="R multiples" icon={<Scale size={15} />} className="span-2" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>P&L ÷ the risk on the entry · click a bar to filter</span>}>
          {R ? (
            <Chart height={220} label="Distribution of R multiples" deps={[R, filters.minR, filters.maxR]} onClick={(p) => { const lo = R.edges[p.dataIndex]!, hi = R.edges[p.dataIndex + 1]!; setFilters(filters.minR === lo && filters.maxR === hi ? { minR: undefined, maxR: undefined } : { minR: lo, maxR: hi }); }} build={() => chartBase({
              xAxis: { ...(chartBase().xAxis as object), type: "category", data: R.counts.map((_, i) => `${rmid(i) >= 0 ? "+" : "−"}${Math.abs(rmid(i)).toFixed(1)}R`), axisLabel: { color: tok("--ink-3"), fontSize: 10, interval: Math.max(0, Math.floor(R.counts.length / 6)) } },
              series: [{ type: "bar", barCategoryGap: "12%", cursor: "pointer", data: R.counts.map((v, i) => ({ value: v, itemStyle: { color: rmid(i) >= 0 ? gain : loss, borderRadius: [3, 3, 0, 0], opacity: filters.minR === undefined || filters.minR === R.edges[i] ? 1 : 0.35 } })) }],
              tooltip: { ...(chartBase().tooltip as object), axisPointer: { type: "shadow", shadowStyle: { color: tok("--hover") } }, formatter: (p: Array<{ dataIndex: number; value: number }>) => { const i = p[0]!.dataIndex; return tipHtml(`${R.edges[i]!.toFixed(2)}R to ${R.edges[i + 1]!.toFixed(2)}R`, null, [["Trades", String(p[0]!.value)], ["Share", fmtPct(p[0]!.value / Math.max(1, a.rTrades), 0)]], "Click to filter to this range"); } },
            })} />
          ) : <div className="empty"><b>No R multiples</b><span style={{ textAlign: "center" }}>R needs a stop on the entry. Add <span className="mono">STOP_LOSS</span> or a <span className="mono">BRACKET</span> to the strategy.</span></div>}
        </Widget>
        <Widget title="Risk">
          <Stat label="Trades with risk" value={`${a.rTrades} of ${a.closed}`} />
          <Stat label="Average R" value={a.avgR === null ? "no stop" : `${a.avgR >= 0 ? "+" : "−"}${Math.abs(a.avgR).toFixed(2)}R`} tone={a.avgR === null ? undefined : a.avgR >= 0 ? "gain" : "loss"} />
          <Stat label="Total R" value={a.totalR === null ? "no stop" : `${a.totalR >= 0 ? "+" : "−"}${Math.abs(a.totalR).toFixed(1)}R`} tone={a.totalR === null ? undefined : a.totalR >= 0 ? "gain" : "loss"} />
          <Stat label="Payoff ratio" value={a.payoff === null ? "-" : fmtNum(a.payoff)} />
          <div className="hint muted" style={{ fontSize: "var(--fs-xs)", marginTop: 4 }}>On bars a stop can fill worse than its level, so losses beyond −1R are expected there.</div>
        </Widget>
      </div>
      <Widget title="Held for" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>click to filter</span>}>
        <SignedBars items={a.hold.map((h) => ({ key: h.label, label: h.label, value: h.pnl, count: h.trades }))}
          active={(() => { const h = a.hold.find((x) => (x.minMs || undefined) === filters.minHoldMs && (Number.isFinite(x.maxMs) ? x.maxMs : undefined) === filters.maxHoldMs); return h?.label ?? null; })()}
          onPick={(k) => { const h = a.hold.find((x) => x.label === k); if (!h) return; const lo = h.minMs || undefined, hi = Number.isFinite(h.maxMs) ? h.maxMs : undefined; const on = filters.minHoldMs === lo && filters.maxHoldMs === hi; setFilters(on ? { minHoldMs: undefined, maxHoldMs: undefined } : { minHoldMs: lo, maxHoldMs: hi }); }} />
      </Widget>
    </div>
  );
}
