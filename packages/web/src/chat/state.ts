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

/** Pure: one streamed event into the open conversation. Another conversation: unchanged; an unknown message: null (refetch). */
export function applyWire(messages: ChatMessage[], conversationId: string | null, w: ChatWire): ChatMessage[] | null {
  if (w.conversationId !== conversationId) return messages;
  const i = messages.findIndex((m) => m.id === w.messageId);
  if (i < 0) return null;
  const cur = messages[i]!;
  if (w.seq <= (cur.evSeq ?? 0)) return messages; // already folded: a duplicate, or covered by the snapshot
  const next = messages.slice();
  next[i] = { ...foldEvent(cur, w.ev), evSeq: w.seq };
  return next;
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

export const useChat = create<{
  status: ChatStatusInfo | null; conversations: ConversationInfo[]; conversationId: string | null; messages: ChatMessage[];
  busy: boolean; think: boolean; omit: ViewKey[]; sendError: string | null;
  loadStatus(refresh?: boolean): Promise<void>; loadConversations(): Promise<void>; open(id: string): Promise<void>; newChat(): void;
  send(text: string, mentions: Mention[]): Promise<boolean>; stop(): Promise<void>; onEvent(w: ChatWire): void;
  setThink(b: boolean): void; toggleOmit(k: ViewKey): void;
}>((set, get) => ({
  status: null, conversations: [], conversationId: null, messages: [], busy: false, think: false, omit: [], sendError: null,
  async loadStatus(refresh = false) {
    try { const s = await api.chatStatus(refresh); set({ status: s, busy: !!s.busy }); }
    catch (e) { set({ sendError: (e as Error).message }); }
  },
  async loadConversations() { try { set({ conversations: (await api.chatConversations()).conversations }); } catch { /* the list refreshes on the next message */ } },
  async open(id) {
    const r = await api.chatConversation(id);
    // a snapshot fetched before events that have since been folded must not roll those back
    const have = get().conversationId === id ? get().messages : [];
    set({ conversationId: id, messages: r.messages.map((m) => { const cur = have.find((x) => x.id === m.id); return cur && (cur.evSeq ?? 0) > (m.evSeq ?? 0) ? cur : m; }) });
  },
  newChat() { set({ conversationId: null, messages: [], sendError: null }); },
  async send(text, mentions) {
    set({ sendError: null });
    try {
      const r = await api.chatSend({ conversationId: get().conversationId, text, think: get().think, omit: get().omit, mentions });
      set({ busy: true, omit: [], think: false, conversationId: r.conversationId }); // Think harder and removed chips are for one message
      // the message is sent whatever happens next: a failed refetch is retried, never reported as a failed send
      await get().open(r.conversationId).catch(() => setTimeout(() => void get().open(r.conversationId).catch(() => undefined), 1500));
      void get().loadConversations();
      return true;
    } catch (e) { set({ sendError: (e as Error).message }); return false; }
  },
  async stop() { try { await api.chatStop(); } catch (e) { useStore.getState().toast("error", (e as Error).message); } },
  onEvent(w) {
    if (w.ev.k === "end") { set({ busy: false }); void get().loadConversations(); }
    else if (!get().busy) set({ busy: true }); // a message sent from another tab
    const next = applyWire(get().messages, get().conversationId, w);
    if (next === null) {
      if (opening) { again = true; return; }
      const id = w.conversationId;
      opening = get().open(id).catch(() => undefined).finally(() => { opening = null; if (again) { again = false; void get().open(id); } });
      return;
    }
    if (next !== get().messages) set({ messages: next });
  },
  setThink(b) { set({ think: b }); },
  toggleOmit(k) { const o = get().omit; set({ omit: o.includes(k) ? o.filter((x) => x !== k) : [...o, k] }); },
}));
