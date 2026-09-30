// packages/web/src/chat/state.ts
import { create } from "zustand";
import { foldEvent, tokensIn, type ChatEvent, type ChatMessage, type Mention, type Usage, type ViewKey } from "@qkt-studio/core/chat";
import { useStore } from "../state/store.js";
import { api } from "../api/client.js";
import type { DockTab } from "../state/ui.js";

export interface ChatStatusInfo {
  /** false when the chat store could not be opened: `reason` says why and sending is refused */
  available: boolean; reason?: string;
  installed: boolean; version: string | null; loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; error: string | null;
  uid: number | null; busy: { conversationId: string; messageId: string } | null; limits: { calls: number; minutes: number };
}
export interface ConversationInfo { id: string; title: string; updated: string; messages: number }
/** `seq` is the message's event counter: an event at or below the message's `evSeq` is already in it (a snapshot fetched after it was sent). */
export interface ChatWire { conversationId: string; messageId: string; seq: number; ev: ChatEvent }
/** A chat this long re-reads a lot on every message: the header offers a fresh one. */
export const LONG_CHAT = 20;

/** Pure: one streamed event into the open conversation. Another conversation: unchanged; an unknown message, or a gap
 *  (events between the message's last one and this one never arrived: the stream dropped and reconnected): null (refetch). */
export function applyWire(messages: ChatMessage[], conversationId: string | null, w: ChatWire): ChatMessage[] | null {
  if (w.conversationId !== conversationId) return messages;
  const i = messages.findIndex((m) => m.id === w.messageId);
  if (i < 0) return null;
  const cur = messages[i]!;
  if (w.seq <= (cur.evSeq ?? 0)) return messages; // already folded: a duplicate, or covered by the snapshot
  if (w.seq > (cur.evSeq ?? 0) + 1) return null; // folding this onto a message that is missing events would lose them
  const next = messages.slice();
  next[i] = { ...foldEvent(cur, w.ev), evSeq: w.seq };
  return next;
}

/** Pure: events held back while the conversation was being refetched (their message was unknown, or they came after a
 *  gap), folded onto the fetched copy in order. Those the copy already holds drop out; those still after a gap, or for a
 *  message still unknown, are returned in `rest` for the next refetch. Another conversation's are dropped. */
export function replayWires(messages: ChatMessage[], conversationId: string | null, held: ChatWire[]): { messages: ChatMessage[]; rest: ChatWire[] } {
  let out = messages;
  const rest: ChatWire[] = [];
  for (const w of [...held].sort((a, b) => a.seq - b.seq)) {
    if (w.conversationId !== conversationId) continue;
    const next = applyWire(out, conversationId, w);
    if (next === null) rest.push(w); else out = next;
  }
  return { messages: out, rest };
}

/** Pure: a fetched message against the one already shown. The shown one is kept when it has folded newer events, unless
 *  the stored one has ended (a restart, a Stop seen by another tab): its status and error then win, so a message never
 *  stays "running" in this tab after the studio has ended it. */
export function mergeSnapshot(shown: ChatMessage | undefined, stored: ChatMessage): ChatMessage {
  if (!shown || (shown.evSeq ?? 0) <= (stored.evSeq ?? 0)) return stored;
  return stored.status === "running" ? shown : { ...shown, status: stored.status, error: stored.error, usage: stored.usage ?? shown.usage };
}

/** Pure: is the message just sent still being answered? The fetched copy (merged with what streamed) says so while it is
 *  "running", but an `end` already seen for it wins: it can arrive before the send's own reply when the CLI fails at once.
 *  Unknown copy (its fetch failed): busy unless its end was seen. */
export function busyAfterSend(message: ChatMessage | undefined, endSeen: boolean): boolean {
  if (endSeen) return false;
  return message ? message.status === "running" : true;
}

/** Pure: the event stream (re)connected. The first connection needs nothing; a reconnection means events may have been
 *  missed, so the chat re-reads its status and the open conversation, but only once the Chat tab has loaded it (a tab
 *  that never opened Chat asks nothing). */
export function shouldResync(a: { reconnect: boolean; chatLoaded: boolean }): boolean {
  return a.reconnect && a.chatLoaded;
}

/** Pure: a run normally pops the Pipeline tab open; not over an open Chat tab that is answering (its own tools start runs). */
export function shouldRevealPipeline(a: { dockOpen: boolean; dockTab: DockTab; chatBusy: boolean }): boolean {
  return !(a.dockOpen && a.dockTab === "chat" && a.chatBusy);
}

/** Pure: the chips above the message box, one per part of the view reference that will be sent. */
export function viewChips(s: { activePath: string | null; runId: string | null; visible: boolean; selectedTrade: number | null; variantLabel: string | null; splitText: string | null }): Array<{ key: ViewKey; label: string }> {
  const out: Array<{ key: ViewKey; label: string }> = [];
  if (s.activePath) out.push({ key: "file", label: s.activePath.split("/").pop()! });
  if (s.runId) out.push({ key: "run", label: `run ${s.runId}` });
  if (s.visible) out.push({ key: "range", label: "chart range" });
  if (s.selectedTrade !== null) out.push({ key: "trade", label: `trade #${s.selectedTrade}` });
  if (s.variantLabel) out.push({ key: "variant", label: `variant: ${s.variantLabel}` });
  if (s.splitText) out.push({ key: "split", label: `split: ${s.splitText}` });
  return out;
}

export function planText(s: { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null } | null): string {
  if (!s?.loggedIn) return "Not signed in";
  if (s.authMethod && /api/i.test(s.authMethod)) return "Signed in with an API key";
  return s.subscriptionType ? `Signed in · Claude ${s.subscriptionType[0]!.toUpperCase()}${s.subscriptionType.slice(1)}` : "Signed in";
}

export function usageText(u: Usage | null): { text: string; title: string } | null {
  if (!u) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return { text: `${k(tokensIn(u))} in · ${k(u.outputTokens)} out · counts toward your Claude plan`, title: u.costUsd === null ? "" : `API-equivalent cost: $${u.costUsd.toFixed(3)}` };
}

// one refetch at a time; events arriving meanwhile ask for one more when it lands
let opening: Promise<void> | null = null, again = false;
// messages whose `end` this tab has seen (a send's reply can come after its message already ended)
const ended = new Set<string>();
// events that could not be folded yet, replayed after the refetch they asked for (bounded: a stream never floods memory)
let held: ChatWire[] = [];
const HELD_MAX = 5000;

export const useChat = create<{
  status: ChatStatusInfo | null; conversations: ConversationInfo[]; conversationId: string | null; messages: ChatMessage[];
  busy: boolean; think: boolean; omit: ViewKey[]; sendError: string | null;
  /** why the status could not be read (the tab shows it with a Retry instead of spinning) */
  statusError: string | null;
  loadStatus(refresh?: boolean): Promise<void>; loadConversations(): Promise<void>; open(id: string): Promise<void>; newChat(): void;
  send(text: string, mentions: Mention[]): Promise<boolean>; stop(): Promise<void>; onEvent(w: ChatWire): void;
  /** Re-read the status (busy or not) and the open conversation: after the event stream reconnects, or a Stop that found nothing running. */
  resync(): Promise<void>;
  setThink(b: boolean): void; toggleOmit(k: ViewKey): void;
}>((set, get) => ({
  status: null, conversations: [], conversationId: null, messages: [], busy: false, think: false, omit: [], sendError: null, statusError: null,
  async loadStatus(refresh = false) {
    try { const s = await api.chatStatus(refresh); set({ status: s, busy: !!s.busy, statusError: null }); }
    catch (e) { set({ statusError: (e as Error).message }); }
  },
  async loadConversations() { try { set({ conversations: (await api.chatConversations()).conversations }); } catch { /* the list refreshes on the next message */ } },
  async open(id) {
    const r = await api.chatConversation(id);
    // a snapshot fetched before events that have since been folded must not roll those back
    const have = get().conversationId === id ? get().messages : [];
    set({ conversationId: id, messages: r.messages.map((m) => mergeSnapshot(have.find((x) => x.id === m.id), m)) });
  },
  newChat() { set({ conversationId: null, messages: [], sendError: null }); },
  async send(text, mentions) {
    set({ sendError: null });
    try {
      const r = await api.chatSend({ conversationId: get().conversationId, text, think: get().think, omit: get().omit, mentions });
      // Think harder and removed chips are for one message
      set({ busy: busyAfterSend(undefined, ended.has(r.messageId)), omit: [], think: false, conversationId: r.conversationId });
      const settle = () => set({ busy: busyAfterSend(get().messages.find((m) => m.id === r.messageId), ended.has(r.messageId)) });
      // the message is sent whatever happens next: a failed refetch is retried, never reported as a failed send
      await get().open(r.conversationId).then(settle, () => setTimeout(() => void get().open(r.conversationId).then(settle, () => void get().loadStatus()), 1500));
      void get().loadConversations();
      return true;
    } catch (e) { set({ sendError: (e as Error).message }); return false; }
  },
  async stop() {
    try { if (!(await api.chatStop()).stopped) await get().resync(); } // nothing was running: this tab missed the end
    catch (e) { useStore.getState().toast("error", (e as Error).message); }
  },
  async resync() {
    await get().loadStatus();
    const id = get().conversationId;
    if (id) await get().open(id).catch(() => undefined);
    void get().loadConversations();
  },
  onEvent(w) {
    if (w.ev.k === "end") { ended.add(w.messageId); set({ busy: false }); void get().loadConversations(); }
    else if (!get().busy) set({ busy: true }); // a message sent from another tab
    const next = applyWire(get().messages, get().conversationId, w);
    if (next !== null) { if (next !== get().messages) set({ messages: next }); return; }
    held.push(w);
    if (held.length > HELD_MAX) held = held.slice(-HELD_MAX);
    if (opening) { again = true; return; }
    const id = w.conversationId;
    const refetch = (): void => {
      again = false;
      opening = get().open(id).catch(() => undefined).then(() => {
        const r = replayWires(get().messages, get().conversationId, held);
        held = r.rest;
        if (r.messages !== get().messages) set({ messages: r.messages });
      }).finally(() => { opening = null; if (again && held.length) refetch(); });
    };
    refetch();
  },
  setThink(b) { set({ think: b }); },
  toggleOmit(k) { const o = get().omit; set({ omit: o.includes(k) ? o.filter((x) => x !== k) : [...o, k] }); },
}));
