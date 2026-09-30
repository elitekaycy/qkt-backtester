// packages/web/src/chat/ChatHeader.tsx
import { SplitChip } from "../preview/SplitChip.js";
import { Plus } from "../ui/icons.js";
import { LONG_CHAT, planText, useChat } from "./state.js";

/** New chat, past chats, the split chip, and whose plan the chat runs on. */
export function ChatHeader() {
  const convs = useChat((s) => s.conversations), id = useChat((s) => s.conversationId), status = useChat((s) => s.status), busy = useChat((s) => s.busy), n = useChat((s) => s.messages.length);
  const chat = () => useChat.getState();
  return (
    <>
      <div className="chat-head">
        <button className="btn sm" disabled={busy} onClick={() => chat().newChat()}><Plus size={14} />New chat</button>
        <select className="select sm" aria-label="Past chats" value={id ?? ""} disabled={busy} onChange={(e) => (e.target.value ? void chat().open(e.target.value) : chat().newChat())}>
          <option value="">{id ? "New chat" : "Past chats…"}</option>
          {convs.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <SplitChip />
        <span className="grow" />
        <span className="muted chat-plan" title={status?.version ? `Claude Code ${status.version}` : undefined}>{planText(status)}</span>
      </div>
      {n >= LONG_CHAT && (
        <div className="banner info chat-long">
          This chat is long, and every message re-reads all of it.
          <button className="btn sm" disabled={busy} onClick={() => chat().newChat()}>Start a new chat</button>
          <span className="muted">What you are looking at carries over.</span>
        </div>
      )}
    </>
  );
}
