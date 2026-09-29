import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { scanStore, seriesDays } from "../src/data-scan.js";
import { acceptNoData, emptyBarDay, readAccepted, undoNoData } from "../src/no-data.js";

function barFile(symbol: string, tfMs: number, n: number): Buffer {
  const sym = Buffer.from("BACKTEST:" + symbol);
  const head = Buffer.alloc(4 + 4 + 4 + 8 + 4 + sym.length + 4);
  let o = 0;
  head.write("QKB1", o, "latin1"); o += 4; head.writeInt32LE(1, o); o += 4; head.writeInt32LE(8, o); o += 4;
  head.writeBigInt64LE(BigInt(tfMs), o); o += 8; head.writeInt32LE(sym.length, o); o += 4; sym.copy(head, o); o += sym.length; head.writeInt32LE(n, o);
  return Buffer.concat([head, Buffer.alloc(n * 6 * 8)]);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dow = (d: Date) => d.getUTCDay();

let store: string;
const put = (sym: string, tf: string, files: Array<[string, number]>, broker = "BACKTEST") => {
  const dir = path.join(store, "bars", broker, sym, tf);
  mkdirSync(dir, { recursive: true });
  for (const [d, n] of files) writeFileSync(path.join(dir, `${d}.bin`), barFile(sym, 900_000, n));
};
/** Every day from `from` to `to` inclusive through `f`, which returns a bar count or null for "no file". */
function span(from: string, to: string, f: (d: Date) => number | null): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) { const d = new Date(t); const n = f(d); if (n !== null) out.push([iso(d), n]); }
  return out;
}
const sat = (d: Date) => dow(d) === 6;

beforeAll(() => {
  store = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cal-")));
  // qkt's own verdict on the forge store: XAGUSD 2022-04-11..20 is "6/8 trading days; missing 2022-04-14,2022-04-15"
  // (no file on Maundy Thursday or Good Friday; the fx calendar has no holidays, Sunday counts, Saturday does not)
  put("XAGUSD", "15m", span("2022-04-10", "2022-04-20", (d) => (sat(d) || ["2022-04-14", "2022-04-15"].includes(iso(d)) ? null : 92)));
  // fx with an EMPTY file on a weekday (how qkt marks a day without trading) and one weekday with no file
  put("EURUSD", "15m", span("2023-12-17", "2024-01-05", (d) => (sat(d) ? null : iso(d) === "2023-12-25" ? 0 : iso(d) === "2024-01-03" ? null : 92)));
  // crypto: every day expected; an empty Saturday and an absent Sunday are both holes
  put("BTCUSD", "15m", span("2023-06-01", "2023-06-30", (d) => (iso(d) === "2023-06-10" ? 0 : iso(d) === "2023-06-11" ? null : 96)));
  // NYSE index: no files on weekends or Good Friday 2023 (a NYSE holiday); one ordinary weekday missing
  put("SPX", "15m", span("2023-04-03", "2023-04-14", (d) => (sat(d) || dow(d) === 0 || ["2023-04-07", "2023-04-12"].includes(iso(d)) ? null : 26)));
  // ticks: a real day, a header-only csv and a header-only csv.gz (a source that recorded nothing), then a real day
  const tdir = path.join(store, "symbols", "ETHUSD");
  mkdirSync(tdir, { recursive: true });
  const head = "timestamp,bid,ask\n", row = (t: string) => `${Date.parse(t)},1800.1,1800.3\n`;
  writeFileSync(path.join(tdir, "2024-03-01.csv"), head + Array.from({ length: 24 }, (_, h) => row(`2024-03-01T${String(h).padStart(2, "0")}:10:00Z`)).join(""));
  writeFileSync(path.join(tdir, "2024-03-02.csv"), head);
  writeFileSync(path.join(tdir, "2024-03-03.csv.gz"), gzipSync(head));
  writeFileSync(path.join(tdir, "2024-03-04.csv.gz"), gzipSync(head + Array.from({ length: 24 }, (_, h) => row(`2024-03-04T${String(h).padStart(2, "0")}:10:00Z`)).join("")));
  // a daily feed (one row per day, as older futures "ticks" are): qkt's hourly check rejects every such day
  writeFileSync(path.join(tdir, "2024-03-05.csv.gz"), gzipSync(head + row("2024-03-05T00:00:00Z")));
});
afterAll(() => rmSync(store, { recursive: true, force: true }));

const sym = async (s: string) => (await scanStore(store)).symbols.find((x) => x.symbol === s)!;

describe("completeness follows qkt's calendars exactly", () => {
  it("reproduces qkt's verdict on XAGUSD 2022-04-11..20: missing 2022-04-14 and 2022-04-15", async () => {
    const s = await sym("XAGUSD");
    expect(s.market).toBe("Mon-Fri");
    expect(s.bars[0]!.gaps).toEqual([{ from: "2022-04-14", to: "2022-04-16" }]);
    expect(s.bars[0]!.missing).toBe(2);
  });
  it("fx: an empty file is a closed day (qkt accepts it); a weekday with no file is a gap; Saturdays are closed", async () => {
    const b = (await sym("EURUSD")).bars[0]!;
    expect(b.gaps).toEqual([{ from: "2024-01-03", to: "2024-01-04" }]);
    expect(b.closed).toBe(3); // Saturdays Dec 23 and Dec 30, and the empty Dec 25
  });
  it("crypto: an empty Saturday and an absent Sunday are both holes", async () => {
    const s = await sym("BTCUSD");
    expect(s.market).toBe("24/7");
    expect(s.bars[0]!.gaps).toEqual([{ from: "2023-06-10", to: "2023-06-12" }]);
  });
  it("NYSE: weekends and Good Friday are closed, an ordinary weekday is a gap", async () => {
    expect((await sym("SPX")).bars[0]!.gaps).toEqual([{ from: "2023-04-12", to: "2023-04-13" }]);
  });
  it("a tick file qkt would reject is missing: only a header, or one row for the whole day", async () => {
    const t = (await sym("ETHUSD")).ticks!;
    expect(t.present).toBe(5);
    expect(t.gaps).toEqual([{ from: "2024-03-02", to: "2024-03-04" }, { from: "2024-03-05", to: "2024-03-06" }]);
  });
  it("seriesDays gives one status letter per calendar day", async () => {
    const r = await seriesDays(store, "BTCUSD", { broker: "BACKTEST", tf: "15m" });
    expect(r!.first).toBe("2023-06-01");
    expect(r!.days.slice(9, 12)).toBe("mmo");
  });
});

describe("accept as no data", () => {
  it("writes qkt's empty day file, clears the gap, and undo puts it back", async () => {
    const r = await acceptNoData(store, { broker: "BACKTEST", symbol: "XAGUSD", tf: "15m", days: ["2022-04-14", "2022-04-15", "2022-04-16", "2022-04-13"] });
    expect(r).toEqual({ accepted: ["2022-04-14", "2022-04-15"], skipped: [
      { day: "2022-04-13", reason: "has bars" }, { day: "2022-04-16", reason: "not a trading day for qkt: nothing is expected" }] });
    const file = path.join(store, "bars/BACKTEST/XAGUSD/15m/2022-04-14.bin");
    expect(readFileSync(file).equals(barFile("XAGUSD", 900_000, 0))).toBe(true);
    expect(emptyBarDay("BACKTEST", "XAGUSD", 900_000).equals(barFile("XAGUSD", 900_000, 0))).toBe(true);
    expect((await sym("XAGUSD")).bars[0]!.status).toBe("complete");
    expect((await readAccepted(store)).map((e) => e.day)).toEqual(["2022-04-14", "2022-04-15"]);
    expect(await undoNoData(store, { broker: "BACKTEST", symbol: "XAGUSD", tf: "15m", days: ["2022-04-14", "2022-04-15"] })).toEqual({ undone: ["2022-04-14", "2022-04-15"] });
    expect(existsSync(file)).toBe(false);
    expect((await sym("XAGUSD")).bars[0]!.missing).toBe(2);
    expect(await readAccepted(store)).toEqual([]);
  });
  it("crypto: an accepted empty day counts as closed; undo keeps an empty file the studio did not write", async () => {
    await acceptNoData(store, { broker: "BACKTEST", symbol: "BTCUSD", tf: "15m", days: ["2023-06-10", "2023-06-11"] });
    expect((await sym("BTCUSD")).bars[0]!.status).toBe("complete");
    await undoNoData(store, { broker: "BACKTEST", symbol: "BTCUSD", tf: "15m", days: ["2023-06-10", "2023-06-11"] });
    expect(existsSync(path.join(store, "bars/BACKTEST/BTCUSD/15m/2023-06-10.bin"))).toBe(true);  // was there before
    expect(existsSync(path.join(store, "bars/BACKTEST/BTCUSD/15m/2023-06-11.bin"))).toBe(false); // written by accept
    expect((await sym("BTCUSD")).bars[0]!.missing).toBe(2);
  });
  it("a folder that links into another store becomes a folder of links; the other store is never written", async () => {
    const archive = realpathSync(mkdtempSync(path.join(os.tmpdir(), "arch-")));
    const adir = path.join(archive, "AUDUSD", "15m");
    mkdirSync(adir, { recursive: true });
    for (const [d, n] of span("2024-02-05", "2024-02-09", (d) => (iso(d) === "2024-02-07" ? null : 92))) writeFileSync(path.join(adir, `${d}.bin`), barFile("AUDUSD", 900_000, n));
    mkdirSync(path.join(store, "bars", "BACKTEST", "AUDUSD"), { recursive: true });
    const link = path.join(store, "bars", "BACKTEST", "AUDUSD", "15m");
    symlinkSync(adir, link);
    await acceptNoData(store, { broker: "BACKTEST", symbol: "AUDUSD", tf: "15m", days: ["2024-02-07"] });
    expect(lstatSync(link).isDirectory()).toBe(true);
    expect(readdirSync(adir).sort()).toEqual(["2024-02-05.bin", "2024-02-06.bin", "2024-02-08.bin", "2024-02-09.bin"]);
    expect(lstatSync(path.join(link, "2024-02-05.bin")).isSymbolicLink()).toBe(true);
    expect((await sym("AUDUSD")).bars[0]!.status).toBe("complete");
    rmSync(archive, { recursive: true, force: true });
    rmSync(path.join(store, "bars", "BACKTEST", "AUDUSD"), { recursive: true, force: true });
  });
  it("refuses bad input", async () => {
    expect(await acceptNoData(store, { broker: "BACKTEST", symbol: "../x", tf: "15m", days: ["2024-01-01"] })).toMatchObject({ error: expect.any(String) });
    expect(await acceptNoData(store, { broker: "BACKTEST", symbol: "XAGUSD", tf: "15m", days: ["2024-13-45"] })).toMatchObject({ error: expect.any(String) });
    expect(await acceptNoData(store, { broker: "BACKTEST", symbol: "XAGUSD", tf: "15m", days: Array.from({ length: 400 }, () => "2024-01-02") })).toMatchObject({ error: expect.any(String) });
  });
});

import { readinessFor } from "../src/data-scan.js";
describe("timeframe folders qkt cannot read", () => {
  it("a 1440m folder is flagged (qkt reads 1d), never counts as available, and readiness says how to fix it", async () => {
    const dir = path.join(store, "bars", "BACKTEST", "OILX", "1440m");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i++) { const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000); if (d.getUTCDay() % 6) writeFileSync(path.join(dir, `${d.toISOString().slice(0, 10)}.bin`), barFile("OILX", 86_400_000, 1)); }
    const r = await scanStore(store);
    const sym = r.symbols.find((s) => s.symbol === "OILX")!;
    expect(sym.bars[0]!.qktReads).toBe("1d");
    expect(sym.status).toBe("incomplete");
    expect(sym.notes.join(" ")).toMatch(/looks for "1d"/);
    const ready = readinessFor(r, "strategies/oil.qkt", "STRATEGY oil VERSION 1\n\nSYMBOLS\n    o = BACKTEST:OILX EVERY 1440m\n\nRULES\n    WHEN o.close > 0\n    THEN BUY o SIZING 1\n");
    expect(ready.bars.runnable).toBe(false);
    expect(ready.bars.blocked[0]!.reason).toMatch(/named "1440m", which qkt does not read: rename it to 1d/);
    rmSync(path.join(store, "bars", "BACKTEST", "OILX"), { recursive: true, force: true });
  });
});
