import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, copyFileSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { decodeBarDay } from "@qkt-studio/core";
import { scanStore, readinessFor } from "../src/data-scan.js";
import { cleanupPartialFiles, validBarFile, validGzip } from "../src/cleanup.js";
import { createStudio } from "../src/main.js";
import type { ServerConfig } from "../src/config.js";

/** Minimal QKB1 v1 writer, mirroring qkt's BinaryBarWriter, so the scanner is tested on data whose gaps we control. */
function barFile(symbol: string, tfMs: number, n: number): Buffer {
  const sym = Buffer.from("BACKTEST:" + symbol);
  const head = Buffer.alloc(4 + 4 + 4 + 8 + 4 + sym.length + 4);
  let o = 0;
  head.write("QKB1", o, "latin1"); o += 4; head.writeInt32LE(1, o); o += 4; head.writeInt32LE(8, o); o += 4;
  head.writeBigInt64LE(BigInt(tfMs), o); o += 8; head.writeInt32LE(sym.length, o); o += 4; sym.copy(head, o); o += sym.length; head.writeInt32LE(n, o);
  return Buffer.concat([head, Buffer.alloc(n * 6 * 8)]);
}
const D = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10); // Jan 1 2024 is a Monday
const isWeekend = (i: number) => [0, 6].includes(new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).getUTCDay());

let store: string;
beforeAll(() => {
  store = realpathSync(mkdtempSync(path.join(os.tmpdir(), "store-")));
  const dir = path.join(store, "bars", "BACKTEST", "TST", "15m");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 28; i++) {
    if (i === 9) continue;                                                        // Jan 10: no file at all -> missing
    if (i === 16) { writeFileSync(path.join(dir, `${D(i)}.bin`), barFile("TST", 900_000, 92).subarray(0, 60)); continue; } // truncated -> unusable
    writeFileSync(path.join(dir, `${D(i)}.bin`), barFile("TST", 900_000, isWeekend(i) ? 0 : i === 3 ? 20 : 92));            // weekend: 0 bars = closed; Jan 4: 20 bars = thin
  }
  const tdir = path.join(store, "symbols", "TST");
  mkdirSync(tdir, { recursive: true });
  for (let i = 0; i < 28; i++) if (!isWeekend(i) && i !== 11) writeFileSync(path.join(tdir, `${D(i)}.csv.gz`), gzipSync("timestamp,symbol\n"));  // Jan 12 weekday missing
  writeFileSync(path.join(tdir, "manifest.json"), JSON.stringify({ source: "unit-test" }));
  const only = path.join(store, "symbols", "TICKSONLY"); mkdirSync(only, { recursive: true });
  for (let i = 0; i < 5; i++) writeFileSync(path.join(only, `${D(i)}.csv.gz`), gzipSync("x"));
});
afterAll(() => rmSync(store, { recursive: true, force: true }));

describe("scanStore on a store with known gaps", () => {
  it("classifies every day kind exactly", async () => {
    const r = await scanStore(store);
    const t = r.symbols.find((s) => s.symbol === "TST")!;
    const b = t.bars[0]!;
    expect(b).toMatchObject({ broker: "BACKTEST", tf: "15m", first: "2024-01-01", last: "2024-01-28", span: 28, files: 27 });
    expect(b.missing).toBe(2);            // Jan 10 (no file) and Jan 17 (truncated file counts as unusable)
    expect(b.thin).toBe(1);               // Jan 4
    expect(b.closed).toBe(8);             // the 8 weekend days in Jan 1-28 2024
    expect(b.ok + b.closed + b.thin + b.missing).toBe(28);
    expect(b.status).toBe("incomplete");  // 2/28 missing is more than the 2% tolerance
    expect(b.gaps).toEqual([{ from: "2024-01-10", to: "2024-01-11" }, { from: "2024-01-17", to: "2024-01-18" }]);
    expect(b.usable).toEqual([{ from: "2024-01-01", to: "2024-01-10" }, { from: "2024-01-11", to: "2024-01-17" }, { from: "2024-01-18", to: "2024-01-29" }]);
  });
  it("ticks: weekend absence is normal, a missing weekday is a gap", async () => {
    const t = (await scanStore(store)).symbols.find((s) => s.symbol === "TST")!.ticks!;
    expect(t).toMatchObject({ source: "unit-test", first: "2024-01-01", last: "2024-01-26", missing: 1 });
    expect(t.gaps).toEqual([{ from: "2024-01-12", to: "2024-01-13" }]);
    expect(t.status).toBe("incomplete"); // 1 of 26 days is 3.8%, above the 2% tolerance
  });
  it("a symbol with ticks but no bars is called out, with the reason", async () => {
    const s = (await scanStore(store)).symbols.find((x) => x.symbol === "TICKSONLY")!;
    expect(s.status).toBe("ticks-only");
    expect(s.notes.join(" ")).toMatch(/Build bars/);
  });
  it("totals add up and a missing folder is an empty, valid scan", async () => {
    const r = await scanStore(store);
    expect(r.totals.symbols).toBe(2);
    expect(r.totals.barFiles).toBe(27);
    expect(r.looksLikeStore).toBe(true);
    const none = await scanStore(path.join(store, "does-not-exist"));
    expect(none).toMatchObject({ looksLikeStore: false, symbols: [] });
  });
});

describe("strategy readiness", () => {
  const src = (streams: string) => `STRATEGY s VERSION 1\n\nSYMBOLS\n${streams}\n\nRULES\n    WHEN a.close > 1\n    THEN BUY a SIZING 1\n`;
  it("bars mode: runnable windows are the complete ranges; the longest is offered", async () => {
    const r = readinessFor(await scanStore(store), "s.qkt", src("    a = BACKTEST:TST EVERY 15m"));
    expect(r.bars.runnable).toBe(true);
    expect(r.bars.ranges).toHaveLength(3);
    expect(r.bars.longest).toEqual({ from: "2024-01-18", to: "2024-01-29" });
    expect(r.bars.blocked).toEqual([]);
  });
  it("blocked with the exact fix when the timeframe was never built, and when the symbol is unknown", async () => {
    const scan = await scanStore(store);
    const a = readinessFor(scan, "s.qkt", src("    a = BACKTEST:TST EVERY 1h"));
    expect(a.bars).toMatchObject({ runnable: false, blocked: [{ stream: "BACKTEST:TST 1h", fix: "build-bars" }] });
    const b = readinessFor(scan, "s.qkt", src("    a = BACKTEST:NOPE EVERY 15m"));
    expect(b.bars.blocked[0]).toMatchObject({ fix: "fetch" });
    expect(b.ticks.runnable).toBe(false);
  });
  it("ticks mode uses the tick coverage, independently of bars", async () => {
    const r = readinessFor(await scanStore(store), "s.qkt", src("    a = BACKTEST:TST EVERY 15m"));
    expect(r.ticks.ranges).toEqual([{ from: "2024-01-01", to: "2024-01-12" }, { from: "2024-01-13", to: "2024-01-27" }]);
    expect(r.ticks.longest).toEqual({ from: "2024-01-13", to: "2024-01-27" });
  });
  it("a strategy on two symbols only runs where both are complete", async () => {
    const scan = await scanStore(store);
    const r = readinessFor(scan, "s.qkt", src("    a = BACKTEST:TST EVERY 15m\n    b = BACKTEST:TST EVERY 15m"));
    expect(r.streams).toHaveLength(1); // duplicates collapse
    const none = readinessFor(scan, "s.qkt", "PORTFOLIO p\n");
    expect(none.bars.runnable).toBe(false); // nothing to run
  });
});

describe("cleanupPartialFiles", () => {
  it("removes only NEW files that fail validation, and keeps complete and old ones", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "clean-")));
    const since = Date.now();
    writeFileSync(path.join(dir, "2024-02-01.bin"), barFile("X", 900_000, 92));                 // new + valid: keep
    writeFileSync(path.join(dir, "2024-02-02.bin"), barFile("X", 900_000, 92).subarray(0, 80)); // new + truncated: remove
    writeFileSync(path.join(dir, "2024-02-03.bin"), Buffer.from("garbage"));                    // new + garbage: remove
    writeFileSync(path.join(dir, "2023-01-01.bin"), Buffer.from("old corrupt"));                // old: never touched
    utimesSync(path.join(dir, "2023-01-01.bin"), new Date(since - 3_600_000), new Date(since - 3_600_000));
    writeFileSync(path.join(dir, "notes.txt"), "not a data file");
    const removed = await cleanupPartialFiles(dir, since, /^\d{4}-\d{2}-\d{2}\.bin$/, validBarFile);
    expect(removed.sort()).toEqual(["2024-02-02.bin", "2024-02-03.bin"]);
    expect(readdirSync(dir).sort()).toEqual(["2023-01-01.bin", "2024-02-01.bin", "notes.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("gzip validation catches a truncated tick file", () => {
    const good = gzipSync("a,b\n1,2\n".repeat(1000));
    expect(validGzip(good)).toBe(true);
    expect(validGzip(good.subarray(0, good.length - 10))).toBe(false);
    expect(validGzip(Buffer.from("plain"))).toBe(false);
  });
});

// ---- against the real local store and the real qkt binary (skipped when absent) ------------------------------------
const realData = path.join(os.homedir(), ".qkt", "data");
const haveQkt = (() => { try { execSync("qkt --version", { stdio: "ignore" }); return true; } catch { return false; } })();
const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));

describe.skipIf(!haveData)("scan of the real store", () => {
  it("finds XAUUSD, reports years and a usable window covering October 2024", async () => {
    const r = await scanStore(realData);
    const x = r.symbols.find((s) => s.symbol === "XAUUSD")!;
    const b = x.bars.find((t) => t.tf === "15m")!;
    expect(b.first).toBe("2017-01-02");
    expect(b.files).toBeGreaterThan(3000);
    expect(b.years.length).toBeGreaterThanOrEqual(9);
    expect(b.usable.some((u) => u.from <= "2024-10-01" && u.to >= "2024-11-01")).toBe(true);
    expect(x.spanYears).toBeGreaterThan(8);
    expect(["complete", "mostly", "incomplete"]).toContain(b.status);
    expect(r.ms).toBeLessThan(15_000);
  });
});

const dyn = describe.skipIf(!haveQkt || !haveData);
dyn("data source and kill switch over HTTP", () => {
  let ws: string, studio: Awaited<ReturnType<typeof createStudio>>, cfg: ServerConfig;
  const get = (url: string) => studio.app.inject({ url });
  const put = (url: string, body: unknown) => studio.app.inject({ method: "PUT", url, payload: body as object });
  const post = (url: string, body: unknown = {}) => studio.app.inject({ method: "POST", url, payload: body as object });
  beforeAll(async () => {
    ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dsws-")));
    mkdirSync(path.join(ws, "strategies"));
    writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 10000\n");
    writeFileSync(path.join(ws, "strategies", "a.qkt"), "STRATEGY a VERSION 1\n\nSYMBOLS\n    g = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN ema(g.close, 9) CROSSES ABOVE ema(g.close, 21)\n     AND POSITION.g = 0\n    THEN BUY g SIZING 0.1\n\n    WHEN ema(g.close, 9) CROSSES BELOW ema(g.close, 21)\n     AND POSITION.g > 0\n    THEN CLOSE g\n");
    cfg = { workspace: ws, dataRoot: realData, defaultDataRoot: realData, qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted" };
    studio = await createStudio(cfg);
  });
  afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

  it("scan and readiness endpoints answer, and readiness names the longest runnable window", async () => {
    const s = (await get("/api/data/scan")).json();
    expect(s.symbols.some((x: { symbol: string }) => x.symbol === "XAUUSD")).toBe(true);
    const r = (await get("/api/data/readiness")).json();
    const a = r.strategies.find((x: { strategy: string }) => x.strategy === "strategies/a.qkt");
    expect(a.bars.runnable).toBe(true);
    expect(a.bars.longest.to > a.bars.longest.from).toBe(true);
  });

  it("changing the data source rescans it, remembers it, and can be reset", async () => {
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alt-")));
    mkdirSync(path.join(scratch, "bars", "BACKTEST", "ALT", "15m"), { recursive: true });
    writeFileSync(path.join(scratch, "bars", "BACKTEST", "ALT", "15m", "2024-01-02.bin"), barFile("ALT", 900_000, 92));
    const ok = await put("/api/settings/data-root", { dataRoot: scratch });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ dataRoot: scratch, looksLikeStore: true, fromSettings: true });
    expect((await get("/api/data/scan")).json().symbols.map((s: { symbol: string }) => s.symbol)).toEqual(["ALT"]);
    expect(JSON.parse(readFileSync(path.join(ws, ".qkt-studio", "settings.json"), "utf8")).dataRoot).toBe(scratch);
    // a second studio started later picks the remembered source up
    const again = await createStudio({ ...cfg, dataRoot: realData });
    expect(again.app.server && (await again.app.inject({ url: "/api/settings" })).json().dataRoot).toBe(scratch);
    await again.app.close();
    const reset = await put("/api/settings/data-root", { dataRoot: null });
    expect(reset.json()).toMatchObject({ dataRoot: realData, fromSettings: false });
    expect((await get("/api/data/scan")).json().symbols.some((s: { symbol: string }) => s.symbol === "XAUUSD")).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("rejects relative paths, files, missing folders, and warns about a folder that is not a store", async () => {
    expect((await put("/api/settings/data-root", { dataRoot: "relative/x" })).statusCode).toBe(400);
    expect((await put("/api/settings/data-root", { dataRoot: path.join(ws, "qkt.config.yaml") })).statusCode).toBe(400);
    expect((await put("/api/settings/data-root", { dataRoot: "/definitely/not/here" })).statusCode).toBe(400);
    const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), "emptystore-")));
    const r = await put("/api/settings/data-root", { dataRoot: empty });
    expect(r.statusCode).toBe(200);
    expect(r.json().warnings.join(" ")).toMatch(/no `symbols\/` or `bars\/`/);
    await put("/api/settings/data-root", { dataRoot: null });
    rmSync(empty, { recursive: true, force: true });
  });

  it("an unprotected, network-reachable server only lets the UI choose known mount roots", async () => {
    const open = await createStudio({ ...cfg, host: "0.0.0.0", dataRoot: realData });
    const r = await open.app.inject({ method: "PUT", url: "/api/settings/data-root", payload: { dataRoot: "/etc" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/STUDIO_TOKEN/);
    expect((await open.app.inject({ url: "/api/fs/dirs?path=/etc" })).statusCode).toBe(403);
    await open.app.close();
  });

  it("the folder browser lists sub-folders and flags data stores", async () => {
    const r = (await get(`/api/fs/dirs?path=${encodeURIComponent(path.dirname(realData))}`)).json();
    expect(r.dirs.find((d: { name: string }) => d.name === path.basename(realData))).toMatchObject({ store: true });
    expect((await get("/api/fs/dirs?path=/no/such/dir")).statusCode).toBe(404);
  });

  it("KILL stops a running Full run, removes it and its files, and leaves no process", async () => {
    const r = await post("/api/runs", { strategy: "strategies/a.qkt", from: "2026-02-02", to: "2026-03-31", tier: "full", allowIncomplete: true });
    const id = r.json().runId as string;
    await new Promise((x) => setTimeout(x, 2500));
    const k = (await post("/api/kill")).json();
    expect(k.runs).toContain(id);
    expect(existsSync(path.join(ws, "runs", id))).toBe(false);
    expect((await get(`/api/runs/${id}`)).statusCode).toBe(404);
    expect((await get("/api/runs")).json().runs.some((x: { id: string }) => x.id === id)).toBe(false);
    await new Promise((x) => setTimeout(x, 300));
    expect(execSync(`ps -eo args | grep -F 'runs/${id}' | grep -v grep | wc -l`).toString().trim()).toBe("0");
  });

  it("stopping a run with purge removes its folder; without purge it is kept as cancelled", async () => {
    const a = (await post("/api/runs", { strategy: "strategies/a.qkt", from: "2026-02-02", to: "2026-03-31", tier: "full", allowIncomplete: true })).json().runId as string;
    await new Promise((x) => setTimeout(x, 1500));
    expect((await post(`/api/runs/${a}/cancel`)).statusCode).toBe(200);
    await new Promise((x) => setTimeout(x, 800));
    expect((await get(`/api/runs/${a}`)).json().status).toBe("cancelled");
    const b = (await post("/api/runs", { strategy: "strategies/a.qkt", from: "2026-02-02", to: "2026-03-31", tier: "full", allowIncomplete: true })).json().runId as string;
    await new Promise((x) => setTimeout(x, 1500));
    expect((await post(`/api/runs/${b}/cancel?purge=1`)).statusCode).toBe(200);
    await new Promise((x) => setTimeout(x, 800));
    expect(existsSync(path.join(ws, "runs", b))).toBe(false);
  });

  it("killing a bar build mid-way leaves only complete bar files", async () => {
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kill-")));
    mkdirSync(path.join(scratch, "symbols", "XAUUSD"), { recursive: true });
    const days = readdirSync(path.join(realData, "symbols", "XAUUSD")).filter((f) => f.endsWith(".csv.gz") && f >= "2024-06-01" && f < "2024-12-31").slice(0, 60);
    for (const f of days) copyFileSync(path.join(realData, "symbols", "XAUUSD", f), path.join(scratch, "symbols", "XAUUSD", f));
    await put("/api/settings/data-root", { dataRoot: scratch });
    const j = (await post("/api/data/build-bars", { symbol: "XAUUSD", tf: "1m", from: days[0]!.slice(0, 10), to: "2024-12-31" })).json().jobId as string;
    await new Promise((x) => setTimeout(x, 900));
    await post("/api/kill");
    let job = (await get(`/api/jobs/${j}`)).json();
    for (let i = 0; i < 40 && job.status === "running"; i++) { await new Promise((x) => setTimeout(x, 250)); job = (await get(`/api/jobs/${j}`)).json(); } // slow machines: wait for the stop to land
    expect(["cancelled", "done"]).toContain(job.status);
    const dir = path.join(scratch, "bars", "BACKTEST", "XAUUSD", "1m");
    for (const f of (existsSync(dir) ? readdirSync(dir) : []).filter((x) => x.endsWith(".bin"))) expect(() => decodeBarDay(new Uint8Array(readFileSync(path.join(dir, f)))), f).not.toThrow();
    await put("/api/settings/data-root", { dataRoot: null });
    rmSync(scratch, { recursive: true, force: true });
  });
});
