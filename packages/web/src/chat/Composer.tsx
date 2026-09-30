// packages/web/src/chat/Composer.tsx
import { useId, useMemo, useRef, useState } from "react";
import { useAgent } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { Brain, Square, X } from "../ui/icons.js";
import { filterMentions, insertMention, mentionOptions, mentionQuery, mentionsIn, type MentionOption } from "./mentions.js";
import { useChat, viewChips } from "./state.js";

/** What "@" can name right now: config files, the run and trade on screen, strategies, symbols. */
export function useMentionOptions(): MentionOption[] {
  const runId = useStore((s) => s.runId), trip = useStore((s) => s.selectedTrip), tree = useStore((s) => s.tree), scan = useStore((s) => s.scan);
  return useMemo(() => mentionOptions({
    strategies: (tree["strategies"] ?? []).filter((e) => e.type === "file" && e.name.endsWith(".qkt")).map((e) => e.path),
    runId, selectedTrade: trip?.id ?? null, symbols: (scan?.symbols ?? []).map((s) => s.symbol).slice(0, 40),
  }), [tree, runId, trip, scan]);
}

/** Message box: context chips (removable for one message), @ mentions, Think harder, Send / Stop. Enter sends, Shift+Enter is a new line. */
export function Composer({ disabled = false }: { disabled?: boolean }) {
  const [text, setText] = useState(""), [caret, setCaret] = useState(0), [active, setActive] = useState(0), [closedAt, setClosedAt] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null), ids = useId();
  const busy = useChat((s) => s.busy), think = useChat((s) => s.think), omit = useChat((s) => s.omit), err = useChat((s) => s.sendError);
  const activePath = useStore((s) => s.activePath), runId = useStore((s) => s.runId), trip = useStore((s) => s.selectedTrip), focus = useStore((s) => s.focus);
  const showing = useAgent((s) => s.showing), split = useAgent((s) => s.split);
  const options = useMentionOptions();
  const q = mentionQuery(text, caret);
  const picks = q && closedAt !== q.start ? filterMentions(options, q.query) : [];
  const chips = viewChips({ activePath, runId, visible: !!focus, selectedTrade: trip?.id ?? null, variantLabel: showing?.label ?? null, splitText: split?.text ?? null });

  const choose = (o: MentionOption) => {
    if (!q) return;
    const r = insertMention(text, q.start, caret, o.label);
    setText(r.text); setCaret(r.caret);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(r.caret, r.caret); });
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    if (await useChat.getState().send(t, mentionsIn(t, options))) { setText(""); setCaret(0); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // an input method is composing: its keys are not ours
    if (picks.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % picks.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + picks.length) % picks.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(picks[Math.min(active, picks.length - 1)]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setClosedAt(q!.start); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } // while an answer runs this does nothing: the hint says so
  };

  return (
    <div className="chat-composer">
      {chips.length > 0 && (
        <div className="chat-chips" aria-label="Sent with this message">
          {chips.map((c) => {
            const off = omit.includes(c.key);
            return <button key={c.key} className={`chip${off ? " off" : ""}`} aria-pressed={!off} title={off ? "Left out of this message: click to include" : "Sent with this message: click to leave out"} onClick={() => useChat.getState().toggleOmit(c.key)}>{c.label}{!off && <X size={12} />}</button>;
          })}
        </div>
      )}
      {picks.length > 0 && (
        <ul className="chat-picker" id={`${ids}-list`} role="listbox" aria-label="Mention">
          {picks.map((o, i) => <li key={o.label} id={`${ids}-opt-${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); choose(o); }}><b>{o.label}</b> <span className="muted">{o.hint}</span></li>)}
        </ul>
      )}
      <textarea ref={ta} className="input chat-input" rows={2} value={text} aria-label="Message" disabled={disabled}
        role="combobox" aria-autocomplete="list" aria-expanded={picks.length > 0} aria-controls={picks.length ? `${ids}-list` : undefined}
        aria-activedescendant={picks.length ? `${ids}-opt-${Math.min(active, picks.length - 1)}` : undefined}
        placeholder="Say what to change, or ask about what you see (@ to name a file, run or trade)"
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setActive(0); setClosedAt(null); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={onKey} />
      {busy && <div className="muted chat-wait" role="status">Working… Send is available when this answer ends (or press Stop).</div>}
      <div className="chat-actions">
        <button className={`btn sm${think ? " primary" : ""}`} aria-pressed={think} disabled={disabled} title="Use Sonnet instead of Haiku for this message (slower, uses more of your plan)" onClick={() => useChat.getState().setThink(!think)}><Brain size={14} />Think harder</button>
        {err && <span className="chat-err" role="alert">{err}</span>}
        <span className="grow" />
        {busy && <button className="btn danger" aria-label="Stop" title="Stop this answer" onClick={() => void useChat.getState().stop()}><Square size={14} fill="currentColor" />Stop</button>}
        <button className="btn primary" disabled={disabled || busy || !text.trim()} onClick={() => void send()}>Send</button>
      </div>
    </div>
  );
}
