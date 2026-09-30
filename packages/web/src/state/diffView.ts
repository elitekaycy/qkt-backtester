// Which view the editor area shows for a variant: the one switch the variant bar, the chat's variant card and the diff's
// own header all use. Adopt and Discard stay useAgent's; this store only says "the diff of variant X is open".
import { create } from "zustand";
import { diffShouldClose, type DiffLayout, type DiffMode } from "../editor/variantDiff.js";
import { useAgent, type VariantInfo } from "./agent.js";
import { useStore } from "./store.js";

const MODE_KEY = "qkt-studio-diff-mode";
function loadMode(): DiffMode {
  try { const m = localStorage.getItem(MODE_KEY); return m === "split" || m === "inline" ? m : "auto"; } catch { return "auto"; }
}

export const useDiffView = create<{
  /** The variant whose diff is open, or null (the normal editor). */
  diffOf: string | null;
  /** Inline vs side-by-side: "auto" follows the pane's width until the user picks one. */
  mode: DiffMode;
  /** Show the diff of `v`: opens its base file's tab and puts the variant on screen first when it is not already. */
  open(v: VariantInfo): Promise<void>;
  close(): void;
  /** The variant bar's Diff button: open, or back to the normal editor when this variant's diff is already open. */
  toggle(v: VariantInfo): Promise<void>;
  setMode(m: DiffLayout): void;
}>((set, get) => ({
  diffOf: null,
  mode: loadMode(),
  async open(v) {
    await useStore.getState().openFile(v.base);
    if (useAgent.getState().showing?.id !== v.id) await useAgent.getState().show(v);
    // show() may have been overtaken by another variant arriving meanwhile: only open the diff of the one on screen
    if (useAgent.getState().showing?.id === v.id) set({ diffOf: v.id });
  },
  close() { if (get().diffOf !== null) set({ diffOf: null }); },
  async toggle(v) { if (get().diffOf === v.id) get().close(); else await get().open(v); },
  setMode(m) {
    set({ mode: m });
    try { localStorage.setItem(MODE_KEY, m); } catch { /* storage blocked */ }
  },
}));

// Adopt, Discard, Back or another variant taking the chart: the diff belonged to the variant that was showing, so it closes
// and the normal editor returns.
useAgent.subscribe((s) => { if (diffShouldClose(useDiffView.getState().diffOf, s.showing?.id ?? null)) useDiffView.getState().close(); });
