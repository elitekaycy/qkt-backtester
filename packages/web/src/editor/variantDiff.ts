// Pure logic of the variant diff view (no DOM, no monaco, no stores): which view the editor area shows, the diff's header
// text, whether the base changed since the variant was made, and inline vs side-by-side. VariantDiff.tsx renders it.
import { textHash } from "@qkt-studio/core/texthash";

/** Side-by-side needs this much editor width (px); below it "auto" shows the inline view (Monaco's own default is 900). */
export const SIDE_BY_SIDE_MIN_WIDTH = 720;

export type DiffMode = "auto" | "split" | "inline";
export type DiffLayout = "split" | "inline";

/** Pure: does the editor area show the variant diff instead of the normal editor? Only for the variant on screen, and only
 *  while its base file is the active tab (switching tabs shows that file; switching back shows the diff again). */
export function diffVisible(a: { diffOf: string | null; showingId: string | null; showingBase: string | null; activePath: string | null }): boolean {
  return a.diffOf !== null && a.diffOf === a.showingId && a.showingBase !== null && a.showingBase === a.activePath;
}

/** Pure: must an open diff close because the variant it belongs to is no longer the one showing (adopted, discarded, Back)? */
export function diffShouldClose(diffOf: string | null, showingId: string | null): boolean {
  return diffOf !== null && diffOf !== showingId;
}

/** Pure: the header's title, git-style "into <- from": the base file's name, then the variant's label. */
export function diffTitle(base: string, label: string): string {
  return `${base.split("/").pop() ?? base} ← ${label}`;
}

/** Pure: has the base text changed since the variant was made from text hashing to `baseHash`? Unknown text is not "changed". */
export function baseChanged(baseHash: string | null | undefined, current: string | null | undefined): boolean {
  if (!baseHash || current === null || current === undefined) return false;
  return textHash(current) !== baseHash;
}

/** Pure: the layout actually on screen. "auto" is side-by-side when the pane is wide enough, else inline; a width of 0
 *  (not measured yet) counts as wide, like Monaco before its first layout. */
export function diffLayout(mode: DiffMode, width: number): DiffLayout {
  if (mode !== "auto") return mode;
  return width > 0 && width < SIDE_BY_SIDE_MIN_WIDTH ? "inline" : "split";
}

/** Pure: the diff editor options for a mode. "auto" lets Monaco fall back to inline itself at the same breakpoint the header
 *  uses; an explicit choice is kept whatever the width. */
export function diffEditorOptions(mode: DiffMode, width: number) {
  return {
    renderSideBySide: diffLayout(mode, width) === "split",
    useInlineViewWhenSpaceIsLimited: mode === "auto",
    renderSideBySideInlineBreakpoint: SIDE_BY_SIDE_MIN_WIDTH,
  };
}

/** Pure: the mode the layout toggle switches to (always an explicit one, the opposite of what is on screen). */
export function toggledMode(mode: DiffMode, width: number): DiffLayout {
  return diffLayout(mode, width) === "split" ? "inline" : "split";
}

type LineChange = { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number };
/** Pure: git's "+added −removed" line counts from Monaco's line changes (an end line of 0 means no lines on that side). */
export function countLines(changes: readonly LineChange[] | null | undefined): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const c of changes ?? []) {
    if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
  }
  return { added, removed };
}
