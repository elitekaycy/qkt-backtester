// packages/web/src/chat/parts.tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DataMessagePartProps, TextMessagePartProps, ToolCallMessagePartProps } from "@assistant-ui/react";
import { CircleCheck, CircleX, Info } from "../ui/icons.js";
import { stepLabel, type FooterData } from "./convert.js";
import { usageText } from "./state.js";

/** The reply's text: markdown (no raw HTML), links open outside the studio. */
export function MarkdownText({ text }: TextMessagePartProps) {
  return <div className="chat-md"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{text}</Markdown></div>;
}
export function UserText({ text }: TextMessagePartProps) { return <div className="chat-user-text">{text}</div>; }

/** One tool call as a compact step ("ran backtest · 3.2 s"), expandable to its arguments and result. */
export function ToolStep({ toolName, args, result, isError, artifact }: ToolCallMessagePartProps) {
  const ms = (artifact as { ms?: number | null } | undefined)?.ms ?? null, done = result !== undefined;
  return (
    <details className={`chat-step${isError ? " bad" : ""}`}>
      <summary>
        {done ? (isError ? <CircleX size={13} /> : <CircleCheck size={13} />) : <span className="spin" />}
        <span>{stepLabel(toolName)}</span>
        {ms !== null && <span className="muted num">· {(ms / 1000).toFixed(1)} s</span>}
      </summary>
      <pre className="mono chat-json">{JSON.stringify(args, null, 1)}</pre>
      {done && <pre className="mono chat-json">{String(result)}</pre>}
    </details>
  );
}

function Footer({ f }: { f: FooterData }) {
  const u = usageText(f.usage);
  const msg = f.status === "stopped" ? "Stopped." : f.status === "interrupted" ? "Interrupted by a studio restart. Send again to continue." : f.error;
  const planLimit = f.status === "error" && !!msg && /limit/i.test(msg);
  return (
    <div className="chat-foot">
      {f.status !== "done" && msg && <div className={`chat-end ${f.status}`} role="status">{msg}{planLimit && <span className="muted"> Try again later, or give Claude Code an Anthropic API key (see docs/production.md).</span>}</div>}
      {u && <div className="muted chat-usage" title={u.title}>{f.model === "sonnet" ? "Think harder · " : ""}{u.text}</div>}
    </div>
  );
}

/** Notices (retries, plan limit, a lost session) and the footer (how it ended, tokens). */
export function DataPart({ name, data }: DataMessagePartProps) {
  if (name === "notice") return <div className="chat-notice muted"><Info size={13} />{(data as { text: string }).text}</div>;
  if (name === "footer") return <Footer f={data as FooterData} />;
  return null;
}
