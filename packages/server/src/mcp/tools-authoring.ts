import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyChanges, checkConfig, lineDiff, type Change } from "@qkt-studio/core";
import { checkQktSource } from "../check.js";
import { resolveInJail } from "../jail.js";
import { changesSchema } from "./schemas.js";
import { instrumentEntry } from "./tools-knowledge.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const brief = (ds: Array<{ severity: string; line: number; message: string; code: string }>) => ds.map((d) => ({ severity: d.severity, line: d.line, code: d.code, message: d.message }));

export function registerAuthoringTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("check_strategy", { description: "Parse and lint strategy source without saving: ok, or the exact errors and warnings with line numbers.", inputSchema: { source: z.string(), path: z.string().optional() } },
    ({ source, path: rel }) => guard(async () => { const r = await checkQktSource(ctx.cfg, source, rel); return ok({ ok: r.ok, diagnostics: brief(r.diagnostics) }); }));

  s.registerTool("create_strategy", { description: "Create a NEW strategy file (never overwrites). The source must pass check_strategy. Opens it in the editor.", inputSchema: { name: z.string(), source: z.string(), dir: z.string().optional() } },
    ({ name, source, dir }) => guard(async () => {
      const slug = name.replace(/\.qkt$/i, "").replace(/[^\w.-]+/g, "_");
      const rel = `${(dir ?? "strategies").replace(/\/+$/, "")}/${slug}.qkt`;
      const abs = await resolveInJail(ctx.cfg.workspace, rel);
      const r = await checkQktSource(ctx.cfg, source, rel);
      if (!r.ok) return fail(`not created, the source does not parse: ${JSON.stringify(brief(r.diagnostics))}`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try { await fs.writeFile(abs, source.endsWith("\n") ? source : `${source}\n`, { flag: "wx" }); }
      catch { return fail(`${rel} already exists; pick another name, or change it with propose_strategy_edit / try_change`); }
      ctx.events.emit({ t: "open", path: rel });
      return ok({ path: rel, warnings: brief(r.diagnostics) });
    }));

  s.registerTool("propose_strategy_edit", { description: "Propose changes to an existing strategy as a diff the user applies. For trying a change and seeing results, use try_change instead.", inputSchema: { path: z.string(), changes: changesSchema } },
    ({ path: rel, changes }) => guard(async () => {
      const abs = await resolveInJail(ctx.cfg.workspace, rel);
      const before = await fs.readFile(abs, "utf8");
      const { source: after, notes } = applyChanges(before, changes as Change[]);
      const r = await checkQktSource(ctx.cfg, after, rel);
      if (!r.ok) return fail(`the change would not parse: ${JSON.stringify(brief(r.diagnostics))}`);
      const diff = lineDiff(before, after);
      const p = await ctx.proposals.create({ kind: "file", title: `Edit ${rel}: ${notes.join("; ")}`, path: rel, before, after, diff });
      return ok({ proposalId: p.id, diff, notes, warnings: brief(r.diagnostics), next: "the user applies or rejects it in the studio" });
    }));

  const yamlTool = (file: string) => async (mutate: (doc: ReturnType<typeof parseDocument>) => void, title: string) => {
    const abs = path.join(ctx.cfg.workspace, file);
    const before = await fs.readFile(abs, "utf8").catch(() => "");
    const doc = parseDocument(before);
    mutate(doc);
    const after = doc.toString();
    const warnings = file === "qkt.config.yaml" ? checkConfig(after, true, { QKT_DATA_HOME: ctx.cfg.dataRoot }).map((f) => f.message) : [];
    const diff = lineDiff(before, after);
    if (!diff) return fail("no change: the file already has those values");
    const p = await ctx.proposals.create({ kind: "file", title, path: file, before, after, diff });
    return ok({ proposalId: p.id, diff, warnings });
  };
  const keyPath = (k: string) => k.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : x));

  s.registerTool("get_config", { description: "The workspace's qkt.config.yaml as it is now." },
    () => guard(async () => ({ content: [{ type: "text", text: await fs.readFile(path.join(ctx.cfg.workspace, "qkt.config.yaml"), "utf8").catch(() => "(no qkt.config.yaml)") }] })));
  s.registerTool("propose_config", { description: "Propose qkt.config.yaml changes: set dotted keys (risk.max_daily_loss) and/or unset keys; comments are kept; validated.", inputSchema: { set: z.record(z.unknown()).optional(), unset: z.array(z.string()).optional() } },
    ({ set, unset }) => guard(() => yamlTool("qkt.config.yaml")((doc) => {
      for (const [k, v] of Object.entries(set ?? {})) doc.setIn(keyPath(k), v);
      for (const k of unset ?? []) doc.deleteIn(keyPath(k));
    }, `Config: ${[...Object.keys(set ?? {}), ...(unset ?? []).map((k) => `-${k}`)].join(", ")}`)));
  s.registerTool("get_instrument", { description: "A symbol's entry in instruments.yaml, or that it has none.", inputSchema: { symbol: z.string() } },
    ({ symbol }) => guard(async () => ok({ symbol, entry: await instrumentEntry(ctx.cfg.workspace, symbol) })));
  s.registerTool("propose_instrument", { description: "Propose adding or changing a symbol's instruments.yaml entry (contractSize, volumeStep, commissionPerLot...).", inputSchema: { symbol: z.string(), fields: z.record(z.union([z.number(), z.string(), z.boolean()])) } },
    ({ symbol, fields }) => guard(() => yamlTool("instruments.yaml")((doc) => {
      // `instruments:` is a list of entries keyed by qktSymbol (see instrumentsTemplate in scaffold.ts)
      const want = symbol.includes(":") ? symbol : `BACKTEST:${symbol}`;
      if (!doc.has("instruments")) doc.set("instruments", doc.createNode([]));
      const items = (doc.toJSON() as { instruments?: Array<Record<string, unknown>> }).instruments ?? [];
      const i = items.findIndex((e) => e.qktSymbol === want);
      if (i >= 0) for (const [k, v] of Object.entries(fields)) doc.setIn(["instruments", i, k], v);
      else doc.addIn(["instruments"], doc.createNode({ qktSymbol: want, ...fields }));
    }, `Instrument ${symbol}: ${Object.keys(fields).join(", ")}`)));
}
