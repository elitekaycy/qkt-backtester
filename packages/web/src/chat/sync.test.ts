// packages/web/src/chat/sync.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@qkt-studio/core/chat";

const server = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  busy: null as { conversationId: string; messageId: string } | null,
  stopped: false,
  calls: [] as string[],
  onSend: null as (() => void) | null,
  sendId: "m1",
}));
vi.mock("../api/client.js", () => ({
  api: {
    chatStatus: async () => { server.calls.push("status"); return { available: true, installed: true, version: "2.1.285", loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", error: null, uid: 1000, busy: server.busy, limits: { calls: 25, minutes: 5 } }; },
    chatConversations: async () => ({ conversations: [] }),
    chatConversation: async (id: string) => { server.calls.push(`conversation:${id}`); return { conversation: { id, title: "t", updated: "" }, messages: structuredClone(server.messages) }; },
    chatSend: async () => { server.onSend?.(); return { conversationId: "c1", messageId: server.sendId }; },
    chatStop: async () => ({ stopped: server.stopped }),
  },
  withToken: (u: string) => u,
}));

const { useChat } = await import("./state.js");
const msg = (o: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", conversationId: "c1", role: "assistant", text: "", model: "haiku", status: "running", error: null, items: [], usage: null, created: "2026-09-30T00:00:00Z", ...o });
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  server.messages = []; server.busy = null; server.stopped = false; server.calls = []; server.onSend = null; server.sendId = "m1";
  useChat.setState({ status: null, conversationId: null, messages: [], busy: false, sendError: null, statusError: null });
});

describe("the chat stays in step with the studio", () => {
  it("an end that arrives before the send's own reply leaves the chat idle", async () => {
    server.sendId = "m0";
    server.messages = [msg({ id: "m0", status: "error", error: "Claude Code is not installed in this image", evSeq: 1 })];
    // the CLI failed at once: its end is streamed before POST /api/chat/send answers
    server.onSend = () => useChat.getState().onEvent({ conversationId: "c1", messageId: "m0", seq: 1, ev: { k: "end", status: "error", error: "Claude Code is not installed in this image" } });
    expect(await useChat.getState().send("hi", [])).toBe(true);
    expect(useChat.getState().busy).toBe(false);
  });
  it("a message still running after the send is busy; once its fetched copy has ended it is not", async () => {
    server.messages = [msg({ evSeq: 0 })];
    await useChat.getState().send("hi", []);
    expect(useChat.getState().busy).toBe(true);
  });
  it("a message that ended while its send was answered (another tab saw it through) is not busy", async () => {
    server.messages = [msg({ status: "done", text: "hello", evSeq: 3 })];
    await useChat.getState().send("hi", []);
    expect(useChat.getState().busy).toBe(false);
  });
  it("Stop that finds nothing running re-reads the status and the conversation: the stuck spinner clears", async () => {
    useChat.setState({ conversationId: "c1", messages: [msg({ evSeq: 4 })], busy: true, status: null });
    server.messages = [msg({ status: "interrupted", error: "Interrupted: the studio restarted. Send again to continue.", evSeq: 4 })];
    server.stopped = false;
    await useChat.getState().stop();
    expect(server.calls).toEqual(["status", "conversation:c1"]);
    expect(useChat.getState().busy).toBe(false);
    expect(useChat.getState().messages[0]).toMatchObject({ status: "interrupted" });
  });
  it("a Stop that stopped something does not resync (the end event follows)", async () => {
    server.stopped = true;
    await useChat.getState().stop();
    expect(server.calls).toEqual([]);
  });
  it("a gap in the stream refetches the conversation and folds what was held back", async () => {
    useChat.setState({ conversationId: "c1", messages: [msg({ text: "a", items: [{ type: "text", text: "a" }], evSeq: 1 })], busy: true });
    // seq 2 and 3 were lost while the connection was down; the server's copy holds them
    server.messages = [msg({ text: "abc", items: [{ type: "text", text: "abc" }], evSeq: 3 })];
    useChat.getState().onEvent({ conversationId: "c1", messageId: "m1", seq: 4, ev: { k: "text", text: "d" } });
    await settle();
    expect(server.calls).toEqual(["conversation:c1"]);
    expect(useChat.getState().messages[0]).toMatchObject({ text: "abcd", evSeq: 4 });
  });
  it("the status request failing is shown, not spun on; a retry that works clears it", async () => {
    const { api } = await import("../api/client.js");
    const ok = api.chatStatus;
    (api as { chatStatus: unknown }).chatStatus = async () => { throw new Error("401 unauthorized"); };
    await useChat.getState().loadStatus();
    expect(useChat.getState()).toMatchObject({ status: null, statusError: "401 unauthorized" });
    (api as { chatStatus: unknown }).chatStatus = ok;
    await useChat.getState().loadStatus();
    expect(useChat.getState().statusError).toBeNull();
    expect(useChat.getState().status).not.toBeNull();
  });
});
