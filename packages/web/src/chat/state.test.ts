// packages/web/src/chat/state.test.ts
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@qkt-studio/core/chat";
import { applyWire, busyAfterSend, mergeSnapshot, planText, replayWires, shouldResync, shouldRevealPipeline, usageText, viewChips } from "./state.js";

const msg = (id: string): ChatMessage => ({ id, conversationId: "c1", role: "assistant", text: "", model: "haiku", status: "running", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" });

describe("chat state helpers", () => {
  it("applies a streamed event to the open conversation; unknown message -> null (refetch); other conversation -> unchanged", () => {
    const ms = [msg("m1")];
    expect(applyWire(ms, "c1", { conversationId: "c1", messageId: "m1", seq: 1, ev: { k: "text", text: "hi" } })![0]!.text).toBe("hi");
    expect(applyWire(ms, "c1", { conversationId: "c1", messageId: "m2", seq: 1, ev: { k: "text", text: "hi" } })).toBeNull();
    expect(applyWire(ms, "c1", { conversationId: "c9", messageId: "m1", seq: 1, ev: { k: "text", text: "hi" } })).toBe(ms);
  });
  it("is idempotent: a replayed event changes nothing, and an event the snapshot already holds is not folded twice", () => {
    const once = applyWire([msg("m1")], "c1", { conversationId: "c1", messageId: "m1", seq: 1, ev: { k: "text", text: "hi" } })!;
    expect(once[0]!.evSeq).toBe(1);
    expect(applyWire(once, "c1", { conversationId: "c1", messageId: "m1", seq: 1, ev: { k: "text", text: "hi" } })).toBe(once);
    const notice = applyWire(once, "c1", { conversationId: "c1", messageId: "m1", seq: 2, ev: { k: "notice", text: "n" } })!;
    expect(applyWire(notice, "c1", { conversationId: "c1", messageId: "m1", seq: 2, ev: { k: "notice", text: "n" } })).toBe(notice);
    const snapshot = [{ ...msg("m1"), text: "hi", items: [{ type: "text" as const, text: "hi" }], evSeq: 3 }];
    expect(applyWire(snapshot, "c1", { conversationId: "c1", messageId: "m1", seq: 3, ev: { k: "text", text: "hi" } })).toBe(snapshot);
    expect(applyWire(snapshot, "c1", { conversationId: "c1", messageId: "m1", seq: 4, ev: { k: "text", text: "!" } })![0]!.text).toBe("hi!");
  });
  it("a gap (events that never arrived) asks for a refetch instead of folding onto a message missing them", () => {
    const one = applyWire([msg("m1")], "c1", { conversationId: "c1", messageId: "m1", seq: 1, ev: { k: "text", text: "a" } })!;
    expect(applyWire(one, "c1", { conversationId: "c1", messageId: "m1", seq: 3, ev: { k: "text", text: "c" } })).toBeNull();
    expect(applyWire(one, "c1", { conversationId: "c1", messageId: "m1", seq: 2, ev: { k: "text", text: "b" } })![0]!.text).toBe("ab");
  });
  it("events held back during a refetch fold onto the fetched copy in order; ones it holds drop, ones after a gap wait", () => {
    const fetched = [{ ...msg("m1"), text: "ab", items: [{ type: "text" as const, text: "ab" }], evSeq: 2 }];
    const w = (seq: number, text: string, conversationId = "c1") => ({ conversationId, messageId: "m1", seq, ev: { k: "text" as const, text } });
    const r = replayWires(fetched, "c1", [w(4, "d"), w(2, "b"), w(3, "c"), w(9, "late"), w(5, "x", "c2")]);
    expect(r.messages[0]).toMatchObject({ text: "abcd", evSeq: 4 });
    expect(r.rest).toEqual([w(9, "late")]);
    const unknown = { conversationId: "c1", messageId: "m9", seq: 1, ev: { k: "text" as const, text: "?" } };
    expect(replayWires(fetched, "c1", [unknown])).toEqual({ messages: fetched, rest: [unknown] });
  });
  it("a fetched copy replaces the shown one unless the shown one is newer; an ended stored copy always ends it", () => {
    const shown = { ...msg("m1"), text: "abc", evSeq: 5 };
    expect(mergeSnapshot(undefined, { ...msg("m1"), evSeq: 1 })).toMatchObject({ evSeq: 1 });
    expect(mergeSnapshot(shown, { ...msg("m1"), text: "ab", evSeq: 4 })).toBe(shown);
    expect(mergeSnapshot(shown, { ...msg("m1"), text: "abcd", evSeq: 6 })).toMatchObject({ text: "abcd", evSeq: 6 });
    // the studio restarted before its last save: the stored copy is older but says interrupted
    expect(mergeSnapshot(shown, { ...msg("m1"), text: "ab", evSeq: 4, status: "interrupted", error: "Interrupted" })).toMatchObject({ text: "abc", evSeq: 5, status: "interrupted", error: "Interrupted" });
  });
  it("busy after a send comes from the message, and an end already seen wins", () => {
    expect(busyAfterSend(msg("m1"), false)).toBe(true);
    expect(busyAfterSend(msg("m1"), true)).toBe(false);
    expect(busyAfterSend({ ...msg("m1"), status: "error" }, false)).toBe(false);
    expect(busyAfterSend(undefined, false)).toBe(true);
    expect(busyAfterSend(undefined, true)).toBe(false);
  });
  it("resyncs on a reconnection only, and only once the Chat tab has loaded", () => {
    expect(shouldResync({ reconnect: false, chatLoaded: true })).toBe(false);
    expect(shouldResync({ reconnect: true, chatLoaded: false })).toBe(false);
    expect(shouldResync({ reconnect: true, chatLoaded: true })).toBe(true);
  });
  it("the pipeline pops up for runs, except over an open Chat tab that is answering", () => {
    expect(shouldRevealPipeline({ dockOpen: true, dockTab: "chat", chatBusy: true })).toBe(false);
    expect(shouldRevealPipeline({ dockOpen: true, dockTab: "chat", chatBusy: false })).toBe(true);
    expect(shouldRevealPipeline({ dockOpen: false, dockTab: "chat", chatBusy: true })).toBe(true);
    expect(shouldRevealPipeline({ dockOpen: true, dockTab: "terminal", chatBusy: true })).toBe(true);
  });
  it("chips show what the view reference will carry", () => {
    expect(viewChips({ activePath: "strategies/ema.qkt", runId: "r1", visible: true, selectedTrade: 7, variantLabel: "stop 2 %", splitText: "test = last 25 %" }))
      .toEqual([{ key: "file", label: "ema.qkt" }, { key: "run", label: "run r1" }, { key: "range", label: "chart range" }, { key: "trade", label: "trade #7" }, { key: "variant", label: "variant: stop 2 %" }, { key: "split", label: "split: test = last 25 %" }]);
    expect(viewChips({ activePath: null, runId: null, visible: false, selectedTrade: null, variantLabel: null, splitText: null })).toEqual([]);
  });
  it("plan and usage lines", () => {
    expect(planText({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })).toBe("Signed in · Claude Max");
    expect(planText({ loggedIn: true, authMethod: "api_key", subscriptionType: null })).toBe("Signed in with an API key");
    expect(planText(null)).toBe("Not signed in");
    expect(usageText({ inputTokens: 400, outputTokens: 1200, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.0123, turns: 2, durationMs: 1 }))
      .toEqual({ text: "2.4k in · 1.2k out · counts toward your Claude plan", title: "API-equivalent cost: $0.012" });
    expect(usageText(null)).toBeNull();
  });
});
