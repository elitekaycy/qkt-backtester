/**
 * Keyboard model of the file tree (WAI-ARIA "tree" pattern) as pure functions, so it can be tested without a browser.
 * `rows` are the VISIBLE rows in order; `i` is the focused row.
 */
export interface NavRow { path: string; depth: number; isDir: boolean; open: boolean }
export interface NavAction {
  /** Move focus to this row index. */
  focus?: number;
  /** Open a closed folder / close an open one (by path). */
  expand?: string; collapse?: string;
  /** Open the file, or toggle the folder (Enter / Space). */
  activate?: boolean;
  /** `*`: open every closed sibling folder. */
  expandSiblings?: string[];
}

const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Index of the row's parent folder, or -1 for a root row. */
export function parentIndex(rows: NavRow[], i: number): number {
  const d = rows[i]?.depth ?? 0;
  if (d === 0) return -1;
  for (let j = i - 1; j >= 0; j--) if (rows[j]!.depth === d - 1) return j;
  return -1;
}

/** Sibling folders of row `i` that are closed (for `*`). */
function closedSiblings(rows: NavRow[], i: number): string[] {
  const p = parentIndex(rows, i), d = rows[i]!.depth, out: string[] = [];
  const start = p + 1;
  for (let j = start; j < rows.length; j++) {
    if (rows[j]!.depth < d) break;
    if (rows[j]!.depth === d && rows[j]!.isDir && !rows[j]!.open) out.push(rows[j]!.path);
  }
  return out;
}

/** What a navigation key does. `null` means the key is not a tree key (let it through). */
export function navigate(rows: NavRow[], i: number, key: string): NavAction | null {
  const r = rows[i];
  if (!r) return null;
  const last = rows.length - 1;
  switch (key) {
    case "ArrowDown": return { focus: Math.min(last, i + 1) };
    case "ArrowUp": return { focus: Math.max(0, i - 1) };
    case "Home": return { focus: 0 };
    case "End": return { focus: last };
    case "ArrowRight":
      if (!r.isDir) return {};
      if (!r.open) return { expand: r.path };
      return rows[i + 1] && rows[i + 1]!.depth > r.depth ? { focus: i + 1 } : {};
    case "ArrowLeft": {
      if (r.isDir && r.open) return { collapse: r.path };
      const p = parentIndex(rows, i);
      return p >= 0 ? { focus: p } : {};
    }
    case "Enter": case " ": return { activate: true };
    case "*": return { expandSiblings: closedSiblings(rows, i) };
    default: return null;
  }
}

/**
 * Type-ahead: the next row (after `i`, wrapping) whose name starts with `buffer`. A single repeated letter cycles through
 * the rows starting with it, as in a file manager. Returns -1 when nothing matches.
 */
export function typeahead(rows: NavRow[], i: number, buffer: string): number {
  const b = buffer.toLowerCase();
  if (!b) return -1;
  const cycling = b.length > 1 && [...b].every((c) => c === b[0]);
  const needle = cycling ? b[0]! : b;
  const n = rows.length;
  for (let k = cycling || b.length === 1 ? 1 : 0; k <= n; k++) {
    const j = (i + k) % n;
    if (name(rows[j]!.path).toLowerCase().replace(/^\./, "").startsWith(needle.replace(/^\./, "")) || name(rows[j]!.path).toLowerCase().startsWith(needle)) return j;
  }
  return -1;
}

/** aria-setsize / aria-posinset for every row: position among its siblings. */
export function siblingInfo(rows: NavRow[]): Array<{ setsize: number; posinset: number }> {
  const out = rows.map(() => ({ setsize: 1, posinset: 1 }));
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i]!.depth;
    // siblings = rows at depth d between the parent and the next row shallower than d
    let start = i;
    for (let j = i - 1; j >= 0; j--) { if (rows[j]!.depth < d) break; if (rows[j]!.depth === d) start = j; }
    let end = i;
    for (let j = i + 1; j < rows.length; j++) { if (rows[j]!.depth < d) break; if (rows[j]!.depth === d) end = j; }
    let size = 0, pos = 0;
    for (let j = start; j <= end; j++) if (rows[j]!.depth === d) { size++; if (j <= i) pos++; }
    out[i] = { setsize: size, posinset: pos };
  }
  return out;
}
