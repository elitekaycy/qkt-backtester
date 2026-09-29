import { create } from "zustand";
import { api, withToken } from "../api/client.js";
import { useStore } from "./store.js";

export interface VariantInfo { id: string; label: string; base: string; runId: string | null; baseRunId: string | null; diff: string; notes: string[]; created: string }
export interface ProposalInfo { id: string; kind: "file" | "job"; title: string; path?: string; diff?: string; status: string; created: string }
type Split = Record<string, unknown>;

/** Pure: the store's view -> the body of POST /api/view. */
export function viewReport(s: { activePath: string | null; cursorLine: number | null; selection: string; runId: string | null; cfg: { from: string; to: string; tier: string }; visible: { from: number; to: number } | null; selectedTripId: number | null; variantId: string | null }) {
  return {
    openFile: s.activePath, cursorLine: s.cursorLine, selection: s.selection || null, runId: s.runId,
    runWindow: { from: s.cfg.from, to: s.cfg.to, tier: s.cfg.tier },
    visibleFrom: s.visible?.from ?? null, visibleTo: s.visible?.to ?? null, selectedTrade: s.selectedTripId, variantId: s.variantId,
  };
}

export const useAgent = create<{
  variants: VariantInfo[]; showing: VariantInfo | null; split: { split: Split; text: string } | null; proposals: ProposalInfo[];
  start(): void; refresh(): Promise<void>; show(v: VariantInfo): Promise<void>; back(): Promise<void>; discard(id: string): Promise<void>; adopt(id: string): Promise<void>;
}>((set, get) => ({
  variants: [], showing: null, split: null, proposals: [],
  start() {
    void get().refresh();
    const es = new EventSource(withToken("/api/events"));
    es.addEventListener("variant", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as { variantId: string };
      void get().refresh().then(() => { const v = get().variants.find((x) => x.id === e.variantId); if (v) void get().show(v); });
    });
    es.addEventListener("proposal", () => void get().refresh());
    es.addEventListener("split", () => void get().refresh());
    es.addEventListener("open", (m) => void useStore.getState().openFile((JSON.parse((m as MessageEvent).data) as { path: string }).path));
    es.addEventListener("run", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as { runId: string };
      void useStore.getState().refreshRuns();
      if (useStore.getState().running === false) void useStore.getState().selectRun(e.runId);
    });
  },
  async refresh() {
    const [v, p, s] = await Promise.all([api.variants(), api.proposals(), api.split()]);
    set({ variants: v.variants, proposals: p.proposals, split: s });
  },
  async show(v) { set({ showing: v }); if (v.runId) await useStore.getState().selectRun(v.runId); },
  async back() { const v = get().showing; set({ showing: null }); if (v?.baseRunId) await useStore.getState().selectRun(v.baseRunId); },
  async discard(id) { await api.discardVariant(id); if (get().showing?.id === id) await get().back(); await get().refresh(); },
  /** Adopt = the variant's text becomes the base file, as ONE edit in the editor (so Ctrl+Z undoes it), then saved. */
  async adopt(id) {
    const v = await api.variant(id);
    if (!v.source) throw new Error("the variant file is gone");
    const store = useStore.getState();
    await store.openFile(v.base);
    const ed = (window as unknown as { __qktEditor?: { getModel(): { getFullModelRange(): unknown; uri: { path: string } } | null; executeEdits(src: string, edits: Array<{ range: unknown; text: string }>): void; pushUndoStop(): void } }).__qktEditor;
    const model = ed?.getModel();
    if (ed && model) { ed.pushUndoStop(); ed.executeEdits("adopt", [{ range: model.getFullModelRange(), text: v.source }]); ed.pushUndoStop(); }
    else store.setContent(v.base, v.source);
    await store.saveFile(v.base);
    set({ showing: null });
    await store.startRun();
  },
}));

/** Debounced "what is the user looking at" report to POST /api/view; called from the store subscriber and from
 *  editor cursor moves, which do not touch the store. */
let sendTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleViewReport(): void {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    const s = useStore.getState();
    const ed = (window as unknown as { __qktEditor?: { getPosition(): { lineNumber: number } | null; getSelection(): unknown; getModel(): { getValueInRange(r: unknown): string } | null } }).__qktEditor;
    const sel = ed?.getSelection(), model = ed?.getModel();
    void api.reportView(viewReport({
      activePath: s.activePath, cursorLine: ed?.getPosition()?.lineNumber ?? null, selection: sel && model ? model.getValueInRange(sel) : "",
      runId: s.runId, cfg: s.cfg, visible: s.focus ? { from: s.focus.from, to: s.focus.to } : null,
      selectedTripId: s.selectedTrip?.id ?? null, variantId: useAgent.getState().showing?.id ?? null,
    })).catch(() => undefined);
  }, 400);
}
