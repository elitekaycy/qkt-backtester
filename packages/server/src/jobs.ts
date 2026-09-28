import { spawnEnv } from "./workspace-env.js";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeError, parseStrategyInfo, type RunError, type Tier } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { resolveInJail } from "./jail.js";
import { downsampleEquity } from "./postprocess.js";
import { cleanupPartialFiles, validBarFile, validGzip } from "./cleanup.js";
import { invalidateScan } from "./data-scan.js";
import { spawnGroup, type ProcHandle } from "./proc.js";
import { Runner, RunRequestError } from "./runner.js";

export type JobKind = "build-bars" | "fetch" | "grid" | "walkforward";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  command?: string;
  log: string[];
  progress?: { done: number; total: number };
  /** Files removed because the job was interrupted while writing them. */
  cleaned?: string[];
  result?: unknown;
  error?: RunError;
}

const NAME = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;
const TF = /^\d{1,4}[smhdw]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DUR = /^\d{1,4}d$/;
const RANKS = ["sharpe", "calmar", "profitFactor", "totalPnL", "winRate"] as const;
const MAX_GRID = 200;
const LOG_KEEP = 200;

const need = (cond: unknown, msg: string) => { if (!cond) throw new RunRequestError(msg); };
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s));

function cartesian(axes: Record<string, string[]>): Array<Record<string, string>> {
  let combos: Array<Record<string, string>> = [{}];
  for (const [k, vs] of Object.entries(axes)) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
  return combos;
}

export class Jobs {
  private jobs = new Map<string, Job>();
  private procs = new Map<string, ProcHandle>();
  private cancelled = new Set<string>();
  private meta = new Map<string, { sinceMs: number; dir: string; pattern: RegExp; validate: (b: Buffer) => boolean }>();

  constructor(private cfg: ServerConfig, private runner: Runner) {}

  private get dir() { return path.join(this.cfg.workspace, ".qkt-studio", "jobs"); }
  private env() { return spawnEnv(this.cfg); }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const f of await fs.readdir(this.dir).catch(() => [] as string[])) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(await fs.readFile(path.join(this.dir, f), "utf8")) as Job;
        if (j.status === "running") { j.status = "failed"; j.error = { kind: "internal", message: "The studio stopped while this job was running." }; }
        this.jobs.set(j.id, j);
      } catch { /* ignore junk */ }
    }
  }

  get(id: string): Job | undefined { return this.jobs.get(id); }
  list(): Job[] { return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100); }

  private create(kind: JobKind, command?: string): Job {
    const job: Job = { id: `${kind}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, kind, status: "running", startedAt: new Date().toISOString(), log: [], command };
    this.jobs.set(job.id, job);
    return job;
  }

  private async save(job: Job): Promise<void> {
    await fs.writeFile(path.join(this.dir, `${job.id}.json`), JSON.stringify(job)).catch(() => {});
  }

  private finish(job: Job, status: JobStatus, error?: RunError): void {
    job.status = status; job.endedAt = new Date().toISOString();
    if (error) job.error = error;
    void this.save(job);
  }

  private pushLog(job: Job, line: string): void {
    job.log.push(line.slice(0, 400));
    if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP);
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    this.cancelled.add(id);
    await this.procs.get(id)?.kill();
    if (job.kind === "grid") for (const r of (job.result as { rows: Array<{ runId?: string }> } | undefined)?.rows ?? []) if (r.runId) void this.runner.cancel(r.runId, { purge: true });
    return true;
  }

  /** Stop every running job. Returns their ids. */
  async cancelAll(): Promise<string[]> {
    const ids = [...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.id);
    await Promise.all(ids.map((id) => this.cancel(id)));
    return ids;
  }

  // ---- data jobs ----------------------------------------------------------------------------------------------

  private validateRange(r: { symbol?: string; tf?: string; from?: string; to?: string }): void {
    need(r.symbol && NAME.test(r.symbol), "symbol must be a plain identifier");
    need(r.tf && TF.test(r.tf), "tf must look like 15m, 1h, 1d");
    need(r.from && DATE.test(r.from) && r.to && DATE.test(r.to) && Date.parse(r.from) < Date.parse(r.to), "from/to must be YYYY-MM-DD with from before to");
  }

  private async cleanup(job: Job): Promise<void> {
    const m = this.meta.get(job.id);
    if (!m) return;
    const removed = await cleanupPartialFiles(m.dir, m.sinceMs, m.pattern, m.validate);
    if (removed.length) { job.cleaned = removed; this.pushLog(job, `removed ${removed.length} partially written file(s): ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? "…" : ""}`); }
    invalidateScan();
  }

  private runProcess(job: Job, args: string[], after?: (code: number | null, stderr: string) => Promise<void>): void {
    job.command = `${this.cfg.qktBin} ${args.map(quote).join(" ")}`;
    const proc = spawnGroup(this.cfg.qktBin, args, { cwd: this.cfg.workspace, env: this.env(), timeoutMs: 60 * 60_000, onLine: (l) => this.pushLog(job, l) });
    this.procs.set(job.id, proc);
    void proc.exited.then(async (exit) => {
      this.procs.delete(job.id);
      if (this.cancelled.has(job.id)) { await this.cleanup(job); return this.finish(job, "cancelled", { kind: "cancelled", message: "Stopped. Partially written files were removed." }); }
      if (exit.code !== 0) { await this.cleanup(job); return this.finish(job, "failed", normalizeError(exit.stderr, exit.code)); }
      try { await after?.(exit.code, exit.stderr); invalidateScan(); this.finish(job, "done"); }
      catch (e) { this.finish(job, "failed", { kind: "internal", message: (e as Error).message }); }
    });
  }

  buildBars(req: { symbol: string; tf: string; from: string; to: string }): Job {
    this.validateRange(req);
    const job = this.create("build-bars");
    this.meta.set(job.id, { sinceMs: Date.now(), dir: path.join(this.cfg.dataRoot, "bars", "BACKTEST", req.symbol, req.tf), pattern: /^\d{4}-\d{2}-\d{2}\.bin$/, validate: validBarFile });
    this.runProcess(job, ["data", "build-bars", req.symbol, "--tf", req.tf, "--from", req.from, "--to", req.to, "--data-root", this.cfg.dataRoot]);
    return job;
  }

  fetch(req: { broker: string; symbol: string; tf: string; from: string; to: string }): Job {
    this.validateRange(req);
    need(req.broker && NAME.test(req.broker), "broker must be a plain identifier");
    const job = this.create("fetch");
    this.meta.set(job.id, { sinceMs: Date.now(), dir: path.join(this.cfg.dataRoot, "symbols", req.symbol), pattern: /\.csv\.gz$/, validate: validGzip });
    this.runProcess(job, ["fetch", `${req.broker}:${req.symbol}`, "--tf", req.tf, "--from", req.from, "--to", req.to, "--data-root", this.cfg.dataRoot]);
    return job;
  }

  // ---- parameter grid: one full run per point (qkt sweep produces no per-scenario bundles) --------------------

  async grid(req: { strategy: string; from: string; to: string; tier: Tier; params: Record<string, string[]>; rank?: (typeof RANKS)[number]; allowIncomplete?: boolean }): Promise<Job> {
    need(req && typeof req.strategy === "string", "strategy is required");
    const rank = req.rank ?? "sharpe";
    need(RANKS.includes(rank), `rank must be one of ${RANKS.join(", ")}`);
    const axes = Object.entries(req.params ?? {});
    need(axes.length > 0, "at least one parameter axis is required");
    for (const [k, vs] of axes) need(/^[A-Za-z_]\w*$/.test(k) && Array.isArray(vs) && vs.length > 0 && vs.every((v) => typeof v === "string" && v.length <= 60 && !/[\n\r\0]/.test(v)), `invalid axis '${k}'`);
    const combos = cartesian(req.params);
    need(combos.length <= MAX_GRID, `grid has ${combos.length} points; the limit is ${MAX_GRID}`);
    const abs = await resolveInJail(this.cfg.workspace, req.strategy).catch((e: Error) => { throw new RunRequestError(e.message, 403); });
    const declared = parseStrategyInfo(await fs.readFile(abs, "utf8").catch(() => { throw new RunRequestError(`strategy not found: ${req.strategy}`, 404); })).params.map((p) => p.name);
    for (const [k] of axes) need(declared.includes(k), `'${k}' is not a PARAM of this strategy (declared: ${declared.join(", ") || "none"})`);

    const job = this.create("grid");
    job.progress = { done: 0, total: combos.length };
    const rows: Array<{ params: Record<string, string>; runId?: string; status: string; summary?: Record<string, number> }> = combos.map((params) => ({ params, status: "queued" }));
    job.result = { rank, rows, warnings: combos.length > 20 ? [`Best of ${combos.length} trials: the top result is optimistically biased by selection. Validate out of sample.`] : [] };
    void (async () => {
      await Promise.all(rows.map(async (row) => {
        try {
          if (this.cancelled.has(job.id)) { row.status = "cancelled"; return; }
          const { runId } = await this.runner.submit({ strategy: req.strategy, from: req.from, to: req.to, tier: req.tier, params: row.params, allowIncomplete: req.allowIncomplete });
          row.runId = runId; row.status = "running";
          const run = await this.runner.waitFor(runId);
          row.status = run.status;
          if (run.status === "done") {
            const s = JSON.parse(await fs.readFile(path.join(this.runner.runDir(runId), "derived", "summary.json"), "utf8"));
            // a blown account (equity at or below zero) has no meaningful ratios: they stay null and the row ranks last
            row.summary = { totalPnL: s.totalPnl, sharpe: s.sharpe, calmar: s.calmar, profitFactor: s.profitFactor ?? 0, winRate: s.winRate, trades: s.trades, maxDrawdown: s.maxDrawdown, blown: s.blown ? 1 : 0 };
          } else if (run.error) this.pushLog(job, `${JSON.stringify(row.params)}: ${run.error.message}`);
        } catch (e) { row.status = "failed"; this.pushLog(job, `${JSON.stringify(row.params)}: ${(e as Error).message}`); }
        finally { job.progress!.done++; }
      }));
      const key = rank as string;
      const score = (r: (typeof rows)[number]) => (!r.summary || r.summary.blown ? -Infinity : r.summary[key] ?? -Infinity);
      rows.sort((a, b) => (score(a) === score(b) ? 0 : score(b) > score(a) ? 1 : -1));
      if (this.cancelled.has(job.id)) return this.finish(job, "cancelled", { kind: "cancelled", message: "Cancelled" });
      const failed = rows.filter((r) => r.status === "failed").length;
      this.finish(job, failed === rows.length ? "failed" : "done", failed === rows.length ? { kind: "internal", message: "Every grid point failed" } : undefined);
    })();
    return job;
  }

  // ---- walk-forward: qkt walkforward with report-dir; results read back from its files -----------------------

  async walkForward(req: { strategy: string; from: string; to: string; tier: Tier; params: Record<string, string[]>; train: string; test: string; step: string; rank?: (typeof RANKS)[number]; allowIncomplete?: boolean }): Promise<Job> {
    need(req && typeof req.strategy === "string", "strategy is required");
    need([req.train, req.test, req.step].every((d) => DUR.test(d)), "train/test/step must look like 45d");
    need(DATE.test(req.from) && DATE.test(req.to) && Date.parse(req.from) < Date.parse(req.to), "from/to must be YYYY-MM-DD with from before to");
    const rank = req.rank ?? "sharpe";
    need(RANKS.includes(rank), `rank must be one of ${RANKS.join(", ")}`);
    const axes = Object.entries(req.params ?? {});
    need(axes.length > 0, "at least one parameter axis is required");
    for (const [k, vs] of axes) need(/^[A-Za-z_]\w*$/.test(k) && Array.isArray(vs) && vs.length > 0 && vs.every((v) => typeof v === "string" && /^[\w.\-]{1,40}$/.test(v)), `invalid axis '${k}'`);
    const abs = await resolveInJail(this.cfg.workspace, req.strategy).catch((e: Error) => { throw new RunRequestError(e.message, 403); });
    need(await fs.stat(abs).then((s) => s.isFile(), () => false), `strategy not found: ${req.strategy}`);
    const cfgAbs = path.join(this.cfg.workspace, "qkt.config.yaml");
    need(await fs.stat(cfgAbs).then(() => true, () => false), "qkt.config.yaml not found");

    const job = this.create("walkforward");
    const outDir = path.join(this.dir, job.id, "wf");
    const args = [
      "walkforward", abs, "--config", cfgAbs, "--from", req.from, "--to", req.to, "--no-fetch", ...(req.tier === "draft" ? ["--bars"] : []),
      ...(req.allowIncomplete ? ["--allow-incomplete"] : []), ...axes.flatMap(([k, vs]) => ["--param", `${k}=${vs.join(",")}`]),
      "--train", req.train, "--test", req.test, "--step", req.step, "--rank", rank, "--parallelism", String(Math.min(this.cfg.maxParallel, 4)), "--report-dir", outDir,
    ];
    this.runProcess(job, args, async () => {
      const summary = JSON.parse(await fs.readFile(path.join(outDir, "walkforward_summary.json"), "utf8"));
      const csv = (await fs.readFile(path.join(outDir, "concatenated_equity.csv"), "utf8").catch(() => "")).split("\n").slice(1).filter(Boolean);
      const ts = csv.map((l) => Number(l.slice(0, l.indexOf(",")))), eq = csv.map((l) => Number(l.slice(l.indexOf(",") + 1)));
      job.result = { ...summary, oosEquity: downsampleEquity(ts, eq, 3000), tier: req.tier, train: req.train, test: req.test, step: req.step };
    });
    return job;
  }
}

export function registerJobRoutes(app: FastifyInstance, jobs: Jobs): void {
  const accepted = (job: Job) => ({ jobId: job.id });
  app.post<{ Body: Parameters<Jobs["buildBars"]>[0] }>("/api/data/build-bars", async (req, reply) => reply.code(202).send(accepted(jobs.buildBars(req.body))));
  app.post<{ Body: Parameters<Jobs["fetch"]>[0] }>("/api/data/fetch", async (req, reply) => reply.code(202).send(accepted(jobs.fetch(req.body))));
  app.post<{ Body: Parameters<Jobs["grid"]>[0] }>("/api/jobs/grid", async (req, reply) => reply.code(202).send(accepted(await jobs.grid(req.body))));
  app.post<{ Body: Parameters<Jobs["walkForward"]>[0] }>("/api/jobs/walkforward", async (req, reply) => reply.code(202).send(accepted(await jobs.walkForward(req.body))));
  app.get("/api/jobs", async () => ({ jobs: jobs.list().map(({ log: _l, result: _r, ...j }) => j) }));
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => jobs.get(req.params.id) ?? reply.code(404).send({ error: "job not found" }));
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req, reply) => ((await jobs.cancel(req.params.id)) ? { cancelled: true } : reply.code(409).send({ error: "job is not running" })));
}
