// packages/server/test/chat/manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatEvent, ChatMessage } from "@qkt-studio/core";
import { ChatBusy, ChatManager, ChatNotFound, ChatUnavailable, LIMITS, type ChatLimits } from "../../src/chat/manager.js";
import { SYSTEM_PROMPT } from "../../src/chat/prompt.js";
import { ChatStore } from "../../src/chat/store.js";
import { ChatTokens } from "../../src/chat/tokens.js";
import { ClaudeStatusCache } from "../../src/chat/auth.js";
import { EventBus } from "../../src/agent/events.js";
import { ViewState } from "../../src/agent/view-state.js";
import { createStudio } from "../../src/main.js";
import { fakeClaude, testConfig } from "../helpers.js";

let home: string;
beforeAll(() => { home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-home-"))); process.env.CLAUDE_CONFIG_DIR = home; });
afterAll(() => {
  for (const k of ["CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_ARGV_LOG", "FAKE_CLAUDE_CHILD_LOG"]) delete process.env[k];
  rmSync(home, { recursive: true, force: true });
});

function setup(o: { limits?: ChatLimits; bin?: string; statusBin?: string; ws?: string; tokens?: ChatTokens; mcpUrl?: string } = {}) {
  const ws = o.ws ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  const argvLog = path.join(ws, "argv.log"), childLog = path.join(ws, "child.log");
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  process.env.FAKE_CLAUDE_CHILD_LOG = childLog;
  const bin = o.bin ?? fakeClaude;
  const store = ChatStore.open(path.join(ws, ".qkt-studio", "chat", "chat.sqlite"))!;
  const events = new EventBus(), view = new ViewState(), tokens = o.tokens ?? new ChatTokens();
  const cancelled: string[] = [], got: ChatEvent[] = [], seqs: number[] = [];
  events.subscribe((e) => { if (e.t === "chat") { got.push(e.ev); seqs.push(e.seq); } });
  const mgr = new ChatManager({ cfg: testConfig(ws, { claudeBin: bin }), store, tokens, events, view, status: new ClaudeStatusCache(o.statusBin ?? bin, ws),
    runner: { cancel: async (id) => { cancelled.push(id); return true; } }, jobs: { cancel: async () => false },
    splitText: async () => "test = last 25 %", limits: o.limits });
  mgr.setMcpUrl(o.mcpUrl ?? "http://127.0.0.1:9/api/mcp");
  const argvs = () => readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a.includes("-p"));
  // the MCP config files the CLI was given: each must be gone once its process has exited
  const configs = () => { const d = path.join(ws, ".qkt-studio", "chat", "run"); return existsSync(d) ? readdirSync(d) : []; };
  const children = () => (existsSync(childLog) ? readFileSync(childLog, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  return { ws, mgr, store, view, tokens, cancelled, got, seqs, argvs, configs, children };
}
const until = async (f: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const reply = (store: ChatStore, conv: string): ChatMessage => store.messages(conv).filter((m) => m.role === "assistant").at(-1)!;
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("ChatManager", () => {
  it("answers, stores the reply with its usage, streams every event and revokes the token", async () => {
    const { mgr, store, got, tokens, configs } = setup();
    const { conversationId } = await mgr.send({ text: "hi" });
    expect(mgr.busy()).not.toBeNull();
    await until(() => mgr.busy() === null);
    expect(reply(store, conversationId)).toMatchObject({ status: "done", text: "Hello from the fake.", model: "haiku", usage: { inputTokens: 400, cacheReadTokens: 2000, outputTokens: 12, costUsd: 0.0012 } });
    expect(store.messages(conversationId)[0]).toMatchObject({ role: "user", text: "hi" });
    // the text arrives as several deltas: collapse runs of the same kind
    expect(got.map((e) => e.k).filter((k, i, a) => k !== a[i - 1])).toEqual(["session", "text", "result", "end"]);
    expect(got.filter((e) => e.k === "text").length).toBeGreaterThan(1);
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
    expect(store.conversation(conversationId)!.sessionStarted).toBe(true);
  });
  it("stamps each event with a rising sequence number and the stored message carries the last one", async () => {
    const { mgr, store, got, seqs } = setup();
    const { conversationId } = await mgr.send({ text: "hi" });
    await until(() => mgr.busy() === null);
    expect(seqs).toEqual(got.map((_, i) => i + 1));
    expect(reply(store, conversationId).evSeq).toBe(got.length);
    expect(store.messages(conversationId)[0]!.evSeq).toBe(0);
  });
  it("starts a session on the first message and resumes it on the next; Think harder is sonnet", async () => {
    const { mgr, argvs } = setup();
    const a = await mgr.send({ text: "hi" }); await until(() => !mgr.busy());
    await mgr.send({ conversationId: a.conversationId, text: "again", think: true }); await until(() => !mgr.busy());
    const [one, two] = argvs();
    expect(one).not.toContain("--resume");
    expect(flag(two!, "--resume")).toBe(flag(one!, "--session-id"));
    expect(two).not.toContain("--session-id");
    expect([flag(one!, "--model"), flag(two!, "--model")]).toEqual(["haiku", "sonnet"]);
    expect(flag(one!, "--system-prompt")).toBe(SYSTEM_PROMPT);
  });
  it("puts the view reference in the message, minus what the user removed, plus mentions", async () => {
    const { mgr, store, view } = setup();
    view.set({ openFile: "strategies/ema.qkt", cursorLine: 4, runId: "r-77", selectedTrade: 3 });
    const a = await mgr.send({ text: "echo this", omit: ["run"], mentions: [{ label: "@config", ref: "qkt.config.yaml" }] });
    await until(() => !mgr.busy());
    const t = reply(store, a.conversationId).text;
    expect(t).toMatch(/open file: strategies\/ema\.qkt \(cursor on line 4\)/);
    expect(t).toMatch(/selected trade: #3/);
    expect(t).toMatch(/split: test = last 25 %/);
    expect(t).toMatch(/mentioned @config: qkt\.config\.yaml/);
    expect(t).not.toMatch(/r-77/);
    expect(t.trimEnd()).toMatch(/echo this$/);
    expect(store.messages(a.conversationId)[0]!.text).toBe("echo this"); // the stored user text is what the user typed
  });
  it("one message at a time: a second send at the same moment, or while one runs, is refused", async () => {
    const { mgr, argvs } = setup();
    const [a, b] = await Promise.allSettled([mgr.send({ text: "keep working" }), mgr.send({ text: "hi" })]);
    expect(a.status).toBe("fulfilled");
    expect(b.status === "rejected" && b.reason instanceof ChatBusy).toBe(true);
    await until(() => argvs().length === 1);
    await expect(mgr.send({ text: "hi" })).rejects.toBeInstanceOf(ChatBusy);
    await mgr.stop();
    expect(argvs()).toHaveLength(1); // exactly one CLI process was started
    await mgr.send({ text: "hi" }); await until(() => !mgr.busy()); // the slot is free again
  });
  it("Stop kills the process group, cancels the runs that message started, and frees the slot", async () => {
    const { mgr, store, cancelled, got, tokens, configs, children } = setup();
    const a = await mgr.send({ text: "keep working" });
    await until(() => got.some((e) => e.k === "text") && children().length === 1);
    const t = mgr.activeTurn()!;
    const child = children()[0]!;
    expect(alive(child)).toBe(true);
    expect(configs()).toHaveLength(1);
    t.grant!.started.add("run-1");
    expect(await mgr.stop()).toBe(true);
    expect(reply(store, a.conversationId)).toMatchObject({ status: "stopped", error: "Stopped." });
    expect(cancelled).toEqual(["run-1"]);
    t.grant!.afterStop!("run-late"); // a tool call that was still inside the studio records its run after Stop (TeeSet calls this)
    await until(() => cancelled.includes("run-late"));
    expect(alive(t.pid!)).toBe(false);
    await until(() => !alive(child), 5000); // the CLI's own child died with the group
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
    expect(mgr.busy()).toBeNull();
    expect(await mgr.stop()).toBe(false);
  });
  it("Stop falls back to the job cancel for an id the runner does not know", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
    const store = ChatStore.open(path.join(ws, ".qkt-studio", "chat", "chat.sqlite"))!;
    const seen: string[] = [];
    const mgr = new ChatManager({ cfg: testConfig(ws, { claudeBin: fakeClaude }), store, tokens: new ChatTokens(), events: new EventBus(), view: new ViewState(),
      status: new ClaudeStatusCache(fakeClaude, ws), splitText: async () => null,
      runner: { cancel: async (id, o) => { seen.push(`run:${id}:${o?.purge}`); return id.startsWith("r"); } },
      jobs: { cancel: async (id) => { seen.push(`job:${id}`); return true; } } });
    mgr.setMcpUrl("http://127.0.0.1:9/api/mcp");
    await mgr.send({ text: "keep working" });
    await until(() => mgr.activeTurn()?.pid !== null && mgr.activeTurn()?.pid !== undefined);
    mgr.activeTurn()!.grant!.started.add("r1").add("sweep-1");
    await mgr.stop();
    expect(seen).toEqual(["run:r1:true", "run:sweep-1:true", "job:sweep-1"]);
  });
  it("the time limit stops the process, keeps what was started, and says so", async () => {
    const { mgr, store, cancelled, tokens, configs, children } = setup({ limits: { maxCalls: 25, maxMs: 500 } });
    const a = await mgr.send({ text: "keep working" });
    await until(() => mgr.activeTurn()?.grant?.started !== undefined);
    mgr.activeTurn()!.grant!.started.add("run-kept");
    await until(() => !mgr.busy());
    expect(reply(store, a.conversationId)).toMatchObject({ status: "limit", error: "stopped at the limit (1 seconds)" });
    expect(cancelled).toEqual([]);
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
    for (const c of children()) await until(() => !alive(c), 5000);
  });
  it("the default limits are 25 tool calls and 5 minutes", () => {
    expect(LIMITS).toEqual({ maxCalls: 25, maxMs: 300_000 });
  });
  it("the call limit: the 26th tool call through the real /api/mcp ends the message at the limit", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
    mkdirSync(path.join(ws, "strategies"));
    const studio = await createStudio(testConfig(ws, { token: "t0k" }));
    await studio.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}/api/mcp`;
      const { mgr, store, got, configs } = setup({ ws, tokens: studio.tokens, mcpUrl: url });
      const a = await mgr.send({ text: "loop" }); // 30 list_files calls
      await until(() => !mgr.busy(), 30_000);
      const m = reply(store, a.conversationId);
      expect(m).toMatchObject({ status: "limit", error: "stopped at the limit (25 tool calls)" });
      const results = got.filter((e): e is Extract<ChatEvent, { k: "tool_result" }> => e.k === "tool_result");
      expect(results.slice(0, 25).every((r) => !r.isError)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(26); // killed right at the refused call
      expect(studio.tokens.size()).toBe(0);
      expect(configs()).toEqual([]);
    } finally { await studio.app.close(); }
  });
  it("a plan limit ends the message with the CLI's own text and the reset notice", async () => {
    const { mgr, store, tokens, configs } = setup();
    const a = await mgr.send({ text: "hit the usage limit" }); await until(() => !mgr.busy());
    const m = reply(store, a.conversationId);
    expect(m.status).toBe("error");
    expect(m.error).toMatch(/usage limit reached/i);
    expect(m.items.some((i) => i.type === "notice" && /resets at/.test(i.text))).toBe(true);
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
  });
  it("a chat whose Claude Code transcript is gone continues in a fresh session, once, with a notice", async () => {
    const { mgr, store, argvs, tokens, configs } = setup();
    const c = store.createConversation("old");
    store.setSession(c.id, "11111111-1111-4111-8111-111111111111", true);
    await mgr.send({ conversationId: c.id, text: "hi" }); await until(() => !mgr.busy());
    const m = reply(store, c.id);
    expect(m.status).toBe("done");
    expect(m.items.some((i) => i.type === "notice" && /fresh session/.test(i.text))).toBe(true);
    expect(store.conversation(c.id)!.sessionId).not.toBe("11111111-1111-4111-8111-111111111111");
    const [x, y] = argvs();
    expect(x).toContain("--resume"); expect(y).toContain("--session-id");
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
  });
  it("a first message that failed before a session existed: the next message recovers the taken id with --resume", async () => {
    const { mgr, store, argvs, tokens, configs } = setup();
    const a = await mgr.send({ text: "fail early" }); await until(() => !mgr.busy());
    expect(reply(store, a.conversationId)).toMatchObject({ status: "error", error: "boom: could not start" });
    expect(store.conversation(a.conversationId)!.sessionStarted).toBe(false);
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
    await mgr.send({ conversationId: a.conversationId, text: "hi" }); await until(() => !mgr.busy());
    expect(reply(store, a.conversationId).status).toBe("done");
    const [first, taken, resumed] = argvs();
    expect(flag(taken!, "--session-id")).toBe(flag(first!, "--session-id"));
    expect(flag(resumed!, "--resume")).toBe(flag(first!, "--session-id"));
  });
  it("a CLI that cannot be started ends the message as an error and still cleans up", async () => {
    // the status says installed (read from the stand-in), but the binary the message starts is gone
    const { mgr, store, tokens, configs } = setup({ bin: "/nonexistent/claude", statusBin: fakeClaude });
    const a = await mgr.send({ text: "hi" }); await until(() => !mgr.busy());
    expect(reply(store, a.conversationId)).toMatchObject({ status: "error", error: "Claude Code is not installed in this image" });
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
  });
  it("the studio shutting down mid-message ends it as interrupted", async () => {
    const { mgr, store, tokens, configs, children } = setup();
    const a = await mgr.send({ text: "keep working" });
    await until(() => children().length === 1);
    const pid = mgr.activeTurn()!.pid!;
    await mgr.close();
    expect(reply(store, a.conversationId)).toMatchObject({ status: "interrupted", error: "Interrupted: the studio stopped. Send again to continue." });
    expect(alive(pid)).toBe(false);
    await until(() => !alive(children()[0]!), 5000);
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
    expect(mgr.busy()).toBeNull();
  });
  it("a studio that died mid-message: the next start marks it interrupted, and the chat resumes its session", async () => {
    const { ws, mgr, store, argvs } = setup();
    const a = await mgr.send({ text: "keep working" });
    await until(() => store.conversation(a.conversationId)!.sessionStarted);
    // what start-up does (Task 6) while the old message is still "running" in the file
    const next = ChatStore.open(path.join(ws, ".qkt-studio", "chat", "chat.sqlite"))!;
    expect(next.markInterrupted()).toBe(1);
    expect(reply(next, a.conversationId)).toMatchObject({ status: "interrupted" });
    await mgr.stop(); // the old studio's process, so the next one can use the session
    const again = new ChatManager({ cfg: testConfig(ws, { claudeBin: fakeClaude }), store: next, tokens: new ChatTokens(), events: new EventBus(), view: new ViewState(),
      status: new ClaudeStatusCache(fakeClaude, ws), runner: { cancel: async () => false }, jobs: { cancel: async () => false }, splitText: async () => null });
    again.setMcpUrl("http://127.0.0.1:9/api/mcp");
    await again.send({ conversationId: a.conversationId, text: "hi" }); await until(() => !again.busy());
    expect(reply(next, a.conversationId).status).toBe("done");
    const [first, second] = argvs();
    expect(flag(second!, "--resume")).toBe(flag(first!, "--session-id"));
  });
  it("refuses to start when Claude Code is signed out or missing, and frees the slot", async () => {
    const { mgr, tokens, configs } = setup();
    writeFileSync(path.join(home, "fake-signed-out"), "");
    try { await expect(mgr.send({ text: "hi" })).rejects.toBeInstanceOf(ChatUnavailable); }
    finally { rmSync(path.join(home, "fake-signed-out")); }
    expect(mgr.busy()).toBeNull();
    expect(tokens.size()).toBe(0);
    expect(configs()).toEqual([]);
    const missing = setup({ bin: "/nonexistent/claude" });
    await expect(missing.mgr.send({ text: "hi" })).rejects.toThrow(/not installed/);
    expect(missing.mgr.busy()).toBeNull();
  });
  it("refuses an empty or huge message, and an unknown conversation", async () => {
    const { mgr } = setup();
    await expect(mgr.send({ text: "   " })).rejects.toBeInstanceOf(RangeError);
    await expect(mgr.send({ text: "x".repeat(8001) })).rejects.toBeInstanceOf(RangeError);
    await expect(mgr.send({ conversationId: "nope", text: "hi" })).rejects.toBeInstanceOf(ChatNotFound);
    expect(mgr.busy()).toBeNull();
  });
  it("the prompt asks for only the change the user named", () => {
    const lines = SYSTEM_PROMPT.split("\n");
    const i = lines.findIndex((l) => l.startsWith("Do what the user asks."));
    expect(lines[i + 1]).toBe("Change only what the user asked for; leave every other value as it is (asked for a stop, do not set a target).");
  });
  it("after close a send is refused", async () => {
    const { mgr, store } = setup();
    await mgr.close();
    await expect(mgr.send({ text: "hi" })).rejects.toThrow(new ChatUnavailable("the studio is shutting down"));
    expect(store.list(10)).toEqual([]);
  });
});
