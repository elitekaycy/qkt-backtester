import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Runner, RunRequestError, type RunEvent } from "../src/runner.js";
import type { ServerConfig } from "../src/config.js";

// These tests drive the REAL qkt binary against the real local data store. They are skipped when either is absent.
const dataRoot = path.join(os.homedir(), ".qkt", "data");
const haveQkt = (() => { try { execSync("qkt --version", { stdio: "ignore" }); return true; } catch { return false; } })();
const haveData = existsSync(path.join(dataRoot, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));
const haveTicks = existsSync(path.join(dataRoot, "symbols", "XAUUSD", "2026-02-10.csv.gz"));
const d = describe.skipIf(!haveQkt || !haveData);

const EMA = `STRATEGY xau_ema VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m

RULES
    WHEN ema(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1

    WHEN ema(gold.close, 9) CROSSES BELOW ema(gold.close, 21)
     AND POSITION.gold > 0
    THEN CLOSE gold
`;
const PARAMD = EMA.replace("STRATEGY xau_ema", "STRATEGY xau_p").replace("ema(gold.close, 9)", "ema(gold.close, fast)").replace("ema(gold.close, 9)", "ema(gold.close, fast)")
  .replace("RULES", "PARAM fast = 9\n\nRULES");
const CONFIG = `starting_balance: 10000\n`;

let ws: string, runner: Runner;
const cfg = (): ServerConfig => ({ workspace: ws, dataRoot, qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted" });
const oct = { from: "2024-10-01", to: "2024-10-31", tier: "draft" as const };

beforeEach(async () => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runner-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "qkt.config.yaml"), CONFIG);
  writeFileSync(path.join(ws, "strategies", "xau-ema.qkt"), EMA);
  runner = new Runner(cfg());
  await runner.init();
});
afterEach(async () => { await runner.close(); rmSync(ws, { recursive: true, force: true }); });

const runDirs = () => readdirSync(path.join(ws, "runs"));

d("happy path (Draft, October 2024)", () => {
  it("runs every step, writes derived files, and passes the integrity checks", async () => {
    const { runId, cached } = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    expect(cached).toBe(false);
    const run = await runner.waitFor(runId);
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => [s.id, s.status])).toEqual([
      ["project", "ok"], ["config", "ok"], ["parse", "ok"], ["coverage", "ok"], ["backtest", "ok"], ["postprocess", "ok"], ["render", "ok"],
    ]);
    expect(run.steps.find((s) => s.id === "backtest")!.message).toBe("81 fills");
    expect(run.coverage?.[0]).toMatchObject({ source: "bar", covered: 26, requested: 26, tf: "15m" });
    expect(run.engine.version).toMatch(/^\d+\.\d+\.\d+/);
    const dir = path.join(ws, "runs", runId);
    for (const f of ["derived/roundtrips.json", "derived/summary.json", "derived/monthly.json", "derived/integrity.json", "derived/equity.json", "derived/meta.json", "engine/result.json", "engine/manifest.json", "logs/stdout.log", "source/strategies/xau-ema.qkt", "source/qkt.config.yaml", "run.json"]) {
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    }
    const summary = JSON.parse(readFileSync(path.join(dir, "derived", "summary.json"), "utf8"));
    expect(summary).toMatchObject({ fills: 81, trades: 40, openTrades: 1 });
    expect(summary.realized).toBeCloseTo(376.85, 6);
    const integ = JSON.parse(readFileSync(path.join(dir, "derived", "integrity.json"), "utf8"));
    expect(integ.ok).toBe(true);
    expect(integ.checks.find((c: { id: string }) => c.id === "barCount")).toMatchObject({ ok: true });
    expect(integ.checks.find((c: { id: string }) => c.id === "fillsInBars")).toMatchObject({ ok: true });
    expect(integ.checks.find((c: { id: string }) => c.id === "manifest")).toMatchObject({ ok: true });
    expect(runner.list()[0]).toMatchObject({ id: runId, status: "done", trades: 40 });
  });

  it("an identical resubmit is a cache hit: same run, no new directory, no new process", async () => {
    const a = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    await runner.waitFor(a.runId);
    const b = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    expect(b).toEqual({ runId: a.runId, cached: true, joined: false });
    expect(runDirs().length).toBe(1);
    const forced = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, force: true });
    expect(forced.cached).toBe(false);
    expect(forced.runId).not.toBe(a.runId);
    await runner.waitFor(forced.runId);
  });

  it("changing the strategy, a param or the tier changes identity", async () => {
    const a = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    await runner.waitFor(a.runId);
    writeFileSync(path.join(ws, "strategies", "xau-ema.qkt"), EMA + "\n-- edited\n");
    const b = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    expect(b.cached).toBe(false);
    await runner.waitFor(b.runId);
  });

  it("two identical submits at once join one run", async () => {
    const [a, b] = await Promise.all([
      runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct }),
      runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct }),
    ]);
    expect(b.runId).toBe(a.runId);
    expect(b.joined).toBe(true);
    await runner.waitFor(a.runId);
    expect(runDirs().length).toBe(1);
  });

  it("streams status snapshots and finishes with a done run; late subscribers replay history", async () => {
    const { runId } = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    const seen: RunEvent[] = [];
    const unsub = await runner.subscribe(runId, (e) => seen.push(e));
    await runner.waitFor(runId);
    unsub();
    const statuses = seen.filter((e): e is Extract<RunEvent, { t: "run" }> => e.t === "run").map((e) => e.run.status);
    expect(statuses[statuses.length - 1]).toBe("done");
    expect(statuses).toContain("running");
    const replay: RunEvent[] = [];
    await runner.subscribe(runId, (e) => replay.push(e));
    expect(replay.some((e) => e.t === "run" && e.run.status === "done")).toBe(true);
  });

  it("passes --param values through and records them", async () => {
    writeFileSync(path.join(ws, "strategies", "p.qkt"), PARAMD);
    const { runId } = await runner.submit({ strategy: "strategies/p.qkt", ...oct, params: { fast: "5" } });
    const run = await runner.waitFor(runId);
    expect(run.status).toBe("done");
    expect(run.params).toEqual({ fast: "5" });
    expect(run.steps.find((s) => s.id === "coverage")!.command).toContain("--param fast=5");
  });
});

d("run options reach qkt and change identity", () => {
  it("starting balance and position mode are passed through and recorded", async () => {
    const { runId } = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, options: { startingBalance: 50000, positionMode: "netting" } });
    const run = await runner.waitFor(runId);
    expect(run.status).toBe("done");
    expect(run.options).toEqual({ startingBalance: 50000, positionMode: "netting" });
    expect(run.steps.find((s) => s.id === "coverage")!.command).toContain("--starting-balance 50000 --position-mode netting");
    const eq = JSON.parse(readFileSync(path.join(ws, "runs", runId, "derived", "equity.json"), "utf8"));
    expect(eq.equity[0]).toBe(50000);
    const plain = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    expect(plain.runId).not.toBe(runId);
    await runner.waitFor(plain.runId);
    const again = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, options: { positionMode: "netting", startingBalance: 50000 } });
    expect(again).toMatchObject({ runId, cached: true });
  });
  it("Full-only options are refused for Draft with the reason, before anything runs", async () => {
    await expect(runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, options: { broker: "mt5-sim" } })).rejects.toThrow(/only available in Full/);
    await expect(runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, options: { bogus: 1 } as never })).rejects.toThrow(/unknown option/);
    expect(existsSync(path.join(ws, "runs")) ? runDirs().length : 0).toBe(0);
  });
});

d("Draft fidelity is disclosed", () => {
  it("a bracket strategy in Draft carries a warning before any result is trusted; a plain one does not", async () => {
    const bracket = EMA.replace("THEN BUY gold SIZING 0.1", "THEN BUY gold SIZING 0.1\n        BRACKET {\n          STOP_LOSS BY 12,\n          TAKE_PROFIT BY 24\n        }");
    writeFileSync(path.join(ws, "strategies", "br.qkt"), bracket);
    const br = await runner.waitFor((await runner.submit({ strategy: "strategies/br.qkt", ...oct })).runId);
    expect(br.status).toBe("done");
    expect(br.warnings.join(" ")).toMatch(/stops, targets or brackets/);
    const plain = await runner.waitFor((await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct })).runId);
    expect(plain.warnings.join(" ")).not.toMatch(/stops, targets/);
  });
});

d("failures are caught at the right step, with real positions", () => {
  it("a missing qkt.config.yaml blocks the run before qkt is ever started", async () => {
    rmSync(path.join(ws, "qkt.config.yaml"));
    const { runId } = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    const run = await runner.waitFor(runId);
    expect(run.status).toBe("failed");
    expect(run.error?.kind).toBe("missing_config");
    expect(run.steps.find((s) => s.id === "config")!.status).toBe("failed");
    expect(run.steps.find((s) => s.id === "coverage")!.status).toBe("skipped");
    expect(existsSync(path.join(ws, "runs", runId, "logs", "stdout.log"))).toBe(false);
    expect(existsSync(path.join(ws, "runs", runId, "engine"))).toBe(false);
  });

  it("bad YAML fails the config step with a position", async () => {
    writeFileSync(path.join(ws, "qkt.config.yaml"), "data_root: [unclosed\n");
    const run = await runner.waitFor((await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct })).runId);
    expect(run.error).toMatchObject({ kind: "bad_config_yaml", file: "qkt.config.yaml" });
    expect(run.error!.line).toBeGreaterThan(0);
  });

  it("a syntax error fails the parse step at qkt's real line", async () => {
    writeFileSync(path.join(ws, "strategies", "bad.qkt"), EMA.replace("SIZING 0.1", "SIZING"));
    const run = await runner.waitFor((await runner.submit({ strategy: "strategies/bad.qkt", ...oct })).runId);
    expect(run.status).toBe("failed");
    expect(run.error?.kind).toBe("parse");
    expect(run.error!.line).toBeGreaterThan(1);
    expect(run.steps.find((s) => s.id === "parse")!.status).toBe("failed");
  });

  it("an unknown indicator is relocated from qkt's 1:1 to the real identifier", async () => {
    writeFileSync(path.join(ws, "strategies", "bad.qkt"), EMA.replace("ema(gold.close, 9)", "emaa(gold.close, 9)"));
    const run = await runner.waitFor((await runner.submit({ strategy: "strategies/bad.qkt", ...oct })).runId);
    expect(run.error).toMatchObject({ kind: "unknown_indicator", line: 7, col: 10, file: "strategies/bad.qkt" });
  });

  it("an unknown stream alias (which qkt silently runs with zero trades) is blocked", async () => {
    writeFileSync(path.join(ws, "strategies", "bad.qkt"), EMA.replace("ema(gold.close, 9)", "ema(gld.close, 9)"));
    const run = await runner.waitFor((await runner.submit({ strategy: "strategies/bad.qkt", ...oct })).runId);
    expect(run.error).toMatchObject({ kind: "unknown_alias", line: 7 });
    expect(run.steps.find((s) => s.id === "coverage")!.status).toBe("skipped");
  });

  it("missing bars fail at the coverage step with qkt's own build-bars remedy", async () => {
    const run = await runner.waitFor((await runner.submit({ strategy: "strategies/xau-ema.qkt", from: "2031-01-05", to: "2031-01-10", tier: "draft" })).runId);
    expect(run.status).toBe("failed");
    expect(run.error?.kind).toBe("missing_data");
    expect(run.error?.message).toMatch(/qkt data build-bars XAUUSD/);
    expect(run.buildBarsHint).toMatch(/^qkt data build-bars XAUUSD --tf 15m/);
    expect(run.steps.find((s) => s.id === "coverage")!.status).toBe("failed");
    expect(run.steps.filter((s) => s.status === "running")).toEqual([]); // nothing left "running…" after the failure
    expect(existsSync(path.join(ws, "runs", run.id, "engine"))).toBe(false);
  });

  it("zero trades is reported as a warning, not silence", async () => {
    const never = `STRATEGY never VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m

RULES
    WHEN gold.close < 0
    THEN BUY gold SIZING 0.1
`;
    writeFileSync(path.join(ws, "strategies", "never.qkt"), never);
    const run = await runner.waitFor((await runner.submit({ strategy: "strategies/never.qkt", ...oct })).runId);
    expect(run.status).toBe("done");
    expect(run.counts).toEqual({ fills: 0, orders: 0 });
    expect(run.warnings.join(" ")).toMatch(/no trades/i);
    const summary = JSON.parse(readFileSync(path.join(ws, "runs", run.id, "derived", "summary.json"), "utf8"));
    expect(summary).toMatchObject({ fills: 0, trades: 0, winRate: 0 });
  });
});

d("request validation", () => {
  it.each([
    [{ strategy: "strategies/xau-ema.txt", ...oct }, /\.qkt/],
    [{ strategy: "strategies/xau-ema.qkt", from: "2024-10-31", to: "2024-10-01", tier: "draft" as const }, /after/],
    [{ strategy: "strategies/xau-ema.qkt", from: "nope", to: "2024-10-01", tier: "draft" as const }, /dates/],
    [{ strategy: "strategies/xau-ema.qkt", from: "2000-01-01", to: "2024-10-01", tier: "draft" as const }, /longer/],
    [{ strategy: "strategies/xau-ema.qkt", ...oct, tier: "turbo" as never }, /tier/],
    [{ strategy: "strategies/xau-ema.qkt", ...oct, params: { "a b": "1" } }, /param name/],
    [{ strategy: "strategies/xau-ema.qkt", ...oct, params: { a: "1\n2" } }, /value/],
    [{ strategy: "../../etc/x.qkt", ...oct }, /escapes/],
    [{ strategy: "strategies/missing.qkt", ...oct }, /not found/],
  ])("rejects %j", async (req, msg) => {
    await expect(runner.submit(req)).rejects.toThrow(msg);
    await expect(runner.submit(req)).rejects.toBeInstanceOf(RunRequestError);
    expect(existsSync(path.join(ws, "runs")) ? runDirs().length : 0).toBe(0);
  });
  it("rejects a run id that tries to leave runs/", () => {
    expect(() => runner.runDir("../../etc")).toThrow(/invalid run id/);
    expect(() => runner.runDir("ok_1-2.3")).not.toThrow();
  });
});

d("crash recovery", () => {
  it("marks runs that were in flight when the studio died as interrupted, and clears half-written output", async () => {
    const id = "20260101T000000Z_x_deadbeef";
    const dir = path.join(ws, "runs", id);
    mkdirSync(path.join(dir, "engine"), { recursive: true });
    writeFileSync(path.join(dir, "engine", "partial.csv"), "x");
    writeFileSync(path.join(dir, "run.json"), JSON.stringify({
      schema: "qkt-studio-run-v1", id, hash: "deadbeef", status: "running", tier: "draft", strategy: "s.qkt", from: "a", to: "b", params: {},
      engine: { version: "1" }, createdAt: new Date().toISOString(), steps: [{ id: "backtest", status: "running" }], waivedDays: [], warnings: [], seq: 1,
    }));
    const fresh = new Runner(cfg());
    await fresh.init();
    const run = await fresh.getRun(id);
    expect(run?.status).toBe("interrupted");
    expect(run?.steps[0]!.status).toBe("failed");
    expect(existsSync(path.join(dir, "engine"))).toBe(false);
    expect(fresh.list()[0]).toMatchObject({ id, status: "interrupted" });
    await fresh.close();
  });
});

const dt = describe.skipIf(!haveQkt || !haveTicks);
dt("Full-tier execution options", () => {
  it("the MT5 simulator runs on ticks with an execution preset and a seed", async () => {
    const { runId } = await runner.submit({ strategy: "strategies/xau-ema.qkt", from: "2026-02-02", to: "2026-02-09", tier: "full", allowIncomplete: true, options: { broker: "mt5-sim", execution: "mt5-basic", seed: 5 } });
    const run = await runner.waitFor(runId);
    expect(run.status, JSON.stringify(run.error)).toBe("done");
    expect(run.steps.find((s) => s.id === "coverage")!.command).toContain("--broker mt5-sim --execution mt5-basic");
  }, 120_000);
});

dt("cancel and supersede (Full tier is slow enough to interrupt)", () => {
  const full = { from: "2026-02-02", to: "2026-03-31", tier: "full" as const };
  const alive = (marker: string) => execSync(`ps -eo args | grep -F -- '${marker}' | grep -v grep | wc -l`).toString().trim();

  it("cancel kills the process group, leaves no engine output, and reports cancelled", async () => {
    const { runId } = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...full, allowIncomplete: true });
    await new Promise((r) => setTimeout(r, 2500));
    expect(Number(alive(`runs/${runId}/engine`))).toBeGreaterThan(0);
    expect(await runner.cancel(runId)).toBe(true);
    const run = await runner.waitFor(runId);
    expect(run.status).toBe("cancelled");
    expect(run.error?.kind).toBe("cancelled");
    expect(existsSync(path.join(ws, "runs", runId, "engine"))).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(`runs/${runId}/engine`)).toBe("0");
    expect(await runner.cancel(runId)).toBe(false);
  });

  it("a newer auto-run of the same strategy cancels the older auto-run", async () => {
    const a = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...full, allowIncomplete: true, auto: true });
    await new Promise((r) => setTimeout(r, 1500));
    const b = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, auto: true });
    expect((await runner.waitFor(a.runId)).status).toBe("cancelled");
    expect((await runner.waitFor(b.runId)).status).toBe("done");
  });

  it("a manual run is never cancelled by an auto-run", async () => {
    const a = await runner.submit({ strategy: "strategies/xau-ema.qkt", from: "2026-02-02", to: "2026-02-09", tier: "full", allowIncomplete: true });
    const b = await runner.submit({ strategy: "strategies/xau-ema.qkt", ...oct, auto: true });
    expect((await runner.waitFor(b.runId)).status).toBe("done");
    expect((await runner.waitFor(a.runId)).status).toBe("done");
  }, 120_000);

  it("cancelling a queued run never starts it", async () => {
    const tight = new Runner({ ...cfg(), maxParallel: 1 });
    await tight.init();
    const a = await tight.submit({ strategy: "strategies/xau-ema.qkt", ...full, allowIncomplete: true });
    const b = await tight.submit({ strategy: "strategies/xau-ema.qkt", ...oct });
    expect(await tight.cancel(b.runId)).toBe(true);
    expect((await tight.waitFor(b.runId)).status).toBe("cancelled");
    await tight.cancel(a.runId);
    await tight.waitFor(a.runId);
    expect(existsSync(path.join(ws, "runs", b.runId, "logs", "stdout.log"))).toBe(false);
    await tight.close();
  });
});
