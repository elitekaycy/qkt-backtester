import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client.js";
import type { SymbolReport, TfReport, TickReport } from "../api/types.js";
import { rangeDays } from "@qkt-studio/core/ranges";
import { useStore } from "../state/store.js";
import { Modal } from "../ui/Modal.js";
import { Tip } from "../ui/Tip.js";
import { addDays } from "../util/format.js";
import { fillableDays, gapDaysIn, monthGrids, yearChip } from "../util/datawindow.js";
import { CircleAlert, CircleCheck, CircleX, Database, Folder, Hammer, Info, Plus, RotateCcw, TriangleAlert, Zap } from "../ui/icons.js";
import { BuildForm } from "./dataParts.js";
import { DataExplainer } from "./DataExplainer.js";
import { NoDataPanel } from "./NoDataPanel.js";
import { DataSourceDialog } from "./DataSourceDialog.js";

type Detail = Awaited<ReturnType<typeof api.symbolDetail>>;
const STATUS_TEXT = { complete: "Complete", mostly: "Nearly complete", incomplete: "Incomplete", empty: "Empty" } as const;
const StatusIcon = ({ s }: { s: keyof typeof STATUS_TEXT }) => s === "complete" ? <CircleCheck size={14} color="var(--ok)" /> : s === "mostly" ? <CircleAlert size={14} color="var(--warn)" /> : s === "incomplete" ? <CircleX size={14} color="var(--danger)" /> : <CircleAlert size={14} color="var(--ink-3)" />;
const DAY_TEXT: Record<string, string> = { o: "ok", c: "closed", t: "thin", m: "MISSING" };

interface Series { key: string; label: string; kind: string; r: TfReport | TickReport; isTicks: boolean }
const seriesOf = (rep: SymbolReport | null): Series[] => !rep ? [] : [
  ...(rep.ticks ? [{ key: "ticks", label: "Ticks", kind: "ticks", r: rep.ticks, isTicks: true }] : []),
  ...rep.bars.filter((b) => b.files > 0).map((b) => ({ key: `${b.broker}:${b.tf}`, label: b.qktReads ? `${b.tf} bars (not read by qkt: expects ${b.qktReads})` : `${b.tf} bars`, kind: `${b.broker}:${b.tf}`, r: b as TfReport | TickReport, isTicks: false })),
];

/** Calendar heat-map of one series: a small month grid per year, missing days in red, click a day to start a range there. */
export function Heatmap({ symbol, kind, source, onPick, sel, remap }: { symbol: string; kind: string; source?: string; onPick(day: string): void; sel: { from: string; to: string }; /** Re-judges days for a market whose hours the symbol route does not know (a futures exchange). */ remap?: (first: string, days: string) => string }) {
  const [data, setData] = useState<{ first: string; last: string; days: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setData(null); setErr(null);
    api.symbolDays(symbol, kind, source).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [symbol, kind, source]);
  const grids = useMemo(() => (data ? monthGrids(data.first, remap ? remap(data.first, data.days) : data.days) : []), [data, remap]);
  if (err) return <div className="muted">No calendar: {err}</div>;
  if (!data) return <div className="empty"><span className="spin" />Reading days…</div>;
  return (
    <div className="heat" role="region" tabIndex={0} aria-label={`Day-by-day status of ${symbol} ${kind}`}>
      {grids.map((g) => (
        <div key={g.year} className="heat-year">
          <div className="heat-y">{g.year}</div>
          <div className="heat-months">
            {g.months.map((m) => (
              <div key={m.month} className={`heat-m${m.missing ? " has-missing" : ""}`}>
                <div className="heat-ml">{m.label}{m.missing > 0 && <span className="badge bad" title={`${m.missing} missing day(s)`}>{m.missing}</span>}</div>
                <div className="heat-grid">
                  {Array.from({ length: m.lead }).map((_, i) => <i key={`l${i}`} className="hc lead" />)}
                  {m.cells.map((c) => {
                    const inWin = (!!sel.from || !!sel.to) && (!sel.from || c.day >= sel.from) && (!sel.to || c.day < sel.to);
                    return <button key={c.day} type="button" tabIndex={-1} className={`hc s-${c.s}${inWin ? " in" : ""}`} title={`${c.day} · ${DAY_TEXT[c.s] ?? c.s}`} aria-label={`${c.day}: ${DAY_TEXT[c.s] ?? c.s}`} onClick={() => onPick(c.day)} />;
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SymbolDialog() {
  const symbol = useStore((s) => s.symbolDialog), close = useStore((s) => s.openSymbol);
  const settings = useStore((s) => s.settings), readiness = useStore((s) => s.readiness), scan = useStore((s) => s.scan);
  const setSymbolPref = useStore((s) => s.setSymbolPref), openFile = useStore((s) => s.openFile);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [source, setSource] = useState<string>("");       // "" = the default source
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [seriesKey, setSeriesKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(false);
  const [pickSource, setPickSource] = useState(false);
  const [anchorDay, setAnchorDay] = useState<string | null>(null);
  const [build, setBuild] = useState(false);
  const [heatKey, setHeatKey] = useState(0);
  const buildBtn = useRef<HTMLButtonElement>(null);

  const load = async (sym: string) => {
    try {
      const d = await api.symbolDetail(sym);
      setDetail(d); setSource(d.pref.source ?? ""); setFrom(d.pref.from ?? ""); setTo(d.pref.to ?? "");
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { setDetail(null); setAnchorDay(null); setSeriesKey(""); setExplain(false); if (symbol) void load(symbol); }, [symbol]);
  // when sources are added from inside the dialog, the detail must list them
  useEffect(() => { if (symbol && settings) void load(symbol); }, [settings?.sources.join("|")]);

  const chosen = detail?.sources.find((x) => (source ? x.root === source : x.isDefault));
  const rep = chosen?.report ?? null;
  const series = seriesOf(rep);
  const cur = series.find((x) => x.key === seriesKey) ?? series.find((x) => !x.isTicks) ?? series[0];
  const first = rep ? [...series.map((x) => x.r.first)].filter(Boolean).sort()[0] ?? null : null;
  const last = rep ? [...series.map((x) => x.r.last)].filter(Boolean).sort().at(-1) ?? null : null;
  const lastExcl = last ? addDays(last, 1) : null;
  const eff = { from: from || first || "", to: to || lastExcl || "" };
  const gaps = cur?.r.gaps ?? [];
  const fill = cur && !cur.isTicks && rep?.ticks ? fillableDays(gaps, rep.ticks) : 0;
  const missingInWindow = gapDaysIn(gaps, eff.from, eff.to);
  const users = readiness.filter((r) => r.streams.some((s) => s.symbol === symbol));
  const custom = detail && (detail.pref.source || detail.pref.from || detail.pref.to);
  const dirty = !!detail && ((detail.pref.source ?? "") !== source || (detail.pref.from ?? "") !== from || (detail.pref.to ?? "") !== to);

  const save = async (over?: { source?: string | null; from?: string | null; to?: string | null }) => {
    if (!symbol) return;
    setBusy(true); setErr(null);
    try {
      await setSymbolPref(symbol, over ?? { source: source || null, from: from || null, to: to || null });
      await load(symbol);
    } catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); }
    finally { setBusy(false); }
  };
  const pick = (day: string) => {
    // first click sets the start, the second the (exclusive) end after it
    if (!anchorDay) { setAnchorDay(day); setFrom(day); setTo(""); return; }
    if (day > anchorDay) { setFrom(anchorDay); setTo(addDays(day, 1)); } else { setFrom(day); setTo(addDays(anchorDay, 1)); }
    setAnchorDay(null);
  };
  const jumpGap = (g: { from: string; to: string }) => { setFrom(addDays(g.from, -30) < (first ?? "") ? first ?? g.from : addDays(g.from, -30)); setTo(g.from); setAnchorDay(null); };

  return (
    <>
      <Modal open={!!symbol && !pickSource} onClose={() => close(null)} title={symbol ? `${symbol} · data` : "Data"} width={860}
        footer={<>
          <button className="btn ghost" style={{ marginRight: "auto" }} disabled={busy || !custom} onClick={() => { setSource(""); setFrom(""); setTo(""); void save({ source: null, from: null, to: null }); }}><RotateCcw size={14} />Reset to default source and full range</button>
          <button className="btn" onClick={() => close(null)}>Close</button>
          <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </>}>
        {!detail && !err && <div className="empty"><span className="spin" />Reading {symbol}…</div>}
        {err && <div className="banner bad" role="alert"><TriangleAlert size={15} /><span>{err}</span></div>}
        {detail && (
          <>
            <div className="sd-head">
              {rep ? <><span className="badge">{rep.market === "24/7" ? "24/7 market" : "Mon–Fri market"}</span>
                <span className="row" style={{ gap: 6 }}><StatusIcon s={rep.status === "ticks-only" ? "empty" : rep.status} /><b>{rep.status === "ticks-only" ? "Ticks only" : STATUS_TEXT[rep.status]}</b></span>
                <span className="muted num">{first} → {last}{rep.spanYears ? ` · ${rep.spanYears} y` : ""}</span></> : <span className="muted">This source has no data for {symbol}.</span>}
              <span className="grow" />
              <button className="btn ghost sm" aria-expanded={explain} onClick={() => setExplain(!explain)}><Info size={14} />What counts as complete?</button>
            </div>
            {explain && <div className="card pad"><DataExplainer /></div>}
            {chosen && (!rep || series.length === 0) && <div className="banner warn" role="alert"><TriangleAlert size={14} /><span>This source has no usable {symbol} data (no bar or tick files were found for it). Saving it would make every run on {symbol} fail. Pick another source.</span></div>}
            {rep?.notes.map((n, i) => <div key={i} className="banner info"><CircleAlert size={14} /><span>{n}</span></div>)}

            <section className="sd-sec">
              <h3>Where {symbol} is read from</h3>
              <div className="sd-sources" role="radiogroup" aria-label={`Source for ${symbol}`}>
                {detail.sources.map((x) => {
                  const on = (source ? x.root === source : x.isDefault);
                  const st = x.report?.status;
                  return (
                    <label key={x.root} className={`sd-src${on ? " on" : ""}${x.report ? "" : " none"}`}>
                      <input type="radio" name="sd-source" checked={on} disabled={!x.report} onChange={() => { setSource(x.isDefault ? "" : x.root); setSeriesKey(""); }} />
                      <Folder size={15} className="ficon dir" />
                      <span className="mono grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={x.root}>{x.root}</span>
                      {x.isDefault && <span className="badge">default</span>}
                      {x.report ? <span className="row" style={{ gap: 4 }}><StatusIcon s={st === "ticks-only" ? "empty" : st!} /><span className="ink2">{st === "ticks-only" ? "ticks only" : STATUS_TEXT[st!]}</span></span> : <span className="muted">no {symbol} here</span>}
                    </label>
                  );
                })}
                <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setPickSource(true)}><Plus size={13} />Add source folder…</button>
              </div>
            </section>

            {rep && (
              <section className="sd-sec">
                <h3>Series in this source</h3>
                <div style={{ overflowX: "auto" }}><table className="tbl sd-tbl">
                  <thead><tr><th>Series</th><th>First → last</th><th className="r">Files</th><th className="r">ok</th><th className="r">closed</th><th className="r">thin</th><th className="r">missing</th><th>Status</th></tr></thead>
                  <tbody>
                    {series.map((x) => {
                      const r = x.r as TfReport;
                      return (
                        <tr key={x.key} className="click" aria-selected={cur?.key === x.key} onClick={() => setSeriesKey(x.key)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSeriesKey(x.key); }}>
                          <td>{x.isTicks ? <Database size={13} className="ficon yaml" /> : <Zap size={13} className="ficon qkt" />} <b>{x.label}</b>{!x.isTicks && <span className="muted"> {r.broker}</span>}</td>
                          <td className="num">{x.r.first} → {x.r.last}</td>
                          <td className="r num">{x.r.files.toLocaleString()}</td>
                          <td className="r num">{x.isTicks ? x.r.files : r.ok}</td>
                          <td className="r num">{x.isTicks ? "–" : r.closed}</td>
                          <td className="r num">{x.isTicks ? "–" : r.thin}</td>
                          <td className={`r num${x.r.missing ? " loss" : ""}`}>{x.r.missing}</td>
                          <td><span className="row" style={{ gap: 4 }}><StatusIcon s={x.r.status} />{STATUS_TEXT[x.r.status]}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
                {/* fixes that need ticks: bars are built into the default source, so they are offered there only */}
                {rep.ticks && !source && (
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {cur && !cur.isTicks && fill > 0 && (
                      <button className="btn sm" onClick={async () => {
                        try { const { jobId } = await api.buildBars({ symbol: symbol!, tf: (cur.r as TfReport).tf, from: rep.ticks!.first!, to: addDays(rep.ticks!.last!, 1) }); useStore.getState().trackJob(jobId, `Fill ${symbol} ${(cur.r as TfReport).tf} bars`); }
                        catch (e) { useStore.getState().toast("error", (e as Error).message); }
                      }} title={`Rebuild the missing ${(cur.r as TfReport).tf} days that tick files cover (days already built are skipped)${cur.r.missing > fill ? `; the other ${cur.r.missing - fill} have no ticks either` : ""}`}><Hammer size={13} />Fill {fill.toLocaleString()} missing {(cur.r as TfReport).tf} day{fill === 1 ? "" : "s"} from ticks</button>
                    )}
                    <button ref={buildBtn} className="btn sm" onClick={() => setBuild(true)}><Plus size={13} />Build another timeframe…</button>
                    <BuildForm open={build} onClose={() => setBuild(false)} anchor={buildBtn} symbol={symbol ?? undefined} />
                  </div>
                )}
                {cur && (
                  <div className="years" role="list" aria-label={`Completeness by year, ${cur.label}`}>
                    {cur.r.years.map((y) => { const c = yearChip(y, cur.r.first, cur.r.last); return (
                      <Tip key={y.year} label={c.title} side="top"><span role="listitem" tabIndex={0} className={`year t-${c.tone}${c.partial ? " partial" : ""}`} aria-label={`${y.year}: ${c.partial ? `partial year, ${c.span}, ` : ""}${y.missing} missing days`}>{y.year}{c.span && <small>{c.span}</small>}</span></Tip>); })}
                  </div>
                )}
              </section>
            )}

            {rep && cur && (
              <section className="sd-sec">
                <h3>Calendar · {cur.label} <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· click a day to start a range, click another to end it</span></h3>
                <div className="legend" aria-hidden="true"><span><i className="hc s-o" />ok</span><span><i className="hc s-c" />closed</span><span><i className="hc s-t" />thin</span><span><i className="hc s-m" />missing</span></div>
                <Heatmap key={heatKey} symbol={symbol!} kind={cur.kind} source={source || undefined} onPick={pick} sel={{ from, to }} />
                {gaps.length > 0 && (
                  <div className="sd-gaps">
                    <b>{gaps.length}{gaps.length >= 40 ? "+" : ""} gap{gaps.length === 1 ? "" : "s"}</b>
                    <span className="muted"> (click one to use the stretch before it)</span>
                    <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {gaps.slice(0, 24).map((g) => <button key={g.from} className="chip" onClick={() => jumpGap(g)}>{g.from}{rangeDays(g) > 1 ? ` → ${addDays(g.to, -1)}` : ""}</button>)}
                    </div>
                  </div>
                )}
                {/* accepting writes day files, so only into the default source (the one builds write to) */}
                {!cur.isTicks && !source && !(cur.r as TfReport).qktReads && (
                  <NoDataPanel symbol={symbol!} broker={(cur.r as TfReport).broker} tf={(cur.r as TfReport).tf} from={from} to={to} missing={cur.r.missing}
                    onChanged={() => { setHeatKey((k) => k + 1); void load(symbol!); void useStore.getState().refreshData(true); }} />
                )}
              </section>
            )}

            <section className="sd-sec">
              <h3>Range strategies may use</h3>
              <div className="grid-2">
                <div className="field"><label htmlFor="sd-from">Start (first day used)</label>
                  <input id="sd-from" className="input" type="date" min={first ?? undefined} max={last ?? undefined} value={from} placeholder={first ?? ""} onChange={(e) => { setFrom(e.target.value); setAnchorDay(null); }} />
                  <div className="hint">{from ? "Custom start." : <>Auto: <b className="num">{first ?? "…"}</b>, the first day found in this source.</>}</div></div>
                <div className="field"><label htmlFor="sd-to">End (exclusive, like qkt --to)</label>
                  <input id="sd-to" className="input" type="date" min={first ?? undefined} max={lastExcl ?? undefined} value={to} onChange={(e) => { setTo(e.target.value); setAnchorDay(null); }} />
                  <div className="hint">{to ? "Custom end: this day itself is NOT included." : <>Auto: <b className="num">{lastExcl ?? "…"}</b>, the day after the last day found ({last}).</>}</div></div>
              </div>
              {(from || to) && <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => { setFrom(""); setTo(""); setAnchorDay(null); }}><RotateCcw size={13} />Back to auto (whole range)</button>}
              {eff.from && eff.to && eff.from >= eff.to && <div className="banner bad"><TriangleAlert size={14} /><span>The start must be before the end.</span></div>}
              {missingInWindow > 0 && <div className="banner warn"><TriangleAlert size={14} /><span>This range contains <b>{missingInWindow}</b> missing day{missingInWindow === 1 ? "" : "s"} in {cur?.label}. Runs over it need “run anyway” in Run settings, or a range that avoids them.</span></div>}
              <div className="hint">Runs are refused outside this range, and the run window is auto-fitted inside it. Saved in the workspace, so it survives restarts.</div>
            </section>

            <section className="sd-sec">
              <h3>Strategies that read {symbol}</h3>
              {users.length === 0 ? <div className="muted">No strategy in the workspace uses {symbol}.</div> : users.map((r) => (
                <div key={r.strategy} className="sd-strat">
                  <button className="link" onClick={() => { void openFile(r.strategy); close(null); }}>{r.strategy.replace(/^strategies\//, "")}</button>
                  {(["bars", "ticks"] as const).map((k) => { const m = r[k]; return (
                    <span key={k} className={`badge ${m.runnable ? "ok" : "bad"}`} title={m.runnable ? `${m.longest!.from} → ${m.longest!.to}` : m.blocked.map((b) => `${b.stream}: ${b.reason}`).join("\n") || "no complete window across all its symbols"}>
                      {m.runnable ? <CircleCheck size={11} /> : <CircleX size={11} />}{k === "bars" ? "Bars" : "Ticks"}{m.longest ? ` ${m.longest.from} → ${m.longest.to}` : ""}</span>); })}
                </div>
              ))}
              {scan && <div className="hint">Runnable windows are the days when every symbol a strategy reads is complete, clipped by the ranges you set here.</div>}
            </section>
          </>
        )}
      </Modal>
      <DataSourceDialog open={pickSource} onClose={() => setPickSource(false)} mode="add" />
    </>
  );
}
