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

    const de = await call(c, "diagnose_entries", { run: runId });
    expect(Object.keys(de.json.weekday)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

    const byName = await call(c, "trades", { run: runId, weekday: "Friday" });
    const byAbbrev = await call(c, "trades", { run: runId, weekday: "fri" });
    const byNumber = await call(c, "trades", { run: runId, weekday: 4 });
    expect(byAbbrev.json.rows).toEqual(byName.json.rows);
    expect(byNumber.json.rows).toEqual(byName.json.rows);
    for (const row of byName.json.rows) expect(new Date(`${row.entry.replace(" ", "T")}:00Z`).getUTCDay()).toBe(5);
    expect((await call(c, "trades", { run: runId, weekday: "notaday" })).isError).toBe(true);

    await c.close(); await s2.app.close();
  }, 120_000);
});

describe("authoring tools", () => {
  it("check, create, and propose edits that only a user apply writes", async () => {
    const c = await mcpClient(base, "t0k");
    const bad = await call(c, "check_strategy", { source: "STRATEGY x VERSION 1\n\nRULES\n    WHEN\n" });
    expect(bad.json.ok).toBe(false);
    const created = await call(c, "create_strategy", { name: "rsi_dip", source: "STRATEGY rsi_dip VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN rsi(gold.close, 14) CROSSES ABOVE 30\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n" });
    expect(created.json.path).toBe("strategies/rsi_dip.qkt");
    expect((await call(c, "create_strategy", { name: "rsi_dip", source: "STRATEGY rsi_dip VERSION 1\n" })).isError).toBe(true); // never overwrites
    const before = readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8");
    const p = await call(c, "propose_strategy_edit", { path: "strategies/rsi_dip.qkt", changes: [{ op: "set_bracket", stop: "1%", target: "2%" }] });
    expect(p.json.diff).toMatch(/\+\s+BRACKET \{ STOP_LOSS BY 1 PCT, TAKE_PROFIT BY 2 PCT \}/);
    expect(readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8")).toBe(before); // nothing written yet
    const hdr = { Authorization: "Bearer t0k" };
    expect((await fetch(`${base}/api/proposals/${p.json.proposalId}/apply`, { method: "POST", headers: hdr })).status).toBe(200);
    expect(readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8")).toMatch(/STOP_LOSS BY 1 PCT/);
    // a proposal made on text the user has since changed is refused as stale
    const p2 = await call(c, "propose_strategy_edit", { path: "strategies/rsi_dip.qkt", changes: [{ op: "set_param", name: "n", value: 3 }] });
    writeFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), `${readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8")}\n-- edited\n`);
    expect((await fetch(`${base}/api/proposals/${p2.json.proposalId}/apply`, { method: "POST", headers: hdr })).status).toBe(409);
    await c.close();
  });
  it("proposes config and instrument changes, validated, keeping comments", async () => {
    writeFileSync(path.join(ws, "qkt.config.yaml"), "# my config\nstarting_balance: 10000 # keep\nrisk:\n  max_daily_loss: \"1000\"\n");
    const c = await mcpClient(base, "t0k");
    const p = await call(c, "propose_config", { set: { "risk.max_daily_loss": "0", "execution.position_mode": "netting" } });
    expect(p.json.diff).toMatch(/\+\s+max_daily_loss: "0"/);
    expect((await call(c, "propose_config", { set: { "not_a_key": 1 } })).json.warnings.join(" ")).toMatch(/Unknown top-level key/);
    const pi = await call(c, "propose_instrument", { symbol: "XAGUSD", fields: { contractSize: 5000, volumeStep: 0.01 } });
    expect(pi.json.diff).toMatch(/\+\s+- qktSymbol: BACKTEST:XAGUSD/);
    await c.close();
  });
});

describe("the split", () => {
  it("is readable and changeable from tools and the API, and announced to the UI", async () => {
    const c = await mcpClient(base, "t0k");
    expect((await call(c, "get_split")).json).toMatchObject({ split: { test_pct: 25 }, text: "test = last 25 %" });
    const seen: string[] = [];
    const off = studio.events.subscribe((e) => seen.push(e.t));
    expect((await call(c, "set_split", { split: { test_last: "2 months" } })).json.text).toBe("test = last 2 months");
    off();
    expect(seen).toContain("split");
    const r = await fetch(`${base}/api/split`, { headers: { Authorization: "Bearer t0k" } });
    expect(await r.json()).toMatchObject({ split: { test_last: "2 months" } });
    expect((await call(c, "set_split", { split: { test_pct: 1 } })).isError).toBe(true);
    await call(c, "set_split", { split: { test_pct: 25 } });
    await c.close();
  });
});
