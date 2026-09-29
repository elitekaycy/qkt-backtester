import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDocument } from "yaml";
import { completeConfig, instrumentsTemplate } from "../scaffold.js";
import { listStrategies, scanSymbolIn, scanCached } from "../data-scan.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

/** A symbol's entry in instruments.yaml (`instruments:` is a list of entries keyed by `qktSymbol: BROKER:SYMBOL`). */
export async function instrumentEntry(workspace: string, symbol: string): Promise<Record<string, unknown> | null> {
  const doc = parseDocument(await fs.readFile(path.join(workspace, "instruments.yaml"), "utf8").catch(() => ""));
  const list = (doc.toJSON() as { instruments?: Array<Record<string, unknown>> } | null)?.instruments ?? [];
  const want = symbol.includes(":") ? symbol : `BACKTEST:${symbol}`;
  return list.find((e) => e.qktSymbol === want) ?? null;
}

/** packages/server/assets in development (src/mcp -> ../../assets), /app/server/assets in the image (dist/mcp -> ../../assets). */
export const ASSETS_DIR = path.resolve(import.meta.dirname, "..", "..", "assets");
const DSL = path.join(ASSETS_DIR, "dsl");
const TOPIC = /^[a-z][a-z0-9-]{0,40}$/;

export function registerKnowledgeTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("dsl_reference", { description: "qkt DSL reference. No topic: the cheat sheet (read first) and the topic list. With a topic: that full page.", inputSchema: { topic: z.string().optional() } },
    ({ topic }) => guard(async () => {
      const topics = (await fs.readdir(DSL)).filter((f) => f.endsWith(".md") && f !== "cheatsheet.md").map((f) => f.slice(0, -3)).sort();
      if (!topic) return { content: [{ type: "text", text: `${await fs.readFile(path.join(DSL, "cheatsheet.md"), "utf8")}\n\ntopics: ${topics.join(", ")}` }] };
      const t = topic.replace(/\.md$/, "");
      if (!TOPIC.test(t) || !topics.includes(t)) return fail(`unknown topic "${topic}"; topics: ${topics.join(", ")}`);
      const text = await fs.readFile(path.join(DSL, `${t}.md`), "utf8");
      return { content: [{ type: "text", text: text.slice(0, 12_000) }] };
    }));
  s.registerTool("dsl_examples", { description: "Example strategies matching words in the query (workspace strategies and qkt's examples), shortest first.", inputSchema: { query: z.string(), limit: z.number().int().max(5).optional() } },
    ({ query, limit }) => guard(async () => {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
      const files: Array<{ name: string; text: string }> = [];
      for (const rel of await listStrategies(ctx.cfg.workspace, 200)) files.push({ name: rel, text: await fs.readFile(path.join(ctx.cfg.workspace, rel), "utf8").catch(() => "") });
      const ex = path.join(DSL, "examples");
      if (existsSync(ex)) for (const f of await fs.readdir(ex)) files.push({ name: `qkt:examples/${f}`, text: await fs.readFile(path.join(ex, f), "utf8") });
      const scored = files.map((f) => ({ ...f, score: words.filter((w) => f.text.toLowerCase().includes(w) || f.name.toLowerCase().includes(w)).length }))
        .filter((f) => f.score > 0 && f.text.length < 6000).sort((a, b) => b.score - a.score || a.text.length - b.text.length).slice(0, limit ?? 3);
      return ok(scored.map((f) => ({ name: f.name, source: f.text })));
    }));
  s.registerTool("config_reference", { description: "qkt.config.yaml reference: every option with its meaning and default; with key, only that section (e.g. risk, execution).", inputSchema: { key: z.string().optional() } },
    ({ key }) => guard(async () => {
      const ref = completeConfig("");
      if (!key) return { content: [{ type: "text", text: ref.slice(0, 12_000) }] };
      const lines = ref.split("\n"), start = lines.findIndex((l) => new RegExp(`^(#\\s?)?${key.replace(/\W/g, "")}:`).test(l));
      if (start < 0) return fail(`no section "${key}" in the config reference`);
      let end = start + 1;
      while (end < lines.length && !/^(#\s?)?[a-z_]+:/.test(lines[end]!)) end++;
      return { content: [{ type: "text", text: lines.slice(Math.max(0, start - 3), end).join("\n") }] };
    }));
  s.registerTool("instruments_reference", { description: "instruments.yaml fields (contract size, lot rules, costs, swap) and, with symbol, that symbol's current entry.", inputSchema: { symbol: z.string().optional() } },
    ({ symbol }) => guard(async () => {
      const head = instrumentsTemplate([]).split("\n").filter((l) => l.startsWith("#")).join("\n");
      if (!symbol) return { content: [{ type: "text", text: head }] };
      const entry = await instrumentEntry(ctx.cfg.workspace, symbol);
      return ok({ symbol, entry: entry ?? `no entry: qkt uses its built-in table for ${symbol}, or refuses a symbol it does not know`, fields: head });
    }));
  s.registerTool("data_status", { description: "What market data exists: per symbol the bar timeframes, first/last day, complete windows, ticks. With symbol, only that one.", inputSchema: { symbol: z.string().optional() } },
    ({ symbol }) => guard(async () => {
      if (symbol) {
        const r = await scanSymbolIn(ctx.cfg.dataRoot, symbol.replace(/^.*:/, ""));
        if (!r) return fail(`no data for ${symbol}`);
        return ok({ symbol: r.symbol, status: r.status, market: r.market, bars: r.bars.filter((b) => b.files > 0).map((b) => ({ tf: b.tf, first: b.first, last: b.last, status: b.status, missing: b.missing, longestComplete: b.usable.sort((x, y) => (Date.parse(y.to) - Date.parse(y.from)) - (Date.parse(x.to) - Date.parse(x.from)))[0] ?? null })), ticks: r.ticks && { first: r.ticks.first, last: r.ticks.last, status: r.ticks.status } });
      }
      const scan = await scanCached(ctx.cfg.dataRoot);
      return ok(scan.symbols.map((x) => ({ symbol: x.symbol, status: x.status, tfs: x.bars.filter((b) => b.files > 0 && !b.qktReads).map((b) => b.tf), last: x.bars.map((b) => b.last).filter(Boolean).sort().pop() ?? x.ticks?.last ?? null })));
    }));
}
