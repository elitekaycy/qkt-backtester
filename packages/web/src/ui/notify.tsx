// The one place notifications go through. Everything that tells the user something transient (a save, a failure, news
// about a run) calls `notify`; `<NotifyHost/>` is mounted once in the shell. Built on sonner, styled with the studio's
// own tokens (notify.css), so swapping the library later means changing this file only.
import { useEffect } from "react";
import { toast, Toaster, type ExternalToast } from "sonner";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "./icons.js";
import "./notify.css";

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

/**
 * Shows `notice` as the toast `id` while it is non-null and takes it down when it goes null. It acts only when the notice's
 * key changes, never on a plain re-render; with `once`, a key already shown stays quiet even if it comes back.
 */
export function useNotice(id: string, notice: Notice | null, once?: (key: string) => boolean): void {
  const key = notice?.key ?? null;
  useEffect(() => {
    if (!notice) { notify.dismiss(id); return; }
    if (once && !once(notice.key)) return;
    notify[notice.kind](notice.text, { id, description: notice.description, action: notice.action });
    // deps: the key is the occurrence; the notice's other fields follow it
  }, [id, key]);
}

const ICONS = {
  success: <CircleCheck size={16} aria-hidden="true" />,
  info: <Info size={16} aria-hidden="true" />,
  warning: <TriangleAlert size={16} aria-hidden="true" />,
  error: <CircleX size={16} aria-hidden="true" />,
  close: <X size={12} aria-hidden="true" />,
};

const CLASSES = {
  toast: "qn", title: "qn-title", description: "qn-desc", content: "qn-content", icon: "qn-icon",
  actionButton: "qn-action", closeButton: "qn-close",
  success: "qn-ok", info: "qn-info", warning: "qn-warn", error: "qn-error",
};

/** Mount once. Bottom-right above the status bar; every toast closable; they stack and fan out on hover. */
export function NotifyHost({ theme }: { theme: "dark" | "light" }) {
  return (
    <Toaster
      className="qn-host"
      position="bottom-right"
      theme={theme}
      closeButton
      visibleToasts={MAX_VISIBLE}
      gap={8}
      style={{ "--width": "380px", zIndex: "var(--z-toast)" } as React.CSSProperties}
      offset={{ bottom: "calc(var(--status-h) + 12px)", right: 16 }}
      mobileOffset={{ bottom: "calc(var(--status-h) + 8px)" }}
      icons={ICONS}
      containerAriaLabel="Notifications"
      toastOptions={{ unstyled: true, classNames: CLASSES, closeButtonAriaLabel: "Close notification" }}
    />
  );
}
