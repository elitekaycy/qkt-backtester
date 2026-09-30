import type { FastifyInstance } from "fastify";
export interface View {
  openFile: string | null; cursorLine: number | null; selection: string | null; runId: string | null;
  visibleFrom: number | null; visibleTo: number | null; selectedTrade: number | null; variantId: string | null;
  runWindow: { from: string; to: string; tier: string } | null;
}
const EMPTY: View = { openFile: null, cursorLine: null, selection: null, runId: null, visibleFrom: null, visibleTo: null, selectedTrade: null, variantId: null, runWindow: null };
/** What the user is looking at, reported by the browser; the tools resolve "this file", "this trade", "the chart" from it. */
export class ViewState {
  private v: View = { ...EMPTY };
  get(): View { return this.v; }
  set(p: Partial<View>): void {
    const keys = Object.keys(EMPTY) as Array<keyof View>;
    for (const k of keys) if (k in p) (this.v as unknown as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k] ?? null;
    if (typeof this.v.selection === "string") this.v.selection = this.v.selection.slice(0, 4000);
  }
}
export function registerView(app: FastifyInstance, view: ViewState): void {
  app.post<{ Body: Partial<View> }>("/api/view", async (req) => { view.set(req.body ?? {}); return { ok: true }; });
}
