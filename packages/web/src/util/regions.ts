/**
 * F6 / Shift+F6 move focus between the big areas of the workbench, the way IDEs do: side rail, side panel, editor, chart,
 * output panel. Each lands on the element a keyboard user expects there (the selected rail button, the tree's current row,
 * the editor's text, the chart's first control, the selected output tab). Hidden or collapsed areas are skipped.
 */
/** The first element matching the selectors, tried in this order (a selector list would pick by document order instead). */
const first = (el: HTMLElement, ...sels: string[]): HTMLElement | null => {
  for (const s of sels) for (const x of el.querySelectorAll<HTMLElement>(s)) if (!(x as HTMLButtonElement).disabled && x.getClientRects().length) return x;
  return null;
};
const REGIONS: Array<{ name: string; sel: string; target(el: HTMLElement): HTMLElement | null }> = [
  { name: "Sections", sel: "nav.rail", target: (el) => first(el, "[aria-current='true']", "button") },
  { name: "Side panel", sel: "aside.sidebar", target: (el) => first(el, "[role=treeitem][tabindex='0']", "[role=listitem] [tabindex='0']", ".side-scroll [tabindex='0']", ".side-scroll button", "button") },
  { name: "Editor", sel: "section[aria-label='Editor']", target: (el) => first(el, ".monaco-editor [role=textbox]", "button") },
  { name: "Chart", sel: "section[aria-label='Chart']", target: (el) => first(el, ".pkpi", ".chart-toolbar button", "button") },
  { name: "Output", sel: ".dock-bar", target: (el) => first(el, "[role=tab][aria-selected='true']", "[role=tab]") },
];
const visible = (el: HTMLElement) => el.offsetParent !== null && el.getClientRects().length > 0;

export function cycleRegion(dir: 1 | -1): void {
  const present = REGIONS.map((r) => ({ ...r, el: document.querySelector<HTMLElement>(r.sel) })).filter((r): r is typeof r & { el: HTMLElement } => !!r.el && visible(r.el));
  if (!present.length) return;
  const a = document.activeElement as HTMLElement | null;
  const cur = present.findIndex((r) => a && r.el.contains(a));
  const next = present[(cur < 0 ? (dir === 1 ? 0 : present.length - 1) : (cur + dir + present.length) % present.length)]!;
  const t = next.target(next.el);
  const ed = (window as unknown as { __qktEditor?: { focus(): void; getModel(): unknown } }).__qktEditor;
  if (next.name === "Editor" && ed?.getModel()) { ed.focus(); return; }
  (t ?? next.el).focus();
}
