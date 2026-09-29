import { useRef, useState } from "react";
import { usesIntrabarOrders } from "@qkt-studio/core/strategy";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { Menu, Popover, type MenuEntry } from "../ui/Popover.js";
import { Tip } from "../ui/Tip.js";
import { addDays, daysBetween, fmtDur } from "../util/format.js";
import { Square, CalendarDays, ChevronDown, RefreshCw, ChevronRight, CircleAlert, CircleCheck, Layers, OctagonX, Play, Search, SlidersHorizontal, TriangleAlert, Zap, Database } from "../ui/icons.js";
import { RunSettings } from "./RunSettings.js";

const fmtChip = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Run split-button, Stop and kill. One place, always visible, so nobody has to go through a terminal. */
function RunControls({ openSettings }: { openSettings(): void }) {
  const ui = useUi();
  const running = useStore((s) => s.running), progress = useStore((s) => s.progress), cfg = useStore((s) => s.cfg), jobs = useStore((s) => s.jobs);
  const strategy = useStore((s) => s.strategyPath());
  const results = useStore((s) => s.results);
  const store = useStore.getState;
  const [menu, setMenu] = useState(false);
  const chev = useRef<HTMLButtonElement>(null);
  const jobsRunning = jobs.filter((j) => j.status === "running").length;
  const busy = running || jobsRunning > 0;
  const bad = !strategy || !cfg.from || !cfg.to || daysBetween(cfg.from, cfg.to) <= 0;

  const items: MenuEntry[] = [
    { id: "bars", label: "Run on bars (fast)", icon: <Zap size={15} />, onSelect: () => { store().setCfg({ tier: "draft" }); void store().startRun({ tier: "draft" }); } },
    { id: "ticks", label: "Run on ticks (accurate)", icon: <Database size={15} />, onSelect: () => { store().setCfg({ tier: "full" }); void store().startRun({ tier: "full" }); } },
    { id: "verify", label: "Re-run this window on ticks", icon: <CircleCheck size={15} />, disabled: !results || results.meta.tier === "full", onSelect: () => void store().startRun({ tier: "full" }) },
    { id: "force", label: "Run again, ignoring the cache", icon: <Play size={15} />, onSelect: () => void store().startRun({ force: true }) },
    { id: "lab", label: "Grid, walk-forward, Monte Carlo…", icon: <ChevronRight size={15} />, separatorBefore: true, onSelect: () => ui.openJournal("lab") },
    { id: "settings", label: "Run settings…", icon: <SlidersHorizontal size={15} />, hint: "Ctrl+,", onSelect: openSettings },
  ];

  if (busy) {
    return (
      <div className="row">
        <AutoToggle />
        <span className="ink2 nowrap hide-md row" style={{ gap: 6 }}>
          <span className="spin" />
          {running ? (progress ? `${progress.phase} · ${fmtDur(progress.elapsedMs)}${progress.etaMs ? ` · ~${fmtDur(progress.etaMs)} left` : ""}` : "starting…") : `${jobsRunning} data job${jobsRunning > 1 ? "s" : ""}`}
        </span>
        {running
          ? <Tip label="Stop this run and delete its files (Ctrl+. stops everything)" side="bottom">
              <button className="btn danger" aria-label="Stop this run and delete its files" onClick={() => void store().stopRun()}><Square size={14} fill="currentColor" />Stop</button>
            </Tip>
          : <Tip label="Stop the running data job and remove its partial files" kbd="Ctrl+." side="bottom">
              <button className="btn danger" onClick={() => void store().killAll()}><OctagonX size={16} />Stop</button>
            </Tip>}
      </div>
    );
  }
  return (
    <>
      <AutoToggle />
      <div className="split-btn">
        <Tip label="Run the open strategy" kbd="Ctrl+Enter" side="bottom">
          <button className="btn primary" disabled={bad} onClick={() => void store().startRun()}><Play size={15} fill="currentColor" />Run</button>
        </Tip>
        <button ref={chev} className="btn primary" aria-label="More run options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><ChevronDown size={16} /></button>
      </div>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={chev} align="end" label="Run options"><Menu items={items} onDone={() => setMenu(false)} /></Popover>
    </>
  );
}

/** Run on every save: the fast loop for iterating on a strategy (bars only; ticks are too slow to re-run per keystroke). */
function AutoToggle() {
  const on = useStore((s) => s.cfg.autoRun), setCfg = useStore((s) => s.setCfg);
  return (
    <Tip label={on ? "Auto-run is on: every save re-runs the strategy on bars. Click to turn off." : "Auto-run is off. Click to re-run on bars every time you save."} side="bottom">
      <button className="btn ghost auto-toggle" aria-pressed={on} onClick={() => setCfg({ autoRun: !on })}>
        <RefreshCw size={14} aria-hidden="true" />Auto
      </button>
    </Tip>
  );
}

export function TopBar() {
  const ui = useUi();
  const cfg = useStore((s) => s.cfg), setCfg = useStore((s) => s.setCfg);
  const strategy = useStore((s) => s.strategyPath());
  const file = useStore((s) => s.openFiles.find((f) => f.path === s.strategyPath()));
  const readiness = useStore((s) => s.readiness);
  const chipRef = useRef<HTMLButtonElement>(null);
  const span = cfg.from && cfg.to ? daysBetween(cfg.from, cfg.to) : 0;
  const approx = cfg.tier === "draft" && !!file && usesIntrabarOrders(file.content);
  const ready = readiness.find((r) => r.strategy === strategy);
  const mode = cfg.tier === "draft" ? ready?.bars : ready?.ticks;
  const inside = !!mode?.ranges.some((r) => cfg.from >= r.from && cfg.to <= r.to);
  const parts = (strategy ?? "").split("/");

  return (
    <header className="topbar">
      <div className="crumb" aria-label="Open strategy">
        {parts.length > 1 && <><span className="hide-md">{parts.slice(0, -1).join(" / ")}</span><ChevronRight size={14} className="hide-md" /></>}
        <b title={strategy ?? ""}>{parts[parts.length - 1] || "No strategy open"}</b>
        {file && file.content !== file.saved && <span className="dot" title="Unsaved changes" style={{ background: "var(--ink-2)" }} />}
        {ready?.kind === "portfolio" && (
          <Tip label={`Portfolio of ${ready.members?.length ?? 0} strategies: ${ready.members?.map((m) => m.alias).join(", ")}`} side="bottom">
            <span className="badge hide-md" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Layers size={12} />{ready.members?.length ?? 0} strategies</span>
          </Tip>
        )}
      </div>

      <div className="seg" role="group" aria-label="Data used to run">
        <Tip label="Uses the bars built from your ticks. Seconds per month. Stops and targets are approximated." side="bottom">
          <button aria-pressed={cfg.tier === "draft"} onClick={() => setCfg({ tier: "draft" })}><Zap size={14} />Bars</button>
        </Tip>
        <Tip label="Replays every tick. Slower (tens of seconds per month) and the reference result." side="bottom">
          <button aria-pressed={cfg.tier === "full"} onClick={() => setCfg({ tier: "full" })}><Database size={14} />Ticks</button>
        </Tip>
      </div>

      <Tip label="Run window and settings" kbd="Ctrl+," side="bottom">
        <button ref={chipRef} className="chipbtn" aria-haspopup="dialog" aria-expanded={ui.runSettings} onClick={() => ui.set({ runSettings: !ui.runSettings })}>
          <CalendarDays size={15} />
          {cfg.from && cfg.to ? <span><b>{fmtChip(cfg.from)}</b> <span className="hide-sm">→ <b>{fmtChip(addDays(cfg.to, -1))}</b></span> <span className="muted hide-md">· {span}d</span></span> : <span>Set window</span>}
          {mode && cfg.from && (inside ? <CircleCheck size={14} color="var(--ok)" aria-label="Data is complete for this window" /> : <CircleAlert size={14} color="var(--warn)" aria-label="This window is not fully covered by complete data" />)}
          <SlidersHorizontal size={14} className="muted" />
        </button>
      </Tip>
      {approx && <Tip label="This strategy uses stops, targets or brackets. Bars approximate their fills; verify on ticks." side="bottom"><span className="badge warn hide-md"><TriangleAlert size={12} />stops on bars ≈</span></Tip>}

      <span className="sep" />
      <RunControls openSettings={() => ui.set({ runSettings: true })} />
      <Tip label="Search commands and files" kbd="Ctrl+K" side="bottom">
        <button className="btn ghost icon" aria-label="Command palette" onClick={() => ui.set({ palette: true })}><Search size={16} /></button>
      </Tip>
      <RunSettingsHost anchor={chipRef} />
    </header>
  );
}

function RunSettingsHost({ anchor }: { anchor: React.RefObject<HTMLElement | null> }) {
  const ui = useUi();
  return <Popover open={ui.runSettings} onClose={() => ui.set({ runSettings: false })} anchor={anchor} align="end" width={420} label="Run settings"><RunSettings /></Popover>;
}
