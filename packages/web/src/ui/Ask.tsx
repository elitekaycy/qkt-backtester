import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Modal } from "./Modal.js";

/**
 * The studio's own question dialogs, in place of the browser's prompt() and confirm(): themed, keyboard-first (Enter
 * answers, Escape cancels), validation shown inline instead of a silent no-op, and awaitable from anywhere:
 *   const name = await askText({ title: "New strategy", label: "Name", initial: "my_strategy" });   // null = cancelled
 *   if (await askConfirm({ title: "Delete x?", danger: true, confirmLabel: "Delete" })) ...
 *   const picked = await askPick({ title: "Strategies", options: ["a.qkt", "b.qkt"], initial: ["a.qkt"] });
 */
type Q =
  | { kind: "text"; title: string; label: string; initial?: string; hint?: string; confirmLabel?: string; validate?(v: string): string | null; done(v: string | null): void }
  | { kind: "confirm"; title: string; message?: string; danger?: boolean; confirmLabel?: string; done(v: boolean): void }
  | { kind: "pick"; title: string; label?: string; options: string[]; initial?: string[]; confirmLabel?: string; done(v: string[] | null): void };

const useAsk = create<{ q: Q | null }>(() => ({ q: null }));
const show = (q: Q) => { useAsk.getState().q?.done(null as never); useAsk.setState({ q }); };

export const askText = (o: Omit<Extract<Q, { kind: "text" }>, "kind" | "done">) => new Promise<string | null>((done) => show({ kind: "text", ...o, done }));
export const askConfirm = (o: Omit<Extract<Q, { kind: "confirm" }>, "kind" | "done">) => new Promise<boolean>((done) => show({ kind: "confirm", ...o, done: (v) => done(!!v) }));
export const askPick = (o: Omit<Extract<Q, { kind: "pick" }>, "kind" | "done">) => new Promise<string[] | null>((done) => show({ kind: "pick", ...o, done }));

/** Mounted once, at the root of the app. */
export function AskHost() {
  const q = useAsk((s) => s.q);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setErr(null);
    // the suggested text starts selected, as in the browser's prompt: typing replaces it (the Modal focuses at 30 ms)
    if (q?.kind === "text") { setText(q.initial ?? ""); const t = setTimeout(() => { input.current?.focus(); input.current?.select(); }, 60); return () => clearTimeout(t); }
    if (q?.kind === "pick") setPicked(q.initial ?? []);
  }, [q]);
  if (!q) return null;
  const close = (v: unknown) => { useAsk.setState({ q: null }); (q.done as (x: unknown) => void)(v); };
  const cancel = () => close(q.kind === "confirm" ? false : null);
  const ok = () => {
    if (q.kind === "text") {
      const v = text.trim();
      const e = !v ? "Enter a name." : q.validate?.(v) ?? null;
      if (e) { setErr(e); return; }
      close(v);
    } else if (q.kind === "pick") {
      if (!picked.length) { setErr("Tick at least one."); return; }
      close(picked);
    } else close(true);
  };
  const label = q.confirmLabel ?? (q.kind === "confirm" ? "OK" : "Create");
  return (
    <Modal open onClose={cancel} title={q.title} width={q.kind === "pick" ? 460 : 420}
      footer={<>
        <button className="btn" onClick={cancel}>Cancel</button>
        <button className={`btn ${q.kind === "confirm" && q.danger ? "danger" : "primary"}`} data-autofocus={q.kind === "confirm" ? true : undefined} onClick={ok}>{label}</button>
      </>}>
      <form className="settings-sec" onSubmit={(e) => { e.preventDefault(); ok(); }}>
        {q.kind === "confirm" && q.message && <p style={{ margin: 0 }}>{q.message}</p>}
        {q.kind === "text" && (
          <div className="field">
            <label htmlFor="ask-text">{q.label}</label>
            <input id="ask-text" ref={input} className="input mono" value={text} autoComplete="off" spellCheck={false} aria-invalid={!!err} aria-describedby={err ? "ask-err" : q.hint ? "ask-hint" : undefined}
              onChange={(e) => { setText(e.target.value); setErr(null); }} onFocus={(e) => e.currentTarget.select()} />
            {q.hint && !err && <div id="ask-hint" className="hint">{q.hint}</div>}
          </div>
        )}
        {q.kind === "pick" && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            {q.label && <legend className="hint" style={{ marginBottom: 6 }}>{q.label}</legend>}
            <div style={{ maxHeight: 280, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {q.options.map((o) => (
                <label key={o} className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={picked.includes(o)} onChange={(e) => { setErr(null); setPicked((p) => (e.target.checked ? [...p, o] : p.filter((x) => x !== o))); }} />
                  <span className="mono">{o}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {err && <div id="ask-err" className="banner bad" role="alert"><span>{err}</span></div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
