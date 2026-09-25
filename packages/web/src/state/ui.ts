import { create } from "zustand";

export type Section = "files" | "data" | "runs";
export type DockTab = "pipeline" | "problems" | "terminal";
export type Pane = "sidebar" | "editor" | "chart" | "dock";
export type JournalSection = "overview" | "calendar" | "daily" | "monthly" | "trades" | "time" | "lab" | "compare";

interface Persisted {
  section: Section | null; sidebarW: number; previewW: number; dockOpen: boolean; dockH: number; dockTab: DockTab;
  journalSection: JournalSection; journalW: number; journalMax: boolean; vim: boolean; autosave: boolean; fontSize: number; layout: "row" | "col"; collapsed: { editor: boolean; chart: boolean };
}
interface Ui extends Persisted {
  /** The pane shown full-workbench, or null. Not persisted: a reload always starts un-maximized. */
  maxed: Pane | null;
  journalOpen: boolean; palette: boolean; shortcuts: boolean; runSettings: boolean; dataDialog: boolean;
  set(patch: Partial<Ui>): void;
  /** Idempotent: `maximize(p)` twice keeps it maximized; `restore()` always ends un-maximized (a double click can never wedge the layout). */
  maximize(p: Pane): void;
  toggleMax(p: Pane): void;
  restore(): void;
  toggleCollapse(p: Pane): void;
  /** Back to the default sizes for one pane (editor = the whole workbench split); also un-maximizes and un-collapses it. */
  resetPane(p: Pane): void;
  openJournal(section?: JournalSection): void;
  toggleSection(s: Section): void;
  reset(): void;
}

const KEY = "qkt-studio-ui-v3";
const DEFAULTS: Persisted = {
  section: "files", sidebarW: 268, previewW: 560, dockOpen: false, dockH: 260, dockTab: "pipeline",
  journalSection: "overview", journalW: 0, journalMax: false, vim: false, autosave: true, fontSize: 13, layout: "row", collapsed: { editor: false, chart: false },
};

function load(): Persisted {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { ...DEFAULTS }; }
}
const PERSIST: Array<keyof Persisted> = ["section", "sidebarW", "previewW", "dockOpen", "dockH", "dockTab", "journalSection", "journalW", "journalMax", "vim", "autosave", "fontSize", "layout", "collapsed"];

export const useUi = create<Ui>((set, get) => ({
  ...load(),
  maxed: null, journalOpen: false, palette: false, shortcuts: false, runSettings: false, dataDialog: false,
  set(patch) {
    set(patch);
    try { const s = get(); localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(PERSIST.map((k) => [k, s[k]])))); } catch { /* storage blocked */ }
  },
  maximize(p) { if (get().maxed !== p) get().set({ maxed: p }); },
  toggleMax(p) { get().set({ maxed: get().maxed === p ? null : p }); },
  restore() { if (get().maxed !== null) get().set({ maxed: null }); },
  toggleCollapse(p) {
    const u = get();
    if (p === "sidebar") u.set({ section: u.section ? null : "files", maxed: u.maxed === "sidebar" ? null : u.maxed });
    else if (p === "dock") u.set({ dockOpen: !u.dockOpen, maxed: u.maxed === "dock" ? null : u.maxed });
    else u.set({ collapsed: { ...u.collapsed, [p]: !u.collapsed[p] }, maxed: u.maxed === p ? null : u.maxed });
  },
  resetPane(p) {
    const u = get();
    const maxed = u.maxed === p ? null : u.maxed;
    if (p === "sidebar") u.set({ sidebarW: DEFAULTS.sidebarW, maxed, section: u.section ?? "files" });
    else if (p === "dock") u.set({ dockH: DEFAULTS.dockH, dockOpen: true, maxed });
    else if (p === "chart") u.set({ previewW: DEFAULTS.previewW, collapsed: { ...u.collapsed, chart: false }, maxed });
    else u.set({ previewW: DEFAULTS.previewW, dockH: DEFAULTS.dockH, collapsed: { editor: false, chart: false }, maxed });
  },
  openJournal(section) { get().set({ journalOpen: true, ...(section ? { journalSection: section } : {}) }); },
  toggleSection(s) { get().set({ section: get().section === s ? null : s }); },
  // "Reset layout" restores panes and sizes only: editor preferences (vim, auto-save, font size) are the user's, not layout
  reset() { const { vim, autosave, fontSize } = get(); get().set({ ...DEFAULTS, vim, autosave, fontSize, journalOpen: false, maxed: null }); },
}));

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
