// packages/core/src/chat.ts
/** Chat messages and the events that build them: shared by the server (what it stores) and the browser (what it shows). */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; turns: number | null; durationMs: number | null }
export type ChatStatus = "running" | "done" | "error" | "stopped" | "limit" | "interrupted";
export type EndStatus = Exclude<ChatStatus, "running">;
export type ChatEvent =
  | { k: "session"; sessionId: string; model: string | null; toolsConnected: boolean | null }
  | { k: "text"; text: string }
  | { k: "tool"; id: string; name: string; input: unknown }
  | { k: "tool_result"; id: string; isError: boolean; text: string; ms?: number }
  | { k: "notice"; text: string }
  | { k: "result"; ok: boolean; text: string; subtype: string; usage: Usage }
  | { k: "end"; status: EndStatus; error?: string; usage?: Usage | null };
export type ChatItem =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; result?: { isError: boolean; text: string; ms?: number } }
  | { type: "notice"; text: string };
export interface ChatMessage {
  id: string; conversationId: string; role: "user" | "assistant"; text: string; model: string | null;
  status: ChatStatus; error: string | null; items: ChatItem[]; usage: Usage | null; created: string;
  /** Sequence number of the last streamed event folded into this message (absent = none). Events carry theirs; one at or below it is already in the message. */
  evSeq?: number;
}
/** Parts of the view reference the user can leave out of one message (the chips above the message box). */
export const VIEW_KEYS = ["file", "run", "range", "trade", "variant", "split"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];
/** An @ mention: what the user typed and what it refers to (a path, a run id, "the chart"...). */
export interface Mention { label: string; ref: string }

/** Tokens the plan counted as input for a message: fresh input plus cache reads and writes. */
export const tokensIn = (u: Usage): number => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** One event into a message. Pure: returns a new message, never changes the one given. */
export function foldEvent(m: ChatMessage, ev: ChatEvent): ChatMessage {
  switch (ev.k) {
    case "text": {
      const items = m.items.slice(), last = items[items.length - 1];
      if (last?.type === "text") { items[items.length - 1] = { type: "text", text: last.text + ev.text }; return { ...m, items, text: m.text + ev.text }; }
      items.push({ type: "text", text: ev.text });
      return { ...m, items, text: m.text ? `${m.text}\n\n${ev.text}` : ev.text };
    }
    case "tool":
      if (m.items.some((i) => i.type === "tool" && i.id === ev.id)) return m;
      return { ...m, items: [...m.items, { type: "tool", id: ev.id, name: ev.name, input: ev.input }] };
    case "tool_result":
      return { ...m, items: m.items.map((i) => (i.type === "tool" && i.id === ev.id ? { ...i, result: { isError: ev.isError, text: ev.text, ms: ev.ms } } : i)) };
    case "notice":
      return { ...m, items: [...m.items, { type: "notice", text: ev.text }] };
    case "result":
      return { ...m, usage: ev.usage, error: ev.ok ? m.error : ev.text || m.error };
    case "end":
      // done means the message succeeded: an earlier attempt's failed result (a retry that then worked) is not its error
      return { ...m, status: ev.status, error: ev.status === "done" ? null : ev.error ?? m.error, usage: ev.usage === undefined ? m.usage : ev.usage };
    case "session":
      return m;
  }
}
