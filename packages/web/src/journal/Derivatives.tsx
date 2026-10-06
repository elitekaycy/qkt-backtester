import { useMemo, useState } from "react";
import type { RunDerivatives, StructureRow } from "@qkt-studio/core";
import { DASH, fmtMoney, fmtNum, fmtTs } from "../util/format.js";
import { legText, marginView, rollSummary } from "../util/derivatives.js";
import { CircleAlert, OctagonX } from "../ui/icons.js";
import { Chart, chartBase, compactMoney, Stat, tipHtml, tok, Widget, zoomOptions } from "./widgets.js";
import { useDerivatives } from "./useDerivatives.js";

const bare = (c: string) => c.replace(/^[A-Za-z0-9_]+:/, "");
const SHOW = 40;
const note = { padding: "0 var(--s3) var(--s2)", fontSize: "var(--fs-xs)" } as const;

/** A table shows its first rows and the rest on request: a run over years can carry hundreds of fills. */
function More({ shown, total, onAll }: { shown: number; total: number; onAll(): void }) {
  return total > shown ? <button className="btn ghost sm" style={{ margin: "var(--s2) var(--s3)" }} onClick={onAll}>Show all {total.toLocaleString()}</button> : null;
}

function Rolls({ d }: { d: RunDerivatives }) {
  const rolls = d.rolls ?? [], [all, setAll] = useState(false);
  const sum = useMemo(() => rollSummary(rolls), [rolls]);
  const rows = all ? rolls : rolls.slice(0, SHOW);
  const total = rolls.reduce((a, r) => a + r.rollCost, 0);
  return (
    <Widget title="Rolls" className="flush" right={<span className="muted">{rolls.length} carried across a roll · {fmtMoney(-total)} in roll costs</span>} style={{ padding: 0 }}>
      <div className="hint muted" style={note}>
        A continuous stream closes the old contract and opens the next at each roll. The gap is the price difference between the two; the cost is the slippage and fees of the two fills. No trade row is written for a roll: the trade spans it.
      </div>
      {sum.length > 0 && <div className="tbl-scroll"><table className="tbl">
        <thead><tr><th>Stream</th><th className="r">Rolls</th><th className="r">Avg gap</th><th className="r">Fees</th><th className="r">Roll cost</th></tr></thead>
        <tbody>{sum.map((s) => <tr key={s.stream}><td><b>{s.stream.split(":").pop()}</b></td><td className="r num">{s.count}</td><td className="r num">{fmtNum(s.avgGap, 2)}</td><td className="r num">{fmtNum(s.fees, 2)}</td><td className="r num loss">{fmtMoney(-s.cost)}</td></tr>)}</tbody>
      </table></div>}
      <div className="tbl-scroll"><table className="tbl">
        <thead><tr><th>When (UTC)</th><th>From</th><th>To</th><th className="r">Quantity</th><th className="r">Gap</th><th className="r">Fees</th><th className="r">Cost</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td className="num">{fmtTs(r.ts)}</td><td>{bare(r.from)}</td><td>{bare(r.to)}</td><td className="r num">{fmtNum(r.quantity, 2)}</td><td className="r num">{fmtNum(r.gap, 2)}</td><td className="r num">{fmtNum(r.fees, 2)}</td><td className="r num loss">{fmtMoney(-r.rollCost)}</td></tr>)}</tbody>
      </table></div>
      <More shown={rows.length} total={rolls.length} onAll={() => setAll(true)} />
    </Widget>
  );
}

function Contracts({ d }: { d: RunDerivatives }) {
  const fills = d.contracts ?? [], [all, setAll] = useState(false);
  const rows = all ? fills : fills.slice(0, SHOW);
  return (
    <Widget title="Contracts behind the fills" className="flush" right={<span className="muted">{fills.length.toLocaleString()} fills on a continuous stream</span>} style={{ padding: 0 }}>
      <div className="hint muted" style={note}>The engine sees the adjusted series; each order really traded the contract that was front at the time, at its own price.</div>
      <div className="tbl-scroll"><table className="tbl">
        <thead><tr><th>When (UTC)</th><th>Stream</th><th>Side</th><th className="r">Quantity</th><th>Contract</th><th className="r">Contract price</th><th className="r">Series price</th></tr></thead>
        <tbody>{rows.map((c, i) => <tr key={i}><td className="num">{fmtTs(c.ts)}</td><td>{c.stream.split(":").pop()}</td><td>{c.side === "BUY" ? "▲ Buy" : "▼ Sell"}</td><td className="r num">{fmtNum(c.quantity, 2)}</td><td><b>{bare(c.contract)}</b></td><td className="r num">{fmtNum(c.contractPrice, 2)}</td><td className="r num muted">{fmtNum(c.streamPrice, 2)}</td></tr>)}</tbody>
      </table></div>
      <More shown={rows.length} total={fills.length} onAll={() => setAll(true)} />
    </Widget>
  );
}

/** Equity against the margin the open positions needed. A day on a margin call is marked with a red ring and listed, never by colour alone. */
function Margin({ d }: { d: RunDerivatives }) {
  const days = d.margin ?? [], rolls = d.rolls ?? [];
  const v = useMemo(() => marginView(days), [days]);
  const [table, setTable] = useState(false);
  const at = (p: { date: string }) => Date.parse(`${p.date}T00:00:00Z`);
  const swatch = (color: string, dashed = false) => <i style={{ display: "inline-block", width: 14, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`, verticalAlign: "middle", marginRight: 6 }} />;
  return (
    <Widget title="Margin and equity" right={<>
      <button className="btn ghost sm" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button>
      <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>days that ended holding a position</span></>}>
      <div aria-label="Legend" style={{ display: "flex", gap: "var(--s4)", flexWrap: "wrap", fontSize: "var(--fs-xs)", color: "var(--ink-2)" }}>
        <span>{swatch(tok("--s1c"))}Equity</span>
        <span>{swatch(tok("--s3c"))}Margin used</span>
        <span>{swatch(tok("--s2c"), true)}Maintenance</span>
        {v.calls > 0 && <span><OctagonX size={12} color="var(--danger)" aria-hidden="true" style={{ verticalAlign: "middle", marginRight: 4 }} />Margin call</span>}
        {rolls.length > 0 && <span>{swatch(tok("--ink-4"))}Roll (dotted)</span>}
      </div>
      {!table ? (
        <Chart height={250} label="Account equity, margin used and maintenance margin by day" deps={[days, rolls]} build={() => {
          const eq = tok("--s1c"), used = tok("--s3c"), maint = tok("--s2c"), danger = tok("--danger"), ink2 = tok("--ink-2");
          return chartBase({
            ...zoomOptions(v.points.length, 60),
            grid: { left: 52, right: 70, top: 14, bottom: v.points.length >= 60 ? 48 : 22 },
            xAxis: { ...(chartBase().xAxis as object), type: "time" },
            series: [
              { name: "Equity", type: "line", showSymbol: false, data: v.points.map((p) => [at(p), p.equity]), lineStyle: { width: 2, color: eq }, itemStyle: { color: eq }, endLabel: { show: true, formatter: "Equity", color: ink2, fontSize: 11 },
                markLine: rolls.length ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: tok("--ink-4"), type: "dotted", width: 1 }, data: rolls.slice(0, 80).map((r) => ({ xAxis: r.ts })) } : undefined },
              { name: "Margin used", type: "line", showSymbol: false, data: v.points.map((p) => [at(p), p.used]), lineStyle: { width: 2, color: used }, itemStyle: { color: used }, endLabel: { show: true, formatter: "Margin", color: ink2, fontSize: 11 } },
              { name: "Maintenance", type: "line", showSymbol: false, data: v.points.map((p) => [at(p), p.maintenance]), lineStyle: { width: 2, color: maint, type: "dashed" }, itemStyle: { color: maint }},
              ...(v.calls ? [{ name: "Margin call", type: "line", data: v.points.filter((p) => p.call).map((p) => [at(p), p.equity]), lineStyle: { opacity: 0 }, symbol: "circle", symbolSize: 11, itemStyle: { color: "transparent", borderColor: danger, borderWidth: 2 }, z: 5 }] : []),
            ],
            tooltip: { ...(chartBase().tooltip as object), formatter: (ps: Array<{ dataIndex: number; seriesName: string }>) => {
              const p = ps.find((x) => x.seriesName === "Equity"); if (!p) return "";
              const pt = v.points[p.dataIndex]; if (!pt) return "";
              const head = pt.equity - pt.maintenance;
              return tipHtml(pt.date, { value: head, text: `${fmtMoney(head, 0)} above maintenance` }, [["Equity", fmtNum(pt.equity, 0)], ["Margin used", fmtNum(pt.used, 0)], ["Maintenance", fmtNum(pt.maintenance, 0)]], pt.call ? "Margin call this day" : undefined);
            } },
            yAxis: { ...(chartBase().yAxis as object), axisLabel: { color: tok("--ink-3"), fontSize: 11, formatter: (x: number) => compactMoney(x) } },
          });
        }} />
      ) : (
        <div className="tbl-scroll" style={{ maxHeight: 280, overflow: "auto" }}><table className="tbl">
          <thead><tr><th>Day</th><th className="r">Equity</th><th className="r">Margin used</th><th className="r">Maintenance</th><th className="r">Above maintenance</th><th>Call</th></tr></thead>
          <tbody>{v.points.map((p) => <tr key={p.date}><td className="num">{p.date}</td><td className="r num">{fmtNum(p.equity, 0)}</td><td className="r num">{fmtNum(p.used, 0)}</td><td className="r num">{fmtNum(p.maintenance, 0)}</td><td className="r num">{fmtNum(p.equity - p.maintenance, 0)}</td><td>{p.call ? <span className="badge bad"><CircleAlert size={11} aria-hidden="true" />margin call</span> : ""}</td></tr>)}</tbody>
        </table></div>
      )}
      <div className="grid cols-3" style={{ gap: "var(--s2) var(--s5)" }}>
        <Stat label="Days with a position" value={String(v.points.length)} />
        <Stat label="Margin-call days" value={String(v.calls)} tone={v.calls ? "loss" : undefined} />
        <Stat label="Tightest day" value={v.tightest ? `${v.tightest.date} · ${fmtMoney(v.tightest.headroom, 0)} above` : DASH} />
      </div>
    </Widget>
  );
}

function Settlements({ d }: { d: RunDerivatives }) {
  const rows = d.settlements ?? [];
  return (
    <Widget title="Settled at expiry" className="flush" right={<span className="muted">{rows.length} position{rows.length === 1 ? "" : "s"} held to the contract's end</span>} style={{ padding: 0 }}>
      <div className="tbl-scroll"><table className="tbl">
        <thead><tr><th>When (UTC)</th><th>Contract</th><th>Side</th><th className="r">Quantity</th><th className="r">Settlement price</th><th>Delivery price</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td className="num">{fmtTs(r.ts)}</td><td><b>{bare(r.contract)}</b></td><td>{r.side === "BUY" ? "▲ Long" : "▼ Short"}</td><td className="r num">{fmtNum(r.quantity, 2)}</td><td className="r num">{fmtNum(r.price, 2)}</td>
          <td>{r.deliveryPriceKnown ? <span className="muted">from the catalog</span> : <span className="badge warn" title="The catalog had no delivery price for this contract, so the last price was used">last price</span>}</td></tr>)}</tbody>
      </table></div>
    </Widget>
  );
}

function Liquidations({ d }: { d: RunDerivatives }) {
  const rows = d.liquidations ?? [];
  return (
    <Widget title="Liquidations" className="flush" right={<span className="badge bad"><OctagonX size={11} aria-hidden="true" />{rows.length} position{rows.length === 1 ? "" : "s"} closed by the venue</span>} style={{ padding: 0 }}>
      <div className="hint muted" style={note}>Account equity fell below the maintenance margin of the positions held, so the venue closed them at the executable price. Equity and maintenance are as they stood when it triggered.</div>
      <div className="tbl-scroll"><table className="tbl">
        <thead><tr><th>When (UTC)</th><th>Symbol</th><th>Side</th><th className="r">Quantity</th><th className="r">Price</th><th className="r">Fee</th><th className="r">Equity</th><th className="r">Maintenance</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td className="num">{fmtTs(r.ts)}</td><td><b>{bare(r.symbol)}</b></td><td>{r.side === "BUY" ? "▲ Long" : "▼ Short"}</td><td className="r num">{fmtNum(r.quantity, 2)}</td><td className="r num">{fmtNum(r.price, 2)}</td><td className="r num">{fmtNum(r.fee, 2)}</td><td className="r num">{fmtNum(r.equity, 0)}</td><td className="r num">{fmtNum(r.maintenance, 0)}</td></tr>)}</tbody>
      </table></div>
    </Widget>
  );
}

function Financing({ d }: { d: RunDerivatives }) {
  const rows = d.financing ?? [];
  const label: Record<string, string> = { funding: "Perpetual funding", swap: "Swap", rollCosts: "Roll costs" };
  return (
    <Widget title="Financing" right={<span className="muted">charged outside the fills</span>}>
      <div className="grid cols-3" style={{ gap: "var(--s2) var(--s5)" }}>
        {rows.map((r) => <Stat key={r.component} label={label[r.component] ?? r.component} value={fmtMoney(r.netPnlImpact)} tone={r.netPnlImpact < 0 ? "loss" : "gain"} />)}
      </div>
      <div className="hint muted" style={{ fontSize: "var(--fs-xs)" }}>A long pays a positive funding rate and a short is paid it. The amounts are already inside the net P&L; the Overview's cost bridge shows them added back.</div>
    </Widget>
  );
}

const OUTCOME: Record<NonNullable<StructureRow["outcome"]>, string> = { CLOSED: "Closed", UNWOUND: "Unwound", SETTLED: "Settled at expiry" };
function Structures({ d }: { d: RunDerivatives }) {
  const rows = d.structures ?? [];
  return (
    <Widget title="Option structures" className="flush" right={<span className="muted">{rows.length} opened by OPEN … = OPTIONS ON …</span>} style={{ padding: 0 }}>
      <div className="hint muted" style={note}>Credit and realised are the premium P&L before fees. A structure still open when the run ended has no outcome yet.</div>
      <div className="tbl-scroll"><table className="tbl">
        <thead><tr><th>Opened (UTC)</th><th>Closed (UTC)</th><th>Structure</th><th>Legs</th><th>Outcome</th><th className="r">Credit</th><th className="r">Realised</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}><td className="num">{r.openedAt === null ? DASH : fmtTs(r.openedAt)}</td><td className="num">{r.closedAt === null ? <span className="badge">open</span> : fmtTs(r.closedAt)}</td><td><b>{r.alias}</b> <span className="muted">{r.structure}</span></td>
            <td>{r.legs.map((l, j) => <div key={j} className="nowrap" style={{ fontSize: "var(--fs-xs)" }}>{legText(l)}</div>)}</td>
            <td>{r.outcome ? <span className={`badge ${r.outcome === "UNWOUND" ? "warn" : ""}`}>{OUTCOME[r.outcome]}</span> : <span className="muted">{DASH}</span>}</td>
            <td className="r num">{r.credit === null ? DASH : fmtMoney(r.credit)}</td><td className={`r num ${r.realized === null ? "" : r.realized >= 0 ? "gain" : "loss"}`}>{r.realized === null ? DASH : fmtMoney(r.realized)}</td></tr>
        ))}</tbody>
      </table></div>
    </Widget>
  );
}

/** Everything a futures or options run wrote beside the trades. Only the sections the run has are shown. */
export function Derivatives() {
  const { data, loading, error } = useDerivatives();
  if (loading) return <div className="empty"><span className="spin" />Loading…</div>;
  if (error || !data) return <div className="empty"><b>No futures or options data in this run</b>{error ?? "Run a strategy that trades them."}</div>;
  const has = (k: RunDerivatives["sections"][number]) => data.sections.includes(k);
  return (
    <div className="grid" style={{ gap: "var(--s4)" }}>
      {has("margin") && <Margin d={data} />}
      {has("rolls") && <Rolls d={data} />}
      {has("structures") && <Structures d={data} />}
      {has("settlements") && <Settlements d={data} />}
      {has("liquidations") && <Liquidations d={data} />}
      {has("financing") && <Financing d={data} />}
      {has("contracts") && <Contracts d={data} />}
    </div>
  );
}
