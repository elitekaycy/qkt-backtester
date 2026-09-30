// packages/web/src/chat/results.test.ts
import { describe, it, expect } from "vitest";
import { overfitFlags, parseResult } from "./results.js";

describe("tool results", () => {
  it("parses a tool's JSON result; plain text, arrays and truncated results give null", () => {
    expect(parseResult('{"variantId":"v1"}')).toEqual({ variantId: "v1" });
    expect(parseResult("no such run")).toBeNull();
    expect(parseResult("[1]")).toBeNull();
    expect(parseResult('{"truncated":true,"head":"..."}')).toBeNull();
  });
  it("flags sweep rows better than the median on the first part but below it on the test part", () => {
    expect(overfitFlags([{ first: 10, test: -5 }, { first: 8, test: 6 }, { first: 1, test: 7 }, { first: 0, test: 2 }])).toEqual([true, false, false, false]);
    expect(overfitFlags([{ first: 10, test: -5 }, { first: 1, test: 7 }])).toEqual([false, false]);
    expect(overfitFlags([{ first: 10, test: null }, { first: 8, test: 6 }, { first: 1, test: 7 }, { first: 0, test: 2 }])[0]).toBe(false);
  });
});
