import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanStore, seriesDays } from "../src/data-scan.js";

function barFile(symbol: string, tfMs: number, n: number): Buffer {
  const sym = Buffer.from("BACKTEST:" + symbol);
  const head = Buffer.alloc(4 + 4 + 4 + 8 + 4 + sym.length + 4);
  let o = 0;
  head.write("QKB1", o, "latin1"); o += 4; head.writeInt32LE(1, o); o += 4; head.writeInt32LE(8, o); o += 4;
  head.writeBigInt64LE(BigInt(tfMs), o); o += 8; head.writeInt32LE(sym.length, o); o += 4; sym.copy(head, o); o += sym.length; head.writeInt32LE(n, o);
  return Buffer.concat([head, Buffer.alloc(n * 6 * 8)]);
}
const day = (y: number, m: number, d: number, add = 0) => new Date(Date.UTC(y, m - 1, d) + add * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dow = (d: Date) => d.getUTCDay();

let store: string;
const put = (sym: string, tf: string, files: Array<[string, number]>) => {
  const dir = path.join(store, "bars", "BACKTEST", sym, tf);
  mkdirSync(dir, { recursive: true });
  for (const [d, n] of files) writeFileSync(path.join(dir, `${d}.bin`), barFile(sym, 900_000, n));
};
/** Every day of 2023-01-02 .. 2024-06-30 through `f`, which returns a bar count or null for "no file". */
function span(f: (d: Date) => number | null): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let d = day(2023, 1, 2); d <= day(2024, 6, 30); d = day(2023, 1, 2, Math.round((d.getTime() - day(2023, 1, 2).getTime()) / 86_400_000) + 1)) {
    const n = f(d); if (n !== null) out.push([iso(d), n]);
  }
  return out;
}

beforeAll(() => {
  store = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cal-")));
  // Mon-Fri market: no file at all on weekends (daily-bar style), plus a lone missing Wednesday
  put("FIVE", "15m", span((d) => (dow(d) === 0 || dow(d) === 6 ? null : iso(d) === "2023-03-15" ? null : 92)));
  // 24/7 market: bars every day except one Saturday that is an empty file (a hole) and one Sunday with no file
  put("CRYPTO", "15m", span((d) => (iso(d) === "2023-06-10" ? 0 : iso(d) === "2023-06-11" ? null : 96)));
  // three more Mon-Fri symbols that all skip 2023-05-29 (a market holiday) and 2023-12-25; one of them ALSO has a private gap
  for (const s of ["A1", "A2", "A3"]) put(s, "15m", span((d) => (["2023-05-29", "2023-12-25"].includes(iso(d)) || dow(d) === 0 || dow(d) === 6 || (s === "A3" && iso(d) === "2023-08-09") ? null : 92)));
  // a series that follows the US exchange calendar in 2023-24 (absent on every US holiday) but is otherwise complete
  const us = new Set(["2023-01-02", "2023-01-16", "2023-02-20", "2023-04-07", "2023-05-29", "2023-06-19", "2023-07-04", "2023-09-04", "2023-11-23", "2023-11-24", "2023-12-25", "2023-12-24", "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29"]);
  put("FUT", "1440m", span((d) => (dow(d) === 0 || dow(d) === 6 || us.has(iso(d)) ? null : 1)));
  // 24/7 market that traded a weekday schedule for the whole of 2023 (older CFD feed) and 24/7 after that
  put("OLDCRYPTO", "15m", span((d) => (d.getUTCFullYear() === 2023 && (dow(d) === 6 || dow(d) === 0) ? 0 : 96)));
});
afterAll(() => rmSync(store, { recursive: true, force: true }));

const bars = async (sym: string) => (await scanStore(store)).symbols.find((s) => s.symbol === sym)!;

describe("calendar-aware completeness", () => {
  it("a Mon-Fri market: absent weekends are closed, only the lone weekday is a gap", async () => {
    const s = await bars("FIVE");
    expect(s.market).toBe("Mon-Fri");
    expect(s.bars[0]!.gaps).toEqual([{ from: "2023-03-15", to: "2023-03-16" }]);
    expect(s.bars[0]!.missing).toBe(1);
  });
  it("a 24/7 market: an empty Saturday or an absent Sunday IS a hole", async () => {
    const s = await bars("CRYPTO");
    expect(s.market).toBe("24/7");
    expect(s.bars[0]!.missing).toBe(2);
    expect(s.bars[0]!.gaps).toEqual([{ from: "2023-06-10", to: "2023-06-12" }]);
  });
  it("fixed holidays (Dec 25) are never a gap for a Mon-Fri market", async () => {
    const s = await bars("FIVE");
    expect(s.bars[0]!.gaps.some((g) => g.from <= "2023-12-25" && g.to > "2023-12-25")).toBe(false);
  });
  it("a weekday most other symbols also lack is a market holiday, not a gap; a private gap still is one", async () => {
    const r = await scanStore(store);
    const g = (n: string) => r.symbols.find((s) => s.symbol === n)!.bars[0]!.gaps;
    expect(g("A1")).toEqual([]);
    expect(g("A2")).toEqual([]);
    expect(g("A3")).toEqual([{ from: "2023-08-09", to: "2023-08-10" }]);
  });
  it("a series that skips US exchange holidays learns them from its own data", async () => {
    expect((await bars("FUT")).bars[0]!.gaps).toEqual([]);
  });
  it("a year with no Saturday trading in a 24/7 market is a weekday-schedule year, not 104 gaps", async () => {
    const s = await bars("OLDCRYPTO");
    expect(s.market).toBe("24/7");
    expect(s.bars[0]!.missing).toBe(0);
    expect(s.bars[0]!.status).toBe("complete");
  });
  it("seriesDays gives one status letter per calendar day", async () => {
    const r = await seriesDays(store, "CRYPTO", { broker: "BACKTEST", tf: "15m" });
    expect(r!.first).toBe("2023-01-02");
    const i = Math.round((day(2023, 6, 10).getTime() - day(2023, 1, 2).getTime()) / 86_400_000);
    expect(r!.days.slice(i, i + 3)).toBe("mmo");
  });
});
