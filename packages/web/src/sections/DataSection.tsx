import { useMemo, useRef, useState } from "react";
import type { Completeness, SymbolReport, TfReport, TickReport, YearRow } from "../api/types.js";
import { api } from "../api/client.js";
import { rangeDays } from "@qkt-studio/core/ranges";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";
import { Tip } from "../ui/Tip.js";
import { addDays } from "../util/format.js";
import { ChevronRight, CircleAlert, CircleCheck, CircleX, CloudDownload, Database, FileCog, Hammer, Info, Pencil, RefreshCw, RotateCcw, ScanSearch, Wand2, Zap } from "../ui/icons.js";
import { yearChip } from "../util/datawindow.js";
import { DataExplainer } from "./DataExplainer.js";
import { DataSourceDialog } from "./DataSourceDialog.js";
import { SymbolDialog } from "./SymbolDialog.js";

const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
const LABEL: Record<Completeness | "ticks-only", string> = { complete: "Complete", mostly: "Nearly complete", incomplete: "Incomplete", empty: "Empty", "ticks-only": "Ticks only" };
const dotClass = (s: Completeness | "ticks-only") => (s === "complete" ? "ok" : s === "mostly" ? "warn" : s === "incomplete" ? "bad" : s === "ticks-only" ? "run" : "");
const StatusIcon = ({ s }: { s: Completeness | "ticks-only" }) => s === "complete" ? <CircleCheck size={14} color="var(--ok)" /> : s === "mostly" ? <CircleAlert size={14} color="var(--warn)" /> : s === "incomplete" ? <CircleX size={14} color="var(--danger)" /> : <CircleAlert size={14} color="var(--ink-3)" />;

function YearStrip({ years, first, last }: { years: YearRow[]; first: string | null; last: string | null }) {
  if (!years.length) return null;
  return (
    <div className="years" role="list" aria-label="Completeness by year">
      {years.map((y) => {
        const c = yearChip(y, first, last);
        return (
          <Tip key={y.year} label={c.title} side="top">
            <span role="listitem" tabIndex={0} className={`year t-${c.tone}${c.partial ? " partial" : ""}${c.full ? " full" : ""}`}
              aria-label={`${y.year}: ${c.partial ? `partial year (${c.span}), ` : ""}${y.missing} missing days`}>{y.year}{c.span && <small>{c.span}</small>}</span>
          </Tip>
        );
      })}
    </div>
  );
}

function SourceBlock({ label, sub, r, kind, onFill }: { label: string; sub?: string; r: TfReport | TickReport; kind: "bars" | "ticks"; onFill?: () => void }) {
  const [gaps, setGaps] = useState(false);
  const missing = r.missing, span = r.span;
  const longestRun = r.usable.reduce<{ from: string; to: string } | null>((b, u) => (!b || rangeDays(u) > rangeDays(b) ? u : b), null);
  return (
    <div className="src">
      <div className="top">
        {kind === "bars" ? <Zap size={14} className="ficon qkt" /> : <Database size={14} className="ficon yaml" />}
        <b>{label}</b>{sub && <span className="muted">{sub}</span>}
        <span className="grow" />
        <StatusIcon s={r.status} /><span className="ink2">{LABEL[r.status]}</span>
      </div>
      {r.first ? (
        <>
          <div className="muted num" style={{ fontSize: "var(--fs-xs)" }}>{r.first} → {r.last} · {span.toLocaleString()} days · {r.files.toLocaleString()} files{missing ? ` · ` : ""}{missing ? <span className="loss">{missing} missing</span> : null}</div>
          {longestRun && <div className="ink2" style={{ fontSize: "var(--fs-xs)" }}>Longest complete run <b className="num">{longestRun.from} → {longestRun.to}</b> ({rangeDays(longestRun).toLocaleString()} days, {(rangeDays(longestRun) / 365.25).toFixed(1)} y)</div>}
          <YearStrip years={r.years} first={r.first} last={r.last} />
          {r.gaps.length > 0 && (
            <div>
              <button className="btn ghost sm" aria-expanded={gaps} onClick={() => setGaps(!gaps)}><ChevronRight size={13} style={{ transform: gaps ? "rotate(90deg)" : undefined }} />{r.gaps.length}{r.gaps.length >= 40 ? "+" : ""} gap{r.gaps.length === 1 ? "" : "s"}</button>
              {onFill && missing > 0 && <button className="btn sm" style={{ marginLeft: 6 }} onClick={onFill}><Hammer size={13} />Fill gaps</button>}
              {gaps && <div className="mono muted" style={{ fontSize: "var(--fs-xs)", padding: "4px 0 0 4px", columns: 2 }}>{r.gaps.map((g) => <div key={g.from}>{g.from}{rangeDays(g) > 1 ? ` → ${addDays(g.to, -1)}` : ""}</div>)}</div>}
            </div>
          )}
        </>
      ) : <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>No files</div>}
    </div>
  );
}

function BuildForm({ open, onClose, anchor, symbol }: { open: boolean; onClose(): void; anchor: React.RefObject<HTMLElement | null>; symbol?: string }) {
  const scan = useStore((s) => s.scan), trackJob = useStore((s) => s.trackJob);
  const syms = (scan?.symbols ?? []).filter((s) => s.ticks);
  const [sym, setSym] = useState(symbol ?? "");
  const [tf, setTf] = useState("15m");
  const cur = syms.find((s) => s.symbol === (sym || symbol || syms[0]?.symbol));
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const f = from || cur?.ticks?.first || "", t = to || (cur?.ticks?.last ? addDays(cur.ticks.last, 1) : "");
  const go = async () => {
    if (!cur) return;
    try { const { jobId } = await api.buildBars({ symbol: cur.symbol, tf, from: f, to: t }); trackJob(jobId, `Build ${cur.symbol} ${tf} bars`); onClose(); }
    catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={320} label="Build bars">
      <div className="settings-sec">
        <h4>Build bars from ticks</h4>
        {syms.length === 0 ? <div className="hint">No symbol has tick files. Fetch ticks first, or point the data source at a folder that has <span className="mono">symbols/</span>.</div> : (
          <>
            <div className="field"><label htmlFor="bb-sym">Symbol</label><select id="bb-sym" className="select" value={cur?.symbol ?? ""} onChange={(e) => { setSym(e.target.value); setFrom(""); setTo(""); }}>{syms.map((s) => <option key={s.symbol}>{s.symbol}</option>)}</select></div>
            <div className="field"><label htmlFor="bb-tf">Timeframe</label><select id="bb-tf" className="select" value={tf} onChange={(e) => setTf(e.target.value)}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></div>
            <div className="grid-2">
              <div className="field"><label htmlFor="bb-f">From</label><input id="bb-f" className="input" type="date" value={f} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="field"><label htmlFor="bb-t">To</label><input id="bb-t" className="input" type="date" value={t} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div className="hint">Runs <span className="mono">qkt data build-bars</span>. Days already built are skipped, so this also fills gaps. Stop interrupts it and removes any half-written file.</div>
            <button className="btn primary" onClick={() => void go()} disabled={!f || !t}><Hammer size={15} />Build {tf} bars</button>
          </>
        )}
      </div>
    </Popover>
  );
}

function FetchForm({ open, onClose, anchor }: { open: boolean; onClose(): void; anchor: React.RefObject<HTMLElement | null> }) {
  const trackJob = useStore((s) => s.trackJob);
  const [f, setF] = useState({ broker: "EXNESS", symbol: "", tf: "1m", from: "", to: "" });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const go = async () => {
    try { const { jobId } = await api.fetchData(f); trackJob(jobId, `Fetch ${f.broker}:${f.symbol}`); onClose(); }
    catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={320} label="Fetch data">
      <div className="settings-sec">
        <h4>Fetch from a broker</h4>
        <div className="grid-2">
          <div className="field"><label htmlFor="ft-b">Broker</label><input id="ft-b" className="input" value={f.broker} onChange={(e) => set("broker", e.target.value)} /></div>
          <div className="field"><label htmlFor="ft-s">Symbol</label><input id="ft-s" className="input" placeholder="XAUUSD" value={f.symbol} onChange={(e) => set("symbol", e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="ft-tf">Timeframe</label><select id="ft-tf" className="select" value={f.tf} onChange={(e) => set("tf", e.target.value)}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="grid-2">
          <div className="field"><label htmlFor="ft-f">From</label><input id="ft-f" className="input" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></div>
          <div className="field"><label htmlFor="ft-t">To</label><input id="ft-t" className="input" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></div>
        </div>
        <div className="hint">Runs <span className="mono">qkt fetch</span>, which needs network access and credentials for that broker. Nothing is downloaded during a backtest.</div>
        <button className="btn primary" disabled={!f.symbol || !f.from || !f.to} onClick={() => void go()}><CloudDownload size={15} />Fetch</button>
      </div>
    </Popover>
  );
}

function SymbolRow({ s }: { s: SymbolReport }) {
  const [open, setOpen] = useState(false);
  const pref = useStore((s2) => s2.settings?.symbolPrefs[s.symbol]);
  const trackJob = useStore((s2) => s2.trackJob);
  const buildRef = useRef<HTMLButtonElement>(null);
  const [build, setBuild] = useState(false);
  const fill = async (tf: string) => {
    if (!s.ticks?.first || !s.ticks.last) return;
    try { const { jobId } = await api.buildBars({ symbol: s.symbol, tf, from: s.ticks.first, to: addDays(s.ticks.last, 1) }); trackJob(jobId, `Fill ${s.symbol} ${tf} bars`); }
    catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  const built = s.bars.filter((b) => b.files > 0);
  const main = built.reduce<TfReport | null>((b, x) => (!b || x.span > b.span ? x : b), null);
  const first = [main?.first, s.ticks?.first].filter(Boolean).sort()[0] ?? null;
  const last = [main?.last, s.ticks?.last].filter(Boolean).sort().at(-1) ?? null;
  const missing = main?.missing ?? 0, tickMissing = s.ticks?.missing ?? 0;
  const openDialog = () => useStore.getState().openSymbol(s.symbol);
  return (
    <div className="sym">
      <div className="sym-head" role="button" tabIndex={0} aria-haspopup="dialog" aria-label={`${s.symbol}: ${LABEL[s.status]}. Open details`} onClick={openDialog} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } }}>
        <button className="btn ghost icon sm" aria-label={open ? `Hide ${s.symbol} summary` : `Show ${s.symbol} summary`} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          <ChevronRight size={14} className="muted" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform var(--t-fast)" }} /></button>
        <span className="sym-status" title={LABEL[s.status]}><StatusIcon s={s.status} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <b>{s.symbol}</b><span className="ink2" style={{ fontSize: "var(--fs-xs)" }}>{LABEL[s.status]}</span>
            <span className="badge" title={s.market === "24/7" ? "Trades every day: any empty day is a gap" : "Weekends and holidays are closed, not gaps"}>{s.market}</span>
            {(pref?.source || pref?.from || pref?.to) && <span className="badge accent" title={[pref.source ? `Source: ${pref.source}` : "", pref.from || pref.to ? `Range: ${pref.from ?? "start"} → ${pref.to ?? "end"}` : ""].filter(Boolean).join("\n")}>{pref.source && (pref.from || pref.to) ? "custom source + range" : pref.source ? "custom source" : "custom range"}</span>}
          </div>
          <div className="muted num" style={{ fontSize: "var(--fs-xs)" }}>
            {first ? `${first} → ${last}` : "no data"}{s.completeYears ? ` · ${s.completeYears} full yr` : ""}{missing ? <> · <span className="loss">{missing} missing</span></> : ""}{tickMissing ? <> · <span className={main ? "muted" : "loss"}>ticks: {tickMissing} missing</span></> : ""}{built.length ? ` · ${built.map((b) => b.tf).join(" ")}` : ""}{s.ticks ? " · ticks" : ""}
          </div>
        </div>
      </div>
      {open && (
        <div className="sym-body">
          {s.notes.map((n, i) => <div key={i} className="banner info" style={{ fontSize: "var(--fs-xs)" }}><CircleAlert size={14} /><span>{n}</span></div>)}
          {s.ticks && <SourceBlock label="Ticks" sub={s.ticks.source} r={s.ticks} kind="ticks" />}
          {built.map((b) => <SourceBlock key={`${b.broker}${b.tf}`} label={b.tf} sub={b.broker} r={b} kind="bars" onFill={s.ticks ? () => void fill(b.tf) : undefined} />)}
          <div className="row"><button className="btn sm" onClick={openDialog}>Details, calendar and range…</button>
            {s.ticks && <><button ref={buildRef} className="btn sm" onClick={() => setBuild(true)}><Hammer size={13} />Build another timeframe…</button><BuildForm open={build} onClose={() => setBuild(false)} anchor={buildRef} symbol={s.symbol} /></>}</div>
        </div>
      )}
    </div>
  );
}

export function DataSection() {
  const settings = useStore((s) => s.settings), scan = useStore((s) => s.scan), scanning = useStore((s) => s.scanning), readiness = useStore((s) => s.readiness), refreshData = useStore((s) => s.refreshData);
  const cfg = useStore((s) => s.cfg), setCfg = useStore((s) => s.setCfg), jobs = useStore((s) => s.jobs), activePath = useStore((s) => s.activePath);
  const [dialog, setDialog] = useState(false);
  const [addDialog, setAddDialog] = useState(false), [explain, setExplain] = useState(false), [busy, setBusy] = useState<null | "reset" | "find">(null);
  const explainBtn = useRef<HTMLButtonElement>(null);
  const resetAll = useStore((s) => s.resetSymbolPrefs), autoFind = useStore((s) => s.autoFindSources);
  const prefs = settings?.symbolPrefs ?? {};
  const customCount = Object.keys(prefs).length;
  const [found, setFound] = useState<Array<{ symbol: string; source: string; days: number }> | null>(null);
  const [buildOpen, setBuildOpen] = useState(false), [fetchOpen, setFetchOpen] = useState(false);
  const buildBtn = useRef<HTMLButtonElement>(null), fetchBtn = useRef<HTMLButtonElement>(null);
  const t = scan?.totals;
  const attention = t ? t.incomplete + t.ticksOnly : 0;
  const ordered = useMemo(() => [...(scan?.symbols ?? [])].sort((a, b) => Number(a.status === "complete") - Number(b.status === "complete") || a.symbol.localeCompare(b.symbol)), [scan]);

  return (
    <>
      <div className="side-head">
        <h2>Data</h2>
        <Tip label="What counts as complete?" side="bottom"><button ref={explainBtn} className="btn ghost icon sm" aria-label="What counts as complete?" aria-expanded={explain} onClick={() => setExplain(!explain)}><Info size={14} /></button></Tip>
        <Popover open={explain} onClose={() => setExplain(false)} anchor={explainBtn} width={420} label="What counts as complete"><div className="settings-sec"><h4>What counts as complete?</h4><DataExplainer /></div></Popover>
        <Tip label="Reset every symbol to the default source and its full range" side="bottom"><button className="btn ghost icon sm" aria-label="Reset all symbols to the default source" disabled={busy !== null || customCount === 0} onClick={async () => { setBusy("reset"); try { await resetAll(); setFound(null); } catch (e) { useStore.getState().toast("error", (e as Error).message); } finally { setBusy(null); } }}><RotateCcw size={14} /></button></Tip>
        <Tip label="Auto-find the best source for every symbol" side="bottom"><button className="btn ghost icon sm" aria-label="Auto-find the best source for every symbol" disabled={busy !== null} onClick={async () => { setBusy("find"); try { setFound(await autoFind()); } catch (e) { useStore.getState().toast("error", (e as Error).message); } finally { setBusy(null); } }}><Wand2 size={14} /></button></Tip>
        <Tip label="Rescan the data source" side="bottom"><button className="btn ghost icon sm" aria-label="Rescan data source" onClick={() => void refreshData(true)}><RefreshCw size={14} className={scanning ? "spin-icon" : ""} style={scanning ? { animation: "spin 0.8s linear infinite" } : undefined} /></button></Tip>
      </div>
      <div className="side-scroll">
        <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <div className="row"><span className="ink2" style={{ fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Data source</span><span className="grow" />
            {settings?.fromSettings && <span className="badge">custom</span>}
            {settings && (settings.exists && settings.looksLikeStore ? <span className="badge ok"><CircleCheck size={12} />qkt store</span> : <span className="badge bad"><CircleX size={12} />{settings.exists ? "no data found" : "missing"}</span>)}
          </div>
          <div className="mono" style={{ wordBreak: "break-all", fontSize: "var(--fs-sm)" }} title="Every symbol is read from here unless you point it elsewhere">{settings?.dataRoot ?? "…"}</div>
          <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>Default source for every symbol{customCount ? ` · ${customCount} symbol${customCount === 1 ? "" : "s"} customised` : ""}</div>
          {settings && settings.sources.length > 0 && <div className="src-list">{settings.sources.map((x) => <span key={x} className="chip mono" title={x}>{x.split("/").slice(-2).join("/")}</span>)}</div>}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => setDialog(true)}><Pencil size={13} />Change…</button>
            <button className="btn sm" onClick={() => void refreshData(true)} disabled={scanning}><ScanSearch size={13} />{scanning ? "Scanning…" : "Rescan"}</button>
            <button className="btn sm" onClick={() => setAddDialog(true)}>Add source…</button>
          </div>
          {scan && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>Scanned in {scan.ms} ms · {new Date(scan.scannedAt).toLocaleTimeString()}</div>}
        </div>

        {t && t.symbols > 0 && (
          <>
          <div className="stat-tiles" style={{ marginTop: "var(--s3)" }}>
            <div className="stat-tile"><b>{t.symbols}</b><span>symbols</span></div>
            <div className="stat-tile"><b style={{ color: attention ? "var(--warn)" : "var(--ok)" }}>{t.complete}<span style={{ color: "var(--ink-3)", fontWeight: 400 }}> / {t.symbols}</span></b><span>complete</span></div>
            <div className="stat-tile"><b style={{ color: t.mostly ? "var(--warn)" : undefined }}>{t.mostly}</b><span>nearly complete</span></div>
            <div className="stat-tile"><b style={{ color: t.incomplete ? "var(--danger)" : undefined }}>{t.incomplete}</b><span>incomplete</span></div>
          </div>
          <div className="muted" style={{ fontSize: "var(--fs-xs)", marginTop: 6 }}>{t.barFiles.toLocaleString()} bar files · {t.tickFiles.toLocaleString()} tick files · <button className="link" onClick={() => setExplain(true)}>what counts as complete?</button></div>
          {busy === "find" && <div className="banner info" role="status" style={{ marginTop: 6 }}><span className="spin" />Comparing every source for every symbol…</div>}
          {found && <div className="banner info" style={{ marginTop: 6, flexDirection: "column", alignItems: "stretch" }}>
            <b>{found.length ? "Auto-find moved:" : "Every symbol is already on its best source."}</b>
            {found.map((c) => <div key={c.symbol} className="mono" style={{ fontSize: "var(--fs-xs)" }}>{c.symbol} → {c.source} ({c.days.toLocaleString()} complete days)</div>)}
          </div>}
          </>
        )}

        <div className="side-group">
          <h3>Symbols <span className="grow" />
            <button ref={buildBtn} className="btn ghost sm" onClick={() => setBuildOpen(true)}><Hammer size={13} />Build</button>
            <button ref={fetchBtn} className="btn ghost sm" onClick={() => setFetchOpen(true)}><CloudDownload size={13} />Fetch</button>
          </h3>
          <BuildForm open={buildOpen} onClose={() => setBuildOpen(false)} anchor={buildBtn} />
          <FetchForm open={fetchOpen} onClose={() => setFetchOpen(false)} anchor={fetchBtn} />
          {!scan && <div className="empty"><span className="spin" />Scanning…</div>}
          {scan && ordered.length === 0 && (
            <div className="empty"><Database className="ico-big" /><b>No market data here yet.</b>
              <span>Choose a folder that contains <span className="mono">symbols/</span> or <span className="mono">bars/</span>, or fetch data from a broker.</span>
              <button className="btn primary" onClick={() => setDialog(true)}>Choose data source</button></div>
          )}
          {ordered.map((s) => <SymbolRow key={s.symbol} s={s} />)}
        </div>

        {readiness.length > 0 && (
          <div className="side-group">
            <h3>Strategy coordination <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· what each can run on</span></h3>
            {readiness.map((r) => {
              const name = r.strategy.replace(/^strategies\//, "");
              const cur = cfg.tier === "draft" ? r.bars : r.ticks;
              return (
                <div key={r.strategy} className="list-row" role="button" tabIndex={0} aria-selected={activePath === r.strategy} style={{ alignItems: "flex-start", padding: "var(--s2)" }}
                  onClick={() => { void useStore.getState().openFile(r.strategy); if (cur.longest) setCfg({ from: cur.longest.from, to: cur.longest.to }); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { void useStore.getState().openFile(r.strategy); if (cur.longest) setCfg({ from: cur.longest.from, to: cur.longest.to }); } }}
                  title="Open it and use its longest complete window">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b style={{ fontWeight: 600 }}>{name}</b>
                    <div className="row" style={{ gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                      <Tip label={r.bars.runnable ? `Runs on bars: ${r.bars.longest!.from} → ${r.bars.longest!.to}` : r.bars.blocked.map((b) => `${b.stream}: ${b.reason}`).join("\n") || "no complete window"} side="top">
                        <span className={`badge ${r.bars.runnable ? "ok" : "bad"}`}>{r.bars.runnable ? <CircleCheck size={11} /> : <CircleX size={11} />}Bars</span></Tip>
                      <Tip label={r.ticks.runnable ? `Runs on ticks: ${r.ticks.longest!.from} → ${r.ticks.longest!.to}` : r.ticks.blocked.map((b) => `${b.stream}: ${b.reason}`).join("\n") || "no complete window"} side="top">
                        <span className={`badge ${r.ticks.runnable ? "ok" : "bad"}`}>{r.ticks.runnable ? <CircleCheck size={11} /> : <CircleX size={11} />}Ticks</span></Tip>
                    </div>
                    <div className="muted num" style={{ fontSize: "var(--fs-xs)", marginTop: 2 }}>{cur.longest ? `${cur.longest.from} → ${cur.longest.to} · ${rangeDays(cur.longest).toLocaleString()} d (${(rangeDays(cur.longest) / 365.25).toFixed(1)} y)` : cur.blocked[0] ? `${cur.blocked[0].stream}: ${cur.blocked[0].reason}` : "no window where every symbol is complete"}</div>
                    {cur.ranges.length > 1 && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{cur.ranges.length} complete windows</div>}
                    {cur.blocked.filter((b) => b.fix).slice(0, 2).map((b) => <div key={b.stream} className="row" style={{ gap: 6, fontSize: "var(--fs-xs)", marginTop: 2 }}><CircleX size={11} color="var(--danger)" /><span className="ink2">{b.stream}: {b.reason}</span><span className="badge">{b.fix === "build-bars" ? "Build bars" : "Fetch"}</span></div>)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {jobs.length > 0 && (
          <div className="side-group">
            <h3>Jobs</h3>
            {jobs.slice(0, 5).map((j) => (
              <div key={j.id} className="row" style={{ padding: "4px var(--s2)", gap: 8 }}>
                {j.status === "running" ? <span className="spin" /> : <span className={`dot ${j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}`} />}
                <div style={{ minWidth: 0 }}><div style={{ fontSize: "var(--fs-sm)" }}>{j.label}</div>{j.message && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{j.message}</div>}</div>
              </div>
            ))}
          </div>
        )}
        <div className="side-group">
          <h3>Configure</h3>
          <div className="muted" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.5 }}>Contract size, lot rules, commission and swap per symbol live in <button className="link" onClick={() => void useStore.getState().openFile("instruments.yaml")}><FileCog size={12} /> instruments.yaml</button>. Balance, risk halts and execution model are in <button className="link" onClick={() => void useStore.getState().openFile("qkt.config.yaml")}><FileCog size={12} /> qkt.config.yaml</button>; secrets and variables in <button className="link" onClick={() => void useStore.getState().openFile(".env")}><FileCog size={12} /> .env</button>.</div>
        </div>
      </div>
      <DataSourceDialog open={dialog} onClose={() => setDialog(false)} />
      <DataSourceDialog open={addDialog} onClose={() => setAddDialog(false)} mode="add" />
      <SymbolDialog />
    </>
  );
}
