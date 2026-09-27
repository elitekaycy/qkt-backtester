import { describe, it, expect } from "vitest";
import { navigate, parentIndex, siblingInfo, typeahead, type NavRow } from "./treeNav.js";

// strategies/        (open)
//   a.qkt
//   sub/             (closed)
//   b.qkt
// qkt.config.yaml
// runs/              (closed)
const rows: NavRow[] = [
  { path: "strategies", depth: 0, isDir: true, open: true },
  { path: "strategies/a.qkt", depth: 1, isDir: false, open: false },
  { path: "strategies/sub", depth: 1, isDir: true, open: false },
  { path: "strategies/b.qkt", depth: 1, isDir: false, open: false },
  { path: "qkt.config.yaml", depth: 0, isDir: false, open: false },
  { path: "runs", depth: 0, isDir: true, open: false },
];

describe("tree keyboard model", () => {
  it("Up/Down move by one and stop at the ends; Home/End jump", () => {
    expect(navigate(rows, 0, "ArrowDown")).toEqual({ focus: 1 });
    expect(navigate(rows, 5, "ArrowDown")).toEqual({ focus: 5 });
    expect(navigate(rows, 0, "ArrowUp")).toEqual({ focus: 0 });
    expect(navigate(rows, 3, "Home")).toEqual({ focus: 0 });
    expect(navigate(rows, 0, "End")).toEqual({ focus: 5 });
  });
  it("Right opens a closed folder, then moves into it; on a file it does nothing", () => {
    expect(navigate(rows, 2, "ArrowRight")).toEqual({ expand: "strategies/sub" });
    expect(navigate(rows, 0, "ArrowRight")).toEqual({ focus: 1 });
    expect(navigate(rows, 1, "ArrowRight")).toEqual({});
    expect(navigate(rows, 5, "ArrowRight")).toEqual({ expand: "runs" });
  });
  it("Left closes an open folder, otherwise goes to the parent", () => {
    expect(navigate(rows, 0, "ArrowLeft")).toEqual({ collapse: "strategies" });
    expect(navigate(rows, 3, "ArrowLeft")).toEqual({ focus: 0 });
    expect(navigate(rows, 4, "ArrowLeft")).toEqual({});
    expect(navigate(rows, 2, "ArrowLeft")).toEqual({ focus: 0 });
  });
  it("Enter and Space activate; * opens the closed sibling folders; other keys pass through", () => {
    expect(navigate(rows, 1, "Enter")).toEqual({ activate: true });
    expect(navigate(rows, 2, " ")).toEqual({ activate: true });
    expect(navigate(rows, 0, "*")).toEqual({ expandSiblings: ["runs"] });
    expect(navigate(rows, 1, "*")).toEqual({ expandSiblings: ["strategies/sub"] });
    expect(navigate(rows, 0, "Tab")).toBeNull();
    expect(navigate(rows, 0, "F2")).toBeNull();
  });
  it("parentIndex finds the enclosing folder", () => {
    expect(parentIndex(rows, 3)).toBe(0);
    expect(parentIndex(rows, 0)).toBe(-1);
    expect(parentIndex(rows, 4)).toBe(-1);
  });
  it("type-ahead finds the next name starting with the typed letters, wrapping around", () => {
    expect(typeahead(rows, 0, "q")).toBe(4);
    expect(typeahead(rows, 4, "q")).toBe(4); // only match: wraps back to itself
    expect(typeahead(rows, 0, "b")).toBe(3);
    expect(typeahead(rows, 0, "ru")).toBe(5);
    expect(typeahead(rows, 5, "s")).toBe(0);
    expect(typeahead(rows, 0, "zzz")).toBe(-1);
    expect(typeahead(rows, 0, "")).toBe(-1);
  });
  it("dotfiles match without their dot", () => {
    const r: NavRow[] = [{ path: "a", depth: 0, isDir: false, open: false }, { path: ".env", depth: 0, isDir: false, open: false }];
    expect(typeahead(r, 0, "e")).toBe(1);
    expect(typeahead(r, 0, ".e")).toBe(1);
  });
  it("aria-setsize and posinset count siblings at each level", () => {
    const s = siblingInfo(rows);
    expect(s[0]).toEqual({ setsize: 3, posinset: 1 });
    expect(s[1]).toEqual({ setsize: 3, posinset: 1 });
    expect(s[2]).toEqual({ setsize: 3, posinset: 2 });
    expect(s[3]).toEqual({ setsize: 3, posinset: 3 });
    expect(s[4]).toEqual({ setsize: 3, posinset: 2 });
    expect(s[5]).toEqual({ setsize: 3, posinset: 3 });
  });
});
