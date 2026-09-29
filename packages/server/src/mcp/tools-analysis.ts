import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyze, diagnoseExits, queryTrips, type PathBars, type RoundTrip } from "@qkt-studio/core";
import { parseTripQuery } from "../run-data.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const runArg = { run: z.string().optional().describe("run id; default: the run on screen") };

/** The run a tool works on: the one given, else the one on screen, else the newest finished run of the open file. */
export async function resolveRun(ctx: ToolCtx, run?: string): Promise<string> {
  if (run) { if (!(await ctx.data.run(run))) throw new Error(`no run ${run}`); return run; }
  const v = ctx.view.get();
  if (v.runId) return v.runId;
  const newest = ctx.runner.list(v.openFile ?? undefined, 20).find((r) => r.status === "done");
  if (!newest) throw new Error("no run on screen and none finished for the open file; run one first (run_backtest or try_change)");
  return newest.id;
}

export function registerAnalysisTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("run_summary", { description: "Headline numbers of a run: net, trades, win rate, profit factor, drawdown, Sharpe; its window, tier, warnings.", inputSchema: runArg },
    ({ run }) => guard(async () => {
      const id = await resolveRun(ctx, run);
      const [r, sm] = [await ctx.data.run(id), await ctx.data.summary(id)];
      if (!sm) return fail(`run ${id} has no results (status ${r?.status})`);
      return ok({ id, strategy: r?.strategy, from: r?.from, to: r?.to, tier: r?.tier, net: sm.totalPnl, trades: sm.trades, winRate: sm.winRate, profitFactor: sm.profitFactor, expectancy: sm.expectancy, maxDrawdown: sm.maxDrawdown, sharpe: sm.sharpe, long: sm.long, short: sm.short, warnings: r?.warnings ?? [] });
    }));
  s.registerTool("diagnose_exits", { description: "How trades ended (stop/target/signal), how far they moved for and against before exiting, and a what-if table of other stop/target distances.", inputSchema: { ...runArg, stops: z.array(z.number().positive()).max(6).optional(), targets: z.array(z.number().positive()).max(8).optional() } },
    ({ run, stops, targets }) => guard(async () => {
      const id = await resolveRun(ctx, run);
      const trips = await ctx.data.trips(id);
      if (!trips) return fail(`run ${id} has no trades`);
      const bySymbol = new Map<string, PathBars | null>();
      for (const sym of new Set(trips.map((t) => t.symbol))) {
        const ts = trips.filter((t) => t.symbol === sym);
        const from = Math.min(...ts.map((t) => t.entryTs)) - 86_400_000, to = Math.max(...ts.map((t) => t.exitTs ?? t.entryTs)) + 30 * 86_400_000;
        const b = await ctx.data.barsFor(id, sym, from, to);
        bySymbol.set(sym, b ? { ts: b.cols.ts, high: b.cols.high, low: b.cols.low } : null);
      }
      const grid = stops || targets ? { stops: stops ?? [], targets: targets ?? [] } : undefined;
      return ok(diagnoseExits(trips, (t: RoundTrip) => bySymbol.get(t.symbol) ?? null, grid && grid.stops.length && grid.targets.length ? grid : undefined));
    }));
  s.registerTool("diagnose_entries", { description: "Where the results come from: trades, win rate and P&L by UTC hour, weekday, side and exit reason.", inputSchema: runArg },
    ({ run }) => guard(async () => {
      const id = await resolveRun(ctx, run);
      const trips = await ctx.data.trips(id);
      if (!trips) return fail(`run ${id} has no trades`);
      const a = analyze(trips);
      return ok({ id, hour: a.hour, weekday: a.weekday, side: a.side, exit: a.exit, note: "weekday 0 = Monday; hours are UTC entry hours" });
    }));
  s.registerTool("trades", { description: "A run's trades, filtered and sorted: side, outcome (win/loss), exit (stop/target/signal), weekday, date range; compact rows.", inputSchema: {
      ...runArg, side: z.enum(["long", "short"]).optional(), outcome: z.enum(["win", "loss", "breakeven", "open", "closed"]).optional(), exit: z.enum(["stop", "target", "signal", "open"]).optional(),
      weekday: z.number().int().min(0).max(6).optional(), from: z.string().optional(), to: z.string().optional(),
      sort: z.enum(["entryTs", "pnl", "r", "holdMs"]).optional(), dir: z.enum(["asc", "desc"]).optional(), limit: z.number().int().max(50).optional(), offset: z.number().int().optional() } },
    (a) => guard(async () => {
      const id = await resolveRun(ctx, a.run);
      const trips = await ctx.data.trips(id);
      if (!trips) return fail(`run ${id} has no trades`);
      const q = parseTripQuery({ side: a.side, outcome: a.outcome, exit: a.exit, weekday: a.weekday?.toString(), sort: a.sort, dir: a.dir, limit: String(a.limit ?? 20), offset: a.offset?.toString(),
        from: a.from ? String(Date.parse(`${a.from}T00:00:00Z`)) : undefined, to: a.to ? String(Date.parse(`${a.to}T00:00:00Z`) + 86_400_000) : undefined });
      const page = queryTrips(trips, q);
      const iso = (x: number | null) => (x === null ? null : new Date(x).toISOString().slice(0, 16).replace("T", " "));
      return ok({ total: page.total, rows: page.rows.map((t) => ({ id: t.id, side: t.side, symbol: t.symbol, entry: iso(t.entryTs), entryPx: t.entryPx, exit: iso(t.exitTs), exitPx: t.exitPx, why: t.exit, sl: t.sl, tp: t.tp, pnl: t.pnl, r: t.r })) });
    }));
  s.registerTool("trade_detail", { description: "One trade: entry, exit, stop, target, result, and the OHLC bars around it (what the chart shows).", inputSchema: { ...runArg, id: z.number().int(), bars_before: z.number().int().max(60).optional(), bars_after: z.number().int().max(60).optional() } },
    ({ run, id, bars_before, bars_after }) => guard(async () => {
      const rid = await resolveRun(ctx, run);
      const t = (await ctx.data.trips(rid))?.find((x) => x.id === id);
      if (!t) return fail(`no trade ${id} in run ${rid}`);
      const b = await ctx.data.barsFor(rid, t.symbol, t.entryTs - 7 * 86_400_000, (t.exitTs ?? t.entryTs) + 7 * 86_400_000);
      const bars: Array<[string, number, number, number, number]> = [];
      if (b) {
        const ts = b.cols.ts; let a = 0; while (a < ts.length && ts[a]! < t.entryTs) a++; let z = a; while (z < ts.length && ts[z]! < (t.exitTs ?? t.entryTs)) z++;
        for (let i = Math.max(0, a - (bars_before ?? 10)); i < Math.min(ts.length, z + 1 + (bars_after ?? 10)); i++) bars.push([new Date(ts[i]!).toISOString().slice(0, 16).replace("T", " "), b.cols.open[i]!, b.cols.high[i]!, b.cols.low[i]!, b.cols.close[i]!]);
      }
      return ok({ trade: { ...t, entry: new Date(t.entryTs).toISOString(), exit: t.exitTs && new Date(t.exitTs).toISOString() }, tf: b?.tf ?? null, bars, columns: ["time", "open", "high", "low", "close"] });
    }));
  s.registerTool("compare_runs", { description: "Two runs side by side: headline numbers and how many trades each has that the other does not.", inputSchema: { a: z.string(), b: z.string() } },
    ({ a, b }) => guard(async () => {
      const [sa, sb, ta, tb] = [await ctx.data.summary(a), await ctx.data.summary(b), await ctx.data.trips(a), await ctx.data.trips(b)];
      if (!sa || !sb) return fail("both runs must be finished");
      const keyOf = (t: RoundTrip) => `${t.symbol}|${t.side}|${t.entryTs}`;
      const ka = new Set((ta ?? []).map(keyOf)), kb = new Set((tb ?? []).map(keyOf));
      const pick = (s: typeof sa) => ({ net: s.totalPnl, trades: s.trades, winRate: s.winRate, profitFactor: s.profitFactor, maxDrawdown: s.maxDrawdown, sharpe: s.sharpe });
      return ok({ a: { id: a, ...pick(sa) }, b: { id: b, ...pick(sb) }, onlyInA: [...ka].filter((k) => !kb.has(k)).length, onlyInB: [...kb].filter((k) => !ka.has(k)).length });
    }));
}
