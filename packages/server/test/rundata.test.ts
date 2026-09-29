import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { checkQktSource } from "../src/check.js";
import { testConfig, haveQkt } from "./helpers.js";
import type { ServerConfig } from "../src/config.js";

let cfg: ServerConfig;
beforeAll(async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  cfg = testConfig(ws);
});

describe.skipIf(!haveQkt)("checkQktSource", () => {
  it("passes a valid strategy and names the error line of a broken one", async () => {
    const good = "STRATEGY t VERSION 1\n\nSYMBOLS\n    g = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN g.close > 0\n    THEN BUY g SIZING 0.1\n";
    expect((await checkQktSource(cfg, good)).ok).toBe(true);
    const bad = good.replace("THEN BUY", "THEN BUYY");
    const r = await checkQktSource(cfg, bad);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.line).toBe(8);
  });
});
