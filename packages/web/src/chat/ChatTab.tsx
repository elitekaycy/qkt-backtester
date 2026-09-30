// packages/web/src/chat/ChatTab.tsx
import { useEffect } from "react";
import { ChatHeader } from "./ChatHeader.js";
import { Composer } from "./Composer.js";
import { SetupCard } from "./SetupCard.js";
import { Thread } from "./Thread.js";
import { useChat } from "./state.js";
import "./chat.css";

/** The Chat dock tab. Lazy-loaded: the chat UI library and markdown load only when the tab is first opened. */
export function ChatTab() {
  const status = useChat((s) => s.status), statusError = useChat((s) => s.statusError);
  useEffect(() => { void useChat.getState().loadStatus(); void useChat.getState().loadConversations(); }, []);
  if (!status && statusError) return (
    <div className="empty" role="alert">
      <span>Could not check Claude Code: {statusError}</span>
      <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void useChat.getState().loadStatus()}>Retry</button>
    </div>
  );
  if (!status) return <div className="empty"><span className="spin" />Checking Claude Code…</div>;
  if (!status.installed || !status.loggedIn) return <SetupCard />;
  return (
    <div className="chat">
      <ChatHeader />
      {!status.available && <div className="banner bad chat-down" role="alert">The chat is unavailable: {status.reason ?? "its store could not be opened"}.</div>}
      <Thread />
      <Composer disabled={!status.available} />
    </div>
  );
}
