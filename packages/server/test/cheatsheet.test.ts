import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkQktSource } from "../src/check.js";
import { testConfig } from "./helpers.js";

describe("the DSL cheat sheet", () => {
  it("every qkt block parses with the qkt the studio runs", async () => {
    const md = readFileSync(path.join(import.meta.dirname, "..", "assets", "dsl", "cheatsheet.md"), "utf8");
    const blocks = [...md.matchAll(/```qkt\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const cfg = testConfig("/tmp");
    for (const b of blocks) expect((await checkQktSource(cfg, b)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
