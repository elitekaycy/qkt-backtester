import { describe, it, expect } from "vitest";
import { navigateList } from "./listNav.js";

describe("navigateList", () => {
  it("moves by one and stops at the ends", () => {
    expect(navigateList(4, 0, "ArrowDown")).toEqual({ focus: 1 });
    expect(navigateList(4, 3, "ArrowDown")).toEqual({ focus: 3 });
    expect(navigateList(4, 0, "ArrowUp")).toEqual({ focus: 0 });
    expect(navigateList(4, 2, "ArrowUp")).toEqual({ focus: 1 });
  });
  it("Home and End jump to the first and last row", () => {
    expect(navigateList(5, 2, "Home")).toEqual({ focus: 0 });
    expect(navigateList(5, 2, "End")).toEqual({ focus: 4 });
  });
  it("Enter activates; unrelated keys and an empty list pass through", () => {
    expect(navigateList(3, 1, "Enter")).toEqual({ activate: true });
    expect(navigateList(3, 1, "Tab")).toBeNull();
    expect(navigateList(0, 0, "ArrowDown")).toBeNull();
  });
});
