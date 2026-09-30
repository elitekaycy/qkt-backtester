// News derived from component state (e.g. "qkt rejected N orders" for the run on screen), shown once per occurrence.
import { useEffect } from "react";
import { notify, type Notice } from "./notify.js";

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

