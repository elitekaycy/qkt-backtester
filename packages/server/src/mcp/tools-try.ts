import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { partsOf, type Change, type RunJson, type Tier } from "@qkt-studio/core";
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

type RunSettings = { from: string; to: string; tier: string; options: Record<string, string | number>; params: Record<string, string> };
/** What a run was run with, apart from the strategy text: the things a comparison must hold equal. */
export const settingsOf = (r: Pick<RunJson, "from" | "to" | "tier" | "options" | "params">): RunSettings =>
  ({ from: r.from, to: r.to, tier: r.tier, options: r.options ?? {}, params: r.params ?? {} });
const canon = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
/** The settings two runs differ in (window, tier, each option, each --param), as `from`, `options.positionMode`, `params.fast`... */
export function settingsDiff(a: RunSettings, b: RunSettings): string[] {
  const out = (["from", "to", "tier"] as const).filter((k) => a[k] !== b[k]) as string[];
  for (const g of ["options", "params"] as const) {
    if (canon(a[g]) === canon(b[g])) continue;
    for (const k of [...new Set([...Object.keys(a[g]), ...Object.keys(b[g])])].sort()) if (String(a[g][k]) !== String(b[g][k])) out.push(`${g}.${k}`);
  }
  return out;
}

/**
 * Both results, the settings they ran with (always identical: variant and base are submitted from one request), and how the
 * base run relates to the run on the user's screen, so a number is never compared against a run made under other settings.
 */
export async function compareVariant(ctx: ToolCtx, v: Variant) {
  const split = await getSplit(ctx.cfg);
  const runs = new Map<string, RunJson>();
  const one = async (id: string | null) => {
    if (!id) return null;
    const run = await ctx.data.run(id);
    if (!run) return null;
    runs.set(id, run);
    const [sm, trips] = run.status === "done" ? [await ctx.data.summary(id), await ctx.data.trips(id)] : [null, null];
    return { runId: id, status: run.status, error: run.error?.message, net: sm?.totalPnl ?? null, trades: sm?.trades ?? null, winRate: sm?.winRate ?? null, profitFactor: sm?.profitFactor ?? null, maxDrawdown: sm?.maxDrawdown ?? null, parts: trips ? partsOf(trips, run.from, run.to, split) : null };
  };
  const variant = await one(v.runId), base = await one(v.baseRunId);
  const vr = v.runId ? runs.get(v.runId) : undefined, br = v.baseRunId ? runs.get(v.baseRunId) : undefined;
  const settings = br ? settingsOf(br) : null;
  const mismatch = vr && br ? settingsDiff(settingsOf(vr), settingsOf(br)) : [];
  // the run on screen, when it is of the same file: is the base that very run, and if not, what differs
  let onScreen: { runId: string; isBase: boolean; differs: string[] } | null = null;
  const screenId = ctx.view.get().runId;
  const sr = screenId && br ? (screenId === br.id ? br : await ctx.data.run(screenId)) : null;
  if (sr && br && sr.strategy === br.strategy) {
    const differs = settingsDiff(settingsOf(sr), settingsOf(br));
    if (sr.id !== br.id && !differs.length && sr.hash !== br.hash) differs.push("strategy text, config or data (the file changed since that run)");
    onScreen = { runId: sr.id, isBase: sr.id === br.id || sr.hash === br.hash, differs };
  }
  return { variant, base, settings, ...(mismatch.length ? { settingsMismatch: mismatch } : {}), onScreen };
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
      for (const v of made) { const c = await compareVariant(ctx, v); rows.push({ variantId: v.id, label: v.label, ...c.variant, ...(c.settingsMismatch ? { settingsMismatch: c.settingsMismatch } : {}) }); }
      const { base: b0, settings, onScreen } = await compareVariant(ctx, made[0]!);
      return ok({ base: b0, settings, onScreen, variants: rows });
    }));
  s.registerTool("list_variants", { description: "Variants tried so far (newest first), optionally for one strategy.", inputSchema: { base: z.string().optional() } },
    ({ base }) => guard(async () => ok(ctx.variants.list(base).slice(0, 20).map((v) => ({ id: v.id, label: v.label, base: v.base, runId: v.runId, created: v.created })))));
  s.registerTool("discard_variant", { description: "Delete a variant copy (its runs stay in the run history).", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => { await ctx.variants.discard(id); return ok({ discarded: id }); }));
}
