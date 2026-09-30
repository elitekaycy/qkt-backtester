// packages/core/test/chat.test.ts
import { describe, it, expect } from "vitest";
import { foldEvent, tokensIn, type ChatEvent, type ChatMessage } from "../src/chat.js";

const empty = (): ChatMessage => ({ id: "m", conversationId: "c", role: "assistant", text: "", model: "haiku", status: "running", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" });
const fold = (evs: ChatEvent[], m = empty()) => evs.reduce(foldEvent, m);
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, costUsd: 0.01, turns: 2, durationMs: 900 };

describe("foldEvent", () => {
  it("joins text deltas into one text item until a tool step, then starts a new one", () => {
    const m = fold([{ k: "text", text: "Trying " }, { k: "text", text: "it." }, { k: "tool", id: "t1", name: "try_change", input: { a: 1 } }, { k: "text", text: "Done." }]);
    expect(m.items.map((i) => i.type)).toEqual(["text", "tool", "text"]);
    expect(m.items[0]).toEqual({ type: "text", text: "Trying it." });
    expect(m.text).toBe("Trying it.\n\nDone.");
  });
  it("attaches a result to its tool step by id, and ignores a repeated tool_use", () => {
    const m = fold([{ k: "tool", id: "t1", name: "run_backtest", input: {} }, { k: "tool", id: "t1", name: "run_backtest", input: {} }, { k: "tool_result", id: "t1", isError: false, text: "{}", ms: 3200 }, { k: "tool_result", id: "nope", isError: true, text: "x" }]);
    expect(m.items).toEqual([{ type: "tool", id: "t1", name: "run_backtest", input: {}, result: { isError: false, text: "{}", ms: 3200 } }]);
  });
  it("a failed result records its text as the error; end sets the status and keeps the usage", () => {
    const m = fold([{ k: "result", ok: false, text: "usage limit reached", subtype: "success", usage }, { k: "end", status: "error" }]);
    expect(m).toMatchObject({ status: "error", error: "usage limit reached", usage });
    expect(fold([{ k: "notice", text: "retrying" }, { k: "end", status: "stopped", error: "Stopped.", usage: null }])).toMatchObject({ status: "stopped", error: "Stopped.", usage: null, items: [{ type: "notice", text: "retrying" }] });
  });
  it("a message that ends done carries no error, even when an earlier attempt's result failed (a retry that succeeded)", () => {
    const m = fold([{ k: "result", ok: false, text: "No conversation found", subtype: "error_during_execution", usage }, { k: "notice", text: "fresh session" }, { k: "result", ok: true, text: "ok", subtype: "success", usage }, { k: "end", status: "done", usage }]);
    expect(m).toMatchObject({ status: "done", error: null });
  });
  it("never mutates the message it is given", () => {
    const m = empty();
    fold([{ k: "text", text: "a" }, { k: "tool", id: "t", name: "x", input: {} }], m);
    expect(m).toEqual(empty());
  });
  it("tokensIn counts fresh input, cache reads and cache writes", () => { expect(tokensIn(usage)).toBe(111); });
});
