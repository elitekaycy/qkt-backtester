import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { partsOf, type Change, type Tier } from "@qkt-studio/core";
import { getSplit } from "../split.js";
import type { Variant } from "../agent/variants.js";
import { changesSchema } from "./schemas.js";
import { ok, guard, toolPath, type ToolCtx } from "./util.js";

const winArgs = { from: z.string().optional(), to: z.string().optional(), tier: z.enum(["draft", "full"]).optional().describe("draft = bars (fast, default), full = ticks") };

/** The window to run on: given, else the run on screen, else the base's newest run. */
async function windowFor(ctx: ToolCtx, base: string, a: { from?: string; to?: string; tier?: Tier }): Promise<Variant["window"]> {
  const v = ctx.view.get();
  const newest = ctx.runner.list(base, 5)[0];
  const from = a.from ?? v.runWindow?.from ?? newest?.from_d, to = a.to ?? v.runWindow?.to ?? newest?.to_d;
  if (!from || !to) throw new Error("no window: give from/to (YYYY-MM-DD), or run the strategy once first");
  return { from, to, tier: a.tier ?? "draft" };
}
const baseOf = async (ctx: ToolCtx, base?: string) => {
  const b = base ?? ctx.view.get().openFile;
  if (!b || !b.endsWith(".qkt")) throw new Error("no strategy: give base, or open one in the editor");
  return (await toolPath(ctx.cfg.workspace, b, { ext: ".qkt" })).rel;
};
/**
 * Run variants with the tool's queue priority. `release` frees the budget the caller reserved for them (a variant and its
 * base each count; n variants of one base need n + 1 runs) once every submit has been accepted or refused; from then on
 * the runs themselves count. Each run the tool itself created is recorded the moment its submit resolves.
 */
async function runVariants(ctx: ToolCtx, vs: Variant[], release: () => void): Promise<void> {
  let pending = vs.length;
  try {
    await Promise.all(vs.map((v) => ctx.variants.run(v, {
      source: "tool",
      onSubmit: (which, r) => {
        if (r.joined) return; // someone else's identical run in flight: not the tool's
        ctx.budget.track(r.runId);
        if (which === "variant") ctx.started.add(r.runId); // the variant's own run only; a base run may be what the user is looking at
      },
      onSubmitted: () => { if (--pending === 0) release(); },
    })));
  } finally { release(); }
}

export async function compareVariant(ctx: ToolCtx, v: Variant) {
  const split = await getSplit(ctx.cfg);
  const one = async (id: string | null) => {
    if (!id) return null;
    const run = await ctx.data.run(id);
    if (!run) return null;
    const [sm, trips] = run.status === "done" ? [await ctx.data.summary(id), await ctx.data.trips(id)] : [null, null];
    return { runId: id, status: run.status, error: run.error?.message, net: sm?.totalPnl ?? null, trades: sm?.trades ?? null, winRate: sm?.winRate ?? null, profitFactor: sm?.profitFactor ?? null, maxDrawdown: sm?.maxDrawdown ?? null, parts: trips ? partsOf(trips, run.from, run.to, split) : null };
  };
  return { variant: await one(v.runId), base: await one(v.baseRunId) };
}

export function registerTryTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("try_change", { description: "Apply changes to a copy of the strategy, run it and its base on the same window, show it on the user's chart, and return both results. The user's file is untouched.", inputSchema: { changes: changesSchema, base: z.string().optional(), label: z.string().optional(), ...winArgs } },
    (a) => guard(async () => {
      const base = await baseOf(ctx, a.base);
      const release = ctx.budget.reserve(2); // before building anything: "busy" leaves no variant behind
      try {
        const v = await ctx.variants.create(base, a.label ?? (a.changes as Change[]).map((c) => c.op).join(", "), a.changes as Change[], await windowFor(ctx, base, a));
        await runVariants(ctx, [v], release);
        return ok({ variantId: v.id, label: v.label, diff: v.diff, notes: v.notes, ...(await compareVariant(ctx, v)), shown: "on the user's chart; they can Adopt, Discard or go back" });
      } finally { release(); }
    }));
  s.registerTool("try_variants", { description: "Several labelled alternatives at once (e.g. stop 1, 2, 3 %), each run beside the base; returns a comparison table.", inputSchema: { variants: z.array(z.object({ label: z.string(), changes: changesSchema })).min(2).max(6), base: z.string().optional(), ...winArgs } },
    (a) => guard(async () => {
      const base = await baseOf(ctx, a.base), window = await windowFor(ctx, base, a);
      const release = ctx.budget.reserve(a.variants.length + 1);
      const made = [];
      try {
        // every variant is built and checked before any is written: one that does not parse leaves nothing half made
        const prepared = await Promise.all(a.variants.map((x) => ctx.variants.prepare(base, x.label, x.changes as Change[], window).catch((e: Error) => { throw new Error(`variant "${x.label}": ${e.message}`); })));
        for (const p of prepared) made.push(await ctx.variants.commit(p));
        await runVariants(ctx, made, release);
      } finally { release(); }
      const rows = [];
      for (const v of made) rows.push({ variantId: v.id, label: v.label, ...(await compareVariant(ctx, v)).variant });
      return ok({ base: (await compareVariant(ctx, made[0]!)).base, variants: rows });
    }));
  s.registerTool("list_variants", { description: "Variants tried so far (newest first), optionally for one strategy.", inputSchema: { base: z.string().optional() } },
    ({ base }) => guard(async () => ok(ctx.variants.list(base).slice(0, 20).map((v) => ({ id: v.id, label: v.label, base: v.base, runId: v.runId, created: v.created })))));
  s.registerTool("discard_variant", { description: "Delete a variant copy (its runs stay in the run history).", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => { await ctx.variants.discard(id); return ok({ discarded: id }); }));
}
