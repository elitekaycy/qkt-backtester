import { create } from "zustand";

export type ChartLayout = "stack" | "tabs" | "grid";
export type ChartTab = "chart" | "trades";

interface Persisted { hidden: string[]; order: string[]; layout: ChartLayout; follow: boolean; tab: ChartTab }
interface Prefs extends Persisted {
  /** Chart shown when the layout is `tabs` (not persisted across runs). */
  activeKey: string | null;
  set(p: Partial<Prefs>): void;
  toggle(key: string): void;
  move(key: string, toIndex: number, all: string[]): void;
}

const KEY = "qkt-studio-chart-v1";
const DEFAULTS: Persisted = { hidden: [], order: [], layout: "stack", follow: true, tab: "chart" };
const load = (): Persisted => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { ...DEFAULTS }; } };
const save = (s: Persisted) => { try { localStorage.setItem(KEY, JSON.stringify({ hidden: s.hidden, order: s.order, layout: s.layout, follow: s.follow, tab: s.tab })); } catch { /* storage blocked */ } };

/** Which charts are shown, in what order, in what layout. Keyed by `broker:symbol:tf`, so the choice survives runs of the same strategy. */
export const useChartPrefs = create<Prefs>((set, get) => ({
  ...load(), activeKey: null,
  set(p) { set(p); save(get()); },
  toggle(key) { const h = get().hidden; get().set({ hidden: h.includes(key) ? h.filter((k) => k !== key) : [...h, key] }); },
  move(key, toIndex, all) {
    const cur = [...get().order.filter((k) => all.includes(k)), ...all.filter((k) => !get().order.includes(k))];
    const from = cur.indexOf(key);
    if (from < 0) return;
    cur.splice(from, 1);
    cur.splice(Math.max(0, Math.min(cur.length, toIndex)), 0, key);
    get().set({ order: cur });
  },
}));

/** Apply the saved order to a list of stream keys (unknown keys keep their natural order, after the known ones). */
export function ordered<T>(items: T[], keyOf: (t: T) => string, order: string[]): T[] {
  const rank = (t: T) => { const i = order.indexOf(keyOf(t)); return i < 0 ? order.length + items.indexOf(t) : i; };
  return [...items].sort((a, b) => rank(a) - rank(b));
}
