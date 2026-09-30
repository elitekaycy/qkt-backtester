// packages/server/test/chat/stream.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MAX_RESULT_CHARS, StreamParser } from "../../src/chat/stream.js";
import { MAX_CHARS } from "../../src/mcp/util.js";

const SCEN = fileURLToPath(new URL("../fixtures/fake-claude/scenarios/", import.meta.url));
const REC = fileURLToPath(new URL("../fixtures/fake-claude/recorded/", import.meta.url));
const parse = (text: string) => { const p = new StreamParser(); return text.split("\n").flatMap((l) => p.feed(l.replaceAll("{{session}}", "s-1"))); };
const file = (f: string) => readFileSync(path.join(SCEN, f), "utf8");

describe("StreamParser", () => {
  it("turns a reply into text, one tool step, its result and usage; streamed deltas win over the whole message", () => {
    expect(parse(file("stop-2pct.jsonl"))).toEqual([
      { k: "session", sessionId: "s-1", model: "claude-haiku-4-5", toolsConnected: true },
      { k: "text", text: "Trying a 2 % stop " },
      { k: "text", text: "on a copy." },
      { k: "tool", id: "toolu_1", name: "try_change", input: { changes: [{ op: "set_bracket", stop: "2 PCT" }], label: "stop 2 %" } },
      { k: "tool_result", id: "toolu_1", isError: false, text: "{\"variantId\":\"v1\",\"label\":\"stop 2 %\"}" },
      { k: "text", text: "Net +190 vs -412. It is on the chart." },
      { k: "result", ok: true, text: "Net +190 vs -412. It is on the chart.", subtype: "success", usage: { inputTokens: 1200, outputTokens: 90, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: 0.0061, turns: 2, durationMs: 4200 } },
    ]);
  });
  it("a plan limit: a notice with the reset time, and a failed result carrying the CLI's text as-is", () => {
    const evs = parse(file("plan-limit.jsonl"));
    expect(evs[1]).toEqual({ k: "notice", text: "Your Claude plan's usage limit is reached; it resets at 2026-09-21 14:13 UTC." });
    expect(evs[2]).toMatchObject({ k: "result", ok: false, text: "Claude AI usage limit reached|1790000000" });
  });
  it("keeps the largest result a tool can give whole, so its card still parses; only a longer one is cut", () => {
    const base = { variantId: "v7", label: "stop 2 %", runId: "r1", baseRunId: "r0", diff: "" };
    const result = JSON.stringify({ ...base, diff: "x".repeat(MAX_CHARS - JSON.stringify(base).length) });
    expect(result.length).toBe(MAX_CHARS);
    const line = (text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text }] }] } });
    const [ev] = new StreamParser().feed(line(result));
    expect(ev).toMatchObject({ k: "tool_result", text: result });
    expect(JSON.parse((ev as { text: string }).text)).toMatchObject({ variantId: "v7", label: "stop 2 %", runId: "r1", baseRunId: "r0" });
    const [long] = new StreamParser().feed(line("y".repeat(MAX_RESULT_CHARS + 10)));
    expect((long as { text: string }).text).toBe(`${"y".repeat(MAX_RESULT_CHARS)}…`);
  });
  it("ignores what it does not know: blank and non-JSON lines, unknown types, sub-agent lines", () => {
    const p = new StreamParser();
    for (const l of ["", "not json", "[1,2]", '{"type":"system","subtype":"hook_started"}', '{"type":"tool_progress"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_9","message":{"id":"m","content":[{"type":"text","text":"sub"}]}}']) expect(p.feed(l)).toEqual([]);
  });
  it("says once that the studio's tools did not connect, and reports retries", () => {
    const p = new StreamParser();
    expect(p.feed('{"type":"system","subtype":"init","session_id":"s","mcp_servers":[{"name":"studio","status":"failed"}]}')).toEqual([
      { k: "session", sessionId: "s", model: null, toolsConnected: false },
      { k: "notice", text: "The studio's tools did not connect (failed); the reply cannot use them." },
    ]);
    expect(p.feed('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":500,"error_status":529}')).toEqual([{ k: "notice", text: "Claude's service did not answer; retrying (attempt 2 of 10)." }]);
  });
  it("a tool result given as a plain string, marked as an error, and cut when huge", () => {
    const p = new StreamParser();
    const long = "x".repeat(MAX_RESULT_CHARS + 1000);
    const [ev] = p.feed(JSON.stringify({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: long, is_error: true }] } }));
    expect(ev).toMatchObject({ k: "tool_result", id: "t", isError: true });
    expect((ev as { text: string }).text.length).toBe(MAX_RESULT_CHARS + 1);
  });
  it.skipIf(!existsSync(REC))("recorded real streams (scripts/chat-live.mjs) parse without throwing and end in a result", () => {
    for (const f of readdirSync(REC).filter((x) => x.endsWith(".jsonl"))) {
      const evs = parse(readFileSync(path.join(REC, f), "utf8"));
      expect(evs.at(-1)?.k, f).toBe("result");
    }
  });
});
