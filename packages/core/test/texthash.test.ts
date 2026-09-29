import { describe, it, expect } from "vitest";
import { textHash } from "../src/texthash.js";

describe("textHash", () => {
  it("is stable, fixed-width, and tells texts apart", () => {
    expect(textHash("STRATEGY a VERSION 1\n")).toBe(textHash("STRATEGY a VERSION 1\n"));
    expect(textHash("")).toMatch(/^[0-9a-f]{14}$/);
    expect(textHash("STRATEGY a VERSION 1\n")).not.toBe(textHash("STRATEGY a VERSION 1\n "));
    expect(textHash("ab")).not.toBe(textHash("ba"));
  });
});
