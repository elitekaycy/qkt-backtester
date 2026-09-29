import { useEffect, useRef } from "react";
import { useStore } from "../state/store.js";
import { useUi, type JournalSection } from "../state/ui.js";
import { Tip } from "../ui/Tip.js";
import { fmtNum } from "../util/format.js";
import { Calendar, CalendarDays, ChartColumn, Clock, Dices, GitCompare, LayoutGrid, Layers, ListChecks, Maximize2, Minimize2, Play, X } from "../ui/icons.js";
import { CalendarView, DailyView, MonthlyView } from "./Calendar.js";
import { Compare } from "./Compare.js";
import { FilterBar } from "./FilterBar.js";
import { Lab } from "./Lab.js";
import { Overview } from "./Overview.js";
import { Strategies } from "./Strategies.js";
import { TimeRisk } from "./TimeRisk.js";
import { TradesView } from "./TradesView.js";
import { AnalyticsProvider } from "./useAnalytics.js";

const NAV: Array<{ id: JournalSection; label: string; icon: typeof ChartColumn; filters: boolean; hint: string }> = [
  { id: "overview", label: "Overview", icon: LayoutGrid, filters: true, hint: "The headline numbers and how the equity got there" },
  { id: "strategies", label: "Strategies", icon: Layers, filters: true, hint: "Contribution, equity and risk per strategy" },
  { id: "calendar", label: "Calendar", icon: CalendarDays, filters: true, hint: "Every day's P&L, week by week" },
  { id: "daily", label: "Daily", icon: Calendar, filters: true, hint: "P&L per trading day" },
  { id: "monthly", label: "Monthly", icon: ChartColumn, filters: true, hint: "P&L, trades and win rate per month" },
  { id: "trades", label: "Trades", icon: ListChecks, filters: true, hint: "Every round trip, filtered and analysed" },
  { id: "time", label: "Time & risk", icon: Clock, filters: true, hint: "When you win, and how much you risk" },
  { id: "lab", label: "Optimize", icon: Dices, filters: false, hint: "Parameter grid, walk-forward and Monte Carlo: which settings work, and whether it holds up" },
  { id: "compare", label: "Compare", icon: GitCompare, filters: false, hint: "Runs side by side" },
];

const Body = ({ id }: { id: JournalSection }) => id === "overview" ? <Overview /> : id === "strategies" ? <Strategies /> : id === "calendar" ? <CalendarView /> : id === "daily" ? <DailyView /> : id === "monthly" ? <MonthlyView /> : id === "trades" ? <TradesView /> : id === "time" ? <TimeRisk /> : id === "lab" ? <Lab /> : <Compare />;

/** The trading journal: a resizable slide-over with its own menu. Everything inside reacts to the shared filters. */
export function Journal({ containerWidth }: { containerWidth: number }) {
  const ui = useUi();
  const results = useStore((s) => s.results), run = useStore((s) => s.run), stale = useStore((s) => s.resultsStale);
  const startRun = useStore((s) => s.startRun);
  const opener = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const multi = (results?.meta.strategies.length ?? 0) > 1;
  const nav = NAV.filter((n) => n.id !== "strategies" || multi);
  const sec = nav.find((n) => n.id === ui.journalSection) ?? nav[0]!;
  const width = ui.journalMax ? containerWidth : Math.min(containerWidth, Math.max(720, ui.journalW || Math.round(containerWidth * 0.74)));

  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => navRef.current?.querySelector<HTMLElement>("[aria-current='page']")?.focus(), 60);
    const key = (e: KeyboardEvent) => {
      // Esc closes, unless something on top of the journal (a popover, a dialog, an open suggestion list) is using it
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".popover, .modal")) { ui.set({ journalOpen: false }); return; }
      // the journal is modal: Tab stays inside it
      if (e.key === "Tab" && drawer.current && !document.querySelector(".popover, .modal")) {
        const f = [...drawer.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex='0']")].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!, at = document.activeElement;
        if (!drawer.current.contains(at)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => { clearTimeout(t); window.removeEventListener("keydown", key); opener.current?.focus?.(); };
  }, []);

  const grip = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => ui.set({ journalMax: false, journalW: Math.round(Math.min(containerWidth, Math.max(720, startW + (startX - ev.clientX)))) });
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); document.body.classList.remove("resizing", "v"); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); document.body.classList.add("resizing", "v");
  };

  return (
    <>
      <div className="scrim" data-testid="journal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) ui.set({ journalOpen: false }); }} aria-hidden="true" />
      <div ref={drawer} className="drawer" role="dialog" aria-modal="true" aria-label={`Journal: ${sec.label}`} style={{ width }}>
        <div className="drawer-grip" role="separator" aria-orientation="vertical" aria-label="Resize journal" aria-valuenow={Math.round(width)} aria-valuemin={720} aria-valuemax={containerWidth} tabIndex={0} onPointerDown={grip} onDoubleClick={() => ui.set({ journalW: 0, journalMax: false })}
          onKeyDown={(e) => { if (e.key === "ArrowLeft") ui.set({ journalMax: false, journalW: Math.min(containerWidth, width + 48) }); else if (e.key === "ArrowRight") ui.set({ journalMax: false, journalW: Math.max(720, width - 48) }); }} />
        <nav className="jnav" aria-label="Journal sections" ref={navRef}>
          <h2><ChartColumn size={20} color="var(--accent-ink)" /><span>Journal</span></h2>
          {nav.map((n) => { const Icon = n.icon; return (
            <button key={n.id} className="jnav-btn" title={n.label} aria-label={n.label} aria-current={n.id === ui.journalSection ? "page" : undefined} onClick={() => ui.set({ journalSection: n.id })}><Icon size={17} strokeWidth={1.75} /><span>{n.label}</span></button>
          ); })}
          <div className="foot">{results ? <>{results.summary.trades} trades · {fmtNum(results.summary.fills, 0)} fills<br />{results.meta.tier === "full" ? "Ticks" : "Bars"} · {results.meta.from} → {results.meta.to}</> : "No run loaded"}</div>
        </nav>
        <div className="jmain">
          <div className="jhead">
            <div style={{ minWidth: 0, flex: 1 }}><h1>{sec.label}</h1><div className="muted" style={{ fontSize: "var(--fs-sm)" }}>{sec.hint}</div></div>
            {stale && <span className="badge warn">updating…</span>}
            <Tip label={ui.journalMax ? "Restore width" : "Full width"} side="bottom"><button className="btn ghost icon" aria-label={ui.journalMax ? "Restore width" : "Full width"} onClick={() => ui.set({ journalMax: !useUi.getState().journalMax })}>{ui.journalMax ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></Tip>
            <Tip label="Close" kbd="Esc" side="bottom"><button className="btn ghost icon" aria-label="Close journal" onClick={() => ui.set({ journalOpen: false })}><X size={17} /></button></Tip>
          </div>
          {!results ? (
            <div className="empty" style={{ flex: 1, justifyContent: "center" }}><ChartColumn className="ico-big" /><b>{run?.status === "failed" ? "The last run failed" : "No results yet"}</b>
              The journal fills in as soon as a run finishes: calendar, daily and monthly P&L, win rate, profit factor, trade analysis.
              <button className="btn primary" onClick={() => { ui.set({ journalOpen: false }); void startRun(); }}><Play size={14} fill="currentColor" />Run the strategy</button></div>
          ) : (
            <AnalyticsProvider>
              {sec.filters && <FilterBar />}
              <div className="jbody" key={sec.id}><Body id={sec.id} /></div>
            </AnalyticsProvider>
          )}
        </div>
      </div>
    </>
  );
}
