// The one place notifications go through. Everything that tells the user something transient (a save, a failure, news
// about a run) calls `notify`. No React and no styles here, so the store can use it: news derived from component state
// goes through useNotice (useNotice.ts), and the host that draws the toasts is NotifyHost.tsx, mounted once in the shell.
// Built on sonner; swapping the library means changing these three files only.
import { toast, type ExternalToast } from "sonner";

export type NotifyKind = "ok" | "info" | "warn" | "error";
export interface NotifyAction { label: string; onClick(): void }
export interface NotifyOpts {
  /** Stable id: a second notify with the same id updates the toast on screen instead of stacking a copy. Defaults to kind + text. */
  id?: string;
  description?: string;
  action?: NotifyAction;
  /** Milliseconds on screen; Infinity keeps it until closed. Defaults per kind (DURATION). */
  duration?: number;
}

/** How long each kind stays up: errors and warnings are worth reading, so they stay longer. */
export const DURATION: Record<NotifyKind, number> = { ok: 4000, info: 5000, warn: 8000, error: 12000 };
/** At most this many are drawn stacked; hovering the stack expands it. */
export const MAX_VISIBLE = 4;

/** The id a toast gets when the caller gives none: the same message repeated is one toast, not a pile. */
export const notifyId = (kind: NotifyKind, text: string, id?: string): string => id ?? `${kind}:${text}`;

const show = { ok: toast.success, info: toast.info, warn: toast.warning, error: toast.error } as const;

function send(kind: NotifyKind, text: string, opts: NotifyOpts = {}): string {
  const id = notifyId(kind, text, opts.id);
  const data: ExternalToast = { id, duration: opts.duration ?? DURATION[kind] };
  if (opts.description) data.description = opts.description;
  if (opts.action) { const a = opts.action; data.action = { label: a.label, onClick: () => a.onClick() }; }
  show[kind](text, data);
  return id;
}

export const notify = {
  ok: (text: string, opts?: NotifyOpts) => send("ok", text, opts),
  info: (text: string, opts?: NotifyOpts) => send("info", text, opts),
  warn: (text: string, opts?: NotifyOpts) => send("warn", text, opts),
  error: (text: string, opts?: NotifyOpts) => send("error", text, opts),
  /** Close one toast by id, or all of them. */
  dismiss: (id?: string) => { toast.dismiss(id); },
};

/** A piece of news derived from state. `key` names the occurrence (e.g. one per run id): it fires once per key. */
export interface Notice { key: string; kind: NotifyKind; text: string; description?: string; action?: NotifyAction }

/** Remembers the occurrences already shown, so a remount or a state flip-flop never repeats one. Bounded, oldest forgotten first. */
export function onceGate(max = 200): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > max) seen.delete(seen.values().next().value!);
    return true;
  };
}

