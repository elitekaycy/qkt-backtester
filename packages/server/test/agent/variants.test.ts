import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { textHash } from "@qkt-studio/core";
import { Variants, type PreparedVariant } from "../../src/agent/variants.js";
import { EventBus } from "../../src/agent/events.js";
import type { Runner } from "../../src/runner.js";
import { createStudio } from "../../src/main.js";
import { testConfig, haveQkt } from "../helpers.js";

const EMA = "STRATEGY ema VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nPARAM fast = 9\n\nRULES\n    WHEN ema(gold.close, fast) > gold.close\n    THEN BUY gold SIZING 0.1\n";
const window = { from: "2024-10-01", to: "2024-10-15", tier: "draft" as const };
const prepared = (label: string): PreparedVariant => ({ label, base: "strategies/ema.qkt", baseText: EMA, changes: [{ op: "set_param", name: "fast", value: 5 }], source: EMA.replace("= 9", "= 5"), window, diff: "", notes: [] });

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-variants-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "strategies", "ema.qkt"), EMA);
});
const vdir = () => path.join(ws, ".qkt-studio", "variants");
const dirs = () => readdirSync(vdir()).filter((d) => d !== "index.json" && !d.endsWith(".tmp"));

describe("variant folders", () => {
  it("are removed when their entry drops out of the index, and orphans are swept at start", async () => {
    const v = new Variants(testConfig(ws), {} as Runner, new EventBus());
    await v.init();
    const first = await v.commit(prepared("first"));
    for (let i = 0; i < 200; i++) await v.commit(prepared(`v${i}`));
    expect(v.get(first.id)).toBeUndefined();
    expect(existsSync(path.join(vdir(), first.id))).toBe(false);
    expect(dirs().length).toBe(200);
    mkdirSync(path.join(vdir(), "orphan1"));
    writeFileSync(path.join(vdir(), "orphan1", "x.qkt"), EMA);
    const again = new Variants(testConfig(ws), {} as Runner, new EventBus());
    await again.init();
    expect(existsSync(path.join(vdir(), "orphan1"))).toBe(false);
    expect(dirs().length).toBe(200);
  }, 60_000);

  it("are all kept when the index is corrupt (an unreadable index is not an empty one)", async () => {
    const v = new Variants(testConfig(ws), {} as Runner, new EventBus());
    await v.init();
    const made = await v.commit(prepared("kept"));
    writeFileSync(path.join(vdir(), "index.json"), "{ not json");
    const again = new Variants(testConfig(ws), {} as Runner, new EventBus());
    await again.init();
    expect(existsSync(path.join(vdir(), made.id))).toBe(true);
    expect(readdirSync(vdir()).some((f) => f.startsWith("index.json.corrupt-"))).toBe(true);
  });
});

describe("Variants.run", () => {
  it("reports each accepted submit even when the other one is refused", async () => {
    const runner = { submit: async (r: { strategy: string }) => { if (r.strategy === "strategies/ema.qkt") throw new Error("no data"); return { runId: "run-v", cached: false, joined: false }; }, waitFor: async () => ({}) } as unknown as Runner;
    const v = new Variants(testConfig(ws), runner, new EventBus());
    await v.init();
    const made = await v.commit(prepared("a"));
    const seen: string[] = [];
    let submitted = 0;
    await expect(v.run(made, { source: "tool", onSubmit: (which, r) => seen.push(`${which}:${r.runId}`), onSubmitted: () => submitted++ })).rejects.toThrow("no data");
    expect(seen).toEqual(["variant:run-v"]);
    expect(submitted).toBe(1);
  });
});

describe.skipIf(!haveQkt)("rebase and the variant route", () => {
  it("GET /api/variants/:id gives the base's hash (never its text); rebase re-applies the changes to the newer text", async () => {
    const studio = await createStudio(testConfig(ws, { token: "t0k" }));
    await studio.app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
    const hdr = { Authorization: "Bearer t0k", "Content-Type": "application/json" };
    try {
      const made = await studio.variants.create("strategies/ema.qkt", "fast 5", [{ op: "set_param", name: "fast", value: 5 }], window);
      const got = await (await fetch(`${base}/api/variants/${made.id}`, { headers: hdr })).json() as Record<string, unknown>;
      expect(got.baseHash).toBe(textHash(EMA));
      expect(got).not.toHaveProperty("baseText");
      expect(got.canRebase).toBe(true);
      expect(got.source).toMatch(/PARAM fast = 5/);

      // the user saved a newer version: rebase keeps their change and adds only the variant's own
      const newer = EMA.replace("SIZING 0.1", "SIZING 0.2");
      writeFileSync(path.join(ws, "strategies", "ema.qkt"), newer);
      const rb = await (await fetch(`${base}/api/variants/${made.id}/rebase`, { method: "POST", headers: hdr, body: "{}" })).json() as { source: string; baseHash: string };
      expect(rb.source).toMatch(/SIZING 0\.2/);
      expect(rb.source).toMatch(/PARAM fast = 5/);
      expect(rb.baseHash).toBe(textHash(newer));
      // or onto unsaved buffer text the browser sends
      const buffer = newer.replace("gold.close\n", "gold.open\n");
      const rb2 = await (await fetch(`${base}/api/variants/${made.id}/rebase`, { method: "POST", headers: hdr, body: JSON.stringify({ text: buffer }) })).json() as { source: string };
      expect(rb2.source).toMatch(/> gold\.open/);
      expect(rb2.source).toMatch(/PARAM fast = 5/);
      // changes that no longer apply: 409 with the reason
      const noParam = newer.replace("PARAM fast = 9\n\n", "").replace("ema(gold.close, fast)", "ema(gold.close, 9)");
      const v2 = await studio.variants.create("strategies/ema.qkt", "stop", [{ op: "replace_text", find: "SIZING 0.2", replace: "SIZING 0.3" }], window);
      const bad = await fetch(`${base}/api/variants/${v2.id}/rebase`, { method: "POST", headers: hdr, body: JSON.stringify({ text: noParam.replace("SIZING 0.2", "SIZING 1") }) });
      expect(bad.status).toBe(409);
      expect((await bad.json() as { error: string }).error).toMatch(/do not apply/);
      // a whole-file replacement cannot be rebased
      const v3 = await studio.variants.create("strategies/ema.qkt", "src", [{ op: "source", text: newer.replace("0.2", "0.4") }], window);
      expect(((await (await fetch(`${base}/api/variants/${v3.id}`, { headers: hdr })).json()) as { canRebase: boolean }).canRebase).toBe(false);
      expect((await fetch(`${base}/api/variants/${v3.id}/rebase`, { method: "POST", headers: hdr, body: "{}" })).status).toBe(409);
      expect(readFileSync(path.join(ws, "strategies", "ema.qkt"), "utf8")).toBe(newer); // rebase never writes the file
    } finally { await studio.app.close(); }
  }, 60_000);

  it("refuses a base that IMPORTs relative files with a clear message", async () => {
    const v = new Variants(testConfig(ws), {} as Runner, new EventBus());
    await v.init();
    writeFileSync(path.join(ws, "strategies", "odd.qkt"), EMA.replace("SYMBOLS", "IMPORT 'x.qkt' AS x\n\nSYMBOLS"));
    await expect(v.prepare("strategies/odd.qkt", "x", [{ op: "set_param", name: "fast", value: 5 }], window)).rejects.toThrow(/IMPORTs other files/);
  });
});
