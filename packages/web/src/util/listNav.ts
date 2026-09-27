/**
 * Keyboard model for a flat, single-select list (Runs, the Data section's symbol and strategy lists): roving
 * tabindex, Up/Down/Home/End move, Enter/Space activate. Pure so it is testable without a browser; the arrow-key
 * DOM wiring (querying the rendered rows and calling `.focus()`) lives in each component, same shape every time.
 */
export interface ListAction { focus?: number; activate?: boolean }

export function navigateList(count: number, i: number, key: string): ListAction | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown": return { focus: Math.min(count - 1, i + 1) };
    case "ArrowUp": return { focus: Math.max(0, i - 1) };
    case "Home": return { focus: 0 };
    case "End": return { focus: count - 1 };
    case "Enter": return { activate: true };
    default: return null;
  }
}
