// packages/web/src/chat/SetupCard.tsx
import { useState } from "react";
import { Copy } from "../ui/icons.js";
import { useChat } from "./state.js";

/** Claude Code missing or signed out: the one-time sign-in, done in Anthropic's own flow inside the container. */
export function SetupCard() {
  const s = useChat((x) => x.status)!;
  const [checking, setChecking] = useState(false);
  // the sign-in must be written as the user the studio runs as; never guess a uid the server did not report
  const cmd = `docker exec -it ${typeof s.uid === "number" ? `-u ${s.uid} ` : ""}qkt-backtester claude auth login`;
  if (!s.installed) return (
    <div className="card pad chat-setup"><b>Claude Code is not in this image</b>
      <p className="muted">The chat runs the Claude Code CLI inside the studio's container. Use the qkt-backtester image 0.3.0 or newer.</p></div>
  );
  return (
    <div className="card pad chat-setup">
      <b>Sign in to Claude Code (once)</b>
      <p>The chat runs Claude Code on your own Claude plan. Sign in with Anthropic's own flow, inside the container, from a terminal on the machine that runs it:</p>
      <pre className="mono chat-cmd">{cmd}</pre>
      {typeof s.uid !== "number" && <p className="muted">(use -u with the uid that owns the workspace: run <code>id -u</code> in the container)</p>}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(cmd)}><Copy size={14} />Copy</button>
        <button className="btn sm primary" disabled={checking} onClick={async () => { setChecking(true); await useChat.getState().loadStatus(true); setChecking(false); }}>{checking ? "Checking…" : "Check again"}</button>
      </div>
      <p className="muted">If your container has another name, use that name. The sign-in stays in Claude Code's own folder in the container (<code>/home/studio/.claude</code>); the studio never sees, stores or forwards it.{s.error ? ` (${s.error})` : ""}</p>
    </div>
  );
}
