import { useMemo, useRef, useState } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import type { SymbolReport, TfReport } from "../api/types.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";
import { navigateList } from "../util/listNav.js";
import { Tip } from "../ui/Tip.js";
import { CircleCheck, CircleX, CloudDownload, Database, Hammer, Info, Pencil, Plus, RefreshCw, RotateCcw, Wand2 } from "../ui/icons.js";
import { DataExplainer } from "./DataExplainer.js";
import { DataSourceDialog } from "./DataSourceDialog.js";
import { SymbolDialog } from "./SymbolDialog.js";
import { ReadinessCard } from "./ReadinessCard.js";
import { BuildForm, FetchForm, LABEL, MiniYears, StatusIcon } from "./dataParts.js";
import { attentionOf, mainSeries } from "../util/dataStatus.js";

const yr = (iso: string | null | undefined) => iso?.slice(0, 4) ?? "";

/** One line per symbol: status, timeframes, years covered and a year strip; everything else is in its dialog. */
function SymbolLine({ s, used, tabStop, onFocus }: { s: SymbolReport; used: boolean; tabStop: boolean; onFocus(): void }) {
  const pref = useStore((st) => st.settings?.symbolPrefs[s.symbol]);
  const main = mainSeries(s);
  const why = attentionOf(s);
  const anyBars = s.bars.find((b) => b.files > 0);
  const first = main?.first ?? s.ticks?.first ?? anyBars?.first ?? null, last = main?.last ?? s.ticks?.last ?? anyBars?.last ?? null;
  const tfs = s.bars.filter((b) => b.files > 0);
  const years = first ? (yr(first) === yr(last) ? yr(first) : `${yr(first)}–${yr(last).slice(2)}`) : "no data";
  return (
    <div role="listitem">
      <button className={`symline${why ? " attn" : ""}`} data-symbol={s.symbol} tabIndex={tabStop ? 0 : -1} aria-haspopup="dialog"
        aria-label={`${s.symbol}: ${LABEL[s.status]}${why ? `, ${why}` : ""}${used ? ", used by the open strategy" : ""}. Open details`}
        onFocus={(e) => { if (e.target === e.currentTarget) onFocus(); }} onClick={() => useStore.getState().openSymbol(s.symbol)}>
        <span className="sl-top">
          <StatusIcon s={s.status} />
          <b>{s.symbol}</b>
          {used && <span className="badge accent" title="The open strategy reads this symbol">used</span>}
          {(pref?.source || pref?.from || pref?.to) && <span className="badge" title={[pref.source ? `Source: ${pref.source}` : "", pref.from || pref.to ? `Range: ${pref.from ?? "start"} → ${pref.to ?? "end"}` : ""].filter(Boolean).join("\n")}>custom</span>}
          <span className="sl-tfs">{tfs.map((b) => <span key={`${b.broker}${b.tf}`} className={b.qktReads ? "unread" : ""} title={b.qktReads ? `qkt never reads this folder: it looks for ${b.qktReads}` : `${b.broker} ${b.tf} bars`}>{b.tf}{b.qktReads ? "*" : ""}</span>)}{s.ticks && <span title="tick files">ticks</span>}</span>
          <span className="grow" />
          <span className="muted num sl-years">{years}</span>
        </span>
        <span className="sl-bottom">
          {main && <MiniYears years={main.years} first={main.first} last={main.last} />}
          {why && <span className={`sl-why ${s.status === "incomplete" || s.status === "empty" ? "bad" : "warn"}`}>{why}</span>}
        </span>
      </button>
    </div>
  );
}

export function DataSection() {
  const settings = useStore((s) => s.settings), scan = useStore((s) => s.scan), scanning = useStore((s) => s.scanning), refreshData = useStore((s) => s.refreshData);
  const jobs = useStore((s) => s.jobs), activePath = useStore((s) => s.activePath), openFiles = useStore((s) => s.openFiles);
  const [dialog, setDialog] = useState(false);
  const [addDialog, setAddDialog] = useState(false), [explain, setExplain] = useState(false), [busy, setBusy] = useState<null | "reset" | "find">(null);
  const [filter, setFilter] = useState<"all" | "attention">("all");
  const explainBtn = useRef<HTMLButtonElement>(null);
  const resetAll = useStore((s) => s.resetSymbolPrefs), autoFind = useStore((s) => s.autoFindSources);
  const prefs = settings?.symbolPrefs ?? {};
  const customCount = Object.keys(prefs).length;
  const [found, setFound] = useState<Array<{ symbol: string; source: string; days: number }> | null>(null);
  const [buildOpen, setBuildOpen] = useState(false), [fetchOpen, setFetchOpen] = useState(false);
  const buildBtn = useRef<HTMLButtonElement>(null), fetchBtn = useRef<HTMLButtonElement>(null);

  // the symbols the open strategy reads come first, then those needing attention, then the rest
  const readiness = useStore((s) => s.readiness);
  const used = useMemo(() => {
    // readiness follows a portfolio's imports; the open buffer covers a strategy not saved yet
    const r = readiness.find((x) => x.strategy === activePath);
    if (r) return new Set(r.streams.map((s) => s.symbol));
    const f = openFiles.find((x) => x.path === activePath);
    return new Set(f && activePath?.endsWith(".qkt") ? parseStrategyInfo(f.content).streams.map((s) => s.symbol) : []);
  }, [openFiles, activePath, readiness]);
  const all = scan?.symbols ?? [];
  const needs = all.filter((s) => attentionOf(s) !== null);
  const ordered = useMemo(() => [...(filter === "attention" ? needs : all)].sort((a, b) =>
    Number(used.has(b.symbol)) - Number(used.has(a.symbol)) || Number(attentionOf(b) !== null) - Number(attentionOf(a) !== null) || a.symbol.localeCompare(b.symbol)), [scan, filter, used]);

  const symListRef = useRef<HTMLDivElement>(null);
  const [symFocus, setSymFocus] = useState<string | null>(null);
  const symTabStop = ordered.some((s) => s.symbol === symFocus) ? symFocus : ordered[0]?.symbol ?? null;
  const onSymKey = (ev: React.KeyboardEvent) => {
    const row = ev.target as HTMLElement;
    if (!row.dataset.symbol) return;
    const i = ordered.findIndex((s) => s.symbol === row.dataset.symbol);
    const act = navigateList(ordered.length, i, ev.key);
    if (!act || act.focus === undefined) return; // Enter is the button's own native activation, not ours to intercept
    ev.preventDefault();
    symListRef.current?.querySelectorAll<HTMLElement>("[data-symbol]")[act.focus]?.focus();
  };

  return (
    <>
      <div className="side-head">
        <h2>Data</h2>
        <Tip label="What counts as complete?" side="bottom"><button ref={explainBtn} className="btn ghost icon sm" aria-label="What counts as complete?" aria-expanded={explain} onClick={() => setExplain(!explain)}><Info size={14} /></button></Tip>
        <Popover open={explain} onClose={() => setExplain(false)} anchor={explainBtn} width={420} label="What counts as complete"><div className="settings-sec"><h4>What counts as complete?</h4><DataExplainer /></div></Popover>
        <Tip label="Reset every symbol to the default source and its full range" side="bottom"><button className="btn ghost icon sm" aria-label="Reset all symbols to the default source" disabled={busy !== null || customCount === 0} onClick={async () => { setBusy("reset"); try { await resetAll(); setFound(null); } catch (e) { useStore.getState().toast("error", (e as Error).message); } finally { setBusy(null); } }}><RotateCcw size={14} /></button></Tip>
        <Tip label="Auto-find the best source for every symbol" side="bottom"><button className="btn ghost icon sm" aria-label="Auto-find the best source for every symbol" disabled={busy !== null} onClick={async () => { setBusy("find"); try { setFound(await autoFind()); } catch (e) { useStore.getState().toast("error", (e as Error).message); } finally { setBusy(null); } }}><Wand2 size={14} /></button></Tip>
        <Tip label="Rescan the data source" side="bottom"><button className="btn ghost icon sm" aria-label="Rescan data source" onClick={() => void refreshData(true)}><RefreshCw size={14} style={scanning ? { animation: "spin 0.8s linear infinite" } : undefined} /></button></Tip>
      </div>
      <div className="side-scroll">
        <ReadinessCard />

        {busy === "find" && <div className="banner info" role="status" style={{ marginTop: 6 }}><span className="spin" />Comparing every source for every symbol…</div>}
        {found && <div className="banner info" style={{ marginTop: 6, flexDirection: "column", alignItems: "stretch" }}>
          <b>{found.length ? "Auto-find moved:" : "Every symbol is already on its best source."}</b>
          {found.map((c) => <div key={c.symbol} className="mono" style={{ fontSize: "var(--fs-xs)" }}>{c.symbol} → {c.source} ({c.days.toLocaleString()} complete days)</div>)}
        </div>}

        <div className="side-group">
          <h3>Symbols <span className="grow" />
            <button ref={buildBtn} className="btn ghost sm" onClick={() => setBuildOpen(true)}><Hammer size={13} />Build</button>
            <button ref={fetchBtn} className="btn ghost sm" onClick={() => setFetchOpen(true)}><CloudDownload size={13} />Fetch</button>
          </h3>
          <BuildForm open={buildOpen} onClose={() => setBuildOpen(false)} anchor={buildBtn} />
          <FetchForm open={fetchOpen} onClose={() => setFetchOpen(false)} anchor={fetchBtn} />
          {!scan && <div className="empty"><span className="spin" />Scanning…</div>}
          {scan && all.length === 0 && (
            <div className="empty"><Database className="ico-big" /><b>No market data here yet.</b>
              <span>Choose a folder that contains <span className="mono">symbols/</span> or <span className="mono">bars/</span>, or fetch data from a broker.</span>
              <button className="btn primary" onClick={() => setDialog(true)}>Choose data source</button></div>
          )}
          {all.length > 0 && (
            <div className="seg sm sym-filter" role="group" aria-label="Show symbols">
              <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span className="num muted">{all.length}</span></button>
              <button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")} disabled={needs.length === 0}>
                {needs.length ? <CircleX size={12} color="var(--warn)" aria-hidden="true" /> : <CircleCheck size={12} color="var(--ok)" aria-hidden="true" />}Needs attention <span className="num muted">{needs.length}</span></button>
            </div>
          )}
          <div role="list" aria-label="Symbols" ref={symListRef} onKeyDown={onSymKey}>
            {ordered.map((s) => <SymbolLine key={s.symbol} s={s} used={used.has(s.symbol)} tabStop={s.symbol === symTabStop} onFocus={() => setSymFocus(s.symbol)} />)}
          </div>
          {filter === "attention" && needs.length === 0 && <div className="muted rc-note">Every symbol is complete.</div>}
        </div>

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

        <div className="data-foot">
          <div className="row" style={{ gap: 6 }}>
            <span className="muted">Source</span>
            {settings && !(settings.exists && settings.looksLikeStore) && <span className="badge bad">{settings.exists ? "no data found" : "missing"}</span>}
            {customCount > 0 && <span className="badge" title="Symbols read from another source or over a custom range">{customCount} customised</span>}
          </div>
          <div className="mono df-path" title={settings?.dataRoot}>{settings?.dataRoot ?? "…"}</div>
          {settings && settings.sources.length > 0 && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>+ {settings.sources.length} more source{settings.sources.length === 1 ? "" : "s"}: {settings.sources.map((x) => x.split("/").slice(-2).join("/")).join(", ")}</div>}
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <button className="btn ghost sm" onClick={() => setDialog(true)}><Pencil size={13} />Change…</button>
            <button className="btn ghost sm" onClick={() => setAddDialog(true)}><Plus size={13} />Add source…</button>
            {scan && <span className="muted num" style={{ fontSize: "var(--fs-xs)", marginLeft: "auto" }} title={`Scanned in ${scan.ms} ms`}>scanned {new Date(scan.scannedAt).toISOString().slice(11, 16)} UTC</span>}
          </div>
        </div>
      </div>
      <DataSourceDialog open={dialog} onClose={() => setDialog(false)} />
      <DataSourceDialog open={addDialog} onClose={() => setAddDialog(false)} mode="add" />
      <SymbolDialog />
    </>
  );
}
