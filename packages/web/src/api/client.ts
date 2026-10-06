import type { BarCols, StrategyRow, BookInfo, DerivativesSection, InstrumentCatalog, InstrumentKind, RunDerivatives } from "@qkt-studio/core";
import type { QktVocabulary } from "@qkt-studio/core/vocabulary";
import type { RunJson, Summary, RoundTrip, IntegrityReport, McResult, MonthRow, Diagnostic, TripQuery, RunRequest, Analytics, ScanReport, Readiness , SymbolReport } from "./types.js";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

const TOKEN_KEY = "qkt-studio-token";
/**
 * The access token, remembered in this browser (localStorage) so a new tab or a restart does not ask again. A
 * `?token=` link is saved and then taken out of the address bar, so it does not stay in the history or a shared screen.
 * A token an older version kept for the tab only (sessionStorage) is carried over.
 */
export function getToken(): string | null {
  try {
    const url = new URL(location.href), q = url.searchParams.get("token");
    if (q) {
      localStorage.setItem(TOKEN_KEY, q);
      url.searchParams.delete("token");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      return q;
    }
    const kept = localStorage.getItem(TOKEN_KEY);
    if (kept) return kept;
    const tab = sessionStorage.getItem(TOKEN_KEY);
    if (tab) { localStorage.setItem(TOKEN_KEY, tab); sessionStorage.removeItem(TOKEN_KEY); }
    return tab;
  } catch { return null; }
}
export const setToken = (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* storage blocked: asked again next time */ } };
/** Forget the saved token (a shared computer); the next load asks for it again. */
export const forgetToken = () => { try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };

export const withToken = (url: string): string => {
  const t = getToken();
  return t ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : url;
};

async function req<T>(url: string, init: RequestInit = {}): Promise<T> {
  const t = getToken();
  const headers: Record<string, string> = { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(init.headers as Record<string, string> | undefined) };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`, body);
  return body as T;
}

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface TreeEntry { name: string; path: string; type: "file" | "dir"; size: number; mtimeMs: number }
/** `GET /api/instruments`: what the data source's instruments.yaml declares, and the roots the browser's lint and completions need. */
export interface InstrumentsInfo {
  exists: boolean; catalog: InstrumentCatalog; futureRoots: string[]; perpetuals: string[]; optionRoots: string[];
  /** The workspace's own instruments.yaml: a run uses it entirely when it exists, the data source's file only as the fallback. */
  workspace: { exists: boolean; catalog: InstrumentCatalog };
  effective: "workspace" | "dataRoot" | "none";
  /** By root key: the fields where the two files disagree, or which side alone declares the root. */
  differences: Record<string, string[]>;
}
export type DerivFetchKind = "catalog" | "rolls" | "funding" | "marks" | "open-interest" | "chains" | "tape" | "liquidations" | "depth" | "bars";
export interface DerivFetchReq { target: string; kind: DerivFetchKind; tf?: string; from?: string; to?: string; live?: boolean; series?: "trade" | "book" }

export interface Info { workspace: string; dataRoot: string; terminal: "shell" | "restricted"; tokenRequired: boolean; hasConfig: boolean; maxParallel: number }
export interface RunRow { id: string; hash: string; strategy: string; status: string; tier: string; from_d: string; to_d: string; created_at: string; seq: number; total_pnl: number | null; sharpe: number | null; trades: number | null; win_rate: number | null; duration_ms: number | null; kind: "strategy" | "portfolio"; members: number }
export interface PortfolioMember { alias: string; path: string; rel: string | null; hold: boolean; exists: boolean; error?: string }
export interface PortfolioListing { path: string; name?: string; members: PortfolioMember[] }
export interface TripPage { total: number; offset: number; limit: number; rows: RoundTrip[] }
export interface SymbolPref { source?: string; from?: string; to?: string }
export interface SettingsView { sources: string[]; symbolPrefs: Record<string, SymbolPref>; dataRoot: string; defaultDataRoot: string; fromSettings: boolean; canChangeAnywhere: boolean; openRoots: string[]; looksLikeStore: boolean; exists: boolean }
export interface DirList { path: string; parent: string | null; store: boolean; dirs: Array<{ name: string; store: boolean }> }
export interface Overlay { total: number; truncated: boolean; rows: RoundTrip[] }
export interface Equity { ts: number[]; equity: number[]; drawdown: number[] }
export interface RunMeta { runId: string; tier: string; from: string; to: string; streams: Array<{ key: string; broker: string; symbol: string; tf: string; base?: string | null; /** Set only for non-CFD streams. */ kind?: InstrumentKind; /** Why a stream without bars (continuous, chain, analytic, hub) has no chart series. */ note?: string }>; /** The derivatives sections this run wrote, present only on futures and options runs. */ derivatives?: DerivativesSection[]; strategies: string[]; fills: number; trips: number; qktVersion: string; /** Account currency every money figure is in; null on runs from before it was recorded. */ currency?: string | null;
  /** Orders qkt refused (risk caps, halts), by reason; absent on runs from before it was recorded. */
  rejections?: { count: number; reasons: Array<{ kind: string; label: string; count: number; example: string; hint?: string }> } }
export interface DayCoverage { day: string; bars: number; status: "ok" | "thin" | "closed" | "missing" }
export interface Coverage { broker: string; symbol: string; tf: string; days: DayCoverage[]; summary: Record<string, number> }
export interface SymbolRow { broker: string; symbol: string; timeframes: string[] }
export interface Job { id: string; kind: string; cleaned?: string[]; status: "running" | "done" | "failed" | "cancelled"; startedAt: string; endedAt?: string; command?: string; log: string[]; progress?: { done: number; total: number }; result?: any; error?: { kind: string; message: string } }

export const api = {
  info: () => req<Info>("/api/info"),
  /** What the qkt this studio runs says about its language; read once, before the editor is set up. */
  qktVocabulary: () => req<QktVocabulary>("/api/qkt/vocabulary"),
  qktGrammar: () => req<Record<string, unknown>>("/api/qkt/grammar"),
  tree: (path = "") => req<{ path: string; entries: TreeEntry[] }>(`/api/tree${qs({ path })}`),
  readFile: (path: string) => req<{ path: string; content: string; etag: string }>(`/api/file${qs({ path })}`),
  writeFile: (path: string, content: string, etag: string) => req<{ path: string; etag: string }>("/api/file", { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ path, content }) }),
  createFile: (path: string, content = "", type: "file" | "dir" = "file") => req<{ path: string; etag?: string }>("/api/file", { method: "POST", body: JSON.stringify({ path, content, type }) }),
  remove: (path: string) => req<void>(`/api/file${qs({ path })}`, { method: "DELETE" }),
  rename: (from: string, to: string) => req<{ from: string; to: string }>("/api/rename", { method: "POST", body: JSON.stringify({ from, to }) }),
  check: (kind: "qkt" | "config", content: string, path?: string) => req<{ diagnostics: Diagnostic[] }>("/api/check", { method: "POST", body: JSON.stringify({ kind, content, path }) }),

  runs: (strategy?: string, limit = 200) => req<{ runs: RunRow[] }>(`/api/runs${qs({ strategy, limit })}`),
  portfolios: () => req<{ portfolios: PortfolioListing[]; usedIn: Record<string, string[]> }>("/api/portfolios"),
  submit: (r: RunRequest) => req<{ runId: string; cached: boolean; joined: boolean }>("/api/runs", { method: "POST", body: JSON.stringify(r) }),
  run: (id: string) => req<RunJson>(`/api/runs/${id}`),
  /** `purge` also deletes the run's folder and history row, so nothing half-written is left behind. */
  cancel: (id: string, purge = false) => req<{ cancelled: boolean }>(`/api/runs/${id}/cancel${purge ? "?purge=1" : ""}`, { method: "POST" }),
  kill: () => req<{ runs: string[]; jobs: string[] }>("/api/kill", { method: "POST" }),
  analytics: (id: string, q: TripQuery) => req<Analytics>(`/api/runs/${id}/analytics${qs(tripParams({ ...q, offset: undefined, limit: undefined }))}`),
  settings: () => req<SettingsView>("/api/settings"),
  setDataRoot: (dataRoot: string | null) => req<SettingsView & { warnings: string[] }>("/api/settings/data-root", { method: "PUT", body: JSON.stringify({ dataRoot }) }),
  dirs: (path?: string) => req<DirList>(`/api/fs/dirs${qs({ path })}`),
  scan: (refresh = false) => req<ScanReport>(`/api/data/scan${refresh ? "?refresh=1" : ""}`),
  readiness: (refresh = false) => req<{ scannedAt: string; strategies: Readiness[] }>(`/api/data/readiness${refresh ? "?refresh=1" : ""}`),
  instruments: () => req<InstrumentsInfo>("/api/instruments"),
  fetchDerivatives: (b: DerivFetchReq) => req<{ jobId: string }>("/api/data/fetch-derivatives", { method: "POST", body: JSON.stringify(b) }),
  /** 404 when the run has no futures/options files: callers check `meta.derivatives` first. */
  derivatives: (id: string) => req<RunDerivatives>(`/api/runs/${id}/derived/derivatives`),
  scaffoldMissing: () => req<{ missing: string[] }>("/api/workspace/missing"),
  completeConfig: (content: string) => req<{ content: string }>("/api/workspace/config-complete", { method: "POST", body: JSON.stringify({ content }) }),
  scaffold: (files?: string[]) => req<{ created: string[]; skipped: string[]; missing: string[] }>("/api/workspace/scaffold", { method: "POST", body: JSON.stringify({ files }) }),
  addSource: (path: string) => req<SettingsView & { warnings: string[] }>("/api/settings/sources", { method: "POST", body: JSON.stringify({ path }) }),
  removeSource: (path: string) => req<SettingsView>("/api/settings/sources", { method: "DELETE", body: JSON.stringify({ path }) }),
  setSymbolPref: (symbol: string, pref: { source?: string | null; from?: string | null; to?: string | null }) => req<SettingsView>(`/api/settings/symbol/${encodeURIComponent(symbol)}`, { method: "PUT", body: JSON.stringify(pref) }),
  resetSymbolPrefs: () => req<SettingsView>("/api/settings/reset-symbols", { method: "POST", body: "{}" }),
  symbolDetail: (symbol: string) => req<{ symbol: string; pref: SymbolPref; sources: Array<{ root: string; isDefault: boolean; report: SymbolReport | null }> }>(`/api/data/symbol/${encodeURIComponent(symbol)}`),
  symbolDays: (symbol: string, kind: string, source?: string) => req<{ first: string; last: string; days: string }>(`/api/data/symbol/${encodeURIComponent(symbol)}/days${qs({ kind, source })}`),
  autoFind: () => req<{ changes: Array<{ symbol: string; source: string; days: number }>; sourcesChecked: number } & SettingsView>("/api/data/auto-find", { method: "POST", body: "{}" }),
  runsUsage: () => req<{ total: number; perRun: Record<string, number> }>("/api/runs-usage"),
  pruneRuns: (b: { ids?: string[]; all?: boolean; olderThanDays?: number; keepLast?: number; strategy?: string }) => req<{ deleted: string[]; freedBytes: number }>("/api/runs/prune", { method: "POST", body: JSON.stringify(b) }),
  deleteRun: (id: string) => req<void>(`/api/runs/${id}`, { method: "DELETE" }),
  summary: (id: string) => req<Summary>(`/api/runs/${id}/derived/summary`),
  integrity: (id: string) => req<IntegrityReport>(`/api/runs/${id}/derived/integrity`),
  monthly: (id: string) => req<MonthRow[]>(`/api/runs/${id}/derived/monthly`),
  equity: (id: string) => req<Equity>(`/api/runs/${id}/derived/equity`),
  meta: (id: string) => req<RunMeta>(`/api/runs/${id}/derived/meta`),
  // Portfolio runs only (404 for a single strategy; callers check meta.strategies.length > 1 first).
  strategies: (id: string) => req<StrategyRow[]>(`/api/runs/${id}/derived/strategies`),
  equityByStrategy: (id: string) => req<{ ids: string[]; series: Record<string, Equity> }>(`/api/runs/${id}/derived/equity-by-strategy`),
  book: (id: string) => req<BookInfo>(`/api/runs/${id}/derived/book`),
  trades: (id: string, q: TripQuery) => req<TripPage>(`/api/runs/${id}/trades${qs(tripParams(q))}`),
  overlay: (id: string, q: TripQuery, from: number, to: number, cap = 20000) => req<Overlay>(`/api/runs/${id}/overlay${qs({ ...tripParams({ ...q, fromTs: undefined, toTs: undefined }), from, to, cap })}`),
  artifact: async (id: string, path: string, tail?: number) => {
    const t = getToken();
    const r = await fetch(`/api/runs/${id}/artifact${qs({ path, tail })}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) throw new ApiError(r.status, "artifact not available");
    return r.text();
  },
  artifactUrl: (id: string, path: string) => withToken(`/api/runs/${id}/artifact${qs({ path })}`),
  runMonteCarlo: (id: string, body: object) => req<McResult>(`/api/runs/${id}/montecarlo`, { method: "POST", body: JSON.stringify(body) }),
  monteCarloList: (id: string) => req<{ results: Array<McResult & { file: string }> }>(`/api/runs/${id}/montecarlo`),

  barsSymbols: () => req<{ symbols: SymbolRow[] }>("/api/bars/symbols"),
  barsRange: (p: { broker: string; symbol: string; tf: string }) => req<{ first: string | null; last: string | null; files: number }>(`/api/bars/range${qs(p)}`),
  coverage: (p: { broker: string; symbol: string; tf: string; base?: string | null; from: string; to: string }) => req<Coverage>(`/api/bars/coverage${qs(p)}`),
  bars: async (p: { broker: string; symbol: string; tf: string; base?: string | null; from: number; to: number; max?: number }): Promise<{ cols: BarCols; sourceCount: number; missingDays: number; emptyDays: number }> => {
    const t = getToken();
    const r = await fetch(`/api/bars${qs(p)}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) throw new ApiError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "bars unavailable");
    return { cols: unpackBars(await r.arrayBuffer()), sourceCount: Number(r.headers.get("X-Bars-Source-Count") ?? 0), missingDays: Number(r.headers.get("X-Bars-Missing-Days") ?? 0), emptyDays: Number(r.headers.get("X-Bars-Empty-Days") ?? 0) };
  },

  noData: () => req<{ dataRoot: string; entries: NoDataEntry[] }>("/api/data/no-data"),
  acceptNoData: (b: NoDataReq) => req<{ accepted: string[]; skipped: Array<{ day: string; reason: string }> }>("/api/data/no-data", { method: "POST", body: JSON.stringify(b) }),
  undoNoData: (b: NoDataReq) => req<{ undone: string[] }>("/api/data/no-data/undo", { method: "POST", body: JSON.stringify(b) }),
  buildBars: (b: { symbol: string; tf: string; from: string; to: string }) => req<{ jobId: string }>("/api/data/build-bars", { method: "POST", body: JSON.stringify(b) }),
  fetchData: (b: { broker: string; symbol: string; tf: string; from: string; to: string }) => req<{ jobId: string }>("/api/data/fetch", { method: "POST", body: JSON.stringify(b) }),
  grid: (b: object) => req<{ jobId: string }>("/api/jobs/grid", { method: "POST", body: JSON.stringify(b) }),
  walkForward: (b: object) => req<{ jobId: string }>("/api/jobs/walkforward", { method: "POST", body: JSON.stringify(b) }),
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => req<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: "POST" }),

  variants: () => req<{ variants: import("../state/agent.js").VariantInfo[] }>("/api/variants"),
  variant: (id: string) => req<import("../state/agent.js").VariantInfo & { source: string | null; baseHash: string; canRebase: boolean }>(`/api/variants/${encodeURIComponent(id)}`),
  /** The variant's changes re-applied to `text` (the base file's current buffer), checked. 409 when they no longer apply. */
  rebaseVariant: (id: string, text: string) => req<{ source: string; notes: string[]; baseHash: string }>(`/api/variants/${encodeURIComponent(id)}/rebase`, { method: "POST", body: JSON.stringify({ text }) }),
  discardVariant: (id: string) => req<void>(`/api/variants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  proposals: () => req<{ proposals: import("../state/agent.js").ProposalInfo[] }>("/api/proposals"),
  applyProposal: (id: string) => req<unknown>(`/api/proposals/${encodeURIComponent(id)}/apply`, { method: "POST" }),
  rejectProposal: (id: string) => req<unknown>(`/api/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  split: () => req<{ split: Record<string, unknown>; text: string }>("/api/split"),
  setSplit: (split: Record<string, unknown>) => req<{ split: Record<string, unknown>; text: string }>("/api/split", { method: "PUT", body: JSON.stringify(split) }),
  runParts: (id: string) => req<{ cut: string | null; first: PartStats; test: PartStats | null }>(`/api/runs/${encodeURIComponent(id)}/parts`),
  reportView: (v: unknown) => req<unknown>("/api/view", { method: "POST", body: JSON.stringify(v) }),
  chatStatus: (refresh = false) => req<import("../chat/state.js").ChatStatusInfo>(`/api/chat/status${refresh ? "?refresh=1" : ""}`),
  chatConversations: () => req<{ conversations: import("../chat/state.js").ConversationInfo[] }>("/api/chat/conversations"),
  chatConversation: (id: string) => req<{ conversation: { id: string; title: string; updated: string }; messages: import("@qkt-studio/core/chat").ChatMessage[] }>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  chatSend: (b: { conversationId: string | null; text: string; think: boolean; omit: import("@qkt-studio/core/chat").ViewKey[]; mentions: import("@qkt-studio/core/chat").Mention[] }) =>
    req<{ conversationId: string; messageId: string }>("/api/chat/send", { method: "POST", body: JSON.stringify(b) }),
  chatStop: () => req<{ stopped: boolean }>("/api/chat/stop", { method: "POST" }),
};

export interface PartStats { from: string; to: string; trades: number; net: number; winRate: number | null; profitFactor: number | null; avgR: number | null }

function tripParams(q: TripQuery): Record<string, unknown> {
  return {
    side: q.side, outcome: q.outcome, symbol: q.symbol, strategy: q.strategy, from: q.fromTs, to: q.toTs, strategies: q.strategies === undefined ? undefined : q.strategies.join(","), minHold: q.minHoldMs, maxHold: q.maxHoldMs,
    exitFrom: q.exitFromTs, exitTo: q.exitToTs, minQty: q.minQty, maxQty: q.maxQty, id: q.id, minPnl: q.minPnl, maxPnl: q.maxPnl, exit: q.exit ?? q.venueExit, contract: q.contract, minR: q.minR, maxR: q.maxR, weekday: q.weekday, hour: q.hour, day: q.day, sort: q.sort, dir: q.dir, offset: q.offset, limit: q.limit,
  };
}

/** Inverse of the server's packBars: [n:u32][pad:u32][tfMs:f64] then six Float64 columns. */
export function unpackBars(buf: ArrayBuffer): BarCols {
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true), tfMs = dv.getFloat64(8, true);
  const col = (i: number) => new Float64Array(buf, 16 + i * n * 8, n);
  return { tfMs, ts: col(0), open: col(1), high: col(2), low: col(3), close: col(4), volume: col(5) };
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return withToken(`${proto}//${location.host}${path}`);
}

export type RunEventMsg =
  | { id: number; t: "run"; run: RunJson }
  | { id: number; t: "progress"; phase: string; fills: number; orders: number; elapsedMs: number; etaMs: number | null }
  | { id: number; t: "log"; level: "info" | "warn" | "error"; message: string };

/** SSE with automatic reconnect (EventSource resends Last-Event-ID). Returns a closer. */
export function openRunEvents(runId: string, onEvent: (e: RunEventMsg) => void, onEnd?: () => void): () => void {
  const es = new EventSource(withToken(`/api/runs/${runId}/events`));
  let ended = false;
  for (const t of ["run", "progress", "log"] as const) {
    es.addEventListener(t, (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as RunEventMsg;
      onEvent(ev);
      if (ev.t === "run" && ["done", "failed", "cancelled", "interrupted"].includes(ev.run.status)) { ended = true; es.close(); onEnd?.(); }
    });
  }
  es.onerror = () => { if (ended) return; /* EventSource retries by itself while readyState is CONNECTING */ if (es.readyState === EventSource.CLOSED) onEnd?.(); };
  return () => { ended = true; es.close(); };
}

export interface NoDataEntry { broker: string; symbol: string; tf: string; day: string; at: string; wrote: boolean }
export interface NoDataReq { broker: string; symbol: string; tf: string; days: string[] }
