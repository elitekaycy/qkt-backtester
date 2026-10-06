import { create } from "zustand";

export type Section = "files" | "data" | "runs";
export type DockTab = "pipeline" | "problems" | "terminal" | "chat";
export type Pane = "sidebar" | "editor" | "chart" | "dock";
export type JournalSection = "overview" | "strategies" | "calendar" | "daily" | "monthly" | "trades" | "time" | "derivatives" | "lab" | "compare";

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
  /**
   * Make a pane visible because the user asked for something in it: leaves a maximized pane that hides it, un-collapses it,
   * and closes the journal drawer when it covers it. Only for user actions: a run opening the dock must not undo a layout.
   */
  reveal(p: Pane): void;
  /** Show a sidebar section (a rail icon, a shortcut, "Open Data"), leaving whatever maximized pane hides the sidebar. */
  showSection(s: Section): void;
  /** Open a dock tab the user asked for. */
  showDock(tab: DockTab): void;
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
  // the journal is drawn over the workbench, which a maximized sidebar hides
  openJournal(section) { get().set({ journalOpen: true, ...(get().maxed === "sidebar" ? { maxed: null } : {}), ...(section ? { journalSection: section } : {}) }); },
  toggleSection(s) {
    const u = get();
    // with another pane maximized the sidebar is hidden: its icon brings it back instead of closing it
    if (u.maxed && u.maxed !== "sidebar") u.set({ section: s, maxed: null });
    else u.set({ section: u.section === s ? null : s, maxed: u.maxed === "sidebar" && u.section === s ? null : u.maxed });
  },
  reveal(p) {
    const u = get();
    const patch: Partial<Ui> = {};
    if (u.maxed && u.maxed !== p) patch.maxed = null;
    if ((p === "editor" || p === "chart") && u.collapsed[p]) patch.collapsed = { ...u.collapsed, [p]: false };
    if (p === "dock" && !u.dockOpen) patch.dockOpen = true;
    if (p !== "sidebar" && u.journalOpen) patch.journalOpen = false;
    if (p === "sidebar" && !u.section) patch.section = "files";
    if (Object.keys(patch).length) u.set(patch);
  },
  showSection(s) { const u = get(); u.set({ section: s, ...(u.maxed && u.maxed !== "sidebar" ? { maxed: null } : {}) }); },
  showDock(tab) {
    get().reveal("dock");
    const vh = typeof window === "undefined" ? 1000 : window.innerHeight;
    get().set({ dockTab: tab, ...(tab === "chat" ? { dockH: chatDockHeight(get().dockH, vh) } : {}) });
  },
  // "Reset layout" restores panes and sizes only: editor preferences (vim, auto-save, font size) are the user's, not layout
  reset() { const { vim, autosave, fontSize } = get(); get().set({ ...DEFAULTS, vim, autosave, fontSize, journalOpen: false, maxed: null }); },
}));

/** The dock height the Chat tab opens at: a short dock grows to 420px (less in a small window: the top bar, the editor's minimum
 *  and the status bar stay visible); a taller one is kept. */
export function chatDockHeight(current: number, viewportH: number): number {
  return Math.max(current, Math.min(420, viewportH - 280));
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
