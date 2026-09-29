import { useEffect, useRef, useState } from "react";
import { attentionOf } from "../util/dataStatus.js";
import { useStore } from "../state/store.js";
import { useUi, type Section } from "../state/ui.js";
import { Popover } from "../ui/Popover.js";
import { Tip } from "../ui/Tip.js";
import { ChartColumn, Database, Files, History, Keyboard, Moon, Settings, Sun, Activity } from "../ui/icons.js";

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Files; kbd: string }> = [
  { id: "files", label: "Files", icon: Files, kbd: "Ctrl+1" },
  { id: "data", label: "Data", icon: Database, kbd: "Ctrl+2" },
  { id: "runs", label: "Runs", icon: History, kbd: "Ctrl+3" },
];

export function Rail() {
  const ui = useUi();
  const theme = useStore((s) => s.theme), running = useStore((s) => s.running), jobs = useStore((s) => s.jobs), results = useStore((s) => s.results), scan = useStore((s) => s.scan), setTheme = useStore((s) => s.setTheme);
  const [menu, setMenu] = useState(false);
  const cog = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const jobRunning = jobs.some((j) => j.status === "running");
  const dataProblem = scan ? scan.symbols.some((x) => attentionOf(x) !== null) : false;

  // one Tab stop for the whole rail (the current section, else the last one focused); arrows and Home/End move inside it
  const buttons = () => [...(nav.current?.querySelectorAll<HTMLButtonElement>("button.rail-btn") ?? [])];
  const rove = (to: HTMLButtonElement) => { for (const b of buttons()) b.tabIndex = b === to ? 0 : -1; };
  useEffect(() => {
    const els = buttons();
    if (!els.some((b) => b.tabIndex === 0)) rove(els.find((b) => b.getAttribute("aria-current") === "true") ?? els[0]!);
  });
  const onKey = (e: React.KeyboardEvent) => {
    const els = buttons();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const to = e.key === "ArrowDown" ? (i + 1) % els.length : e.key === "ArrowUp" ? (i - 1 + els.length) % els.length : e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    rove(els[to]!); els[to]!.focus();
  };

  return (
    <nav ref={nav} className="rail" aria-label="Sections" onKeyDown={onKey} onFocus={(e) => { if ((e.target as HTMLElement).matches("button.rail-btn")) rove(e.target as HTMLButtonElement); }}>
      <div className="logo" aria-hidden="true"><Activity size={18} strokeWidth={2.2} /></div>
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        const active = ui.section === s.id;
        return (
          <Tip key={s.id} label={s.label} kbd={s.kbd} side="right">
            <button className="rail-btn" aria-label={s.label} aria-current={active ? "true" : undefined} aria-pressed={active} onClick={() => ui.toggleSection(s.id)}>
              <Icon size={20} strokeWidth={1.75} />
              {s.id === "runs" && running && <span className="pip run" aria-label="a run is in progress" />}
              {s.id === "data" && jobRunning && <span className="pip run" aria-label="a data job is running" />}
              {s.id === "data" && !jobRunning && dataProblem && <span className="pip bad" aria-label="some data is incomplete" />}
            </button>
          </Tip>
        );
      })}
      <Tip label="Journal" kbd="Ctrl+J" side="right">
        <button className="rail-btn" aria-label="Journal" aria-pressed={ui.journalOpen} onClick={() => ui.set({ journalOpen: !ui.journalOpen })}>
          <ChartColumn size={20} strokeWidth={1.75} />
          {results && !ui.journalOpen && <span className="pip" aria-label="results available" />}
        </button>
      </Tip>
      <div className="spacer" />
      <Tip label="Shortcuts" kbd="?" side="right">
        <button className="rail-btn" aria-label="Keyboard shortcuts" onClick={() => ui.set({ shortcuts: true })}><Keyboard size={20} strokeWidth={1.75} /></button>
      </Tip>
      <Tip label={theme === "dark" ? "Switch to light" : "Switch to dark"} side="right">
        <button className="rail-btn" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun size={20} strokeWidth={1.75} /> : <Moon size={20} strokeWidth={1.75} />}
        </button>
      </Tip>
      <Tip label="Preferences" side="right">
        <button ref={cog} className="rail-btn" aria-label="Preferences" aria-expanded={menu} aria-haspopup="dialog" onClick={() => setMenu(!menu)}><Settings size={20} strokeWidth={1.75} /></button>
      </Tip>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={cog} label="Preferences" width={300}>
        <div className="settings-sec">
          <h4>Editor</h4>
          <label className="switch"><input type="checkbox" checked={ui.vim} onChange={(e) => ui.set({ vim: e.target.checked })} /><span className="track" /><span>Vim keybindings</span></label>
          <label className="switch"><input type="checkbox" checked={ui.autosave} onChange={(e) => ui.set({ autosave: e.target.checked })} /><span className="track" /><span>Auto-save after a pause</span></label>
          <div className="row"><span className="ink2 grow">Font size</span>
            <div className="seg sm" role="group" aria-label="Font size">
              <button aria-label="Smaller" onClick={() => ui.set({ fontSize: Math.max(10, ui.fontSize - 1) })}>−</button>
              <button disabled style={{ minWidth: 34 }}>{ui.fontSize}</button>
              <button aria-label="Larger" onClick={() => ui.set({ fontSize: Math.min(22, ui.fontSize + 1) })}>+</button>
            </div>
          </div>
        </div>
        <div className="settings-sec">
          <h4>Layout</h4>
          <div className="row"><span className="ink2 grow">Chart</span>
            <div className="seg sm" role="group" aria-label="Chart position">
              <button aria-pressed={ui.layout === "row"} onClick={() => ui.set({ layout: "row" })}>Beside</button>
              <button aria-pressed={ui.layout === "col"} onClick={() => ui.set({ layout: "col" })}>Below</button>
            </div>
          </div>
          <button className="btn sm" onClick={() => { ui.reset(); setMenu(false); }}>Reset layout</button>
        </div>
      </Popover>
    </nav>
  );
}
