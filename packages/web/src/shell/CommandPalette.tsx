import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store.js";
import { useUi, type JournalSection } from "../state/ui.js";
import { Modal } from "../ui/Modal.js";
import { FileCode2, Play, Search } from "../ui/icons.js";

interface Cmd { id: string; label: string; hint?: string; group: string; run(): void }

const score = (q: string, s: string) => {
  if (!q) return 1;
  const t = s.toLowerCase(), n = q.toLowerCase();
  if (t.includes(n)) return 2 + 1 / (1 + t.indexOf(n));
  let i = 0; for (const c of t) if (c === n[i]) i++;
  return i === n.length ? 1 : 0;
};

export function CommandPalette() {
  const ui = useUi();
  const store = useStore.getState;
  const tree = useStore((s) => s.tree), theme = useStore((s) => s.theme);
  const [q, setQ] = useState(""), [sel, setSel] = useState(0);
  useEffect(() => { if (ui.palette) { setQ(""); setSel(0); } }, [ui.palette]);
  const close = () => ui.set({ palette: false });

  const cmds = useMemo<Cmd[]>(() => {
    const j = (id: JournalSection, label: string): Cmd => ({ id: `j-${id}`, label: `Journal: ${label}`, group: "Journal", run: () => ui.openJournal(id) });
    const files: Cmd[] = Object.values(tree).flat().filter((e) => e.type === "file" && !e.path.startsWith("runs/")).map((e) => ({ id: `f-${e.path}`, label: e.path, group: "Files", run: () => void store().openFile(e.path) }));
    return [
      { id: "run", label: "Run the open strategy", hint: "Ctrl+Enter", group: "Run", run: () => void store().startRun() },
      { id: "bars", label: "Run on bars (fast)", group: "Run", run: () => { store().setCfg({ tier: "draft" }); void store().startRun({ tier: "draft" }); } },
      { id: "ticks", label: "Run on ticks (accurate)", group: "Run", run: () => { store().setCfg({ tier: "full" }); void store().startRun({ tier: "full" }); } },
      { id: "stop", label: "Stop everything and remove partial output", hint: "Ctrl+.", group: "Run", run: () => void store().killAll() },
      { id: "settings", label: "Run settings", hint: "Ctrl+,", group: "Run", run: () => ui.set({ runSettings: true }) },
      j("overview", "Overview"), j("calendar", "Calendar"), j("daily", "Daily"), j("monthly", "Monthly"), j("trades", "Trades"), j("time", "Time & risk"), j("lab", "Robustness (Monte Carlo, grid, walk-forward)"), j("compare", "Compare runs"),
      { id: "files", label: "Show Files", hint: "Ctrl+1", group: "View", run: () => ui.set({ section: "files" }) },
      { id: "data", label: "Show Data source and coverage", hint: "Ctrl+2", group: "View", run: () => ui.set({ section: "data" }) },
      { id: "runs", label: "Show Runs", hint: "Ctrl+3", group: "View", run: () => ui.set({ section: "runs" }) },
      { id: "max-editor", label: "Full screen the editor", group: "View", run: () => ui.toggleMax("editor") },
      { id: "max-chart", label: "Full screen the chart", group: "View", run: () => ui.toggleMax("chart") },
      { id: "max-dock", label: "Full screen the output panel", group: "View", run: () => ui.toggleMax("dock") },
      { id: "max-side", label: "Full screen the sidebar", group: "View", run: () => ui.toggleMax("sidebar") },
      { id: "restore", label: "Restore the layout (leave full screen)", hint: "Esc", group: "View", run: () => ui.restore() },
      { id: "reset-layout", label: "Reset all pane sizes", group: "View", run: () => ui.reset() },
      { id: "dock", label: "Toggle output panel", hint: "Ctrl+`", group: "View", run: () => ui.set({ dockOpen: !ui.dockOpen }) },
      { id: "term", label: "Open terminal", group: "View", run: () => ui.set({ dockOpen: true, dockTab: "terminal" }) },
      { id: "layout", label: `Put the chart ${ui.layout === "row" ? "below" : "beside"} the editor`, group: "View", run: () => ui.set({ layout: ui.layout === "row" ? "col" : "row" }) },
      { id: "theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", group: "Preferences", run: () => store().setTheme(theme === "dark" ? "light" : "dark") },
      { id: "vim", label: ui.vim ? "Turn Vim keybindings off" : "Turn Vim keybindings on", group: "Preferences", run: () => ui.set({ vim: !ui.vim }) },
      { id: "scan", label: "Rescan the data source", group: "Data", run: () => void store().refreshData(true) },
      { id: "keys", label: "Keyboard shortcuts", hint: "?", group: "Help", run: () => ui.set({ shortcuts: true }) },
      ...files,
    ];
  }, [tree, theme, ui.vim, ui.layout, ui.dockOpen]);

  const results = useMemo(() => cmds.map((c) => ({ c, s: score(q, `${c.group} ${c.label}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.c), [cmds, q]);
  const go = (c?: Cmd) => { if (!c) return; close(); setTimeout(c.run, 0); };

  return (
    <Modal open={ui.palette} onClose={close} title="Command palette" width={620}>
      <div style={{ margin: "0 calc(var(--s4) * -1)" }}>
        <div className="row" style={{ borderBottom: "1px solid var(--line)", padding: "0 var(--s4)" }}>
          <Search size={17} className="muted" />
          <input data-autofocus className="input" style={{ border: 0, boxShadow: "none", background: "transparent", height: 44, fontSize: "var(--fs-lg)" }} placeholder="Type a command or a file name…" value={q} role="combobox" aria-expanded="true" aria-controls="cmd-list"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); } else if (e.key === "Enter") { e.preventDefault(); go(results[sel]); } }} />
        </div>
        <div id="cmd-list" role="listbox" style={{ maxHeight: 340, overflow: "auto", padding: "var(--s2)" }}>
          {results.length === 0 && <div className="empty">No matches</div>}
          {results.map((c, i) => (
            <div key={c.id} role="option" aria-selected={i === sel} className="list-row" style={i === sel ? { background: "var(--accent-soft)", color: "var(--ink)" } : undefined} onMouseMove={() => setSel(i)} onClick={() => go(c)}>
              {c.group === "Files" ? <FileCode2 size={15} className="ficon qkt" /> : c.group === "Run" ? <Play size={14} /> : <span style={{ width: 14 }} />}
              <span className="grow" style={{ flex: 1 }}>{c.label}</span><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{c.group}</span>{c.hint && <span className="kbd">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

const KEYS: Array<[string, string]> = [
  ["Ctrl Enter", "Run the open strategy"], ["Ctrl .", "Stop everything and clean up"], ["Ctrl ,", "Run settings"], ["Ctrl K", "Command palette"],
  ["Ctrl J", "Open or close the Journal"], ["Ctrl B", "Show or hide the sidebar"], ["Ctrl 1 · 2 · 3", "Files · Data · Runs"], ["Ctrl `", "Show or hide the output panel"],
  ["F6 · Shift F6", "Move between areas: sections, side panel, editor, chart, output"], ["Ctrl S", "Save the file"], ["Ctrl M", "In the editor: make Tab move focus out of it instead of indenting (again to undo)"], ["Esc", "Close the journal, a dialog or a menu; put the cursor back in a full-screen editor (it stays full screen)"],
  ["Ctrl Z · Ctrl Y", "Undo / redo in the editor (also Ctrl Shift Z)"], ["?", "This list"], ["← → · Shift", "Resize a focused divider (Shift for larger steps)"],
];
const TREE_KEYS: Array<[string, string]> = [
  ["↑ ↓", "Move between rows"], ["→", "Open a closed folder, or move into it"], ["←", "Close an open folder, or go to its parent"],
  ["Home · End", "First / last row"], ["Enter · Space", "Open the file, or toggle the folder"], ["A letter", "Jump to a name starting with it"],
  ["F2", "Rename"], ["Delete", "Delete (with confirm)"], ["Shift F10 · Menu", "Focus the row's actions"],
];
const VIM_KEYS: Array<[string, string]> = [
  [":w", "Save"], [":wq · :x", "Save and close the tab"], [":q", "Close the tab (refuses with unsaved changes)"], [":q!", "Close and discard changes"],
  [":wa", "Save every open file"], [":run", "Run the strategy"], [":12", "Jump to line 12"],
];
export function Shortcuts() {
  const ui = useUi();
  const table = (keys: Array<[string, string]>) => (
    <div className="kv" style={{ gap: "var(--s2) var(--s5)" }}>{keys.map(([k, d]) => <div key={k} style={{ display: "contents" }}><span className="row" style={{ gap: 4 }}>{k.split(" ").map((x, i) => (x === "·") ? <span key={i}>·</span> : <span key={i} className="kbd">{x}</span>)}</span><span className="ink2">{d}</span></div>)}</div>
  );
  return (
    <Modal open={ui.shortcuts} onClose={() => ui.set({ shortcuts: false })} title="Keyboard shortcuts" width={560}>
      {table(KEYS)}
      <div className="hint muted">On macOS use ⌘ in place of Ctrl. Panels can be resized by dragging the dividers, or with the arrow keys when a divider has focus. Double-click a divider to reset it.</div>
      <h4 style={{ margin: "var(--s4) 0 var(--s2)" }}>File tree, Runs and Data lists</h4>
      {table(TREE_KEYS)}
      <div className="hint muted">Runs and the Data section's symbol list use the same ↑ ↓, Home and End.</div>
      <h4 style={{ margin: "var(--s4) 0 var(--s2)" }}>Chart</h4>
      {table([["← →", "Step to the previous / next trade"], ["Esc", "Deselect the trade"]])}
      <h4 style={{ margin: "var(--s4) 0 var(--s2)" }}>Vim mode: ex commands</h4>
      {table(VIM_KEYS)}
    </Modal>
  );
}
