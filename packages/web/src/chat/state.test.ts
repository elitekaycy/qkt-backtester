// packages/web/src/chat/state.test.ts
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@qkt-studio/core/chat";
import { applyWire, planText, shouldRevealPipeline, usageText, viewChips } from "./state.js";

const msg = (id: string): ChatMessage => ({ id, conversationId: "c1", role: "assistant", text: "", model: "haiku", status: "running", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" });

describe("chat state helpers", () => {
  it("applies a streamed event to the open conversation; unknown message -> null (refetch); other conversation -> unchanged", () => {
    const ms = [msg("m1")];
    expect(applyWire(ms, "c1", { conversationId: "c1", messageId: "m1", ev: { k: "text", text: "hi" } })![0]!.text).toBe("hi");
    expect(applyWire(ms, "c1", { conversationId: "c1", messageId: "m2", ev: { k: "text", text: "hi" } })).toBeNull();
    expect(applyWire(ms, "c1", { conversationId: "c9", messageId: "m1", ev: { k: "text", text: "hi" } })).toBe(ms);
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
