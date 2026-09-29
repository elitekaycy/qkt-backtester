import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
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
});
