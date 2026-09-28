import { anchorParseError } from "@qkt-studio/core/lint";
import { create } from "zustand";
import { useUi } from "./ui.js";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { api, ApiError, openRunEvents, type Equity, type Info, type RunMeta, type RunRow, type SettingsView, type TreeEntry } from "../api/client.js";
import type { Diagnostic, IntegrityReport, MonthRow, Readiness, RoundTrip, RunJson, RunOptions, ScanReport, Summary, Tier, TripQuery } from "../api/types.js";
import { addDays, fmtMoney } from "../util/format.js";
import { defaultWindow, recomputeReadiness } from "../util/datawindow.js";
import type { SymbolReport } from "../api/types.js";

export interface OpenFile { path: string; content: string; saved: string; etag: string; conflict?: boolean }
export interface Progress { phase: string; fills: number; orders: number; elapsedMs: number; etaMs: number | null }
export interface Results { runId: string; summary: Summary; integrity: IntegrityReport; monthly: MonthRow[]; equity: Equity; meta: RunMeta; strategy: string }
export interface Toast { id: number; kind: "info" | "error" | "ok"; text: string }
export type DiagSource = "lsp" | "check" | "run" | "config";

export interface RunConfig { tier: Tier; from: string; to: string; autoRun: boolean; paramsByStrategy: Record<string, Record<string, string>>; options: RunOptions; allowIncomplete: boolean }
export interface TrackedJob { id: string; label: string; status: "running" | "done" | "failed" | "cancelled"; message?: string }

const PREF_KEY = "qkt-studio-prefs-v1";
function loadPrefs(): Partial<RunConfig & { theme: "dark" | "light" }> {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}"); } catch { return {}; }
}
function savePrefs(p: object): void { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } }

const isStrategy = (p: string | null | undefined): p is string => !!p && p.endsWith(".qkt");
const CONFIG = "qkt.config.yaml";

let closeEvents: (() => void) | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 1;

interface State {
  info: Info | null;
  theme: "dark" | "light";
  toasts: Toast[];

  tree: Record<string, TreeEntry[]>;
  expanded: Record<string, boolean>;
  openFiles: OpenFile[];
  activePath: string | null;
  lastStrategy: string | null;

  cfg: RunConfig;

  settings: SettingsView | null;
  scan: ScanReport | null;
  readiness: Readiness[];
  /** Reports of symbols read from a source other than the default (their own source's view). */
  overrideReports: Record<string, SymbolReport | undefined>;
  /** Symbol whose detail dialog is open. */
  symbolDialog: string | null;
  openSymbol(symbol: string | null): void;
  /** The server's last message when a run was refused (e.g. window outside a symbol's range); shown in Run settings. */
  submitError: string | null;
  /** One sentence for screen readers when a run starts, finishes or fails (read by a polite live region). */
  announce: string;
  setSymbolPref(symbol: string, pref: { source?: string | null; from?: string | null; to?: string | null }): Promise<void>;
  resetSymbolPrefs(): Promise<void>;
  autoFindSources(): Promise<Array<{ symbol: string; source: string; days: number }>>;
  addSource(path: string): Promise<string[]>;
  removeSource(path: string): Promise<void>;
  scanning: boolean;
  jobs: TrackedJob[];
  /** Runs ticked for side-by-side comparison in the Journal. */
  compare: string[];

  runId: string | null;
  run: RunJson | null;
  progress: Progress | null;
  logs: string[];
  running: boolean;
  runs: RunRow[];

  results: Results | null;
  /** The previous result of the same strategy, for "what did my change do" deltas; null after switching strategy. */
  previous: Results | null;
  /** Why the last save did not auto-run (a syntax error), or null. */
  autoSkipped: string | null;
  resultsStale: boolean;

  filters: TripQuery;
  selectedTrip: RoundTrip | null;
  focus: { from: number; to: number; nonce: number } | null;

  problems: Record<string, Partial<Record<DiagSource, Diagnostic[]>>>;

  init(): Promise<void>;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;
  setTheme(t: "dark" | "light"): void;

  refreshTree(path?: string): Promise<void>;
  toggleDir(path: string): Promise<void>;
  openFile(path: string): Promise<void>;
  closeFile(path: string): void;
  setActive(path: string): void;
  setContent(path: string, content: string): void;
  saveFile(path: string): Promise<boolean>;
  saveAllDirty(): Promise<boolean>;
  reloadFromDisk(path: string): Promise<void>;
  overwriteOnDisk(path: string): Promise<void>;
  createEntry(path: string, type: "file" | "dir", content?: string): Promise<void>;
  removeEntry(path: string): Promise<void>;
  renameEntry(from: string, to: string): Promise<void>;

  strategyPath(): string | null;
  setCfg(patch: Partial<RunConfig>): void;
  setParam(strategy: string, name: string, value: string): void;
  applyDefaultRange(): Promise<void>;

  startRun(opts?: { allowIncomplete?: boolean; force?: boolean; tier?: Tier; auto?: boolean }): Promise<void>;
  /** Stop the current run and remove everything it wrote. */
  stopRun(): Promise<void>;
  /** Stop every run and job and clean up partially written files. */
  killAll(): Promise<void>;
  refreshData(force?: boolean): Promise<void>;
  setDataRoot(path: string | null): Promise<string[]>;
  trackJob(id: string, label: string): void;
  toggleCompare(id: string): void;
  reorderFiles(from: string, to: string): void;
  setOption<K extends keyof RunOptions>(key: K, value: RunOptions[K] | undefined): void;
  selectRun(id: string): Promise<void>;
  loadResults(id: string): Promise<void>;
  refreshRuns(): Promise<void>;

  setFilters(patch: Partial<TripQuery>): void;
  clearFilters(): void;
  selectTrip(t: RoundTrip | null, focus?: boolean): void;

  setDiagnostics(path: string, source: DiagSource, list: Diagnostic[]): void;
}

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const prefs = loadPrefs();

export const useStore = create<State>((set, get) => ({
  info: null,
  theme: prefs.theme === "light" ? "light" : "dark",
  toasts: [],
  tree: {}, expanded: { "": true, strategies: true }, openFiles: [], activePath: null, lastStrategy: null,
  cfg: { tier: prefs.tier === "full" ? "full" : "draft", from: prefs.from ?? "", to: prefs.to ?? "", autoRun: prefs.autoRun !== false, paramsByStrategy: prefs.paramsByStrategy ?? {}, options: prefs.options ?? {}, allowIncomplete: prefs.allowIncomplete === true },
  settings: null, scan: null, readiness: [], overrideReports: {}, symbolDialog: null, submitError: null, announce: "", scanning: false, jobs: [], compare: [],
  runId: null, run: null, progress: null, logs: [], running: false, runs: [],
  results: null, previous: null, autoSkipped: null, resultsStale: false,
  filters: {}, selectedTrip: null, focus: null,
  problems: {},

  async init() {
    document.documentElement.dataset.theme = get().theme;
    const info = await api.info();
    set({ info });
    await get().refreshTree("");
    await get().refreshTree("strategies");
    const root = get().tree[""] ?? [];
    const strategies = get().tree["strategies"] ?? [];
    const first = strategies.find((e) => e.type === "file" && e.name.endsWith(".qkt")) ?? root.find((e) => e.name.endsWith(".qkt"));
    if (root.some((e) => e.name === CONFIG)) await get().openFile(CONFIG);
    if (first) await get().openFile(first.path);
    await get().refreshRuns();
    if (!get().cfg.from || !get().cfg.to) await get().applyDefaultRange();
    void get().refreshData();
  },

  toast(kind, text) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 4000);
  },
  dismissToast(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },
  setTheme(t) {
    document.documentElement.dataset.theme = t;
    set({ theme: t });
    savePrefs({ ...loadPrefs(), theme: t });
  },

  // ---- files ----------------------------------------------------------------------------------------------
  async refreshTree(path = "") {
    try {
      const r = await api.tree(path);
      set((s) => ({ tree: { ...s.tree, [path]: r.entries } }));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) get().toast("error", `Cannot list ${path || "workspace"}: ${(e as Error).message}`);
    }
  },
  async toggleDir(path) {
    const open = !get().expanded[path];
    set((s) => ({ expanded: { ...s.expanded, [path]: open } }));
    if (open) await get().refreshTree(path);
  },
  async openFile(path) {
    const ex = get().openFiles.find((f) => f.path === path);
    if (ex) { get().setActive(path); return; }
    try {
      const r = await api.readFile(path);
      set((s) => ({ openFiles: [...s.openFiles, { path, content: r.content, saved: r.content, etag: r.etag }] }));
      get().setActive(path);
    } catch (e) {
      get().toast("error", e instanceof ApiError && e.status === 415 ? `${path} is a binary file` : `Cannot open ${path}: ${(e as Error).message}`);
    }
  },
  closeFile(path) {
    set((s) => {
      const files = s.openFiles.filter((f) => f.path !== path);
      const active = s.activePath === path ? files[files.length - 1]?.path ?? null : s.activePath;
      return { openFiles: files, activePath: active };
    });
  },
  setActive(path) { set((s) => ({ activePath: path, lastStrategy: isStrategy(path) ? path : s.lastStrategy })); },
  setContent(path, content) {
    set((s) => ({ openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content } : f)) }));
    // auto-save after a pause in typing, so an edit is never lost to a reload, a crash or a forgotten Ctrl+S
    clearTimeout(autosaveTimers.get(path));
    if (useUi.getState().autosave) autosaveTimers.set(path, setTimeout(() => { const f = get().openFiles.find((x) => x.path === path); if (f && f.content !== f.saved && !f.conflict) void get().saveFile(path); }, 1200));
  },

  async saveFile(path) {
    const f = get().openFiles.find((x) => x.path === path);
    if (!f) return false;
    if (f.content === f.saved && !f.conflict) return true;
    try {
      const r = await api.writeFile(path, f.content, f.etag);
      set((s) => ({ openFiles: s.openFiles.map((x) => (x.path === path ? { ...x, saved: f.content, etag: r.etag, conflict: false } : x)) }));
      if (get().cfg.autoRun && (isStrategy(path) || path === CONFIG)) {
        if (autoTimer) clearTimeout(autoTimer);
        // a file with a syntax error would only produce a failed run: keep the last good result and say why instead
        const target = isStrategy(path) ? path : get().strategyPath();
        const errs = target ? Object.entries(get().problems[target] ?? {}).filter(([src]) => src !== "run").flatMap(([, l]) => l ?? []).filter((d) => d.severity === "error") : [];
        if (errs.length) { const e0 = errs[0]!; set({ autoSkipped: `Not run: line ${e0.line}: ${e0.message}` }); return true; }
        set({ autoSkipped: null });
        // a short pause only to gather files saved together (Save all)
        autoTimer = setTimeout(() => void get().startRun({ auto: true, tier: "draft" }), 150);
      }
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        set((s) => ({ openFiles: s.openFiles.map((x) => (x.path === path ? { ...x, conflict: true } : x)) }));
        get().toast("error", `${path} changed on disk. Reload it or overwrite.`);
      } else get().toast("error", `Save failed: ${(e as Error).message}`);
      return false;
    }
  },
  async saveAllDirty() {
    let ok = true;
    for (const f of get().openFiles) if (f.content !== f.saved) ok = (await get().saveFile(f.path)) && ok;
    return ok;
  },
  async reloadFromDisk(path) {
    const r = await api.readFile(path);
    set((s) => ({ openFiles: s.openFiles.map((x) => (x.path === path ? { path, content: r.content, saved: r.content, etag: r.etag } : x)) }));
  },
  async overwriteOnDisk(path) {
    const f = get().openFiles.find((x) => x.path === path);
    if (!f) return;
    const cur = await api.readFile(path);
    set((s) => ({ openFiles: s.openFiles.map((x) => (x.path === path ? { ...x, etag: cur.etag, conflict: false } : x)) }));
    await get().saveFile(path);
  },
  async createEntry(path, type, content = "") {
    try {
      await api.createFile(path, content, type);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      await get().refreshTree(dir);
      if (dir) set((s) => ({ expanded: { ...s.expanded, [dir]: true } }));
      if (type === "file") await get().openFile(path);
    } catch (e) { get().toast("error", (e as Error).message); }
  },
  async removeEntry(path) {
    try {
      await api.remove(path);
      set((s) => ({ openFiles: s.openFiles.filter((f) => f.path !== path && !f.path.startsWith(path + "/")) }));
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      await get().refreshTree(dir);
      const a = get().activePath;
      if (a && !get().openFiles.some((f) => f.path === a)) set({ activePath: get().openFiles[0]?.path ?? null });
    } catch (e) { get().toast("error", (e as Error).message); }
  },
  async renameEntry(from, to) {
    try {
      await api.rename(from, to);
      set((s) => ({
        openFiles: s.openFiles.map((f) => (f.path === from ? { ...f, path: to } : f)),
        activePath: s.activePath === from ? to : s.activePath,
      }));
      for (const d of new Set([from, to].map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")))) await get().refreshTree(d);
    } catch (e) { get().toast("error", (e as Error).message); }
  },

  // ---- run configuration ----------------------------------------------------------------------------------
  strategyPath() {
    const s = get();
    return isStrategy(s.activePath) ? s.activePath : s.lastStrategy;
  },
  setCfg(patch) {
    set((s) => ({ cfg: { ...s.cfg, ...patch }, ...(("from" in patch || "to" in patch || "tier" in patch) ? { submitError: null } : {}) }));
    savePrefs({ ...loadPrefs(), ...get().cfg });
  },
  setParam(strategy, name, value) {
    const by = { ...get().cfg.paramsByStrategy, [strategy]: { ...get().cfg.paramsByStrategy[strategy], [name]: value } };
    get().setCfg({ paramsByStrategy: by });
  },
  async applyDefaultRange() {
    const sp = get().strategyPath();
    const ready = get().readiness.find((r) => r.strategy === sp);
    const allowed = ready ? (get().cfg.tier === "draft" ? ready.bars : ready.ticks).ranges : [];
    const win = defaultWindow(allowed);
    if (win) { get().setCfg({ from: win.from, to: win.to }); return; }
    const f = get().openFiles.find((x) => x.path === sp);
    const stream = f ? parseStrategyInfo(f.content).streams[0] : undefined;
    try {
      let r = stream ? await api.barsRange({ broker: stream.broker, symbol: stream.symbol, tf: stream.tf }) : { first: null, last: null, files: 0 };
      if (!r.last) { r = await api.barsRange({ broker: "BACKTEST", symbol: stream?.symbol ?? "XAUUSD", tf: stream?.tf ?? "15m" }); }
      if (r.last) {
        const to = addDays(r.last, 1);
        const from = r.first && addDays(to, -30) < r.first ? r.first : addDays(to, -30);
        get().setCfg({ from, to });
        return;
      }
    } catch { /* fall through */ }
    const today = new Date().toISOString().slice(0, 10);
    get().setCfg({ from: addDays(today, -30), to: today });
  },

  // ---- runs ---------------------------------------------------------------------------------------------
  async startRun(opts = {}) {
    const strategy = get().strategyPath();
    if (!strategy) { get().toast("error", "Open a .qkt strategy first."); return; }
    if (!(await get().saveAllDirty())) return;
    const { cfg } = get();
    const f = get().openFiles.find((x) => x.path === strategy);
    const declared = new Map((f ? parseStrategyInfo(f.content).params : []).map((p) => [p.name, p.default]));
    const overrides = Object.fromEntries(Object.entries(cfg.paramsByStrategy[strategy] ?? {}).filter(([k, v]) => declared.has(k) && v !== "" && v !== declared.get(k)));
    closeEvents?.();
    set((s) => ({ running: true, run: null, progress: null, logs: [], resultsStale: s.results !== null, submitError: null, announce: `Running ${strategy.split("/").pop()}…` }));
    try {
      const tier = opts.tier ?? cfg.tier;
      const { broker, execution, slippage, ...common } = cfg.options;
      const options: RunOptions = tier === "full" ? { ...common, broker, execution, slippage } : common;
      const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== "")) as RunOptions;
      const { runId } = await api.submit({ strategy, from: cfg.from, to: cfg.to, tier, params: overrides, allowIncomplete: opts.allowIncomplete ?? cfg.allowIncomplete, force: opts.force, auto: opts.auto, options: clean });
      set({ runId });
      closeEvents = openRunEvents(runId, (e) => {
        if (get().runId !== runId) return;
        if (e.t === "run") set({ run: e.run });
        else if (e.t === "progress") set({ progress: e });
        else set((s) => ({ logs: [...s.logs.slice(-299), `${e.level === "warn" ? "warning: " : ""}${e.message}`] }));
      }, () => {
        void (async () => {
          if (get().runId !== runId) return;
          const run = await api.run(runId).catch(() => null);
          set({ running: false, run: run ?? get().run });
          if (run?.status === "done") {
            await get().loadResults(runId);
            const sm = get().results?.summary;
            set({ announce: sm ? `Run finished: ${sm.trades} closed trade${sm.trades === 1 ? "" : "s"}, net P&L ${fmtMoney(sm.totalPnl)}.` : "Run finished." });
          } else set({ resultsStale: false, announce: run?.status === "failed" ? `Run failed: ${run.error?.message ?? "see the pipeline"}` : "Run stopped." });
          if (run?.error && run.error.file && run.error.line) {
            const path = run.error.file === CONFIG ? CONFIG : run.error.file;
            get().setDiagnostics(path, "run", [{ severity: "error", code: run.error.kind, message: run.error.message, line: run.error.line, col: run.error.col ?? 1, endCol: (run.error.col ?? 1) + 1 }]);
          } else for (const p of Object.keys(get().problems)) get().setDiagnostics(p, "run", []);
          await get().refreshRuns();
        })();
      });
    } catch (e) {
      set({ running: false, resultsStale: false, submitError: e instanceof ApiError && e.status === 400 ? e.message : null });
      get().toast("error", (e as Error).message);
    }
  },
  async stopRun() {
    const id = get().runId;
    if (!id || !get().running) return;
    closeEvents?.();
    await api.cancel(id, true).catch(() => undefined);
    set({ running: false, run: null, progress: null, runId: get().results?.runId ?? null, resultsStale: false });
    await get().refreshRuns();
    get().toast("ok", "Stopped. The partial run was removed.");
  },
  async killAll() {
    closeEvents?.();
    try {
      const k = await api.kill();
      set((s) => ({ running: false, run: null, progress: null, resultsStale: false, runId: s.results?.runId ?? null, jobs: s.jobs.map((j) => (j.status === "running" ? { ...j, status: "cancelled" as const } : j)) }));
      await get().refreshRuns();
      void get().refreshData(true);
      get().toast("ok", k.runs.length + k.jobs.length ? `Stopped ${k.runs.length} run(s) and ${k.jobs.length} job(s); partial output removed.` : "Nothing was running.");
    } catch (e) { get().toast("error", (e as Error).message); }
  },
  async refreshData(force = false) {
    set({ scanning: true });
    try {
      const [settings, scan, ready] = await Promise.all([api.settings(), api.scan(force), api.readiness(force)]);
      // symbols pointed at another source are judged by THAT source's report, and every strategy is re-evaluated with the
      // per-symbol windows applied (the server's readiness only knows the default source)
      const overrideReports: Record<string, SymbolReport | undefined> = {};
      await Promise.all(Object.entries(settings.symbolPrefs).filter(([, p]) => p.source).map(async ([sym, p]) => {
        try { overrideReports[sym] = (await api.symbolDetail(sym)).sources.find((x) => x.root === p.source)?.report ?? undefined; } catch { /* keep the default report */ }
      }));
      const readiness = ready.strategies.map((r) => recomputeReadiness(r, scan, settings.symbolPrefs, overrideReports));
      set({ settings, scan, readiness, overrideReports, scanning: false });
    } catch (e) { set({ scanning: false }); if (!(e instanceof ApiError && e.status === 401)) get().toast("error", `Data scan failed: ${(e as Error).message}`); }
  },
  openSymbol(symbol) { set({ symbolDialog: symbol }); },
  async setSymbolPref(symbol, pref) {
    const r = await api.setSymbolPref(symbol, pref);
    set({ settings: r });
    void get().refreshData(true); // readiness follows; the dialog does not wait for a full rescan
  },
  async resetSymbolPrefs() {
    const r = await api.resetSymbolPrefs();
    set({ settings: r });
    await get().refreshData(true);
    get().toast("ok", "Every symbol now uses the default source and the full range found there.");
  },
  async autoFindSources() {
    const r = await api.autoFind();
    set({ settings: r });
    await get().refreshData(true);
    get().toast("ok", r.changes.length ? `Auto-find moved ${r.changes.length} symbol(s) to a better source.` : `Checked ${r.sourcesChecked} source${r.sourcesChecked === 1 ? "" : "s"}: the default source is already the best for every symbol.`);
    return r.changes;
  },
  async addSource(path) {
    const r = await api.addSource(path);
    set({ settings: r });
    void get().refreshData(true);
    return r.warnings;
  },
  async removeSource(path) {
    const r = await api.removeSource(path);
    set({ settings: r });
    void get().refreshData(true);
  },
  async setDataRoot(path) {
    const r = await api.setDataRoot(path);
    set({ settings: r });
    await get().refreshData(true);
    await get().applyDefaultRange();
    return r.warnings;
  },
  trackJob(id, label) {
    set((s) => ({ jobs: [{ id, label, status: "running" as const }, ...s.jobs.filter((j) => j.id !== id)].slice(0, 12) }));
    const poll = async () => {
      const j = await api.job(id).catch(() => null);
      if (!j) return;
      set((s) => ({ jobs: s.jobs.map((x) => (x.id === id ? { ...x, status: j.status, message: j.error?.message ?? (j.cleaned?.length ? `${j.cleaned.length} partial file(s) removed` : undefined) } : x)) }));
      if (j.status === "running") setTimeout(poll, 700);
      else { void get().refreshData(true); if (j.status === "done") get().toast("ok", `${label} finished`); else if (j.status === "failed") get().toast("error", `${label} failed: ${j.error?.message ?? "see log"}`); }
    };
    void poll();
  },
  toggleCompare(id) { set((s) => ({ compare: s.compare.includes(id) ? s.compare.filter((x) => x !== id) : [...s.compare, id].slice(-4) })); },
  reorderFiles(from, to) {
    set((s) => {
      const a = s.openFiles.findIndex((f) => f.path === from), b = s.openFiles.findIndex((f) => f.path === to);
      if (a < 0 || b < 0 || a === b) return s;
      const next = [...s.openFiles]; const [m] = next.splice(a, 1); next.splice(b, 0, m!);
      return { openFiles: next };
    });
  },
  setOption(key, value) {
    const options = { ...get().cfg.options };
    if (value === undefined || value === "") delete options[key]; else options[key] = value;
    get().setCfg({ options });
  },
  async selectRun(id) {
    closeEvents?.();
    const run = await api.run(id).catch(() => null);
    if (!run) { get().toast("error", "Run not found"); return; }
    set({ runId: id, run, running: false, progress: null, logs: [], selectedTrip: null });
    if (run.status === "done") await get().loadResults(id);
  },
  async loadResults(id) {
    try {
      const [summary, integrity, monthly, equity, meta, run] = await Promise.all([api.summary(id), api.integrity(id), api.monthly(id), api.equity(id), api.meta(id), api.run(id)]);
      if (get().runId !== id) return;
      const prev = get().results;
      const previous = prev && prev.runId !== id && prev.strategy === run.strategy ? prev : prev?.runId === id ? get().previous : null;
      set({ results: { runId: id, summary, integrity, monthly, equity, meta, strategy: run.strategy }, previous, resultsStale: false, selectedTrip: null });
    } catch (e) {
      set({ resultsStale: false });
      get().toast("error", `Cannot load results: ${(e as Error).message}`);
    }
  },
  async refreshRuns() {
    try { set({ runs: (await api.runs()).runs }); } catch { /* keep the old list */ }
  },

  // ---- trades / filters ---------------------------------------------------------------------------------
  setFilters(patch) { set((s) => ({ filters: { ...s.filters, ...patch } })); },
  clearFilters() { set({ filters: {} }); },
  selectTrip(t, focus = true) {
    if (!t) { set({ selectedTrip: null }); return; }
    const end = t.exitTs ?? t.entryTs;
    const pad = Math.max((end - t.entryTs) * 1.5, 6 * 3_600_000);
    set((s) => ({ selectedTrip: t, focus: focus ? { from: t.entryTs - pad, to: end + pad, nonce: (s.focus?.nonce ?? 0) + 1 } : s.focus }));
  },

  setDiagnostics(path, source, list) {
    if (path.endsWith(".qkt") && list.length) {
      const text = get().openFiles.find((f) => f.path === path)?.content;
      if (text !== undefined) list = list.map((d) => (d.severity === "error" ? { ...d, ...anchorParseError(text, d) } : d));
    }
    set((s) => {
      const cur = { ...(s.problems[path] ?? {}) };
      if (list.length) cur[source] = list; else delete cur[source];
      const next = { ...s.problems };
      if (Object.keys(cur).length) next[path] = cur; else delete next[path];
      return { problems: next };
    });
  },
}));

/** Flatten diagnostics for the Problems list. */
export function flattenProblems(problems: State["problems"]): Array<Diagnostic & { path: string; source: DiagSource }> {
  const out: Array<Diagnostic & { path: string; source: DiagSource }> = [];
  for (const [path, bySource] of Object.entries(problems)) for (const [source, list] of Object.entries(bySource)) for (const d of list ?? []) out.push({ ...d, path, source: source as DiagSource });
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
