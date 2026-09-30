// packages/web/src/chat/Thread.tsx
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { toThreadMessage } from "./convert.js";
import { useMentionOptions } from "./Composer.js";
import { mentionsIn } from "./mentions.js";
import { DataPart, MarkdownText, ToolStep, UserText } from "./parts.js";
import { useChat } from "./state.js";

const textOf = (m: AppendMessage) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
function UserMessage() { return <MessagePrimitive.Root className="msg user"><MessagePrimitive.Parts components={{ Text: UserText }} /></MessagePrimitive.Root>; }
function AssistantMessage() {
  return <MessagePrimitive.Root className="msg assistant"><MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolStep }, data: { Fallback: DataPart } }} /></MessagePrimitive.Root>;
}
function EmptyHint() {
  return (
    <div className="chat-empty muted">
      <p>Say what to change or ask about what you see, in plain English:</p>
      <ul><li>make the stop-loss 2 percent and let's see</li><li>skip Fridays</li><li>why did this trade lose?</li><li>make the test part the last 2 months</li></ul>
      <p>The open file, the run on screen and the selected trade go with each message (the chips below). Type @ to name something else.</p>
    </div>
  );
}

/** The conversation, rendered by assistant-ui's unstyled primitives; the messages come from our store (the studio's stream). */
export function Thread() {
  const messages = useChat((s) => s.messages), busy = useChat((s) => s.busy), options = useMentionOptions();
  const runtime = useExternalStoreRuntime({
    messages, isRunning: busy, convertMessage: toThreadMessage,
    onNew: async (m: AppendMessage) => { const t = textOf(m); await useChat.getState().send(t, mentionsIn(t, options)); },
    onCancel: async () => { await useChat.getState().stop(); },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport">
          {messages.length === 0 && <EmptyHint />}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
