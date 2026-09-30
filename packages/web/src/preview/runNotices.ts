// News about the run on screen, as toasts rather than banners that push the chart down. Pure builders: the pane feeds
// them state and ui/notify's useNotice shows each occurrence once.
import type { RunMeta } from "../api/client.js";
import type { Notice } from "../ui/notify.js";

export const REJECTIONS_TOAST = "run-rejections";
export const AUTO_SKIPPED_TOAST = "auto-skipped";

/** "qkt rejected N orders" for the run on screen; null while the results are stale (a newer run is on its way) or clean. */
export function rejectionNotice(input: { runId: string | null | undefined; rejections: RunMeta["rejections"] | null | undefined; fills: number | null | undefined; stale: boolean }): Notice | null {
  const rj = input.rejections;
  if (!input.runId || input.stale || !rj || rj.count <= 0) return null;
  const n = rj.count, top = rj.reasons[0];
  const reasons = rj.reasons.slice(0, 2).map((x) => `${x.count.toLocaleString()} × ${x.label}`).join(", ") + (rj.reasons.length > 2 ? ", …" : "");
  return {
    key: `rejected:${input.runId}`,
    kind: "warn",
    text: `qkt rejected ${n.toLocaleString()} order${n === 1 ? "" : "s"}${input.fills === 0 ? ", so this run made no trades" : ""}`,
    description: [reasons, top?.hint].filter(Boolean).join(reasons.endsWith("…") ? " " : ". "),
  };
}

/** Every reason with an example, for the toast's "Show" dialog: the part a toast has no room for. */
export function rejectionDetail(rejections: RunMeta["rejections"] | null | undefined): string {
  if (!rejections) return "";
  const hint = rejections.reasons.find((x) => x.hint)?.hint;
  return rejections.reasons.map((x) => `${x.count.toLocaleString()} × ${x.label} (e.g. ${x.example})`).join("; ") + (hint ? `. ${hint}` : "");
}

/** A save whose auto-run was skipped because the strategy does not compile; one toast per distinct skip. */
export function autoSkippedNotice(reason: string | null | undefined): Notice | null {
  if (!reason) return null;
  return { key: `skipped:${reason}`, kind: "warn", text: reason, description: "The results shown are from the last version that ran; saving a fix runs it again." };
}
