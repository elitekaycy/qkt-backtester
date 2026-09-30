// packages/server/test/chat/tokens.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import http from "node:http";
import os from "node:os"; import path from "node:path";
import { createStudio } from "../../src/main.js";
import { ChatTokens, TeeSet, toolCalls } from "../../src/chat/tokens.js";
import { testConfig } from "../helpers.js";
import { call as callTool, mcpClient } from "../mcp/client.js";

let studio: Awaited<ReturnType<typeof createStudio>>, base: string;
beforeAll(async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  studio = await createStudio(testConfig(ws, { token: "t0k" }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); });

const rawStatus = (p: string, headers: Record<string, string>, method = "GET") => new Promise<number>((resolve, reject) => {
  const u = new URL(base);
  const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  r.on("error", reject); r.end();
});

describe("per-process tokens", () => {
  it("open /api/mcp and nothing else, and stop working once revoked", async () => {
    const g = studio.tokens.issue({ maxCalls: 25, onLimit: () => undefined });
    const c = await mcpClient(base, g.token);
    expect((await c.listTools()).tools.length).toBeGreaterThan(10);
    await c.close();
    // raw paths, sent as written (fetch would normalise the ../ away)
    for (const p of ["/api/info", "/api/health", "/api/chat/status", "/api/mcp/../info", "/api/mcp%2f..%2finfo"]) {
      expect(await rawStatus(p, { Authorization: `Bearer ${g.token}` }), p).toBe(401);
    }
    // a chat token is never accepted from the query string (it would dodge the call count)
    expect(await rawStatus(`/api/mcp?token=${g.token}`, {}, "POST"), "query token").toBe(401);
    studio.tokens.revoke(g.token);
    await expect(mcpClient(base, g.token)).rejects.toThrow(/unauthorized|401/);
    expect(studio.tokens.size()).toBe(0);
  });
  it("count tool calls: past the limit a call is refused as a tool error and the owner is told once per refused call", async () => {
    let told = 0;
    const g = studio.tokens.issue({ maxCalls: 2, onLimit: () => { told++; } });
    const c = await mcpClient(base, g.token);
    expect((await callTool(c, "get_split")).isError).toBe(false);
    expect((await callTool(c, "get_split")).isError).toBe(false);
    const third = await callTool(c, "get_split");
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/limit of 2 tool calls/);
    expect(told).toBe(1);
    await c.close(); studio.tokens.revoke(g.token);
  });
  it("the studio's own token still works on /api/mcp and is never counted", async () => {
    const c = await mcpClient(base, "t0k");
    for (let i = 0; i < 3; i++) expect((await callTool(c, "get_split")).isError).toBe(false);
    await c.close();
  });
});

describe("helpers", () => {
  it("TeeSet records into both sets and answers has() from the shared one", () => {
    const shared = new Set<string>(["user-run"]), grant = { started: new Set<string>(), afterStop: null as ((id: string) => void) | null };
    const t = new TeeSet(shared, grant);
    t.add("r1");
    expect([...shared].sort()).toEqual(["r1", "user-run"]);
    expect([...grant.started]).toEqual(["r1"]);
    expect(t.has("user-run")).toBe(true);
  });
  it("TeeSet hands a run recorded after Stop straight to the stop's cancel", () => {
    const late: string[] = [];
    const grant = { started: new Set<string>(), afterStop: (id: string) => { late.push(id); } };
    new TeeSet(new Set<string>(), grant).add("r-late");
    expect(late).toEqual(["r-late"]);
    expect([...grant.started]).toEqual(["r-late"]);
  });
  it("toolCalls counts tools/call in a request or a batch", () => {
    expect(toolCalls({ method: "tools/call" })).toBe(1);
    expect(toolCalls([{ method: "tools/call" }, { method: "tools/list" }, { method: "tools/call" }])).toBe(2);
    expect(toolCalls({ method: "initialize" })).toBe(0);
    expect(new ChatTokens().lookup(undefined)).toBeUndefined();
  });
});
