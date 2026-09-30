// packages/server/src/chat/stream.ts
import type { ChatEvent, Usage } from "@qkt-studio/core";

const TOOL_PREFIX = "mcp__studio__";
const MAX_RESULT_CHARS = 4000;
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export const toolName = (n: string): string => (n.startsWith(TOOL_PREFIX) ? n.slice(TOOL_PREFIX.length) : n);
const textOf = (content: unknown): string => (typeof content === "string" ? content : arr(content).map((p) => str(obj(p)?.text) ?? "").join(""));
// the CLI's reset times are epoch seconds; accept milliseconds too
const clock = (t: number): string => `${new Date(t < 1e12 ? t * 1000 : t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function usageOf(o: Obj): Usage {
  const u = obj(o.usage) ?? {};
  return {
    inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) ?? 0, cacheWriteTokens: num(u.cache_creation_input_tokens) ?? 0,
    costUsd: num(o.total_cost_usd), turns: num(o.num_turns), durationMs: num(o.duration_ms),
  };
}

/**
 * Claude Code's `--output-format stream-json` lines -> chat events. Tolerant on purpose: the format is the CLI's and grows new
 * message types, so only the fields below are read; unknown lines and fields are ignored, never an error. With
 * --include-partial-messages the text arrives twice (deltas, then the whole assistant message): the deltas win.
 */
export class StreamParser {
  private streamed = new Set<string>();
  private current: string | null = null;
  sessionId: string | null = null;

  feed(line: string): ChatEvent[] {
    const t = line.trim();
    if (!t.startsWith("{")) return [];
    let o: Obj | null;
    try { o = obj(JSON.parse(t)); } catch { return []; }
    if (!o) return [];
    // a sub-agent's own messages (no sub-agents are enabled, but the format allows them) never reach the chat
    if (o.parent_tool_use_id !== undefined && o.parent_tool_use_id !== null) return [];
    switch (o.type) {
      case "system": return this.system(o);
      case "stream_event": return this.delta(o);
      case "assistant": return this.assistant(o);
      case "user": return this.user(o);
      case "result": return [this.result(o)];
      case "rate_limit_event": return this.rateLimit(o);
      default: return [];
    }
  }

  private system(o: Obj): ChatEvent[] {
    if (o.subtype === "init") {
      const sid = str(o.session_id) ?? "";
      if (sid) this.sessionId = sid;
      const status = str(arr(o.mcp_servers).map(obj).find((s) => s?.name === "studio")?.status);
      const out: ChatEvent[] = [{ k: "session", sessionId: sid, model: str(o.model), toolsConnected: status === null ? null : status === "connected" }];
      if (status !== null && status !== "connected") out.push({ k: "notice", text: `The studio's tools did not connect (${status}); the reply cannot use them.` });
      return out;
    }
    if (o.subtype === "api_retry") return [{ k: "notice", text: `Claude's service did not answer; retrying (attempt ${num(o.attempt) ?? "?"} of ${num(o.max_retries) ?? "?"}).` }];
    return [];
  }

  private delta(o: Obj): ChatEvent[] {
    const e = obj(o.event);
    if (!e) return [];
    if (e.type === "message_start") { this.current = str(obj(e.message)?.id); return []; }
    const d = obj(e.delta);
    if (e.type !== "content_block_delta" || d?.type !== "text_delta" || typeof d.text !== "string" || !d.text) return [];
    if (this.current) this.streamed.add(this.current);
    return [{ k: "text", text: d.text }];
  }

  private assistant(o: Obj): ChatEvent[] {
    const m = obj(o.message);
    if (!m) return [];
    const id = str(m.id), streamed = id !== null && this.streamed.has(id);
    const out: ChatEvent[] = [];
    for (const b of arr(m.content).map(obj)) {
      if (!b) continue;
      if (b.type === "text" && !streamed && typeof b.text === "string" && b.text) out.push({ k: "text", text: b.text });
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") out.push({ k: "tool", id: b.id, name: toolName(b.name), input: b.input ?? {} });
    }
    const err = str(o.error);
    if (err) out.push({ k: "notice", text: `Claude reported: ${err.replace(/_/g, " ")}.` });
    return out;
  }

  private user(o: Obj): ChatEvent[] {
    const out: ChatEvent[] = [];
    for (const b of arr(obj(o.message)?.content).map(obj)) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      let text = textOf(b.content);
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}…`;
      out.push({ k: "tool_result", id: b.tool_use_id, isError: b.is_error === true, text });
    }
    return out;
  }

  private result(o: Obj): ChatEvent {
    const text = str(o.result) ?? arr(o.errors).map((e) => String(e)).join("; ");
    return { k: "result", ok: o.subtype === "success" && o.is_error !== true, text, subtype: str(o.subtype) ?? "unknown", usage: usageOf(o) };
  }

  private rateLimit(o: Obj): ChatEvent[] {
    const i = obj(o.rate_limit_info), resets = num(i?.resetsAt);
    if (i?.status === "rejected") return [{ k: "notice", text: `Your Claude plan's usage limit is reached${resets ? `; it resets at ${clock(resets)}` : ""}.` }];
    if (i?.status === "allowed_warning") return [{ k: "notice", text: "Close to your Claude plan's usage limit." }];
    return [];
  }
}
