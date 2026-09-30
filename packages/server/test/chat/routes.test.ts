// packages/server/test/chat/routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatMessage } from "@qkt-studio/core";
import type { StudioEvent } from "../../src/agent/events.js";
import { createStudio } from "../../src/main.js";
import { parseSend } from "../../src/chat/routes.js";
import { fakeClaude, testConfig } from "../helpers.js";

let studio: Awaited<ReturnType<typeof createStudio>>, base: string, home: string, ws: string;
const H = { Authorization: "Bearer t0k", "Content-Type": "application/json" };
const get = async (u: string) => { const r = await fetch(`${base}${u}`, { headers: H }); return { status: r.status, body: await r.json() as any }; };
const post = async (u: string, b: unknown = {}) => { const r = await fetch(`${base}${u}`, { method: "POST", headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
const last = async (conv: string): Promise<ChatMessage> => (await get(`/api/chat/conversations/${conv}`)).body.messages.at(-1);
const settle = async (conv: string) => { const end = Date.now() + 30_000; for (;;) { const m = await last(conv); if (m.status !== "running") return m; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

beforeAll(async () => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-home-")));
  process.env.CLAUDE_CONFIG_DIR = home;
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "strategies", "ema.qkt"), "STRATEGY ema VERSION 1\n");
  studio = await createStudio(testConfig(ws, { token: "t0k", claudeBin: fakeClaude }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); delete process.env.CLAUDE_CONFIG_DIR; rmSync(home, { recursive: true, force: true }); });

describe("/api/chat", () => {
  it("status says signed in and on which plan, never the account", async () => {
    const s = await get("/api/chat/status");
    expect(s.body).toMatchObject({ installed: true, loggedIn: true, subscriptionType: "max", busy: null, limits: { calls: 25, minutes: 5 } });
    expect(JSON.stringify(s.body)).not.toMatch(/person@example|org-123/);
  });
  it("a whole message: tool calls go through /api/mcp with the per-process token; the 26th is refused and the message ends at the limit", async () => {
    const seen: StudioEvent[] = [];
    const off = studio.events.subscribe((e) => { if (e.t === "chat") seen.push(e); });
    const r = await post("/api/chat/send", { text: "loop over the files" });
    expect(r.status).toBe(202);
    const m = await settle(r.body.conversationId);
    off();
    expect(m).toMatchObject({ status: "limit", error: "stopped at the limit (25 tool calls)" });
    const tools = m.items.filter((i) => i.type === "tool");
    expect(tools.slice(0, 25).every((t) => t.type === "tool" && t.result && !t.result.isError)).toBe(true);
    expect(seen.some((e) => e.t === "chat" && e.ev.k === "end" && e.ev.status === "limit")).toBe(true);
    expect(studio.tokens.size()).toBe(0);
    expect((await get("/api/chat/conversations")).body.conversations[0]).toMatchObject({ id: r.body.conversationId, title: "loop over the files", messages: 2 });
  });
  it("one message at a time over HTTP, and Stop", async () => {
    const a = await post("/api/chat/send", { text: "keep working" });
    expect(a.status).toBe(202);
    expect((await post("/api/chat/send", { text: "hi" })).status).toBe(409);
    expect((await get("/api/chat/status")).body.busy).toEqual({ conversationId: a.body.conversationId, messageId: a.body.messageId });
    expect((await post("/api/chat/stop")).body).toEqual({ stopped: true });
    expect((await last(a.body.conversationId)).status).toBe("stopped");
  });
  it("signed out: status says so and a send is refused with the reason", async () => {
    writeFileSync(path.join(home, "fake-signed-out"), "");
    try {
      expect((await get("/api/chat/status?refresh=1")).body.loggedIn).toBe(false);
      const r = await post("/api/chat/send", { text: "hi" });
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/not signed in/);
    } finally { rmSync(path.join(home, "fake-signed-out")); await get("/api/chat/status?refresh=1"); }
  });
  it("bad input: empty text 400, unknown conversation 404, and the body is cleaned", async () => {
    expect((await post("/api/chat/send", { text: "" })).status).toBe(400);
    expect((await post("/api/chat/send", { text: "hi", conversationId: "nope" })).status).toBe(404);
    expect(parseSend({ text: "x", omit: ["run", "evil"], think: "yes", mentions: [{ label: "@a", ref: "b" }, { label: 1 }, { label: "@env", ref: ".env" }, { label: "@r", ref: "runs/abc/result.json" }, { label: "@up", ref: "../etc/passwd" }, ...Array(20).fill({ label: "@c", ref: "d" })] }))
      .toEqual({ conversationId: null, text: "x", think: false, omit: ["run"], mentions: [{ label: "@a", ref: "b" }, ...Array(9).fill({ label: "@c", ref: "d" })] });
  });
  it("a studio restart marks a message cut off mid-answer as interrupted; the conversation continues", async () => {
    const a = await post("/api/chat/send", { text: "keep working" });
    await new Promise((r) => setTimeout(r, 300));
    await studio.app.close(); // shutdown ends the message in flight as interrupted
    studio = await createStudio(testConfig(ws, { token: "t0k", claudeBin: fakeClaude }));
    await studio.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
    expect((await last(a.body.conversationId)).status).toBe("interrupted");
    const b = await post("/api/chat/send", { conversationId: a.body.conversationId, text: "hi" });
    expect(b.status).toBe(202);
    expect((await settle(a.body.conversationId)).status).toBe("done");
  });
  it("an unusable chat store disables the chat with a reason; the studio still starts", async () => {
    const ws2 = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
    mkdirSync(path.join(ws2, ".qkt-studio"));
    writeFileSync(path.join(ws2, ".qkt-studio", "chat"), "a file where the chat folder should be");
    const s2 = await createStudio(testConfig(ws2, { token: "t0k", claudeBin: fakeClaude }));
    try {
      expect(s2.chatStore).toBeNull();
      await s2.app.listen({ port: 0, host: "127.0.0.1" });
      const b2 = `http://127.0.0.1:${(s2.app.server.address() as { port: number }).port}`;
      const status = await (await fetch(`${b2}/api/chat/status`, { headers: H })).json() as any;
      expect(status).toMatchObject({ available: false, reason: "the chat store could not be opened", busy: null });
      const r = await fetch(`${b2}/api/chat/send`, { method: "POST", headers: H, body: JSON.stringify({ text: "hi" }) });
      expect(r.status).toBe(503);
      expect(((await r.json()) as any).error).toBe("the chat store could not be opened");
    } finally { await s2.app.close(); rmSync(ws2, { recursive: true, force: true }); }
  });
});
