import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createStudio } from "../../src/main.js";
import { testConfig, realData, haveData } from "../helpers.js";

export async function mcpClient(base: string, token?: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
  return c;
}
export const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

let studio: Awaited<ReturnType<typeof createStudio>>, base: string, ws: string;
beforeAll(async () => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 10000\n");
  writeFileSync(path.join(ws, "strategies", "ema.qkt"), "STRATEGY ema VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN gold.close > 0\n    THEN BUY gold SIZING 0.1\n");
  studio = await createStudio(testConfig(ws, { token: "t0k" }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); });

describe("/api/mcp", () => {
  it("refuses a client without the token, like the rest of /api", async () => {
    await expect(mcpClient(base)).rejects.toThrow(/unauthorized/);
  });
  it("lists the tools and answers get_context from what the browser reported", async () => {
    const c = await mcpClient(base, "t0k");
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_context", "list_files", "read_file", "list_runs", "get_run"]));
    await fetch(`${base}/api/view`, { method: "POST", headers: { Authorization: "Bearer t0k", "Content-Type": "application/json" }, body: JSON.stringify({ openFile: "strategies/ema.qkt", cursorLine: 7 }) });
    const ctx = await call(c, "get_context");
    expect(ctx.json.openFile).toMatchObject({ path: "strategies/ema.qkt", cursorLine: 7 });
    expect((await call(c, "read_file", { path: "strategies/ema.qkt" })).json.text).toMatch(/STRATEGY ema/);
    expect((await call(c, "read_file", { path: "../etc/passwd" })).isError).toBe(true);
    for (const t of (await c.listTools()).tools) expect((t.description ?? "").length).toBeLessThanOrEqual(200);
    await c.close();
  });
});

describe("knowledge tools", () => {
  it("serve the cheat sheet, a page, examples and the config reference", async () => {
    const c = await mcpClient(base, "t0k");
    const sheet = await call(c, "dsl_reference");
    expect(sheet.text).toMatch(/cheat sheet/);
    expect(sheet.text).toMatch(/topics: .*bracket/);
    expect((await call(c, "dsl_reference", { topic: "bracket" })).text).toMatch(/STOP_LOSS/);
    expect((await call(c, "dsl_reference", { topic: "../../etc/passwd" })).isError).toBe(true);
    expect((await call(c, "dsl_examples", { query: "ema" })).json.length).toBeGreaterThan(0);
    expect((await call(c, "config_reference", { key: "risk" })).text).toMatch(/max_daily_loss/);
    expect((await call(c, "instruments_reference")).text).toMatch(/contractSize/);
    await c.close();
  });
  it("paginates a long DSL page instead of silently dropping the tail", async () => {
    const c = await mcpClient(base, "t0k");
    const full = readFileSync(path.join(import.meta.dirname, "..", "..", "assets", "dsl", "indicators.md"), "utf8");
    expect(full.length).toBeGreaterThan(8000);
    const markerRe = /\n\[truncated: call again with offset=(\d+)\]$/;

    const first = await call(c, "dsl_reference", { topic: "indicators" });
    expect(first.text.length).toBeLessThanOrEqual(8000);
    const m1 = markerRe.exec(first.text);
    expect(m1).not.toBeNull();
    const page1 = first.text.slice(0, m1!.index);
    expect(full.startsWith(page1)).toBe(true);

    const second = await call(c, "dsl_reference", { topic: "indicators", offset: Number(m1![1]) });
    const m2 = markerRe.exec(second.text);
    const page2 = m2 ? second.text.slice(0, m2.index) : second.text;
    // the second page starts exactly where the first left off - no overlap, nothing skipped
    expect(full.slice(page1.length, page1.length + page2.length)).toBe(page2);
    if (!m2) expect(page1.length + page2.length).toBe(full.length);
    await c.close();
  });
});

describe.skipIf(!haveData)("analysis tools", () => {
  it("summarise, diagnose and list the trades of a real run", async () => {
    const s2 = await createStudio(testConfig(ws, { token: "t0k", dataRoot: realData }));
    await s2.app.listen({ port: 0, host: "127.0.0.1" });
    const b2 = `http://127.0.0.1:${(s2.app.server.address() as { port: number }).port}`;
    writeFileSync(path.join(ws, "strategies", "bracket.qkt"), "STRATEGY bracket VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN ema(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n        BRACKET { STOP_LOSS BY 5, TAKE_PROFIT BY 20 }\n");
    const { runId } = await s2.runner.submit({ strategy: "strategies/bracket.qkt", from: "2024-10-01", to: "2024-10-15", tier: "draft" });
    await s2.runner.waitFor(runId);
    const c = await mcpClient(b2, "t0k");
    const sum = await call(c, "run_summary", { run: runId });
    expect(sum.json.trades).toBeGreaterThan(0);
    const d = await call(c, "diagnose_exits", { run: runId });
    expect(d.json.exits.stop + d.json.exits.target + d.json.exits.signal + d.json.exits.open).toBe(d.json.trades);
    expect(d.json.bracket.medianStop).toBeCloseTo(5, 1);
    expect(d.json.whatIf.length).toBeGreaterThan(0);
    const t = await call(c, "trades", { run: runId, limit: 3 });
    expect(t.json.rows.length).toBeLessThanOrEqual(3);
    const one = await call(c, "trade_detail", { run: runId, id: t.json.rows[0].id, bars_before: 5, bars_after: 5 });
    expect(one.json.bars.length).toBeGreaterThan(5);
    expect((await call(c, "run_summary", { run: "nope" })).isError).toBe(true);
    await c.close(); await s2.app.close();
  }, 120_000);
});
