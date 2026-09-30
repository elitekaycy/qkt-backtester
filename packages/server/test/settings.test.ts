import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, savePrefs, updateSettings } from "../src/settings.js";
import { setSplit } from "../src/split.js";
import { EventBus } from "../src/agent/events.js";
import { testConfig } from "./helpers.js";

const fresh = () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ws-settings-"));
  mkdirSync(path.join(ws, ".qkt-studio"));
  return ws;
};

describe("settings.json writers", () => {
  it("a split change racing data-source and preference changes loses none of them", async () => {
    const ws = fresh();
    const cfg = testConfig(ws, { sources: ["/data/a"], symbolPrefs: { XAUUSD: { source: "/data/a" } } });
    writeFileSync(path.join(ws, ".qkt-studio", "settings.json"), JSON.stringify({ dataRoot: "/data/root" }));
    await Promise.all([
      setSplit(cfg, new EventBus(), { test_last: "2 months" }),
      savePrefs(cfg),
      updateSettings(cfg, (s) => ({ ...s, dataRoot: "/data/other" })),
      setSplit(cfg, new EventBus(), { test_pct: 30 }),
    ]);
    const s = await loadSettings(cfg);
    expect(s).toMatchObject({ dataRoot: "/data/other", sources: ["/data/a"], symbols: { XAUUSD: { source: "/data/a" } }, split: { test_pct: 30 } });
  });

  it("a corrupt settings.json is kept aside, never overwritten with a near-empty file", async () => {
    const ws = fresh();
    const file = path.join(ws, ".qkt-studio", "settings.json");
    writeFileSync(file, '{"dataRoot": "/data/root", "sources": [');
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await setSplit(testConfig(ws), new EventBus(), { test_pct: 30 });
    log.mockRestore();
    const aside = readdirSync(path.join(ws, ".qkt-studio")).filter((f) => f.startsWith("settings.json.corrupt-"));
    expect(aside.length).toBe(1);
    expect(readFileSync(path.join(ws, ".qkt-studio", aside[0]!), "utf8")).toContain("/data/root");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ split: { test_pct: 30 } });
  });
});
