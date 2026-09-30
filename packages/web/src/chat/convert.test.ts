// packages/web/src/chat/convert.test.ts
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@qkt-studio/core/chat";
import { stepLabel, toThreadMessage } from "./convert.js";

const base: ChatMessage = { id: "m", conversationId: "c", role: "assistant", text: "", model: "haiku", status: "done", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" };

describe("toThreadMessage", () => {
  it("a user message is exactly what the user typed", () => {
    expect(toThreadMessage({ ...base, role: "user", text: "stop 2 %" })).toMatchObject({ id: "m", role: "user", content: [{ type: "text", text: "stop 2 %" }] });
  });
  it("assistant items become text, tool-call and notice parts in order, then a footer once finished", () => {
    const t = toThreadMessage({ ...base, items: [{ type: "text", text: "Trying." }, { type: "tool", id: "t1", name: "try_change", input: { label: "x" }, result: { isError: false, text: "{}", ms: 3100 } }, { type: "notice", text: "retrying" }], usage: null });
    expect(t.content).toEqual([
      { type: "text", text: "Trying." },
      { type: "tool-call", toolCallId: "t1", toolName: "try_change", args: { label: "x" }, result: "{}", isError: false, artifact: { ms: 3100 } },
      { type: "data-notice", data: { text: "retrying" } },
      { type: "data-footer", data: { status: "done", error: null, usage: null, model: "haiku" } },
    ]);
    expect(t.status).toEqual({ type: "complete", reason: "stop" });
  });
  it("maps the message status; a running message has no footer; a non-object tool input becomes {}", () => {
    const run = toThreadMessage({ ...base, status: "running", items: [{ type: "tool", id: "t", name: "x", input: "odd" }] });
    expect(run.status).toEqual({ type: "running" });
    expect(run.content).toEqual([{ type: "tool-call", toolCallId: "t", toolName: "x", args: {}, result: undefined, isError: undefined, artifact: { ms: null } }]);
    expect(toThreadMessage({ ...base, status: "stopped" }).status).toEqual({ type: "incomplete", reason: "cancelled" });
    expect(toThreadMessage({ ...base, status: "error", error: "boom" }).status).toEqual({ type: "incomplete", reason: "error", error: "boom" });
    expect(toThreadMessage({ ...base, status: "limit" }).status).toEqual({ type: "incomplete", reason: "other" });
  });
  it("names tool steps in plain words", () => {
    expect(stepLabel("run_backtest")).toBe("ran backtest");
    expect(stepLabel("something_new")).toBe("something new");
  });
});
