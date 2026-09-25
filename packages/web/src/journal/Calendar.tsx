import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import type { RoundTrip } from "../api/types.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { ChevronLeft, ChevronRight, RotateCcw } from "../ui/icons.js";
import { DASH, fmtDur, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtTs, glyph } from "../util/format.js";
import { useAnalytics } from "./useAnalytics.js";
import { useJournalNav } from "./nav.js";
import { Chart, chartBase, pf, tipHtml, Widget, tok, zoomOptions, type ChartHandle, type ZoomRange } from "./widgets.js";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayName = (iso: string) => WEEKDAY[new Date(iso + "T00:00:00Z").getUTCDay()]!;
const monthLabel = (m: string) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shift = (m: string, n: number) => { const d = new Date(m + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const shade = (pnl: number, max: number) => `color-mix(in srgb, ${pnl >= 0 ? tok("--gain") : tok("--loss")} ${Math.round(9 + 46 * Math.min(1, Math.abs(pnl) / (max || 1)))}%, ${tok("--card")})`;

function DayTrades({ day }: { day: string }) {
  const runId = useStore((s) => s.results?.runId), filters = useStore((s) => s.filters), selectTrip = useStore((s) => s.selectTrip);
  const ui = useUi();
  const [rows, setRows] = useState<RoundTrip[]>([]);
  useEffect(() => { if (runId) void api.trades(runId, { ...filters, day, limit: 100 }).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [runId, day, JSON.stringify({ ...filters, day: undefined })]);
  return (
    <Widget title={`Trades exited on ${day}`} right={<span className="muted">{rows.length}</span>}>
      <table className="tbl"><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th className="r">Entry px</th><th>Exit</th><th className="r">Exit px</th><th>Held</th><th className="r">P&L</th></tr></thead>
        <tbody>{rows.map((t) => (
          <tr key={t.id} className="click" onClick={() => { selectTrip(t, true); ui.set({ journalOpen: false }); }} title="Show on the chart">
            <td>{t.symbol.split(":").pop()}</td><td>{t.side === "long" ? "▲ Long" : "▼ Short"}</td><td className="mono">{fmtTs(t.entryTs)}</td><td className="r num">{fmtPrice(t.entryPx)}</td>
            <td className="mono">{fmtTs(t.exitTs)}</td><td className="r num">{fmtPrice(t.exitPx)}</td><td>{fmtDur(t.holdMs)}</td><td className={`r num ${t.pnl >= 0 ? "gain" : "loss"}`}>{glyph(t.pnl)} {fmtMoney(t.pnl)}</td>
          </tr>))}
        </tbody></table>
    </Widget>
  );
}

export function CalendarView() {
  const { base } = useAnalytics();
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  const days = useMemo(() => new Map((base?.daily ?? []).map((d) => [d.day, d])), [base]);
  const months = useMemo(() => [...new Set((base?.daily ?? []).map((d) => d.day.slice(0, 7)))], [base]);
  const [month, setMonth] = useState<string>("");
  const wanted = useJournalNav((s) => s.month), clearWanted = useJournalNav((s) => s.setMonth);
  useEffect(() => {
    if (wanted && months.includes(wanted)) { setMonth(wanted); clearWanted(null); return; }
    if (months.length && !months.includes(month)) setMonth(months[months.length - 1]!);
  }, [months, wanted]);
  if (!base) return <div className="empty"><span className="spin" />Loading…</div>;
  if (!months.length || !month) return <div className="empty"><b>No closed trades in this selection.</b>Loosen the filters above.</div>;

  const first = new Date(month + "-01T00:00:00Z"), lead = (first.getUTCDay() + 6) % 7;
  const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: Array<{ day: string; inMonth: boolean }> = [];
  for (let i = -lead; i < Math.ceil((lead + dim) / 7) * 7 - lead; i++) cells.push({ day: new Date(first.getTime() + i * 86_400_000).toISOString().slice(0, 10), inMonth: i >= 0 && i < dim });
  const inMonth = cells.filter((c) => c.inMonth).map((c) => days.get(c.day)).filter(Boolean) as NonNullable<ReturnType<typeof days.get>>[];
  const max = Math.max(1, ...inMonth.map((d) => Math.abs(d.pnl)));
  const total = inMonth.reduce((a, d) => a + d.pnl, 0), trades = inMonth.reduce((a, d) => a + d.trades, 0), wins = inMonth.reduce((a, d) => a + d.wins, 0);
  const best = inMonth.reduce<typeof inMonth[0] | null>((b, d) => (!b || d.pnl > b.pnl ? d : b), null), worst = inMonth.reduce<typeof inMonth[0] | null>((b, d) => (!b || d.pnl < b.pnl ? d : b), null);
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const idx = months.indexOf(month);

  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      <Widget title="P&L calendar" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>by exit day (UTC) · click a day to filter</span>}>
        <div className="row" style={{ gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
          <button className="btn icon sm" aria-label="Previous month" disabled={idx <= 0} onClick={() => setMonth(months[idx - 1]!)}><ChevronLeft size={16} /></button>
          <b style={{ fontSize: "var(--fs-lg)", minWidth: 150, textAlign: "center" }}>{monthLabel(month)}</b>
          <button className="btn icon sm" aria-label="Next month" disabled={idx >= months.length - 1} onClick={() => setMonth(months[idx + 1]!)}><ChevronRight size={16} /></button>
          <span className="grow" style={{ flex: 1 }} />
          <span className={`num ${total >= 0 ? "gain" : "loss"}`} style={{ fontWeight: 650 }}>{glyph(total)} {fmtMoney(total)}</span>
          <span className="muted">{trades} trades · {fmtPct(trades ? wins / trades : 0, 0)} win</span>
          {best && <span className="muted hide-md">best <b className="gain">{fmtMoney(best.pnl, 0)}</b></span>}{worst && worst.pnl < 0 && <span className="muted hide-md">worst <b className="loss">{fmtMoney(worst.pnl, 0)}</b></span>}
        </div>
        <div className="cal" role="grid" aria-label={`P&L calendar for ${monthLabel(month)}`}>
          {DOW.map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}<div className="dow">Week</div>
          {weeks.map((w, wi) => {
            const wd = w.filter((c) => c.inMonth).map((c) => days.get(c.day)).filter(Boolean) as typeof inMonth;
            const wp = wd.reduce((a, d) => a + d.pnl, 0), wt = wd.reduce((a, d) => a + d.trades, 0);
            return [
              ...w.map((c) => {
                const d = days.get(c.day), n = Number(c.day.slice(8));
                if (!d || !c.inMonth) return <div key={c.day} className={`cal-cell${c.inMonth ? "" : " out"}`} role="gridcell" style={c.inMonth && d ? undefined : { background: c.inMonth ? "var(--card)" : "transparent", borderStyle: c.inMonth ? "solid" : "dashed" }}><span className="d">{n}</span></div>;
                return (
                  <button key={c.day} className="cal-cell" role="gridcell" aria-pressed={filters.day === c.day} style={{ background: shade(d.pnl, max) }}
                    aria-label={`${c.day}: ${fmtMoney(d.pnl)}, ${d.trades} trades`} title={`${dayName(c.day)} ${c.day} · ${glyph(d.pnl)} ${fmtMoney(d.pnl)} · ${d.trades} trade${d.trades === 1 ? "" : "s"} · ${fmtPct(d.wins / d.trades, 0)} win`} onClick={() => setFilters({ day: filters.day === c.day ? undefined : c.day })}>
                    <span className="d">{n}</span><span className={`p ${d.pnl >= 0 ? "gain" : "loss"}`} style={{ color: "var(--ink)" }}>{glyph(d.pnl)} {fmtMoney(d.pnl, 0)}</span><span className="t">{d.trades} trade{d.trades === 1 ? "" : "s"}</span>
                  </button>
                );
              }),
              <div key={`w${wi}`} className="cal-week"><span>Week {wi + 1}</span><b className={wp >= 0 ? "gain" : "loss"}>{wt ? fmtMoney(wp, 0) : DASH}</b><span>{wt} trades</span></div>,
            ];
          })}
        </div>
        <div className="legend" style={{ marginTop: "var(--s3)" }}><span><i style={{ background: shade(max, max) }} />profit day</span><span><i style={{ background: shade(-max, max) }} />loss day</span><span className="muted">Intensity follows the size of the day.</span></div>
      </Widget>
      {filters.day && <DayTrades day={filters.day} />}
    </div>
  );
}

export function DailyView() {
  const { base } = useAnalytics();
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  const chart = useRef<ChartHandle>(null);
  const [zoom, setZoom] = useState<ZoomRange | null>(null);
  const d = base?.daily ?? [];
  useEffect(() => { setZoom(null); }, [d.length]);
  if (!base) return <div className="empty"><span className="spin" />Loading…</div>;
  if (!d.length) return <div className="empty"><b>No closed trades in this selection.</b>Loosen the filters above.</div>;
  let run = 0;
  const rows = d.map((x) => ({ ...x, cum: (run += x.pnl) }));
  const gain = tok("--gain"), loss = tok("--loss");
  // what the zoom window covers, so the numbers under the chart always describe what is on screen
  const lo = zoom ? Math.floor((zoom.start / 100) * d.length) : 0, hi = zoom ? Math.max(lo + 1, Math.ceil((zoom.end / 100) * d.length)) : d.length;
  const vis = d.slice(lo, hi);
  const vPnl = vis.reduce((a, x) => a + x.pnl, 0), vTr = vis.reduce((a, x) => a + x.trades, 0), vW = vis.reduce((a, x) => a + x.wins, 0);
  const zoomed = zoom !== null && (zoom.start > 0.5 || zoom.end < 99.5);
  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      <Widget title="Daily P&L" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{d.length} trading days · hover for detail · click a bar to filter · scroll to zoom</span>}>
        <Chart ref={chart} height={300} label="Profit and loss per day" deps={[d, filters.day]} onZoom={setZoom} onClick={(p) => { const day = d[p.dataIndex]?.day; if (day) setFilters({ day: filters.day === day ? undefined : day }); }}
          build={() => chartBase({
            ...zoomOptions(d.length),
            xAxis: { ...(chartBase().xAxis as object), type: "category", data: d.map((x) => x.day.slice(5)), axisLabel: { color: tok("--ink-3"), fontSize: 10, hideOverlap: true } },
            series: [{ type: "bar", barCategoryGap: "25%", cursor: "pointer", emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.35)" } },
              data: d.map((x) => ({ value: x.pnl, itemStyle: { color: x.pnl >= 0 ? gain : loss, borderRadius: x.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3], opacity: !filters.day || filters.day === x.day ? 1 : 0.35 } })) }],
            tooltip: { ...(chartBase().tooltip as object), axisPointer: { type: "shadow", shadowStyle: { color: tok("--hover") } },
              formatter: (p: Array<{ dataIndex: number }>) => { const x = rows[p[0]!.dataIndex]!; return tipHtml(`${dayName(x.day)} ${x.day}`, { value: x.pnl, text: fmtMoney(x.pnl) }, [["Trades", String(x.trades)], ["Win rate", `${fmtPct(x.wins / x.trades, 0)} (${x.wins}W ${x.trades - x.wins}L)`], ["Cumulative", fmtMoney(x.cum)]], filters.day === x.day ? "Click to clear this day" : "Click to filter to this day"); } },
          })} />
        <div className="zoombar" aria-live="polite">
          <span className="muted">{zoomed ? `Showing ${vis[0]?.day} → ${vis[vis.length - 1]?.day}` : "Whole period"}</span>
          <span className="num">{vis.length} days</span><span className="num">{vTr} trades</span><span className="num">{vTr ? fmtPct(vW / vTr, 0) : DASH} win</span>
          <b className={`num ${vPnl >= 0 ? "gain" : "loss"}`}>{glyph(vPnl)} {fmtMoney(vPnl)}</b>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" disabled={!zoomed} onClick={() => { chart.current?.resetZoom(); setZoom(null); }}><RotateCcw size={13} />Reset zoom</button>
        </div>
      </Widget>
      <Widget title="Days" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>click a row to filter</span>}>
        <div className="tblwrap" style={{ maxHeight: 380 }}>
          <table className="tbl"><thead><tr><th>Day</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">P&L</th><th className="r">Cumulative</th></tr></thead>
            <tbody>{[...rows].reverse().map((x) => (
              <tr key={x.day} className={`click${filters.day === x.day ? " sel" : ""}`} tabIndex={0} aria-selected={filters.day === x.day} onClick={() => setFilters({ day: filters.day === x.day ? undefined : x.day })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilters({ day: filters.day === x.day ? undefined : x.day }); } }}>
                <td className="mono">{x.day} <span className="muted">{dayName(x.day).slice(0, 3)}</span></td><td className="r num">{x.trades}</td><td className="r num">{fmtPct(x.wins / x.trades, 0)}</td>
                <td className={`r num ${x.pnl >= 0 ? "gain" : "loss"}`}>{glyph(x.pnl)} {fmtMoney(x.pnl)}</td><td className={`r num ${x.cum >= 0 ? "gain" : "loss"}`}>{fmtMoney(x.cum)}</td></tr>))}</tbody></table>
        </div>
      </Widget>
      {filters.day && <DayTrades day={filters.day} />}
    </div>
  );
}

export function MonthlyView() {
  const { base } = useAnalytics();
  const start = useStore((s) => s.results?.equity.equity[0] ?? 0);
  if (!base) return <div className="empty"><span className="spin" />Loading…</div>;
  const m = base.monthly;
  if (!m.length) return <div className="empty"><b>No closed trades in this selection.</b></div>;
  const gain = tok("--gain"), loss = tok("--loss");
  const openMonth = (mo?: string) => { if (!mo) return; useJournalNav.getState().setMonth(mo); useUi.getState().openJournal("calendar"); };
  const years = [...new Set(m.map((x) => x.month.slice(0, 4)))];
  const by = new Map(m.map((x) => [x.month, x]));
  const max = Math.max(1, ...m.map((x) => Math.abs(x.pnl)));
  const mnames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      <Widget title="Monthly P&L" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>hover for detail · click a month to open it in the calendar</span>}>
        <Chart height={260} label="Profit and loss per month" deps={[m]} onClick={(p) => openMonth(m[p.dataIndex]?.month)} build={() => chartBase({
          ...zoomOptions(m.length, 30),
          xAxis: { ...(chartBase().xAxis as object), type: "category", data: m.map((x) => x.month) },
          series: [{ type: "bar", barCategoryGap: "30%", cursor: "pointer", data: m.map((x) => ({ value: x.pnl, itemStyle: { color: x.pnl >= 0 ? gain : loss, borderRadius: x.pnl >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })) }],
          tooltip: { ...(chartBase().tooltip as object), axisPointer: { type: "shadow", shadowStyle: { color: tok("--hover") } }, formatter: (p: Array<{ dataIndex: number }>) => { const x = m[p[0]!.dataIndex]!; return tipHtml(monthLabel(x.month), { value: x.pnl, text: fmtMoney(x.pnl) }, [["Trades", String(x.trades)], ["Win rate", fmtPct(x.wins / x.trades, 0)], ["Profit factor", pf(x)], ["% of start", start ? fmtPct(x.pnl / start) : DASH]], "Click to open this month in the calendar"); } },
        })} />
      </Widget>
      <div className="grid cols-2">
        <Widget title="By month">
          <table className="tbl"><thead><tr><th>Month</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">PF</th><th className="r">P&L</th><th className="r">% of start</th></tr></thead>
            <tbody>{m.map((x) => (
              <tr key={x.month} className="click" tabIndex={0} onClick={() => openMonth(x.month)} onKeyDown={(e) => { if (e.key === "Enter") openMonth(x.month); }} title="Open in the calendar"><td className="mono">{x.month}</td><td className="r num">{x.trades}</td><td className="r num">{fmtPct(x.wins / x.trades, 0)}</td><td className="r num">{pf(x)}</td>
                <td className={`r num ${x.pnl >= 0 ? "gain" : "loss"}`}>{glyph(x.pnl)} {fmtMoney(x.pnl)}</td><td className="r num">{start ? fmtPct(x.pnl / start) : DASH}</td></tr>))}</tbody></table>
        </Widget>
        <Widget title="Year × month heat" right={<span className="muted" style={{ fontSize: "var(--fs-xs)" }}>values are printed</span>}>
          <table className="tbl heat" style={{ tableLayout: "fixed" }} aria-label="P&L by month and year">
            <thead><tr><th style={{ width: 46 }} />{mnames.map((n) => <th key={n} style={{ textAlign: "center", padding: "6px 2px" }}>{n}</th>)}</tr></thead>
            <tbody>{years.map((y) => (
              <tr key={y}><td className="muted">{y}</td>{mnames.map((_, i) => { const r = by.get(`${y}-${String(i + 1).padStart(2, "0")}`); return <td key={i} className={`num${r ? " hcell" : ""}`} onClick={r ? () => openMonth(`${y}-${String(i + 1).padStart(2, "0")}`) : undefined} title={r ? `${mnames[i]} ${y} · ${glyph(r.pnl)} ${fmtMoney(r.pnl)} · ${r.trades} trades · ${fmtPct(r.wins / r.trades, 0)} win (click to open)` : ""} style={{ textAlign: "center", padding: "6px 1px", fontSize: 11, background: r ? shade(r.pnl, max) : "transparent" }}>{r ? `${glyph(r.pnl)}${fmtNum(Math.abs(r.pnl), 0)}` : ""}</td>; })}</tr>))}</tbody></table>
        </Widget>
      </div>
    </div>
  );
}
