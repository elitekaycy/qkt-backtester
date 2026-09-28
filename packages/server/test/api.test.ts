import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync, copyFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createStudio } from "../src/main.js";
import type { ServerConfig } from "../src/config.js";
import { tokenize, checkRestricted } from "../src/terminal.js";

const realData = path.join(os.homedir(), ".qkt", "data");
const haveQkt = (() => { try { execSync("qkt --version", { stdio: "ignore" }); return true; } catch { return false; } })();
const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));
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
const BRACKET = EMA.replace("STRATEGY xau_ema", "STRATEGY xau_br").replace("THEN BUY gold SIZING 0.1", "THEN BUY gold SIZING 0.1\n        BRACKET {\n          STOP_LOSS BY 12,\n          TAKE_PROFIT BY 24\n        }");
const PARAM = EMA.replace("STRATEGY xau_ema", "STRATEGY xau_p").replace(/ema\(gold\.close, 9\)/g, "ema(gold.close, fast)").replace(/ema\(gold\.close, 21\)/g, "ema(gold.close, slow)")
  .replace("RULES", "PARAM fast = 9\nPARAM slow = 21\n\nRULES");

let ws: string, cfg: ServerConfig, studio: Awaited<ReturnType<typeof createStudio>>, base: string;
const oct = { from: "2024-10-01", to: "2024-10-31", tier: "draft" };
const post = (url: string, body: unknown) => studio.app.inject({ method: "POST", url, payload: body as object });
const get = (url: string) => studio.app.inject({ url });
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); }
}

beforeAll(async () => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "api-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 10000\n");
  writeFileSync(path.join(ws, "strategies", "xau-ema.qkt"), EMA);
  writeFileSync(path.join(ws, "strategies", "param.qkt"), PARAM);
  writeFileSync(path.join(ws, "strategies", "br.qkt"), BRACKET);
  cfg = { workspace: ws, dataRoot: realData, qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted" };
  studio = await createStudio(cfg);
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); rmSync(ws, { recursive: true, force: true }); });

let runId = "";
d("runs over HTTP", () => {
  it("POST /api/runs -> 202, finishes, run + derived endpoints serve the result", async () => {
    const r = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", ...oct });
    expect(r.statusCode).toBe(202);
    runId = r.json().runId;
    const run = await until(async () => { const x = (await get(`/api/runs/${runId}`)).json(); return ["done", "failed"].includes(x.status) ? x : false; });
    expect(run.status).toBe("done");
    const s = (await get(`/api/runs/${runId}/derived/summary`)).json();
    expect(s).toMatchObject({ trades: 40, fills: 81, openTrades: 1 });
    expect((await get(`/api/runs/${runId}/derived/integrity`)).json().ok).toBe(true);
    expect((await get(`/api/runs/${runId}/derived/monthly`)).json()[0].month).toBe("2024-10");
    const eq = (await get(`/api/runs/${runId}/derived/equity`)).json();
    expect(eq.ts.length).toBe(eq.equity.length);
    expect(eq.drawdown.every((x: number) => x <= 0)).toBe(true);
    expect((await get(`/api/runs/${runId}/derived/roundtrips`)).statusCode).toBe(404); // not exposed raw
    expect((await get("/api/runs")).json().runs[0]).toMatchObject({ id: runId, status: "done", trades: 40 });
  });

  it("an identical POST is a 200 cache hit", async () => {
    const r = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", ...oct });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ runId, cached: true });
  });

  it("bad requests are 4xx JSON errors, never 500s", async () => {
    for (const body of [{ strategy: "x.txt", ...oct }, { strategy: "../../etc/x.qkt", ...oct }, { strategy: "strategies/nope.qkt", ...oct }, {}]) {
      const r = await post("/api/runs", body);
      expect(r.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
      expect(typeof r.json().error).toBe("string");
    }
    expect([400, 404]).toContain((await get("/api/runs/..%2F..%2Fetc")).statusCode); // traversal never reaches the filesystem
    expect((await post("/api/runs/..%2Fx/montecarlo", {})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get("/api/runs/does-not-exist")).statusCode).toBe(404);
  });

  it("trades are paged and filtered server-side", async () => {
    const all = (await get(`/api/runs/${runId}/trades?limit=10`)).json();
    expect(all.total).toBe(41);
    expect(all.rows.length).toBe(10);
    const wins = (await get(`/api/runs/${runId}/trades?outcome=win`)).json();
    expect(wins.total).toBe(17);
    expect(wins.rows.every((t: { pnl: number }) => t.pnl > 0)).toBe(true);
    expect((await get(`/api/runs/${runId}/trades?side=short`)).json().total).toBe(0);
    const top = (await get(`/api/runs/${runId}/trades?sort=pnl&dir=desc&limit=1`)).json().rows[0];
    expect(top.pnl).toBeCloseTo(237.135, 3);
    expect((await get(`/api/runs/${runId}/trades?outcome=open`)).json().total).toBe(1);
    const page2 = (await get(`/api/runs/${runId}/trades?limit=10&offset=10`)).json();
    expect(page2.rows[0].id).toBe(all.rows[9].id + 1);
  });

  it("overlay returns compact trips for a window and respects filters and the cap", async () => {
    const from = Date.UTC(2024, 9, 1), to = Date.UTC(2024, 9, 8);
    const o = (await get(`/api/runs/${runId}/overlay?from=${from}&to=${to}`)).json();
    expect(o.total).toBeGreaterThan(3);
    expect(o.rows.every((t: { entryTs: number }) => t.entryTs < to)).toBe(true);
    expect((await get(`/api/runs/${runId}/overlay?from=${from}&to=${to}&cap=2`)).json()).toMatchObject({ truncated: true });
    expect((await get(`/api/runs/${runId}/overlay?from=${from}&to=${to}&side=short`)).json().total).toBe(0);
  });

  it("artifacts: logs tail works, HTML is sandboxed, traversal and non-artifact paths are refused", async () => {
    const log = await get(`/api/runs/${runId}/artifact?path=logs/stdout.log&tail=2000`);
    expect(log.statusCode).toBe(200);
    expect(log.body.length).toBeLessThanOrEqual(2000);
    const html = await get(`/api/runs/${runId}/artifact?path=engine/report.html`);
    expect(html.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(html.headers["content-type"]).toMatch(/text\/html/);
    for (const p of ["../../etc/passwd", "engine/../../../x", "run.json", "/etc/passwd", "engine"]) {
      expect([400, 403]).toContain((await get(`/api/runs/${runId}/artifact?path=${encodeURIComponent(p)}`)).statusCode);
    }
    expect((await get(`/api/runs/${runId}/artifact?path=logs/none.log`)).statusCode).toBe(404);
  });

  it("SSE streams a live run to completion and a late client replays it", async () => {
    const r = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", ...oct, force: true });
    const id = r.json().runId as string;
    const res = await fetch(`${base}/api/runs/${id}/events`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await readAll(res);
    expect(text).toMatch(/event: run/);
    expect(text).toMatch(/"status":"done"/);
    const replay = await readAll(await fetch(`${base}/api/runs/${id}/events`));
    expect(replay).toMatch(/"status":"done"/);
  });

  it("Monte Carlo runs on the trade list, persists its seed, and refuses too few trades", async () => {
    const mc = await post(`/api/runs/${runId}/montecarlo`, { method: "block", sims: 500, seed: 7 });
    expect(mc.statusCode).toBe(200);
    const b = mc.json();
    expect(b).toMatchObject({ method: "block", seed: 7, sims: 500, trades: 40 });
    expect(b.observed.finalEquity).toBeCloseTo(10_000 + 376.85, 3);
    expect((await get(`/api/runs/${runId}/montecarlo`)).json().results.length).toBeGreaterThanOrEqual(1);
    expect((await post(`/api/runs/${runId}/montecarlo`, { sims: 1e9 })).statusCode).toBe(400);
    const short = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", from: "2024-10-01", to: "2024-10-04", tier: "draft" });
    const sid = short.json().runId as string;
    await until(async () => ["done", "failed"].includes((await get(`/api/runs/${sid}`)).json().status));
    const tooFew = await post(`/api/runs/${sid}/montecarlo`, {});
    expect(tooFew.statusCode).toBe(422);
    expect(tooFew.json().have).toBeLessThan(30);
  });

  it("DELETE removes a run and its index row", async () => {
    const r = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", from: "2024-10-01", to: "2024-10-05", tier: "draft" });
    const id = r.json().runId as string;
    await until(async () => ["done", "failed"].includes((await get(`/api/runs/${id}`)).json().status));
    expect((await studio.app.inject({ method: "DELETE", url: `/api/runs/${id}` })).statusCode).toBe(204);
    expect((await get(`/api/runs/${id}`)).statusCode).toBe(404);
    expect((await get("/api/runs")).json().runs.some((x: { id: string }) => x.id === id)).toBe(false);
    expect(existsSync(path.join(ws, "runs", id))).toBe(false);
  });
});

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
    if (Date.now() - t0 > 60_000) throw new Error("SSE did not end");
  }
}

d("journal analytics react to filters", () => {
  let brId = "";
  it("aggregates a real bracket run: partitions agree and exit reasons are present", async () => {
    const r = await post("/api/runs", { strategy: "strategies/br.qkt", ...oct });
    brId = r.json().runId;
    await until(async () => ["done", "failed"].includes((await get(`/api/runs/${brId}`)).json().status));
    const a = (await get(`/api/runs/${brId}/analytics`)).json();
    expect(a.closed).toBeGreaterThan(20);
    expect(a.daily.reduce((n: number, d: { trades: number }) => n + d.trades, 0)).toBe(a.closed);
    expect(a.hour).toHaveLength(24);
    expect(a.weekday).toHaveLength(7);
    expect(a.exit.map((e: { reason: string }) => e.reason)).toEqual(expect.arrayContaining(["target", "stop"]));
    expect(a.rHistogram).not.toBeNull();
    expect(a.pnlHistogram.counts.reduce((x: number, y: number) => x + y, 0)).toBe(a.closed);
  });
  it("every filter narrows the analytics and the trade list identically", async () => {
    const all = (await get(`/api/runs/${brId}/analytics`)).json();
    for (const q of ["exit=target", "exit=stop", "side=long", "outcome=win", "minR=1", "weekday=2", "hour=14", "minHold=60"]) {
      const a = (await get(`/api/runs/${brId}/analytics?${q}`)).json();
      const t = (await get(`/api/runs/${brId}/trades?${q}&limit=1000`)).json();
      expect(a.count, q).toBe(t.total);
      expect(a.count, q).toBeLessThanOrEqual(all.count);
    }
    // a filter that changes nothing would slip through the loop above, so the selective ones must strictly narrow
    for (const q of ["exit=target", "exit=stop", "side=short", "outcome=win", "minR=1"]) {
      const a = (await get(`/api/runs/${brId}/analytics?${q}`)).json();
      expect(a.count, `${q} narrows`).toBeLessThan(all.count);
    }
    expect((await get(`/api/runs/${brId}/analytics?exit=target`)).json().count).toBe(all.exit.find((e: { reason: string }) => e.reason === "target").trades);
    const tg = (await get(`/api/runs/${brId}/analytics?exit=target`)).json();
    expect(tg.wins).toBe(tg.closed);
    expect(tg.exit).toHaveLength(1);
    const day = all.daily[2].day;
    const oneDay = (await get(`/api/runs/${brId}/analytics?day=${day}`)).json();
    expect(oneDay.closed).toBe(all.daily[2].trades);
    expect((await get(`/api/runs/${brId}/analytics?exit=bogus`)).json().count).toBe(all.count); // unknown values are ignored, not errors
    expect((await get("/api/runs/does-not-exist/analytics")).statusCode).toBe(404);
  });
  it("run options travel through the HTTP API", async () => {
    const r = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", ...oct, options: { startingBalance: 20000 } });
    expect(r.statusCode).toBe(202);
    const id = r.json().runId as string;
    await until(async () => ["done", "failed"].includes((await get(`/api/runs/${id}`)).json().status));
    expect((await get(`/api/runs/${id}/derived/equity`)).json().equity[0]).toBe(20000);
    const bad = await post("/api/runs", { strategy: "strategies/xau-ema.qkt", ...oct, options: { broker: "mt5-sim" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/only available in Full/);
  });
});

d("data inventory", () => {
  it("lists ticks and every built bar timeframe per symbol without reading data", async () => {
    const r = (await get("/api/data/symbols")).json();
    const x = r.symbols.find((s: { symbol: string }) => s.symbol === "XAUUSD");
    expect(x.ticks.files).toBeGreaterThan(100);
    expect(x.ticks.first <= "2024-10-01" && x.ticks.last >= "2026-01-01").toBe(true);
    expect(x.bars.find((b: { tf: string }) => b.tf === "15m")).toMatchObject({ broker: "BACKTEST" });
    expect(x.bars.find((b: { tf: string }) => b.tf === "15m").files).toBeGreaterThan(1000);
  });
  it("tick coverage marks present and absent days", async () => {
    const c = (await get("/api/data/ticks/coverage?symbol=XAUUSD&from=2024-10-01&to=2024-10-08")).json();
    expect(c.days).toHaveLength(7);
    expect(c.days[0]).toMatchObject({ day: "2024-10-01", present: true });
    const none = (await get("/api/data/ticks/coverage?symbol=NOPE&from=2024-10-01&to=2024-10-03")).json();
    expect(none.summary).toEqual({ present: 0, absent: 2 });
    expect((await get("/api/data/ticks/coverage?symbol=..&from=2024-10-01&to=2024-10-03")).statusCode).toBe(400);
    expect((await get("/api/data/ticks/coverage?symbol=X&from=2024-10-03&to=2024-10-01")).statusCode).toBe(400);
  });
});

d("live check of unsaved buffers", () => {
  const check = (kind: string, content: string) => post("/api/check", { kind, content });
  it("a clean strategy has no diagnostics", async () => {
    expect((await check("qkt", EMA)).json().diagnostics).toEqual([]);
  });
  it("syntax errors carry qkt's real position", async () => {
    const d = (await check("qkt", EMA.replace("SIZING 0.1", "SIZING"))).json().diagnostics;
    expect(d[0]).toMatchObject({ severity: "error", code: "parse" });
    expect(d[0].line).toBeGreaterThan(1);
  });
  it("an unknown indicator is relocated from 1:1 to the identifier's range", async () => {
    const d = (await check("qkt", EMA.replace("ema(gold.close, 9)", "emaa(gold.close, 9)"))).json().diagnostics;
    expect(d[0]).toMatchObject({ code: "unknown_indicator", line: 7, col: 10, endCol: 14 });
  });
  it("the silent unknown-alias mistake is reported", async () => {
    const d = (await check("qkt", EMA.replace("ema(gold.close, 9)", "ema(gld.close, 9)"))).json().diagnostics;
    expect(d.find((x: { code: string }) => x.code === "unknown_alias")).toMatchObject({ severity: "error", line: 7 });
  });
  it("checks config text: YAML errors and unknown keys", async () => {
    expect((await check("config", "starting_balance: 10000\n")).json().diagnostics).toEqual([]);
    expect((await check("config", "data_root: [unclosed\n")).json().diagnostics[0]).toMatchObject({ severity: "error", code: "bad_config_yaml" });
    expect((await check("config", "source: tv\nbogus: 1\n")).json().diagnostics[0]).toMatchObject({ severity: "warning", code: "unknown_key", line: 2 });
  });
  it("validates its input and leaves no temp files behind", async () => {
    expect((await check("nope", "x")).statusCode).toBe(400);
    expect((await post("/api/check", { kind: "qkt" })).statusCode).toBe(400);
    expect((await check("qkt", "x".repeat(1024 * 1024 + 1))).statusCode).toBe(413);
    await new Promise((r) => setTimeout(r, 200));
    expect(execSync("ls /tmp | grep -c '^qkt-check-' || true").toString().trim()).toBe("0");
  });
});

d("bars and coverage", () => {
  it("serves packed columnar bars with exclusive upper bound and honest counts", async () => {
    const from = Date.UTC(2024, 9, 1), to = Date.UTC(2024, 9, 31);
    const r = await get(`/api/bars?broker=BACKTEST&symbol=XAUUSD&tf=15m&from=${from}&to=${to}&max=20000`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-bars-count"]).toBe("2021");
    const buf = r.rawPayload;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(dv.getUint32(0, true)).toBe(2021);
    expect(dv.getFloat64(8, true)).toBe(900_000);
    expect(buf.byteLength).toBe(16 + 2021 * 6 * 8);
    const lod = await get(`/api/bars?broker=BACKTEST&symbol=XAUUSD&tf=15m&from=${from}&to=${to}&max=300`);
    expect(Number(lod.headers["x-bars-count"])).toBeLessThanOrEqual(300);
    expect(lod.headers["x-bars-source-count"]).toBe("2021");
  });
  it("reads a timeframe from a finer base folder, aggregated the way qkt does, and refuses a base that does not divide it", async () => {
    const from = Date.UTC(2024, 9, 1), to = Date.UTC(2024, 9, 31);
    const unpack = (r: { rawPayload: Buffer }) => {
      const b = r.rawPayload, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint32(0, true);
      const col = (c: number) => Array.from({ length: n }, (_, i) => dv.getFloat64(16 + (c * n + i) * 8, true));
      return { n, step: dv.getFloat64(8, true), ts: col(0), open: col(1), high: col(2), low: col(3), close: col(4) };
    };
    const m15 = unpack(await get(`/api/bars?broker=BACKTEST&symbol=XAUUSD&tf=15m&from=${from}&to=${to}&max=20000`));
    const h1 = unpack(await get(`/api/bars?broker=BACKTEST&symbol=XAUUSD&tf=1h&base=15m&from=${from}&to=${to}&max=20000`));
    expect(h1.step).toBe(3_600_000);
    expect(h1.ts.every((t) => t % 3_600_000 === 0)).toBe(true);
    // every hour is the open of its first quarter, the close of its last, the extremes of all of them
    for (let i = 0; i < h1.n; i++) {
      const q = m15.ts.flatMap((t, j) => (t >= h1.ts[i]! && t < h1.ts[i]! + 3_600_000 ? [j] : []));
      expect(q.length).toBeGreaterThan(0);
      expect(h1.open[i]).toBe(m15.open[q[0]!]);
      expect(h1.close[i]).toBe(m15.close[q[q.length - 1]!]);
      expect(h1.high[i]).toBe(Math.max(...q.map((j) => m15.high[j]!)));
      expect(h1.low[i]).toBe(Math.min(...q.map((j) => m15.low[j]!)));
    }
    const cov = (await get("/api/bars/coverage?broker=BACKTEST&symbol=XAUUSD&tf=1h&base=15m&from=2024-10-01&to=2024-10-08")).json();
    expect(cov.base).toBe("15m");
    for (const q of ["tf=15m&base=1h", "tf=1h&base=7m", "tf=1h&base=zz"]) {
      expect((await get(`/api/bars?broker=BACKTEST&symbol=XAUUSD&${q}&from=${from}&to=${to}`)).statusCode, q).toBe(400);
    }
  });
  it("rejects bad parameters and never lets identifiers become paths", async () => {
    for (const q of ["broker=..&symbol=X&tf=15m&from=2024-10-01&to=2024-10-02", "broker=B&symbol=..&tf=15m&from=2024-10-01&to=2024-10-02", "broker=.&symbol=X&tf=15m&from=2024-10-01&to=2024-10-02", "broker=B&symbol=../x&tf=15m&from=2024-10-01&to=2024-10-02",
      "broker=B&symbol=X&tf=zz&from=2024-10-01&to=2024-10-02", "broker=B&symbol=X&tf=15m&from=2024-10-02&to=2024-10-01", "broker=B&symbol=X&tf=15m&from=2000-01-01&to=2024-10-01", "symbol=X"]) {
      expect((await get(`/api/bars?${q}`)).statusCode, q).toBe(400);
    }
  });
  it("coverage separates closed days (empty file) from missing days (no file)", async () => {
    const c = (await get("/api/bars/coverage?broker=BACKTEST&symbol=XAUUSD&tf=15m&from=2024-10-01&to=2024-10-08")).json();
    const byDay = Object.fromEntries(c.days.map((x: { day: string; status: string; bars: number }) => [x.day, x]));
    expect(byDay["2024-10-02"]).toMatchObject({ status: "ok", bars: 92 });
    expect(byDay["2024-10-05"]).toMatchObject({ status: "closed", bars: 0 }); // Saturday
    expect(byDay["2024-10-06"].bars).toBe(8); // Sunday evening session is not "thin"
    expect(byDay["2024-10-06"].status).toBe("ok");
    expect(c.summary.missing).toBe(0);
    const future = (await get("/api/bars/coverage?broker=BACKTEST&symbol=XAUUSD&tf=15m&from=2031-01-05&to=2031-01-08")).json();
    expect(future.summary).toMatchObject({ missing: 3, ok: 0 });
  });
  it("reports the first and last day available, and nulls for an unknown symbol", async () => {
    const r = (await get("/api/bars/range?broker=BACKTEST&symbol=XAUUSD&tf=15m")).json();
    expect(r.first).toBe("2017-01-02");
    expect(r.last >= "2026-01-31").toBe(true);
    expect(r.files).toBeGreaterThan(1000);
    expect((await get("/api/bars/range?broker=BACKTEST&symbol=NOPE&tf=15m")).json()).toMatchObject({ first: null, last: null, files: 0 });
    expect((await get("/api/bars/range?broker=..&symbol=X&tf=15m")).statusCode).toBe(400);
  });
  it("lists the symbols and timeframes in the store", async () => {
    const s = (await get("/api/bars/symbols")).json().symbols;
    expect(s.find((x: { symbol: string }) => x.symbol === "XAUUSD").timeframes).toContain("15m");
  });
});

d("jobs", () => {
  const job = async (id: string) => until(async () => { const j = (await get(`/api/jobs/${id}`)).json(); return j.status !== "running" ? j : false; });

  it("build-bars builds into the data root and matches qkt's own files byte for byte", async () => {
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "data-")));
    mkdirSync(path.join(scratch, "symbols", "XAUUSD"), { recursive: true });
    for (const day of ["2024-10-01", "2024-10-02", "2024-10-03"]) copyFileSync(path.join(realData, "symbols", "XAUUSD", `${day}.csv.gz`), path.join(scratch, "symbols", "XAUUSD", `${day}.csv.gz`));
    const s2 = await createStudio({ ...cfg, workspace: realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws2-"))), dataRoot: scratch });
    const r = await s2.app.inject({ method: "POST", url: "/api/data/build-bars", payload: { symbol: "XAUUSD", tf: "15m", from: "2024-10-01", to: "2024-10-03" } });
    expect(r.statusCode).toBe(202);
    const id = r.json().jobId;
    const j = await until(async () => { const x = (await s2.app.inject({ url: `/api/jobs/${id}` })).json(); return x.status !== "running" ? x : false; });
    expect(j.status).toBe("done");
    expect(j.command).toMatch(/data build-bars XAUUSD --tf 15m/);
    const mine = path.join(scratch, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-02.bin");
    expect(existsSync(mine)).toBe(true);
    expect(readFileSync(mine).equals(readFileSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-02.bin")))).toBe(true);
    for (const bad of [{ symbol: "../x", tf: "15m", from: "2024-10-01", to: "2024-10-03" }, { symbol: "X", tf: "bad", from: "2024-10-01", to: "2024-10-03" }, { symbol: "X", tf: "15m", from: "2024-10-03", to: "2024-10-01" }]) {
      expect((await s2.app.inject({ method: "POST", url: "/api/data/build-bars", payload: bad })).statusCode).toBe(400);
    }
    await s2.app.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("a parameter grid runs one full run per point, ranks them, and links each run", async () => {
    const r = await post("/api/jobs/grid", { strategy: "strategies/param.qkt", ...oct, params: { fast: ["5", "9"], slow: ["21", "34"] }, rank: "sharpe" });
    expect(r.statusCode).toBe(202);
    const j = await job(r.json().jobId);
    expect(j.status).toBe("done");
    expect(j.progress).toEqual({ done: 4, total: 4 });
    const rows = j.result.rows as Array<{ params: Record<string, string>; runId: string; status: string; summary: { sharpe: number; trades: number } }>;
    expect(rows.length).toBe(4);
    expect(rows.every((x) => x.status === "done" && x.runId && x.summary.trades > 0)).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.summary.sharpe).toBeGreaterThanOrEqual(rows[i]!.summary.sharpe);
    expect(new Set(rows.map((x) => x.runId)).size).toBe(4);
    expect(existsSync(path.join(ws, "runs", rows[0]!.runId, "derived", "roundtrips.json"))).toBe(true);
  });

  it("grid validation: unknown params, empty axes, oversized grids", async () => {
    expect((await post("/api/jobs/grid", { strategy: "strategies/param.qkt", ...oct, params: { nope: ["1"] } })).statusCode).toBe(400);
    expect((await post("/api/jobs/grid", { strategy: "strategies/param.qkt", ...oct, params: {} })).statusCode).toBe(400);
    const big = { fast: Array.from({ length: 15 }, (_, i) => String(i + 2)), slow: Array.from({ length: 15 }, (_, i) => String(i + 20)) };
    expect((await post("/api/jobs/grid", { strategy: "strategies/param.qkt", ...oct, params: big })).statusCode).toBe(400);
  });

  it("walk-forward returns folds, winner counts and a stitched out-of-sample equity curve", async () => {
    const r = await post("/api/jobs/walkforward", { strategy: "strategies/param.qkt", from: "2024-09-01", to: "2024-12-31", tier: "draft", params: { fast: ["5", "9", "13"], slow: ["21", "34"] }, train: "45d", test: "15d", step: "15d" });
    expect(r.statusCode).toBe(202);
    const j = await job(r.json().jobId);
    expect(j.status).toBe("done");
    expect(j.result.folds.length).toBe(5);
    expect(j.result.oosEquity.ts.length).toBeGreaterThan(100);
    expect(Object.keys(j.result.winnerCounts).length).toBeGreaterThan(0);
  });

  it("jobs can be cancelled", async () => {
    const r = await post("/api/jobs/walkforward", { strategy: "strategies/param.qkt", from: "2026-02-02", to: "2026-03-31", tier: "full", allowIncomplete: true, params: { fast: ["5", "9"], slow: ["21"] }, train: "20d", test: "10d", step: "10d" });
    const id = r.json().jobId as string;
    await new Promise((x) => setTimeout(x, 1500));
    expect((await post(`/api/jobs/${id}/cancel`, {})).statusCode).toBe(200);
    expect((await job(id)).status).toBe("cancelled");
    expect((await post(`/api/jobs/${id}/cancel`, {})).statusCode).toBe(409);
  });
});

function wsSession(url: string) {
  const sock = new WebSocket(url);
  const msgs: string[] = [];
  const waiters: Array<{ pred: (m: string) => boolean; res: (m: string) => void }> = [];
  sock.on("message", (d) => { const m = d.toString(); msgs.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } });
  const opened = new Promise<void>((res, rej) => { sock.on("open", () => res()); sock.on("error", rej); });
  const wait = (pred: (m: string) => boolean, ms = 8000) => new Promise<string>((res, rej) => {
    const hit = msgs.find(pred); if (hit) return res(hit);
    waiters.push({ pred, res }); setTimeout(() => rej(new Error("ws timeout; got: " + msgs.slice(-3).join(" | "))), ms);
  });
  return { sock, msgs, opened, wait };
}

d("LSP bridge", () => {
  it("initialises qkt lsp, reports diagnostics for a bad document, and cleans up the child", async () => {
    const s = wsSession(`${base.replace("http", "ws")}/ws/lsp`);
    await s.opened;
    const send = (o: object) => s.sock.send(JSON.stringify({ jsonrpc: "2.0", ...o }));
    send({ id: 1, method: "initialize", params: { processId: null, rootUri: `file://${ws}`, capabilities: {} } });
    const init = JSON.parse(await s.wait((m) => JSON.parse(m).id === 1));
    expect(init.result.capabilities.hoverProvider).toBeTruthy();
    send({ method: "initialized", params: {} });
    const uri = `file://${ws}/strategies/t.qkt`;
    send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "qkt", version: 1, text: EMA.replace("CROSSES ABOVE", "CROSSES ABOV") } } });
    const diag = JSON.parse(await s.wait((m) => JSON.parse(m).method === "textDocument/publishDiagnostics"));
    expect(diag.params.diagnostics[0]).toMatchObject({ severity: 1 });
    expect(diag.params.diagnostics[0].message).toMatch(/ABOVE or BELOW/);
    send({ id: 2, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 6, character: 10 } } });
    expect(JSON.parse(await s.wait((m) => JSON.parse(m).id === 2)).result.contents.value).toMatch(/ema\(value, period\)/);
    s.sock.close();
    await new Promise((r) => setTimeout(r, 800));
    expect(execSync("ps -eo args | grep -F 'qkt' | grep -F ' lsp' | grep -v grep | grep -F -- \"-classpath\" | grep -F \"$(realpath ~/.local/bin/qkt | xargs dirname | xargs dirname)\" | wc -l || true").toString().trim()).toBe("0");
  });
});

d("terminal", () => {
  it("restricted mode runs whitelisted qkt commands and refuses everything else", async () => {
    const s = wsSession(`${base.replace("http", "ws")}/ws/term`);
    await s.opened;
    expect(JSON.parse(await s.wait((m) => JSON.parse(m).t === "hello")).mode).toBe("restricted");
    const run = async (line: string) => { s.msgs.length = 0; s.sock.send(JSON.stringify({ t: "cmd", line })); return JSON.parse(await s.wait((m) => JSON.parse(m).t === "exit")); };
    expect((await run("qkt --version")).code).toBe(0);
    expect(s.msgs.join("")).toMatch(/qkt \d+\.\d+/);
    expect((await run("qkt parse strategies/xau-ema.qkt")).code).toBe(0);
    for (const bad of ["rm -rf /", "qkt daemon --load-dir /", "qkt parse x.qkt; rm -rf ~", "qkt parse $(id)", "qkt parse ../../etc/passwd", "qkt parse /etc/passwd", "cat /etc/passwd"]) {
      const r = await run(bad);
      expect(r.code, bad).not.toBe(0);
    }
    expect(s.msgs.join("")).not.toMatch(/root:/);
    s.sock.close();
  });

  it("shell mode gives a real pty bash in the workspace (loopback/token only)", async () => {
    const shell = await createStudio({ ...cfg, terminal: "shell", workspace: ws });
    await shell.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (shell.app.server.address() as { port: number }).port;
    const s = wsSession(`ws://127.0.0.1:${port}/ws/term`);
    await s.opened;
    expect(JSON.parse(await s.wait((m) => JSON.parse(m).t === "hello")).mode).toBe("shell");
    s.sock.send(JSON.stringify({ t: "in", d: "echo sum-$((40+2)) && pwd && tty | grep -c pts\n" }));
    await s.wait((m) => /sum-42/.test(m));
    const out = s.msgs.map((m) => (JSON.parse(m) as { d?: string }).d ?? "").join("");
    expect(out).toContain("sum-42");
    expect(out).toContain(ws);
    s.sock.send(JSON.stringify({ t: "in", d: "exit\n" }));
    await s.wait((m) => JSON.parse(m).t === "exit");
    await shell.app.close();
  });
});

describe("terminal helpers", () => {
  it("tokenize handles quotes and rejects shell operators", () => {
    expect(tokenize("qkt parse 'my file.qkt'")).toEqual(["qkt", "parse", "my file.qkt"]);
    expect(tokenize('qkt backtest "a b.qkt" --from 2024-01-01')).toEqual(["qkt", "backtest", "a b.qkt", "--from", "2024-01-01"]);
    for (const bad of ["a; b", "a | b", "a && b", "a > f", "$(x)", "`x`", "a *", "'unclosed"]) expect(tokenize(bad), bad).toBeNull();
    expect(tokenize("   ")).toEqual([]);
  });
  it("checkRestricted allows the whitelist and blocks escapes", () => {
    expect(checkRestricted(["qkt", "backtest", "s.qkt", "--report-dir", "runs/x"], "/w", "/d")).toBeNull();
    expect(checkRestricted(["qkt", "daemon"], "/w", "/d")).toMatch(/Not allowed/);
    expect(checkRestricted(["rm"], "/w", "/d")).toMatch(/command not found/);
    expect(checkRestricted(["qkt", "parse", "a/../../b"], "/w", "/d")).toMatch(/\.\./);
    expect(checkRestricted(["qkt", "parse", "/etc/passwd"], "/w", "/d")).toMatch(/outside/);
    expect(checkRestricted(["qkt", "parse", "/w/s.qkt"], "/w", "/d")).toBeNull();
  });
});

describe("run housekeeping", () => {
  it("prune deletes the files of the chosen runs and reports the space it freed; usage lists them", async () => {
    // relies on the runs created by earlier tests in this file being present
    const before = (await studio.app.inject({ url: "/api/runs-usage" })).json() as { total: number; perRun: Record<string, number> };
    const ids = Object.keys(before.perRun);
    if (!ids.length) return;
    const victim = ids[0]!;
    const r = (await studio.app.inject({ method: "POST", url: "/api/runs/prune", payload: { ids: [victim] } })).json();
    expect(r.deleted).toEqual([victim]);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(existsSync(path.join(ws, "runs", victim))).toBe(false);
    expect((await studio.app.inject({ url: `/api/runs/${victim}` })).statusCode).toBe(404);
    const after = (await studio.app.inject({ url: "/api/runs-usage" })).json() as { total: number };
    expect(after.total).toBeLessThan(before.total);
    expect((await studio.app.inject({ method: "POST", url: "/api/runs/prune", payload: {} })).statusCode).toBe(400);
  });
});

describe.skipIf(!haveQkt)("live check of a portfolio resolves its imports from the file's own folder", () => {
  it("a valid portfolio buffer has no diagnostics; a missing import names the workspace path", async () => {
    const dir = path.join(ws, "strategies");
    writeFileSync(path.join(dir, "child_a.qkt"), "STRATEGY child_a VERSION 1\n\nSYMBOLS\n    g = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN g.close > 0\n     AND POSITION.g = 0\n    THEN BUY g SIZING 0.1\n");
    const book = "PORTFOLIO pb VERSION 1\n\nIMPORT 'child_a.qkt' AS a\n\nRULES\n    RUN a\n";
    const ok = (await studio.app.inject({ method: "POST", url: "/api/check", payload: { kind: "qkt", content: book, path: "strategies/pb.qkt" } })).json();
    expect(ok.diagnostics).toEqual([]);
    const bad = (await studio.app.inject({ method: "POST", url: "/api/check", payload: { kind: "qkt", content: book.replace("child_a.qkt", "nope.qkt"), path: "strategies/pb.qkt" } })).json();
    expect(bad.diagnostics[0].message).toMatch(/nope\.qkt/);
    expect(readdirSync(dir).some((n) => n.startsWith(".qkt-check-"))).toBe(false); // the check copy is always removed
  });
});
