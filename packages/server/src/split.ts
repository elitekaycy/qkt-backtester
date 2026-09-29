import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SPLIT, describeSplit, parseSplit, partsOf, type Split } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { loadSettings, updateSettings } from "./settings.js";
import type { EventBus } from "./agent/events.js";
import type { RunData } from "./run-data.js";
import { ok, guard, type ToolCtx } from "./mcp/util.js";

export async function getSplit(cfg: ServerConfig): Promise<Split> { return (await loadSettings(cfg)).split ?? DEFAULT_SPLIT; }
export async function setSplit(cfg: ServerConfig, events: EventBus, x: unknown): Promise<Split> {
  const split = parseSplit(x);
  await updateSettings(cfg, (s) => ({ ...s, split }));
  events.emit({ t: "split" });
  return split;
}

export function registerSplitRoutes(app: FastifyInstance, cfg: ServerConfig, events: EventBus, data: RunData): void {
  app.get("/api/split", async () => { const split = await getSplit(cfg); return { split, text: describeSplit(split) }; });
  app.put<{ Body: unknown }>("/api/split", async (req, reply) => {
    try { const split = await setSplit(cfg, events, req.body); return { split, text: describeSplit(split) }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  /** A run's trades divided by the split (no re-run: trades are grouped by exit time). */
  app.get<{ Params: { id: string } }>("/api/runs/:id/parts", async (req, reply) => {
    const [run, trips] = [await data.run(req.params.id), await data.trips(req.params.id)];
    if (!run || !trips) return reply.code(404).send({ error: "run has no trades" });
    return partsOf(trips, run.from, run.to, await getSplit(cfg));
  });
}

export function registerSplitTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("get_split", { description: "The split of backtest windows into a first part and a test part (the user's setting)." },
    () => guard(async () => { const split = await getSplit(ctx.cfg); return ok({ split, text: describeSplit(split) }); }));
  s.registerTool("set_split", { description: 'Change the split: {"test_pct": 25}, {"test_last": "3 months"}, {"test_from": "2026-07-01"} or {"none": true}. Every view updates.', inputSchema: { split: z.record(z.unknown()) } },
    ({ split }) => guard(async () => { const next = await setSplit(ctx.cfg, ctx.events, split); return ok({ split: next, text: describeSplit(next) }); }));
}
