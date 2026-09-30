// packages/server/test/chat/store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatMessage } from "@qkt-studio/core";
import { ChatStore } from "../../src/chat/store.js";

const fresh = () => new ChatStore(path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), "chat-"))), "chat", "chat.sqlite"));
const msg = (conversationId: string, id: string, role: "user" | "assistant", status: ChatMessage["status"] = "done"): ChatMessage =>
  ({ id, conversationId, role, text: `${role} ${id}`, model: role === "assistant" ? "haiku" : null, status, error: null, items: [], usage: null, created: new Date().toISOString() });

describe("ChatStore", () => {
  it("keeps conversations and their messages in order, the most recently used conversation first", async () => {
    const s = fresh();
    const a = s.createConversation("stop 2 %"), b = s.createConversation("skip fridays");
    expect(a.sessionStarted).toBe(false);
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    s.addMessage(msg(a.id, "1", "user")); s.addMessage(msg(a.id, "2", "assistant", "running"));
    await new Promise((r) => setTimeout(r, 5));
    s.saveMessage({ ...msg(a.id, "2", "assistant"), text: "Net +190", items: [{ type: "text", text: "Net +190" }], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.001, turns: 1, durationMs: 10 } });
    expect(s.messages(a.id).map((m) => [m.id, m.role, m.status])).toEqual([["1", "user", "done"], ["2", "assistant", "done"]]);
    expect(s.messages(a.id)[1]).toMatchObject({ text: "Net +190", items: [{ type: "text", text: "Net +190" }], usage: { costUsd: 0.001 } });
    expect(s.list().map((c) => [c.id, c.messages])).toEqual([[a.id, 2], [b.id, 0]]);
    s.close();
  });
  it("marks a message a restart left running as interrupted", () => {
    const s = fresh();
    const c = s.createConversation("x");
    s.addMessage(msg(c.id, "1", "assistant", "running"));
    expect(s.markInterrupted()).toBe(1);
    expect(s.messages(c.id)[0]).toMatchObject({ status: "interrupted", error: "Interrupted: the studio restarted. Send again to continue." });
    s.close();
  });
  it("remembers the Claude Code session and whether it exists yet", () => {
    const s = fresh();
    const c = s.createConversation("x");
    s.setSession(c.id, c.sessionId, true);
    expect(s.conversation(c.id)).toMatchObject({ sessionId: c.sessionId, sessionStarted: true });
    s.setSession(c.id, "00000000-0000-4000-8000-000000000000", false);
    expect(s.conversation(c.id)).toMatchObject({ sessionId: "00000000-0000-4000-8000-000000000000", sessionStarted: false });
    expect(s.conversation("nope")).toBeUndefined();
    s.close();
  });
});
