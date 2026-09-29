import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { partsOf, type Tier } from "@qkt-studio/core";
import { validateBuildRange } from "../jobs.js";
import { getSplit } from "../split.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const pathOf = (ctx: ToolCtx, p?: string) => { const x = p ?? ctx.view.get().openFile; if (!x?.endsWith(".qkt")) throw new Error("no strategy: give path, or open one in the editor"); return x; };
const windowOf = (ctx: ToolCtx, p: string, from?: string, to?: string) => {
  const v = ctx.view.get(), newest = ctx.runner.list(p, 5)[0];
  const f = from ?? v.runWindow?.from ?? newest?.from_d, t = to ?? v.runWindow?.to ?? newest?.to_d;
  if (!f || !t) throw new Error("no window: give from/to (YYYY-MM-DD), or run the strategy once first");
  return { from: f, to: t };
};

/** Run and job tools: backtest, walk-forward, sweep, job status/cancel, and data-build proposals. */
export function registerRunTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("run_backtest", { description: "Run a strategy as the Run button does (it shows on the chart when it is the open file); waits up to 3 minutes.", inputSchema: { path: z.string().optional(), from: z.string().optional(), to: z.string().optional(), tier: z.enum(["draft", "full"]).optional(), params: z.record(z.string()).optional() } },
    (a) => guard(async () => {
      const p = pathOf(ctx, a.path), w = windowOf(ctx, p, a.from, a.to);
      const { runId, cached } = await ctx.runner.submit({ strategy: p, ...w, tier: (a.tier ?? "draft") as Tier, params: a.params });
      const run = await Promise.race([ctx.runner.waitFor(runId), new Promise<null>((r) => setTimeout(() => r(null), 180_000))]);
      ctx.events.emit({ t: "run", runId });
      if (!run) return ok({ runId, status: "running", note: "still running; ask get_run later" });
      const sm = run.status === "done" ? await ctx.data.summary(runId) : null;
      return ok({ runId, cached, status: run.status, error: run.error?.message, net: sm?.totalPnl, trades: sm?.trades, winRate: sm?.winRate, profitFactor: sm?.profitFactor, maxDrawdown: sm?.maxDrawdown });
    }));
  s.registerTool("run_walkforward", { description: "Walk-forward test (the Lab's): optimise params on rolling train windows, test on the next; returns a job id.", inputSchema: { path: z.string().optional(), from: z.string(), to: z.string(), params: z.record(z.array(z.string())), train: z.string().describe("e.g. 90d"), test: z.string().describe("e.g. 30d"), step: z.string().describe("e.g. 30d") } },
    (a) => guard(async () => ok({ jobId: (await ctx.jobs.walkForward({ strategy: pathOf(ctx, a.path), from: a.from, to: a.to, tier: "draft", params: a.params, train: a.train, test: a.test, step: a.step })).id })));
  s.registerTool("sweep", { description: "Grid over params (the Lab grid). The job's rows give you the FIRST part of the split only; the user sees both.", inputSchema: { path: z.string().optional(), params: z.record(z.array(z.string())), from: z.string().optional(), to: z.string().optional() } },
    (a) => guard(async () => { const p = pathOf(ctx, a.path); return ok({ jobId: (await ctx.jobs.grid({ strategy: p, ...windowOf(ctx, p, a.from, a.to), tier: "draft", params: a.params })).id }); }));
  s.registerTool("job_status", { description: "Progress and results of a job (sweep, walk-forward, data build).", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => {
      const j = ctx.jobs.get(id);
      if (!j) return fail(`no job ${id}`);
      const base = { id, kind: j.kind, status: j.status, progress: j.progress, error: j.error?.message };
      if (j.kind !== "grid" || j.status !== "done") return ok({ ...base, log: j.log.slice(-5) });
      const split = await getSplit(ctx.cfg);
      const rows = [];
      for (const r of ((j.result as { rows?: Array<{ params: Record<string, string>; runId?: string; status: string }> })?.rows ?? []).slice(0, 30)) {
        const run = r.runId ? await ctx.data.run(r.runId) : null, trips = r.runId ? await ctx.data.trips(r.runId) : null;
        const parts = run && trips ? partsOf(trips, run.from, run.to, split) : null;
        rows.push({ params: r.params, runId: r.runId, status: r.status, first: parts?.first ?? null }); // the test part is for the user's eyes
      }
      return ok({ ...base, split, rows });
    }));
  s.registerTool("cancel", { description: "Stop a run or job the tools started.", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => ok({ cancelled: (await ctx.runner.cancel(id, { purge: true })) || (await ctx.jobs.cancel(id)) })));
  s.registerTool("propose_build_bars", { description: "Propose building bars from ticks for a symbol and timeframe; the user starts the job.", inputSchema: { symbol: z.string(), tf: z.string(), from: z.string(), to: z.string() } },
    (a) => guard(async () => {
      const symbol = a.symbol.replace(/^.*:/, "");
      validateBuildRange({ symbol, tf: a.tf, from: a.from, to: a.to });
      const p = await ctx.proposals.create({ kind: "job", title: `Build ${a.symbol} ${a.tf} bars ${a.from} to ${a.to}`, job: { symbol, tf: a.tf, from: a.from, to: a.to } });
      return ok({ proposalId: p.id });
    }));
}
