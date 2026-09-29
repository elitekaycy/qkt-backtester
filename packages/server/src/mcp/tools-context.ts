import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listStrategies } from "../data-scan.js";
import { resolveInJail } from "../jail.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

export function registerContextTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("get_context", { description: "What the user is looking at: open file, cursor, selection, the run on screen with its headline numbers, visible chart range, selected trade, variant, split." },
    () => guard(async () => {
      const v = ctx.view.get();
      const summary = v.runId ? await ctx.data.summary(v.runId) : null;
      const files = await listStrategies(ctx.cfg.workspace, 50);
      return ok({
        openFile: v.openFile ? { path: v.openFile, cursorLine: v.cursorLine, selection: v.selection } : null,
        run: v.runId ? { id: v.runId, window: v.runWindow, summary: summary && { trades: summary.trades, totalPnl: summary.totalPnl, winRate: summary.winRate, maxDrawdown: summary.maxDrawdown } } : null,
        chart: { visibleFrom: v.visibleFrom && new Date(v.visibleFrom).toISOString(), visibleTo: v.visibleTo && new Date(v.visibleTo).toISOString(), selectedTrade: v.selectedTrade },
        variantId: v.variantId, strategies: files,
      });
    }));
  s.registerTool("list_files", { description: "Workspace files (strategies, qkt.config.yaml, instruments.yaml, notes), optionally under one folder.", inputSchema: { dir: z.string().optional() } },
    ({ dir }) => guard(async () => {
      const root = await resolveInJail(ctx.cfg.workspace, dir ?? ".");
      const out: string[] = [];
      const walk = async (d: string, depth: number) => {
        if (depth > 3 || out.length >= 300) return;
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.name === "runs" || e.name === "node_modules" || (e.name.startsWith(".") && e.name !== ".env")) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p, depth + 1); else out.push(path.relative(ctx.cfg.workspace, p).split(path.sep).join("/"));
        }
      };
      await walk(root, 0);
      return ok(out.sort());
    }));
  s.registerTool("read_file", { description: "Read a workspace file (whole, or a line range).", inputSchema: { path: z.string(), from_line: z.number().int().optional(), to_line: z.number().int().optional() } },
    ({ path: rel, from_line, to_line }) => guard(async () => {
      if (/(^|\/)\.env$/.test(rel)) return fail(".env holds secrets and is not readable by tools");
      const abs = await resolveInJail(ctx.cfg.workspace, rel);
      const lines = (await fs.readFile(abs, "utf8")).split("\n");
      const a = Math.max(1, from_line ?? 1), b = Math.min(lines.length, to_line ?? lines.length);
      return ok({ path: rel, lines: `${a}-${b} of ${lines.length}`, text: lines.slice(a - 1, b).join("\n") }, "read a line range with from_line/to_line");
    }));
  s.registerTool("list_runs", { description: "Recent runs, newest first, optionally of one strategy: id, window, tier, status, trades, net P&L.", inputSchema: { strategy: z.string().optional(), limit: z.number().int().max(50).optional() } },
    ({ strategy, limit }) => guard(async () => ok(ctx.runner.list(strategy, limit ?? 15).map((r) => ({ id: r.id, strategy: r.strategy, from: r.from_d, to: r.to_d, tier: r.tier, status: r.status, trades: r.trades, net: r.total_pnl, sharpe: r.sharpe })))));
  s.registerTool("get_run", { description: "One run: status, window, tier, params, error if it failed, and headline numbers.", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => {
      const r = await ctx.data.run(id);
      if (!r) return fail(`no run ${id}`);
      const summary = r.status === "done" ? await ctx.data.summary(id) : null;
      return ok({ id: r.id, strategy: r.strategy, status: r.status, from: r.from, to: r.to, tier: r.tier, params: r.params, error: r.error, warnings: r.warnings, summary });
    }));
}
