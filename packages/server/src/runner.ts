import { createHash } from "node:crypto";
import { prepareDataView, allowedWindow } from "./data-view.js";
import { configStartingBalance } from "@qkt-studio/core";
import { childEnv, instrumentsArgs, loadWorkspaceEnv, type WorkspaceEnv } from "./workspace-env.js";
import { rootFor } from "./settings.js";
import { scanCached, seriesDays } from "./data-scan.js";
import { knownParsed, rememberParsed } from "./parse-cache.js";
import { promises as fs, mkdirSync } from "node:fs";
import path from "node:path";
import {
  availableTimeframes, barBases, usesIntrabarOrders, checkConfig, classifyLine, dataFingerprint, isTerminal, lintAliases, makeRunId, newRunJson, normalizeError, parseBuildBarsHint,
  parseIncomplete, parseStrategyInfo, redactConfig, relocate, runHash, tfMs, transition, uniqueStreams, warmupBarsEstimate,
  type HoleDay, type RunError, type RunHashInput, type RunJson, type RunStatus, type StepId, type StepRecord, type StreamDecl, type Tier,
} from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { RunIndex, STARTUP_MS, type IndexRow } from "./index-db.js";
import { JailError, resolveInJail, toRel } from "./jail.js";
import { DERIVED_VERSION, postprocess, PostprocessError, STUDIO_VERSION } from "./postprocess.js";
import { execQkt, spawnGroup, type ProcHandle } from "./proc.js";
import { optionArgs, OptionsError, validateOptions, type RunOptions } from "./run-options.js";

export interface RunRequest {
  strategy: string;
  from: string;
  to: string;
  tier: Tier;
  params?: Record<string, string>;
  /** Pass --allow-incomplete (waive the holes qkt reports). */
  allowIncomplete?: boolean;
  /** Force a fresh run even when an identical finished one exists. */
  force?: boolean;
  /** Auto-run on save: a newer auto run of the same strategy cancels this one. */
  auto?: boolean;
  /** Extra qkt options (starting balance, position mode, seed; broker/execution/slippage for Full runs). */
  options?: RunOptions;
}

export class RunRequestError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export type RunEvent = { id: number } & (
  | { t: "run"; run: RunJson }
  | { t: "progress"; phase: string; fills: number; orders: number; elapsedMs: number; etaMs: number | null }
  | { t: "log"; level: "info" | "warn" | "error"; message: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

class StepFailure extends Error {
  constructor(public readonly step: StepId, public readonly error: RunError) { super(error.message); }
}
class Cancelled extends Error {}

interface Active {
  run: RunJson;
  /** Rejects with Cancelled the moment the run is cancelled: raced against the steps that wait without a child process. */
  cancelWait: Promise<never>;
  rejectCancel(): void;
  /** Data folder qkt reads for this run: the source itself, or a folder of symlinks when symbols come from different sources. */
  dataRoot: string;
  wsEnv: WorkspaceEnv;
  dir: string;
  cancelled: boolean;
  proc?: ProcHandle;
  events: RunEvent[];
  nextId: number;
  listeners: Set<(e: RunEvent) => void>;
  startedMs: number;
  phase: string;
  logCount: number;
  finished: Promise<RunJson>;
  resolve: (r: RunJson) => void;
  /** Delete the run directory (and its history row) once it has stopped: used by Stop/kill. */
  purge?: boolean;
  request: RunRequest;
  stratAbs: string;
  stratSource: string;
  cfgAbs: string;
  info: { streams: StreamDecl[] };
}

const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z_.-]{0,120}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Kill engine processes whose `--report-dir` is inside `runsDir`: left behind when the studio itself was killed. Linux only
 * (reads /proc); elsewhere it does nothing. Returns how many were stopped.
 */
async function stopOrphanEngines(runsDir: string): Promise<number> {
  const prefix = path.resolve(runsDir) + path.sep;
  let n = 0;
  for (const pid of await fs.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    const i = args.indexOf("--report-dir");
    if (i < 0 || !(args[i + 1] ?? "").startsWith(prefix)) continue;
    try { process.kill(Number(pid), "SIGKILL"); n++; } catch { /* gone, or not ours to kill */ }
  }
  return n;
}

/**
 * STUDIO_CDS_DIR set (the Docker image does): backtest JVMs share a class-data archive that the JVM creates on first use,
 * about 10% off every run's start-up with identical results. Backtests only, in their own file, so the archive holds what a
 * backtest loads rather than whatever JVM happened to start first.
 */
function withCds(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = process.env.STUDIO_CDS_DIR;
  if (!dir) return env;
  try { mkdirSync(dir, { recursive: true }); } catch { return env; }
  const opt = `-XX:+AutoCreateSharedArchive -XX:SharedArchiveFile=${path.join(dir, "backtest.jsa")}`;
  return { ...env, QKT_OPTS: [env.QKT_OPTS, opt].filter(Boolean).join(" ") };
}

/** A promise that rejects with Cancelled when the run is cancelled (handled, so an unraced one never counts as unhandled). */
function cancelHandle(): { cancelWait: Promise<never>; rejectCancel(): void } {
  let reject!: (e: unknown) => void;
  const cancelWait = new Promise<never>((_, rej) => { reject = rej; });
  cancelWait.catch(() => undefined);
  return { cancelWait, rejectCancel: () => reject(new Cancelled()) };
}
/** Wait for `p`, or stop waiting as soon as the run is cancelled. */
const orCancel = <T>(a: { cancelWait: Promise<never> }, p: Promise<T>): Promise<T> => Promise.race([p, a.cancelWait]);
const MAX_RANGE_DAYS = 3660;
const MAX_LOG_EVENTS = 300;

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s));
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Runner {
  readonly index: RunIndex;
  private active = new Map<string, Active>();
  /** Final states of runs whose run.json could not be written (disk full): served instead of the stale file. */
  private readonly unsaved = new Map<string, RunJson>();
  private queue: Active[] = [];
  private running = 0;
  private engine: { version: string; gitSha?: string } | null = null;

  constructor(private cfg: ServerConfig) {
    mkdirSync(path.join(cfg.workspace, ".qkt-studio"), { recursive: true });
    this.index = new RunIndex(path.join(cfg.workspace, ".qkt-studio", "index.sqlite"));
  }

  get runsDir() { return path.join(this.cfg.workspace, "runs"); }
  get workspace() { return this.cfg.workspace; }

  runDir(id: string): string {
    if (!RUN_ID.test(id)) throw new RunRequestError("invalid run id", 400);
    return path.join(this.runsDir, id);
  }

  /** Boot: ensure dirs, mark orphaned runs interrupted, rebuild the index from disk. */
  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.mkdir(path.join(this.cfg.workspace, ".qkt-studio"), { recursive: true });
    // a studio killed outright (SIGKILL, OOM) cannot stop its engines: any still writing into this workspace's runs is ours
    // and its run is about to be marked interrupted, so stop it first
    const orphans = await stopOrphanEngines(this.runsDir);
    if (orphans) console.error(`stopped ${orphans} engine process${orphans === 1 ? "" : "es"} left running by a previous studio`);
    for (const d of await fs.readdir(this.runsDir).catch(() => [] as string[])) {
      const file = path.join(this.runsDir, d, "run.json");
      try {
        const run = JSON.parse(await fs.readFile(file, "utf8")) as RunJson;
        if (!isTerminal(run.status)) {
          run.status = transition(run.status, "interrupted");
          run.finishedAt = new Date().toISOString();
          run.error = { kind: "internal", message: "The studio stopped while this run was in progress." };
          run.steps = run.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s));
          await fs.writeFile(file, JSON.stringify(run, null, 2));
          await fs.rm(path.join(this.runsDir, d, "engine"), { recursive: true, force: true });
        }
      } catch { /* not a run directory */ }
    }
    await this.index.reindex(this.runsDir);
  }

  async close(): Promise<void> {
    for (const a of this.active.values()) { a.cancelled = true; await a.proc?.kill(500); }
    this.index.close();
  }

  private async engineInfo(): Promise<{ version: string; gitSha?: string }> {
    if (this.engine) return this.engine;
    const r = await execQkt(this.cfg.qktBin, ["--version"], { cwd: this.cfg.workspace, timeoutMs: 20_000 });
    const m = /^qkt (\S+)(?: \(([0-9a-f]+)\))?/.exec(r.stdout.trim());
    if (r.code !== 0 || !m) throw new RunRequestError(`Cannot run qkt ('${this.cfg.qktBin}'): ${r.stderr.trim().slice(0, 200) || "no output"}`, 503);
    this.engine = { version: m[1]!, gitSha: m[2] };
    return this.engine;
  }

  // ---- submit -------------------------------------------------------------------------------------------------

  private validate(req: RunRequest): void {
    if (!req || typeof req.strategy !== "string" || !req.strategy.endsWith(".qkt")) throw new RunRequestError("strategy must be a .qkt file");
    if (!DATE.test(req.from) || !DATE.test(req.to) || Number.isNaN(Date.parse(req.from)) || Number.isNaN(Date.parse(req.to))) throw new RunRequestError("from/to must be YYYY-MM-DD dates");
    const span = (Date.parse(req.to) - Date.parse(req.from)) / DAY_MS;
    if (span <= 0) throw new RunRequestError("'to' must be after 'from' (the upper bound is exclusive)");
    if (span > MAX_RANGE_DAYS) throw new RunRequestError(`range is longer than ${MAX_RANGE_DAYS} days`);
    if (req.tier !== "draft" && req.tier !== "full") throw new RunRequestError("tier must be 'draft' or 'full'");
    try { validateOptions(req.tier, req.options); } catch (e) { if (e instanceof OptionsError) throw new RunRequestError(e.message); throw e; }
    for (const [k, v] of Object.entries(req.params ?? {})) {
      if (!/^[A-Za-z_]\w*$/.test(k)) throw new RunRequestError(`invalid param name '${k}'`);
      if (typeof v !== "string" || v.length > 200 || /[\n\r\0]/.test(v)) throw new RunRequestError(`invalid value for param '${k}'`);
    }
  }

  /** The strategy file plus everything it IMPORTs, keyed by workspace-relative path. */
  private async loadSources(stratAbs: string): Promise<{ sources: Record<string, string>; streams: StreamDecl[] }> {
    const ws = await fs.realpath(this.cfg.workspace);
    const sources: Record<string, string> = {};
    const streams: StreamDecl[] = [];
    const visit = async (abs: string, depth: number): Promise<void> => {
      const rel = toRel(ws, abs);
      if (sources[rel] !== undefined) return;
      if (depth > 6 || Object.keys(sources).length > 50) throw new RunRequestError("too many nested imports");
      let text: string;
      try { text = await fs.readFile(abs, "utf8"); }
      catch { throw new RunRequestError(depth === 0 ? `strategy not found: ${rel}` : `imported file not found: ${rel}`, 404); }
      sources[rel] = text;
      const info = parseStrategyInfo(text);
      streams.push(...info.streams);
      for (const imp of info.imports) {
        let child: string;
        try { child = await resolveInJail(ws, path.relative(ws, path.resolve(path.dirname(abs), imp.path))); }
        catch (e) { if (e instanceof JailError) throw new RunRequestError(`import '${imp.path}' escapes the workspace`, 403); throw e; }
        await visit(child, depth + 1);
      }
    };
    await visit(stratAbs, 0);
    return { sources, streams: uniqueStreams(streams) };
  }

  /**
   * The data files a run reads, for its fingerprint: the window plus the warmup qkt reads before `from`. The warmup span is the
   * bar count converted to calendar days with room for weekends and holidays (x1.5 + a week), never less than 14 days.
   */
  private async dataFiles(streams: StreamDecl[], tier: Tier, from: string, to: string, warmBars: number): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const end = Date.parse(to);
    const daysFor = (s: StreamDecl) => {
      const back = Math.min(1100, Math.max(14, Math.ceil((Math.max(warmBars, s.warmupBars ?? 0) * (tfMs(s.tf) ?? DAY_MS) * 1.5) / DAY_MS) + 7));
      const out: string[] = [];
      for (let d = Date.parse(from) - back * DAY_MS; d < end; d += DAY_MS) out.push(isoDay(d));
      return out;
    };
    const paths = new Set<string>();
    if (tier === "draft") {
      // the folder qkt reads for each symbol (a 1h stream runs on 15m bars when only those are built), not the stream's own name
      const built = new Map<string, string[]>();
      for (const s of streams) { const k = `${s.broker}:${s.symbol}`; if (!built.has(k)) built.set(k, await availableTimeframes(rootFor(this.cfg, s.symbol), s.broker, s.symbol)); }
      const bases = barBases(streams, (b, sy) => built.get(`${b}:${sy}`) ?? []);
      for (const s of streams) for (const d of daysFor(s)) paths.add(path.join(rootFor(this.cfg, s.symbol), "bars", s.broker, s.symbol, bases.get(`${s.broker}:${s.symbol}`) ?? s.tf, `${d}.bin`));
    }
    else for (const s of streams) for (const d of daysFor(s)) paths.add(path.join(rootFor(this.cfg, s.symbol), "symbols", s.symbol, `${d}.csv.gz`));
    const list = [...paths];
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (let i = 0; i < list.length; i += 256) {
      const stats = await Promise.all(list.slice(i, i + 256).map((p) => fs.stat(p).then((s) => ({ path: p, size: s.size, mtimeMs: s.mtimeMs }), () => null)));
      for (const s of stats) if (s) out.push(s);
    }
    return out;
  }

  private submitLock: Promise<unknown> = Promise.resolve();

  /** Serialised so two identical submits can never both miss the in-flight lookup. */
  submit(req: RunRequest): Promise<{ runId: string; cached: boolean; joined: boolean }> {
    const next = this.submitLock.then(() => this.submitInner(req), () => this.submitInner(req));
    this.submitLock = next.catch(() => undefined);
    return next;
  }

  private async submitInner(req: RunRequest): Promise<{ runId: string; cached: boolean; joined: boolean }> {
    this.validate(req);
    let stratAbs: string;
    try { stratAbs = await resolveInJail(this.cfg.workspace, req.strategy); }
    catch (e) { if (e instanceof JailError) throw new RunRequestError(e.message, e.status); throw e; }
    const ws = await fs.realpath(this.cfg.workspace);
    const stratRel = toRel(ws, stratAbs);
    const { sources, streams } = await this.loadSources(stratAbs);
    const engine = await this.engineInfo();

    const cfgAbs = path.join(ws, "qkt.config.yaml");
    const configText = await fs.readFile(cfgAbs, "utf8").catch(() => "");
    const files = await this.dataFiles(streams, req.tier, req.from, req.to, warmupBarsEstimate(Object.values(sources), req.params ?? {}));
    const wsEnv = await loadWorkspaceEnv(ws);
    // per-symbol data windows (Data -> symbol): a run may not reach outside them
    const win = allowedWindow(this.cfg, streams.map((s) => s.symbol));
    if (win.from && req.from < win.from) throw new RunRequestError(`The window starts ${req.from}, before ${win.from}, the start you set for ${win.by.from} in Data. Move the start date or change that symbol's range.`, 400);
    if (win.to && req.to > win.to) throw new RunRequestError(`The window ends ${req.to}, after ${win.to}, the end you set for ${win.by.to} in Data. Move the end date or change that symbol's range.`, 400);
    const params = Object.fromEntries(Object.entries(req.params ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const options = validateOptions(req.tier, req.options);
    if (options.startingBalance === undefined) { const sb = configStartingBalance(configText, childEnv(this.cfg, wsEnv)); if (sb !== undefined) options.startingBalance = sb; }
    const hashInput: RunHashInput = {
      strategySources: sources, config: configText, params, from: req.from, to: req.to, tier: req.tier, engine,
      // "window-check:1": runs made before the studio refused windows with missing days are not reused (see checkWindowData)
      flags: ["window-check:1", ...(req.allowIncomplete ? ["--allow-incomplete"] : []), ...optionArgs(options), `env:${wsEnv.fingerprint}`, ...(wsEnv.instrumentsText ? [`instruments:${runHashText(wsEnv.instrumentsText)}`] : []), ...Object.entries(this.cfg.symbolPrefs ?? {}).filter(([k, v]) => v.source && streams.some((s) => s.symbol === k)).map(([k, v]) => `src:${k}=${v.source}`)], dataFingerprint: dataFingerprint(files),
    };
    const hash = runHash(hashInput);

    if (!req.force) {
      const done = this.index.findDone(hash);
      if (done && (await fs.stat(path.join(this.runDir(done.id), "derived", "summary.json")).then(() => true, () => false))) {
        await this.ensureDerived(done.id).catch(() => undefined);
        return { runId: done.id, cached: true, joined: false };
      }
      const live = this.index.findActive(hash);
      if (live && this.active.has(live.id)) return { runId: live.id, cached: false, joined: true };
    }

    if (req.auto) for (const a of this.active.values()) if (a.run.strategy === stratRel && a.request.auto) void this.cancel(a.run.id);

    let id = makeRunId(new Date(), stratRel, hash);
    for (let n = 2; await fs.stat(this.runDir(id)).then(() => true, () => false); n++) id = `${makeRunId(new Date(), stratRel, hash)}-${n}`;
    const dir = this.runDir(id);
    await fs.mkdir(path.join(dir, "source"), { recursive: true });
    await fs.mkdir(path.join(dir, "logs"), { recursive: true });
    for (const [rel, text] of Object.entries(sources)) {
      const dest = path.join(dir, "source", rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, text);
    }
    if (configText) await fs.writeFile(path.join(dir, "source", "qkt.config.yaml"), redactConfig(configText));

    const run = newRunJson({ id, hash, tier: req.tier, strategy: stratRel, from: req.from, to: req.to, params, engine, seq: this.index.nextSeq(stratRel) });
    run.auto = req.auto;
    if (Object.keys(options).length) run.options = options as Record<string, string | number>;
    run.studioVersion = STUDIO_VERSION;
    if (req.tier === "draft" && Object.values(sources).some(usesIntrabarOrders)) {
      run.warnings.push("This strategy uses stops, targets or brackets. Draft mode approximates their fills from bars, so results can differ from Full (measured ~7% on a demo). Verify with Full before trusting the numbers.");
    }
    let resolve!: (r: RunJson) => void;
    const finished = new Promise<RunJson>((r) => { resolve = r; });
    const a: Active = {
      ...cancelHandle(), run, dir, dataRoot: this.cfg.dataRoot, wsEnv, cancelled: false, events: [], nextId: 1, listeners: new Set(), startedMs: Date.now(), phase: "queued", logCount: 0,
      finished, resolve, request: req, stratAbs, stratSource: sources[stratRel] ?? "", cfgAbs, info: { streams },
    };
    this.active.set(id, a);
    await this.persist(a);
    this.index.upsert(run);
    this.queue.push(a);
    void this.pump();
    return { runId: id, cached: false, joined: false };
  }

  // ---- events -------------------------------------------------------------------------------------------------

  private emit(a: Active, e: DistributiveOmit<RunEvent, "id">): void {
    const ev = { ...e, id: a.nextId++ } as RunEvent;
    if (ev.t !== "progress") {
      a.events.push(ev);
      if (a.events.length > MAX_LOG_EVENTS + 50) a.events.splice(0, a.events.length - MAX_LOG_EVENTS);
      void fs.appendFile(path.join(a.dir, "logs", "events.ndjson"), JSON.stringify(ev) + "\n").catch(() => {});
    }
    for (const l of a.listeners) l(ev);
  }

  private log(a: Active, level: "info" | "warn" | "error", message: string): void {
    if (a.logCount++ >= MAX_LOG_EVENTS) return;
    this.emit(a, { t: "log", level, message: message.slice(0, 500) });
  }

  /** Replay history then stream live. `afterId` is the SSE Last-Event-ID. */
  async subscribe(id: string, cb: (e: RunEvent) => void, afterId = 0): Promise<() => void> {
    const a = this.active.get(id);
    if (a) {
      for (const e of a.events) if (e.id > afterId) cb(e);
      a.listeners.add(cb);
      return () => a.listeners.delete(cb);
    }
    const run = await this.getRun(id);
    if (!run) throw new RunRequestError("run not found", 404);
    let n = afterId;
    try {
      for (const line of (await fs.readFile(path.join(this.runDir(id), "logs", "events.ndjson"), "utf8")).split("\n")) {
        if (!line) continue;
        const ev = JSON.parse(line) as RunEvent;
        if (ev.id > n && ev.t !== "run") { cb(ev); n = ev.id; }
      }
    } catch { /* no events file */ }
    cb({ id: n + 1, t: "run", run });
    return () => {};
  }

  async getRun(id: string): Promise<RunJson | null> {
    const a = this.active.get(id);
    if (a) return a.run;
    const unsaved = this.unsaved.get(id);
    if (unsaved) return unsaved;
    try { return JSON.parse(await fs.readFile(path.join(this.runDir(id), "run.json"), "utf8")) as RunJson; }
    catch { return null; }
  }

  list(strategy?: string, limit?: number): IndexRow[] { return this.index.list({ strategy, limit }); }

  private rederiving = new Map<string, Promise<void>>();
  /**
   * Make sure a finished run's derived/ files come from the current derivation rules, re-deriving them from engine/ if they are
   * older. Concurrent callers share one re-derivation. A run without engine output (failed, cancelled) is left as it is.
   */
  async ensureDerived(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const pending = this.rederiving.get(id);
    if (pending) return pending;
    // registered before the first await, so concurrent callers (the UI loads several derived files at once) share one
    // re-derivation instead of each parsing the run again
    const dir = this.runDir(id);
    const job = (async () => {
      const meta = JSON.parse(await fs.readFile(path.join(dir, "derived", "meta.json"), "utf8").catch(() => "null")) as { derivedVersion?: number } | null;
      if (!meta || meta.derivedVersion === DERIVED_VERSION) return;
      if (!(await fs.stat(path.join(dir, "engine", "result.json")).then(() => true, () => false))) return;
      const run = await this.getRun(id);
      if (!run || run.status !== "done") return;
      const { root } = await prepareDataView(this.cfg, uniqueStreams(Object.values(await this.sourcesOf(dir, run.strategy)).flatMap((t) => parseStrategyInfo(t).streams)).map((s) => s.symbol));
      await postprocess({ runDir: dir, run, dataRoot: root });
    })().finally(() => this.rederiving.delete(id));
    this.rederiving.set(id, job);
    return job;
  }

  /** The strategy sources a run was made from (its source/ snapshot), keyed by relative path. */
  private async sourcesOf(dir: string, strategy: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else if (e.name.endsWith(".qkt")) out[path.relative(path.join(dir, "source"), p)] = await fs.readFile(p, "utf8");
      }
    };
    await walk(path.join(dir, "source"));
    if (!Object.keys(out).length) out[strategy] = "";
    return out;
  }

  /** Resolves when the run reaches a terminal state (tests and job chaining). */
  async waitFor(id: string): Promise<RunJson> {
    const a = this.active.get(id);
    if (a) return a.finished;
    const r = await this.getRun(id);
    if (!r) throw new RunRequestError("run not found", 404);
    return r;
  }

  // ---- cancel / queue -----------------------------------------------------------------------------------------

  async cancel(id: string, opts: { purge?: boolean } = {}): Promise<boolean> {
    const a = this.active.get(id);
    if (!a) return false;
    a.cancelled = true;
    if (opts.purge) a.purge = true;
    a.rejectCancel();
    const qi = this.queue.indexOf(a);
    if (qi >= 0) { this.queue.splice(qi, 1); await this.finishCancelled(a); return true; }
    await a.proc?.kill();
    return true;
  }

  private async pump(): Promise<void> {
    while (this.running < this.cfg.maxParallel && this.queue.length) {
      const a = this.queue.shift()!;
      this.running++;
      void this.execute(a)
        .catch((e) => console.error(`run ${a.run.id}: ${(e as Error).stack ?? e}`))
        .finally(() => { this.running--; void this.pump(); });
    }
  }

  // ---- pipeline -----------------------------------------------------------------------------------------------

  private async persist(a: Active): Promise<void> {
    const file = path.join(a.dir, "run.json");
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(a.run, null, 2));
    await fs.rename(tmp, file);
    // Snapshot, not a reference: history and slow SSE writers must see the state as of this event.
    this.emit(a, { t: "run", run: structuredClone(a.run) });
  }

  /**
   * For the terminal paths (failed, cancelled): a write that fails (disk full, a read-only folder) must not throw out of the
   * error handler, or the whole server exits and takes every other run with it. The run's final state stays in memory, in
   * the index and in the event stream; only its run.json is stale, and startup marks such a run interrupted.
   */
  private async persistFinal(a: Active): Promise<void> {
    try { await this.persist(a); this.unsaved.delete(a.run.id); } catch (e) {
      console.error(`run ${a.run.id}: could not write run.json (${(e as Error).message}); its state is kept in memory`);
      this.unsaved.set(a.run.id, structuredClone(a.run));
      this.emit(a, { t: "run", run: structuredClone(a.run) });
    }
  }

  private step(a: Active, id: StepId): StepRecord { return a.run.steps.find((s) => s.id === id)!; }

  private async setStatus(a: Active, to: RunStatus): Promise<void> {
    a.run.status = transition(a.run.status, to);
    await this.persist(a);
    this.index.upsert(a.run);
  }

  private async startStep(a: Active, id: StepId, command?: string): Promise<void> {
    const s = this.step(a, id);
    s.status = "running"; s.startedAt = new Date().toISOString(); if (command) s.command = command;
    a.phase = id;
    await this.persist(a);
  }

  private async endStep(a: Active, id: StepId, status: "ok" | "warn" | "failed" | "skipped", message?: string): Promise<void> {
    const s = this.step(a, id);
    s.status = status;
    if (s.startedAt) s.ms = Date.now() - Date.parse(s.startedAt);
    if (message) s.message = message;
    await this.persist(a);
  }

  private guardCancel(a: Active): void { if (a.cancelled) throw new Cancelled(); }

  private env(a: Active): NodeJS.ProcessEnv {
    // Bars ignore config data_root; QKT_DATA_HOME is the only thing they honour [probed]. The workspace .env feeds ${VAR} in qkt.config.yaml.
    return childEnv(this.cfg, a.wsEnv, a.dataRoot);
  }

  private async execute(a: Active): Promise<void> {
    const r = a.run;
    try {
      await this.setStatus(a, "checking");
      await this.stepProject(a); this.guardCancel(a);
      await this.stepConfig(a); this.guardCancel(a);
      a.dataRoot = (await orCancel(a, prepareDataView(this.cfg, a.info.streams.map((s) => s.symbol)))).root;
      await this.stepParse(a); this.guardCancel(a);
      await orCancel(a, this.checkWindowData(a)); this.guardCancel(a);
      await this.stepEngine(a); this.guardCancel(a);
      await this.stepPostprocess(a);
      r.status = transition(r.status, "done");
      r.finishedAt = new Date().toISOString(); r.durationMs = Date.now() - a.startedMs;
      await this.endStep(a, "render", "ok");
      await this.persist(a);
      const summary = await fs.readFile(path.join(a.dir, "derived", "summary.json"), "utf8").then((t) => JSON.parse(t) as { totalPnl: number; sharpe: number; trades: number; winRate: number }, () => undefined);
      this.index.upsert(r, summary);
    } catch (e) {
      if (e instanceof Cancelled || a.cancelled) { await this.finishCancelled(a); return; }
      const failure = e instanceof StepFailure ? e : e instanceof PostprocessError
        ? new StepFailure("postprocess", { kind: "internal", message: e.message })
        : new StepFailure(this.currentStep(a), this.unexpected(e));
      const st = this.step(a, failure.step);
      if (st.status !== "failed") {
        st.status = "failed"; st.message = failure.error.message;
        if (st.startedAt) st.ms = Date.now() - Date.parse(st.startedAt);
      }
      for (const s of r.steps) if (s.status === "pending") s.status = "skipped";
      r.error = failure.error;
      try { r.status = transition(r.status, "failed"); } catch { r.status = "failed"; }
      r.finishedAt = new Date().toISOString(); r.durationMs = Date.now() - a.startedMs;
      await fs.rm(path.join(a.dir, "engine"), { recursive: true, force: true }).catch(() => undefined);
      await this.persistFinal(a);
      try { this.index.upsert(r); } catch (ie) { console.error(`run ${r.id}: index update failed: ${(ie as Error).message}`); }
    } finally {
      this.active.delete(r.id);
      a.resolve(r);
    }
  }

  private currentStep(a: Active): StepId { return a.run.steps.find((s) => s.status === "running")?.id ?? "postprocess"; }

  private unexpected(e: unknown): RunError {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unsupported result/i.test(msg)) return { kind: "unsupported_result", message: msg };
    return { kind: "internal", message: msg.slice(0, 400) };
  }

  private async finishCancelled(a: Active): Promise<void> {
    const r = a.run;
    for (const s of r.steps) if (s.status === "running" || s.status === "pending") s.status = s.status === "running" ? "failed" : "skipped";
    r.error = { kind: "cancelled", message: "Cancelled" };
    try { r.status = transition(r.status, "cancelled"); } catch { r.status = "cancelled"; }
    r.finishedAt = new Date().toISOString(); r.durationMs = Date.now() - a.startedMs;
    await fs.rm(path.join(a.dir, "engine"), { recursive: true, force: true }).catch(() => undefined);
    await this.persistFinal(a);
    try { this.index.upsert(r); } catch (ie) { console.error(`run ${r.id}: index update failed: ${(ie as Error).message}`); }
    this.active.delete(r.id);
    if (a.purge) { await fs.rm(a.dir, { recursive: true, force: true }).catch(() => undefined); this.index.remove(r.id); }
    a.resolve(r);
  }

  /** Stop every active or queued run and remove what they had written. Returns the ids stopped. */
  async cancelAll(opts: { purge?: boolean } = {}): Promise<string[]> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.cancel(id, opts)));
    await Promise.all(ids.map((id) => this.waitFor(id).catch(() => undefined)));
    return ids;
  }

  activeIds(): string[] { return [...this.active.keys()]; }

  private async stepProject(a: Active): Promise<void> {
    await this.startStep(a, "project");
    const cwd = this.cfg.workspace;
    await fs.access(a.stratAbs).catch(() => { throw new StepFailure("project", { kind: "file_not_found", message: `Strategy not found: ${a.run.strategy}`, file: a.run.strategy }); });
    await this.endStep(a, "project", "ok", `workspace ${cwd}; strategy ${a.run.strategy}; ${a.run.tier === "draft" ? "Draft (--bars)" : "Full (ticks)"}`);
  }

  private async stepConfig(a: Active): Promise<void> {
    await this.startStep(a, "config");
    const text = await fs.readFile(a.cfgAbs, "utf8").catch(() => null);
    const findings = checkConfig(text, text !== null, { QKT_DATA_HOME: this.cfg.dataRoot });
    const errs = findings.filter((f) => f.severity === "error");
    if (errs.length) {
      const f = errs[0]!;
      throw new StepFailure("config", { kind: f.code === "missing_config" ? "missing_config" : "bad_config_yaml", message: f.message, file: "qkt.config.yaml", line: f.line, col: f.col });
    }
    const warns = findings.filter((f) => f.severity !== "error");
    for (const w of warns) a.run.warnings.push(w.message);
    await this.endStep(a, "config", warns.length ? "warn" : "ok", warns.length ? `${warns.length} warning(s)` : `qkt.config.yaml OK (explicit --config)`);
  }

  private async stepParse(a: Active): Promise<void> {
    const cmd = `${this.cfg.qktBin} parse ${quote(a.run.strategy)}`;
    await this.startStep(a, "parse", cmd);
    // the live check already ran qkt parse on exactly this text: skip the second JVM (a fast save-and-run loop)
    const already = knownParsed(a.stratSource);
    const r = already ? { code: 0, stdout: "", stderr: "" } : await orCancel(a, execQkt(this.cfg.qktBin, ["parse", a.stratAbs], { cwd: this.cfg.workspace, env: this.env(a), timeoutMs: 30_000 }));
    this.guardCancel(a);
    if (r.code !== 0) {
      const err = normalizeError(r.stderr || r.stdout, r.code);
      if (err.kind === "unknown_indicator") { const loc = relocate(a.stratSource, err.message); if (loc) { err.line = loc.line; err.col = loc.col; } }
      err.file = a.run.strategy;
      throw new StepFailure("parse", err);
    }
    if (!already) rememberParsed(a.stratSource);
    const lint = lintAliases(a.stratSource).filter((d) => d.severity === "error");
    if (lint.length) { const d = lint[0]!; throw new StepFailure("parse", { kind: "unknown_alias", message: d.message, file: a.run.strategy, line: d.line, col: d.col }); }
    await this.endStep(a, "parse", "ok", already ? "syntax OK (checked while editing)" : "syntax OK");
  }

  private async stepEngine(a: Active): Promise<void> {
    const r = a.run, req = a.request;
    const engineDir = path.join(a.dir, "engine");
    const args = [
      "backtest", a.stratAbs, "--config", a.cfgAbs, "--from", r.from, "--to", r.to, "--no-fetch",
      ...(r.tier === "draft" ? ["--bars"] : []), ...(req.allowIncomplete ? ["--allow-incomplete"] : []),
      ...instrumentsArgs(a.wsEnv), ...Object.entries(r.params).flatMap(([k, v]) => ["--param", `${k}=${v}`]), ...optionArgs((r.options ?? {}) as RunOptions), "--report-dir", engineDir,
    ];
    r.coverage = []; r.counts = { fills: 0, orders: 0 };
    await this.startStep(a, "coverage", `${this.cfg.qktBin} ${args.map(quote).join(" ")}`);
    let covDone = false;
    const onLine = (line: string) => {
      const ev = classifyLine(line);
      if (ev.kind === "coverage") {
        r.coverage!.push({ source: ev.source, symbol: ev.symbol, covered: ev.covered, requested: ev.requested, tf: ev.tf });
        if (!covDone) {
          covDone = true;
          const total = r.coverage!;
          void (async () => {
            const short = total.some((c) => c.covered < c.requested);
            await this.endStep(a, "coverage", short ? "warn" : "ok", total.map((c) => `${c.symbol}${c.tf ? " " + c.tf : ""} ${c.covered}/${c.requested} trading days`).join("; "));
            await this.startStep(a, "backtest");
            if (r.status === "checking") await this.setStatus(a, "running");
          })().catch(() => {});
        }
      } else if (ev.kind === "fill") r.counts!.fills++;
      else if (ev.kind === "order") r.counts!.orders++;
      else if (ev.kind === "warning") this.log(a, "warn", ev.message);
      else if (ev.kind === "strategyLog") this.log(a, "info", `${ev.strategy}: ${ev.message}`);
    };

    const perDay = this.index.msPerDay(r.tier, r.strategy) ?? this.index.msPerDay(r.tier);
    const days = Math.max(1, (Date.parse(r.to) - Date.parse(r.from)) / DAY_MS);
    const tick = setInterval(() => {
      const elapsed = Date.now() - a.startedMs;
      this.emit(a, { t: "progress", phase: a.phase, fills: r.counts!.fills, orders: r.counts!.orders, elapsedMs: elapsed, etaMs: perDay !== null ? Math.max(0, Math.round(STARTUP_MS + perDay * days - elapsed)) : null });
    }, 250);

    const proc = spawnGroup(this.cfg.qktBin, args, {
      cwd: this.cfg.workspace, env: withCds(this.env(a)), timeoutMs: Number(process.env.MAX_RUN_MS ?? 30 * 60_000),
      logFiles: { out: path.join(a.dir, "logs", "stdout.log"), err: path.join(a.dir, "logs", "stderr.log") }, onLine,
    });
    a.proc = proc;
    const exit = await proc.exited;
    clearInterval(tick);
    a.proc = undefined;
    // Let the async step bookkeeping from onLine settle before we judge the outcome.
    await new Promise((res) => setTimeout(res, 20));
    this.guardCancel(a);

    const holes: HoleDay[] = parseIncomplete(exit.stderr);
    if (holes.length) r.holes = holes;
    const hint = parseBuildBarsHint(exit.stderr);
    if (hint) r.buildBarsHint = hint;
    if (req.allowIncomplete && holes.length) r.waivedDays = [...new Set([...r.waivedDays, ...holes.map((h) => h.day)])].sort();
    if (req.allowIncomplete && holes.length) r.warnings.push(`Ran with ${holes.length} incomplete/missing day(s) waived: ${holes.slice(0, 5).map((h) => h.day).join(", ")}${holes.length > 5 ? "…" : ""}`);

    if (exit.timedOut) throw new StepFailure(covDone ? "backtest" : "coverage", { kind: "engine_crash", message: "The run exceeded its time limit and was stopped." });
    if (exit.code !== 0) {
      const err = normalizeError(exit.stderr, exit.code);
      const step: StepId = err.kind === "missing_data" || err.kind === "incomplete_data" ? "coverage"
        : err.kind === "parse" || err.kind === "unknown_indicator" ? "parse"
        : err.kind === "bad_config_yaml" || err.kind === "bad_config_key" || err.kind === "missing_config" ? "config"
        : covDone ? "backtest" : "coverage";
      if (err.kind === "unknown_indicator") { const loc = relocate(a.stratSource, err.message); if (loc) { err.line = loc.line; err.col = loc.col; } err.file = r.strategy; }
      throw new StepFailure(step, err);
    }
    if (!covDone) { await this.endStep(a, "coverage", "ok", "no coverage report from qkt"); await this.startStep(a, "backtest"); }
    await this.endStep(a, "backtest", "ok", `${r.counts!.fills} fills`);
  }

  /**
   * The same day-by-day rule the Data section shows, applied before the engine starts. qkt's own coverage check accepts any
   * day that has a file, so an empty file on a 24/7 market (a Saturday with no bars) would pass and the run would silently
   * trade through a day with no data, while the Data section calls that window incomplete. Such days refuse the run like
   * qkt's own holes do; with "run anyway" they are recorded as waived. Reads what the run reads: in a bars run the folder qkt
   * aggregates from, in a tick run the tick files. Days before `from` are warm-up and are not checked.
   */
  private async checkWindowData(a: Active): Promise<void> {
    const r = a.run, req = a.request;
    const report = await scanCached(a.dataRoot).catch(() => null);
    if (!report) return;
    const bySym = new Map(report.symbols.map((s) => [s.symbol, s]));
    const bases = barBases(a.info.streams, (broker, symbol) => bySym.get(symbol)?.bars.filter((b) => b.broker === broker && b.files > 0 && !b.qktReads).map((b) => b.tf) ?? []);
    const found: Array<{ what: string; days: string[] }> = [];
    const seen = new Set<string>();
    for (const s of a.info.streams) {
      const key = r.tier === "draft" ? `${s.broker}:${s.symbol}` : s.symbol;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = r.tier === "draft" ? bases.get(key) : null;
      if (r.tier === "draft" && !base) continue; // nothing qkt can read: its own coverage step names the missing folder
      const series = await seriesDays(a.dataRoot, s.symbol, r.tier === "draft" ? { broker: s.broker, tf: base! } : "ticks").catch(() => null);
      if (!series) continue; // no files at all: qkt reports it with the exact fix
      const days: string[] = [];
      const t0 = Date.parse(`${series.first}T00:00:00Z`);
      for (let i = 0; i < series.days.length; i++) {
        if (series.days[i] !== "m") continue;
        const day = new Date(t0 + i * DAY_MS).toISOString().slice(0, 10);
        if (day >= r.from && day < r.to) days.push(day);
      }
      if (days.length) found.push({ what: r.tier === "draft" ? `${s.symbol} ${base} bars` : `${s.symbol} ticks`, days });
    }
    if (!found.length) return;
    const all = [...new Set(found.flatMap((f) => f.days))].sort();
    const list = found.map((f) => `${f.what}: ${f.days.slice(0, 6).join(", ")}${f.days.length > 6 ? ` and ${f.days.length - 6} more` : ""}`).join("; ");
    if (req.allowIncomplete) {
      r.waivedDays = [...new Set([...r.waivedDays, ...all])].sort();
      r.warnings.push(`Ran with ${all.length} day${all.length === 1 ? "" : "s"} of missing data waived (${list}): the engine sees no ${r.tier === "draft" ? "bars" : "ticks"} on them.`);
      return;
    }
    throw new StepFailure("coverage", {
      kind: "incomplete_data",
      message: `The window has days with no data: ${list}. qkt would run through them as if the market were closed. Pick a window without them (Data shows the complete stretches), fill them, or turn on "run anyway" to waive them.`,
    });
  }

  private async stepPostprocess(a: Active): Promise<void> {
    await this.setStatus(a, "postprocessing");
    await this.startStep(a, "postprocess");
    const res = await postprocess({ runDir: a.dir, run: a.run, dataRoot: a.dataRoot });
    a.run.warnings.push(...res.warnings);
    const bad = res.integrity.checks.filter((c) => c.ok === false);
    if (bad.length) a.run.warnings.push(`Integrity check failed: ${bad.map((c) => c.label).join("; ")}`);
    await this.endStep(a, "postprocess", bad.length ? "warn" : "ok", `${res.trips} trades from ${res.fills} fills; integrity ${res.integrity.ok ? "OK" : "FAILED"}`);
    await this.startStep(a, "render");
  }
}

const runHashText = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
