import type { editor as MonacoEditorNS } from "monaco-editor/editor/editor.api.js";
import { create } from "zustand";
import { textHash } from "@qkt-studio/core/texthash";
import { api, withToken } from "../api/client.js";
import { askConfirm } from "../ui/Ask.js";
import { useChat, type ChatWire } from "../chat/state.js";
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

/** Pure: whether a run finished by an agent tool (the SSE `run` event) should take over the chart in this tab.
 *  Only when it is the strategy currently open here and no variant is being reviewed — a run of some other
 *  strategy, or one started while a variant is showing, must not yank the chart out from under the user. */
export function shouldShowRun(a: { runStrategy: string | null; activePath: string | null; variantShowing: boolean }): boolean {
  return !a.variantShowing && a.runStrategy !== null && a.runStrategy === a.activePath;
}

export type AdoptAction = "saveFailed" | "autoRun" | "startRun";
/** Pure: what adopt() does after saveFile resolves. A failed save (e.g. a 412 conflict) must not be reported as
 *  success or trigger a run. A successful save with autoRun on has already scheduled its own run (the store's
 *  saveFile does this), so calling startRun() again would submit a duplicate. */
export function decideAdoptAction(saved: boolean, autoRun: boolean): AdoptAction {
  if (!saved) return "saveFailed";
  return autoRun ? "autoRun" : "startRun";
}

export type AdoptPlan = "adopt" | "rebase" | "confirm";
/** Pure: how Adopt treats the base file. The variant was made from text whose hash is `baseHash`. If the buffer (and the
 *  saved text) still are that text, the variant replaces it as is. If the user has changed the file since, their newer
 *  text must not be silently lost: the variant's changes are re-applied to it ("rebase") when the variant is a change
 *  list, otherwise the user is asked ("confirm"). */
export function decideAdoptPlan(a: { baseHash: string; current: string; saved: string | null; canRebase: boolean }): AdoptPlan {
  const unchanged = textHash(a.current) === a.baseHash && (a.saved === null || textHash(a.saved) === a.baseHash);
  if (unchanged) return "adopt";
  return a.canRebase ? "rebase" : "confirm";
}

/** Pure: may a finished variant (the SSE `variant` event) take over this tab's chart? Not while the tab follows a live
 *  run of the user's own (its progress and Stop button would vanish); following the shown variant's own runs is fine. */
export function variantMayTakeOver(a: { running: boolean; runId: string | null; showing: { runId: string | null; baseRunId: string | null } | null }): boolean {
  if (!a.running) return true;
  return !!a.showing && a.runId !== null && (a.runId === a.showing.runId || a.runId === a.showing.baseRunId);
}

const TERMINAL = new Set(["done", "failed", "cancelled", "interrupted"]);
export const isTerminalStatus = (status: string | undefined) => !!status && TERMINAL.has(status);
export type SideView = { text: string; final: boolean };
/** Pure: one side (variant or base) of the variant bar. `run` is the run's record, null while it cannot be read yet,
 *  "gone" when the server no longer has it; `net` is its net P&L once its parts are loaded ("none": finished without trades). A failed, cancelled or purged
 *  run is final (the bar stops polling) and says so, instead of "running…" forever. */
export function variantSide(run: { status: string; error?: { message: string } } | null | "gone", net: number | "none" | null, fmt: (n: number) => string): SideView {
  if (run === "gone") return { text: "gone (the run was removed)", final: true };
  if (!run || !isTerminalStatus(run.status)) return { text: "running…", final: false };
  if (run.status === "done") return net === "none" ? { text: "no trades", final: true } : net === null ? { text: "loading…", final: false } : { text: fmt(net), final: true };
  if (run.status === "failed") return { text: `failed: ${run.error?.message ?? "see the run's pipeline"}`, final: true };
  return { text: run.status, final: true };
}

export type ApplyProposalAction = "none" | "reload" | "conflict";
/** Pure: after a file proposal is applied, what an open tab on that file should do. Not open at all -> nothing to
 *  do. Open and clean -> take the new text as the saved state (reloadFromDisk). Open with unsaved edits -> the
 *  edits must never be silently discarded, so the tab is marked in conflict instead, the same state the file-watch
 *  path uses (EditorPane's conflict banner: Reload from disk / Overwrite). */
export function decideApplyProposalAction(file: { content: string; saved: string } | undefined): ApplyProposalAction {
  if (!file) return "none";
  return file.content === file.saved ? "reload" : "conflict";
}

/** Poll monaco's global model registry for the model at `workspace`/`path` (the same URI EditorPane uses), up to
 *  `timeoutMs`. EditorPane creates a file's model asynchronously (its own effect, after `openFiles` changes), so a
 *  freshly-opened file may not have a model yet the instant `openFile()` resolves. */
async function waitForModel(workspace: string, path: string, timeoutMs = 2000): Promise<MonacoEditorNS.ITextModel | null> {
  // dynamic: agent.ts is imported from plain unit tests (no DOM), and monaco.js touches `window` at import time
  const { setupMonaco } = await import("../editor/monaco.js");
  const m = await setupMonaco();
  const uri = m.Uri.parse(`file://${workspace}/${path}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const model = m.editor.getModel(uri);
    if (model) return model;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** One EventSource for the whole tab, kept in module scope so StrictMode's mount/unmount/remount (or a second call
 *  to start()) never leaves a duplicate stream running. */
let es: EventSource | null = null;

export const useAgent = create<{
  variants: VariantInfo[]; showing: VariantInfo | null; split: { split: Split; text: string } | null; proposals: ProposalInfo[];
  /** Opens the SSE stream (closing any previous one first) and returns a stop function for cleanup. */
  start(): () => void;
  refresh(): Promise<void>; show(v: VariantInfo): Promise<void>; back(): Promise<void>; discard(id: string): Promise<void>; adopt(id: string): Promise<void>;
}>((set, get) => ({
  variants: [], showing: null, split: null, proposals: [],
  start() {
    es?.close();
    void get().refresh();
    const src = (es = new EventSource(withToken("/api/events")));
    src.addEventListener("variant", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as { variantId: string };
      void get().refresh().then(() => {
        const v = get().variants.find((x) => x.id === e.variantId);
        const st = useStore.getState();
        // the tab is following the user's own live run: the variant stays in the list, it does not take the chart
        if (v && variantMayTakeOver({ running: st.running, runId: st.runId, showing: get().showing })) void get().show(v);
      });
    });
    src.addEventListener("chat", (m) => useChat.getState().onEvent(JSON.parse((m as MessageEvent).data as string) as ChatWire));
    src.addEventListener("proposal", () => void get().refresh());
    src.addEventListener("split", () => void get().refresh());
    // not "open": that is the EventSource's own connection event; the data guard stays as a second line of defence
    src.addEventListener("open_file", (m) => {
      const data = (m as MessageEvent).data as unknown;
      if (typeof data === "string") void useStore.getState().openFile((JSON.parse(data) as { path: string }).path);
    });
    src.addEventListener("run", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as { runId: string };
      void useStore.getState().refreshRuns();
      if (useStore.getState().running) return; // this tab is following a live run of its own: leave it alone
      void api.run(e.runId).then((run) => {
        if (shouldShowRun({ runStrategy: run.strategy, activePath: useStore.getState().activePath, variantShowing: !!get().showing })) void useStore.getState().selectRun(e.runId);
      }).catch(() => undefined);
    });
    return () => { if (es === src) { src.close(); es = null; } };
  },
  async refresh() {
    const [v, p, s] = await Promise.all([api.variants(), api.proposals(), api.split()]);
    set({ variants: v.variants, proposals: p.proposals, split: s });
  },
  /** Show a variant's run: a finished one is selected, one still going is followed live so its results load when it ends. */
  async show(v) {
    set({ showing: v });
    if (!v.runId) return;
    const run = await api.run(v.runId).catch(() => null);
    if (get().showing?.id !== v.id) return;
    if (run && !isTerminalStatus(run.status)) useStore.getState().attachRun(v.runId);
    else await useStore.getState().selectRun(v.runId);
  },
  async back() { const v = get().showing; set({ showing: null }); if (v?.baseRunId) await useStore.getState().selectRun(v.baseRunId); },
  async discard(id) { await api.discardVariant(id); if (get().showing?.id === id) await get().back(); await get().refresh(); },
  /** Adopt = the variant's text becomes the base file, as ONE edit (undoable with Ctrl+Z), then saved and re-run
   *  exactly once. The edit targets the base file's OWN monaco model by URI, never whatever model happens to be
   *  attached to the editor right now (the attach can still be mid-flight after openFile()). */
  async adopt(id) {
    const v = await api.variant(id);
    if (!v.source) throw new Error("the variant file is gone");
    await useStore.getState().openFile(v.base);
    const name = v.base.split("/").pop();

    // the user may have changed the base since the variant was made: never silently replace their newer text
    const open = useStore.getState().openFiles.find((f) => f.path === v.base);
    let text = v.source;
    let plan = open ? decideAdoptPlan({ baseHash: v.baseHash, current: open.content, saved: open.saved, canRebase: v.canRebase }) : "adopt";
    if (plan === "rebase" && open) {
      const rebased = await api.rebaseVariant(id, open.content).catch(() => null);
      if (rebased) { text = rebased.source; useStore.getState().toast("info", `${name} had changed; the variant's changes were applied to your current text`); }
      else plan = "confirm";
    }
    if (plan === "confirm" && !(await askConfirm({ title: `${name} changed since this variant was made`, message: "Adopt anyway? This replaces your newer text (Ctrl+Z in the editor restores it while the file is open).", confirmLabel: "Adopt anyway", danger: true }))) return;

    let editedInEditor = false;
    const workspace = useStore.getState().info?.workspace;
    if (workspace) {
      const model = await waitForModel(workspace, v.base);
      if (model) {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        model.pushStackElement();
        editedInEditor = true;
      }
    }
    if (!editedInEditor) {
      useStore.getState().setContent(v.base, text);
      useStore.getState().toast("info", `Adopted ${name}: undo (Ctrl+Z) is not available for this change.`);
    }

    const saved = await useStore.getState().saveFile(v.base);
    const action = decideAdoptAction(saved, useStore.getState().cfg.autoRun);
    if (action === "saveFailed") { useStore.getState().toast("error", "Adopt: could not save, so the variant is kept — fix the conflict and try again."); return; }
    set({ showing: null });
    if (action === "startRun") await useStore.getState().startRun();
    // action === "autoRun": saveFile already scheduled the run itself; calling startRun() again would duplicate it.
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
