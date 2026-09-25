import { create } from "zustand";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { api, ApiError, openRunEvents, type Equity, type Info, type RunMeta, type RunRow, type TreeEntry } from "../api/client.js";
import type { Diagnostic, IntegrityReport, MonthRow, RoundTrip, RunJson, Summary, Tier, TripQuery } from "../api/types.js";
import { addDays } from "../util/format.js";

export interface OpenFile { path: string; content: string; saved: string; etag: string; conflict?: boolean }
export interface Progress { phase: string; fills: number; orders: number; elapsedMs: number; etaMs: number | null }
export interface Results { runId: string; summary: Summary; integrity: IntegrityReport; monthly: MonthRow[]; equity: Equity; meta: RunMeta }
export interface Toast { id: number; kind: "info" | "error" | "ok"; text: string }
export type DiagSource = "lsp" | "check" | "run" | "config";

export interface RunConfig { tier: Tier; from: string; to: string; autoRun: boolean; paramsByStrategy: Record<string, Record<string, string>> }

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

  runId: string | null;
  run: RunJson | null;
  progress: Progress | null;
  logs: string[];
  running: boolean;
  runs: RunRow[];

  results: Results | null;
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
  cancelRun(): Promise<void>;
  selectRun(id: string): Promise<void>;
  loadResults(id: string): Promise<void>;
  refreshRuns(): Promise<void>;

  setFilters(patch: Partial<TripQuery>): void;
  clearFilters(): void;
  selectTrip(t: RoundTrip | null, focus?: boolean): void;

  setDiagnostics(path: string, source: DiagSource, list: Diagnostic[]): void;
}

const prefs = loadPrefs();

export const useStore = create<State>((set, get) => ({
  info: null,
  theme: prefs.theme === "light" ? "light" : "dark",
  toasts: [],
  tree: {}, expanded: { "": true, strategies: true }, openFiles: [], activePath: null, lastStrategy: null,
  cfg: { tier: prefs.tier === "full" ? "full" : "draft", from: prefs.from ?? "", to: prefs.to ?? "", autoRun: prefs.autoRun === true, paramsByStrategy: prefs.paramsByStrategy ?? {} },
  runId: null, run: null, progress: null, logs: [], running: false, runs: [],
  results: null, resultsStale: false,
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
  setContent(path, content) { set((s) => ({ openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content } : f)) })); },

  async saveFile(path) {
    const f = get().openFiles.find((x) => x.path === path);
    if (!f) return false;
    if (f.content === f.saved && !f.conflict) return true;
    try {
      const r = await api.writeFile(path, f.content, f.etag);
      set((s) => ({ openFiles: s.openFiles.map((x) => (x.path === path ? { ...x, saved: f.content, etag: r.etag, conflict: false } : x)) }));
      if (get().cfg.autoRun && (isStrategy(path) || path === CONFIG)) {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => void get().startRun({ auto: true, tier: "draft" }), 300);
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
    set((s) => ({ cfg: { ...s.cfg, ...patch } }));
    savePrefs({ ...loadPrefs(), ...get().cfg });
  },
  setParam(strategy, name, value) {
    const by = { ...get().cfg.paramsByStrategy, [strategy]: { ...get().cfg.paramsByStrategy[strategy], [name]: value } };
    get().setCfg({ paramsByStrategy: by });
  },
  async applyDefaultRange() {
    const sp = get().strategyPath();
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
    set((s) => ({ running: true, run: null, progress: null, logs: [], resultsStale: s.results !== null }));
    try {
      const { runId } = await api.submit({ strategy, from: cfg.from, to: cfg.to, tier: opts.tier ?? cfg.tier, params: overrides, allowIncomplete: opts.allowIncomplete, force: opts.force, auto: opts.auto });
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
          if (run?.status === "done") await get().loadResults(runId);
          else set({ resultsStale: false });
          if (run?.error && run.error.file && run.error.line) {
            const path = run.error.file === CONFIG ? CONFIG : run.error.file;
            get().setDiagnostics(path, "run", [{ severity: "error", code: run.error.kind, message: run.error.message, line: run.error.line, col: run.error.col ?? 1, endCol: (run.error.col ?? 1) + 1 }]);
          } else for (const p of Object.keys(get().problems)) get().setDiagnostics(p, "run", []);
          await get().refreshRuns();
        })();
      });
    } catch (e) {
      set({ running: false, resultsStale: false });
      get().toast("error", (e as Error).message);
    }
  },
  async cancelRun() {
    const id = get().runId;
    if (id) await api.cancel(id).catch(() => undefined);
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
      const [summary, integrity, monthly, equity, meta] = await Promise.all([api.summary(id), api.integrity(id), api.monthly(id), api.equity(id), api.meta(id)]);
      if (get().runId !== id) return;
      set({ results: { runId: id, summary, integrity, monthly, equity, meta }, resultsStale: false, selectedTrip: null });
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
