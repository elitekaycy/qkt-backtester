import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanStore, readinessFor } from "../src/data-scan.js";
import { rangesFromTimestamps, runsOfDays, scanDerivatives, kindContextOf } from "../src/derivatives-scan.js";
import { fieldUses } from "../src/derivatives-readiness.js";
import { kindOf } from "@qkt-studio/core";

const FUT = path.resolve(import.meta.dirname, "fixtures/deriv/futures");
const OPT = path.resolve(import.meta.dirname, "fixtures/deriv/options");
// a real built bar day (qkt's QKB1 format), used as a stand-in for any day of bars
const BAR_DAY = path.resolve(import.meta.dirname, "../../core/test/fixtures/bars-2024-10-02.bin");

const strat = (stream: string, cond = "x.close > 0") => `STRATEGY t VERSION 1\n\nSYMBOLS\n    x = ${stream}\n\nRULES\n    WHEN ${cond} AND POSITION.x = 0\n    THEN BUY x SIZING 0.01\n`;

describe("helpers", () => {
  it("runsOfDays keeps closed days inside a window and trims them off its edges", () => {
    // Friday 2024-09-20, Monday 2024-09-23: the weekend between is closed on a CME calendar
    expect(runsOfDays(["2024-09-20", "2024-09-23"], "cme_globex")).toEqual([{ from: "2024-09-20", to: "2024-09-24" }]);
    // the same days on a 24/7 calendar leave a hole
    expect(runsOfDays(["2024-09-20", "2024-09-23"], "crypto")).toEqual([{ from: "2024-09-20", to: "2024-09-21" }, { from: "2024-09-23", to: "2024-09-24" }]);
  });
  it("rangesFromTimestamps splits at a gap over the tolerance", () => {
    const d = (iso: string) => Date.parse(iso + "T00:00:00Z");
    expect(rangesFromTimestamps([d("2024-01-01"), d("2024-01-02"), d("2024-01-05")], 86_400_000)).toEqual([{ from: "2024-01-01", to: "2024-01-03" }, { from: "2024-01-05", to: "2024-01-06" }]);
  });
  it("fieldUses reads alias.field outside comments and strings", () => {
    const u = fieldUses("RULES\n    WHEN p.mark - p.index > 5 AND POSITION.p = 0 -- p.iv\n    THEN LOG \"p.dte\"\n");
    expect([...(u.get("p") ?? [])].sort()).toEqual(["index", "mark"]);
  });
});

describe("futures store (a real Binance quarterly slice around a roll)", () => {
  it("scans the root with its catalog, rolls, terms and contract bars, from listings alone", async () => {
    const d = await scanDerivatives(FUT);
    expect(d.instruments.exists).toBe(true);
    const root = d.futures.find((f) => f.key === "BINANCE_UM:BTCUSDT")!;
    expect(root.terms).toMatchObject({ multiplier: 1, roll: { adjust: "panama", daysBeforeExpiry: 8 } });
    expect(root.catalog).toMatchObject({ contracts: 3, delivered: 3 });
    expect(root.rolls).toMatchObject({ count: 2, policy: "8d@08:00" });
    expect(root.rolls!.schedule[1]).toMatchObject({ from: "BTCUSDT_240927", to: "BTCUSDT_241227" });
    const c = root.contracts.find((x) => x.symbol === "BTCUSDT_241227")!;
    expect(c.expiry).toBe("2024-12-27");
    expect(c.bars).toEqual([{ tf: "15m", files: 7, first: "2024-09-16", last: "2024-09-22", present: [{ from: "2024-09-16", to: "2024-09-23" }] }]);
    expect(root.contracts.find((x) => x.symbol === "BTCUSDT_240628")!.bars).toEqual([]);
  });

  it("moves contracts under their root in the plain symbol list", async () => {
    const scan = await scanStore(FUT);
    expect(scan.symbols.map((s) => s.symbol)).toEqual([]);
    expect(scan.derivatives!.futures).toHaveLength(1);
    expect(scan.looksLikeStore).toBe(true);
  });

  it("classifies streams from the store: contract, continuous, perpetual-less root", async () => {
    const ctx = kindContextOf((await scanDerivatives(FUT)));
    expect(kindOf({ broker: "BINANCE_UM", symbol: "BTCUSDT_241227" }, ctx)).toBe("future");
    expect(kindOf({ broker: "BINANCE_UM", symbol: "BTCUSDT@front" }, ctx)).toBe("continuous");
    expect(kindOf({ broker: "EXNESS", symbol: "XAUUSD" }, ctx)).toBe("cfd");
  });

  it("a listed contract is ready exactly where its bars are", async () => {
    const scan = await scanStore(FUT);
    const r = readinessFor(scan, "s.qkt", strat("BINANCE_UM:BTCUSDT_241227 EVERY 15m"));
    expect(r.kinds).toEqual({ x: "future" });
    expect(r.bars.runnable).toBe(true);
    expect(r.bars.ranges).toEqual([{ from: "2024-09-16", to: "2024-09-23" }]);
  });

  it("a listed contract with no bars at the timeframe is blocked with the fetch that fills it", async () => {
    const scan = await scanStore(FUT);
    const r = readinessFor(scan, "s.qkt", strat("BINANCE_UM:BTCUSDT_241227 EVERY 5m"));
    expect(r.bars.runnable).toBe(false);
    expect(r.bars.blocked[0]).toMatchObject({ fix: "fetch" });
    expect(r.bars.blocked[0]!.command).toMatch(/^qkt fetch BINANCE_UM:BTCUSDT_241227 --tf 5m /);
  });

  it("a continuous stream is judged per contract along the roll schedule, and needs --allow-incomplete", async () => {
    const scan = await scanStore(FUT);
    const r = readinessFor(scan, "s.qkt", strat("BINANCE_UM:BTCUSDT@front EVERY 15m"));
    expect(r.kinds).toEqual({ x: "continuous" });
    expect(r.needsAllowIncomplete).toBe(true);
    // 240927 is front from the 2024-06-20 roll to the 2024-09-19 roll but has bars only from 09-16; 241227 takes over on 09-19
    expect(r.bars.ranges).toEqual([{ from: "2024-09-16", to: "2024-09-23" }]);
    expect(r.ticks.ranges).toEqual(r.bars.ranges);
  });

  it("a continuous stream names what is missing", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "deriv-"));
    try {
      cpSync(FUT, tmp, { recursive: true });
      writeFileSync(path.join(tmp, "instruments.yaml"), "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 1\n    calendar: crypto\n");
      let r = readinessFor(await scanStore(tmp), "s.qkt", strat("BINANCE_UM:BTCUSDT@front EVERY 15m"));
      expect(r.bars.blocked[0]).toMatchObject({ fix: "terms" });
      expect(r.bars.blocked[0]!.reason).toMatch(/no roll policy/);

      writeFileSync(path.join(tmp, "instruments.yaml"), "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 1\n    calendar: crypto\n    roll: { daysBeforeExpiry: 8, atUtc: \"08:00\", adjust: ratio }\n");
      r = readinessFor(await scanStore(tmp), "s.qkt", strat("BINANCE_UM:BTCUSDT@front EVERY 15m"));
      expect(r.bars.blocked[0]!.reason).toMatch(/adjust: panama/);

      writeFileSync(path.join(tmp, "instruments.yaml"), "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 1\n    calendar: crypto\n    roll: { daysBeforeExpiry: 8, atUtc: \"08:00\", adjust: panama }\n");
      r = readinessFor(await scanStore(tmp), "s.qkt", strat("BINANCE_UM:BTCUSDT@front EVERY 1d"));
      expect(r.bars.blocked[0]!.reason).toMatch(/does not divide/);

      rmSync(path.join(tmp, "contracts/BINANCE_UM/BTCUSDT.rolls.json"));
      r = readinessFor(await scanStore(tmp), "s.qkt", strat("BINANCE_UM:BTCUSDT@front EVERY 15m"));
      expect(r.bars.blocked[0]).toMatchObject({ fix: "rolls", command: "qkt fetch BINANCE_UM:BTCUSDT --rolls" });

      rmSync(path.join(tmp, "contracts/BINANCE_UM/BTCUSDT.json"));
      r = readinessFor(await scanStore(tmp), "s.qkt", strat("BINANCE_UM:BTCUSDT@front EVERY 15m"));
      expect(r.bars.blocked[0]).toMatchObject({ fix: "catalog", command: "qkt fetch BINANCE_UM:BTCUSDT --catalog" });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("perpetual", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "perp-"));
    // a perpetual: bars for 5 days, funding for the first 3 and then a 2-day gap with one more rate
    mkdirSync(path.join(tmp, "bars/BINANCE_UM/BTCUSDT/1h"), { recursive: true });
    for (const d of ["2024-02-01", "2024-02-02", "2024-02-03", "2024-02-04", "2024-02-05"]) copyFileSync(BAR_DAY, path.join(tmp, "bars/BINANCE_UM/BTCUSDT/1h", `${d}.bin`));
    mkdirSync(path.join(tmp, "funding/BINANCE_UM"), { recursive: true });
    const t = (iso: string) => Date.parse(iso + "T00:00:00Z");
    writeFileSync(path.join(tmp, "funding/BINANCE_UM/BTCUSDT.csv"), ["time,rate,price", ...[t("2024-02-01"), t("2024-02-01") + 28_800_000, t("2024-02-02"), t("2024-02-03"), t("2024-02-05")].map((x) => `${x},0.0001,`)].join("\n") + "\n");
    writeFileSync(path.join(tmp, "instruments.yaml"), "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 1\n    perpetual: BTCUSDT\n    calendar: crypto\n");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("keeps the perpetual's bars in the symbol list and adds its funding as a requirement", async () => {
    const scan = await scanStore(tmp);
    expect(scan.symbols.map((s) => s.symbol)).toEqual(["BTCUSDT"]);
    const root = scan.derivatives!.futures[0]!;
    expect(root.perpetual).toMatchObject({ name: "BTCUSDT", funding: { rows: 5, first: "2024-02-01", last: "2024-02-05" } });
    // rates stop for more than a day between 02-03 and 02-05: qkt refuses a run over that
    expect(root.perpetual!.funding!.present).toEqual([{ from: "2024-02-01", to: "2024-02-04" }, { from: "2024-02-05", to: "2024-02-06" }]);
  });

  it("is ready only where bars and funding both cover", async () => {
    const r = readinessFor(await scanStore(tmp), "p.qkt", strat("BINANCE_UM:BTCUSDT EVERY 1h"));
    expect(r.kinds).toEqual({ x: "perpetual" });
    expect(r.bars.ranges).toEqual([{ from: "2024-02-01", to: "2024-02-04" }, { from: "2024-02-05", to: "2024-02-06" }]);
  });

  it("blocks with the fetch when the strategy reads open interest and none is stored", async () => {
    const r = readinessFor(await scanStore(tmp), "p.qkt", strat("BINANCE_UM:BTCUSDT EVERY 1h", "x.open_interest > 1"));
    expect(r.bars.runnable).toBe(false);
    expect(r.bars.blocked[0]).toMatchObject({ fix: "open-interest" });
    expect(r.bars.blocked[0]!.command).toBe("qkt fetch BINANCE_UM:BTCUSDT --open-interest --from 2024-02-01 --to 2024-02-06");
  });

  it("blocks with the fetch when no funding is stored", async () => {
    rmSync(path.join(tmp, "funding"), { recursive: true });
    const r = readinessFor(await scanStore(tmp), "p.qkt", strat("BINANCE_UM:BTCUSDT EVERY 1h"));
    expect(r.bars.blocked[0]).toMatchObject({ fix: "funding", command: "qkt fetch BINANCE_UM:BTCUSDT --funding --from 2024-02-01 --to 2024-02-06" });
  });

  it("a CFD on the same symbol name stays a CFD", async () => {
    const r = readinessFor(await scanStore(tmp), "p.qkt", strat("BACKTEST:BTCUSDT EVERY 1h"));
    expect(r.kinds).toBeUndefined();
    expect(r.bars.blocked[0]!.reason).toMatch(/bars/);
  });
});

describe("options store (a real Deribit BTC_USDC slice)", () => {
  it("scans the root with its chain days", async () => {
    const d = await scanDerivatives(OPT);
    const o = d.options[0]!;
    expect(o.key).toBe("DERIBIT:BTC_USDC");
    expect(o.terms).toMatchObject({ chains: "trade", contractSize: 1 });
    expect(o.catalog).toMatchObject({ contracts: 2, first: "2026-09-26" });
    expect(o.chains.trade).toMatchObject({ files: 2, first: "2026-09-25", last: "2026-09-26" });
    expect(o.chains.book).toBeNull();
  });

  it("an option contract runs in Full on its chain days and not in a bars run", async () => {
    const scan = await scanStore(OPT);
    const r = readinessFor(scan, "o.qkt", strat("DERIBIT:BTC_USDC_26SEP26_84000_C EVERY 1h"));
    expect(r.kinds).toEqual({ x: "option" });
    expect(r.ticks.ranges).toEqual([{ from: "2026-09-25", to: "2026-09-27" }]);
    expect(r.bars.runnable).toBe(false);
    expect(r.bars.blocked[0]!.reason).toMatch(/stored chain/);
  });

  it("a chain stream and a CHAIN: analytic read the same series", async () => {
    const scan = await scanStore(OPT);
    const src = "STRATEGY t VERSION 1\n\nSYMBOLS\n    ch = OPTIONS:DERIBIT.BTC_USDC EVERY 1h,\n    iv = CHAIN:DERIBIT.BTC_USDC.atm_iv.30d EVERY 1h\n\nRULES\n    WHEN iv.close > 55 AND POSITION.ch = 0\n    THEN LOG \"x\"\n";
    const r = readinessFor(scan, "o.qkt", src);
    expect(r.kinds).toEqual({ ch: "chain", iv: "analytic" });
    expect(r.ticks.ranges).toEqual([{ from: "2026-09-25", to: "2026-09-27" }]);
  });

  it("names the missing chain series and the fetch", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "opt-"));
    try {
      cpSync(OPT, tmp, { recursive: true });
      writeFileSync(path.join(tmp, "instruments.yaml"), "options:\n  - root: DERIBIT:BTC_USDC\n    contractSize: 1\n");
      let r = readinessFor(await scanStore(tmp), "o.qkt", strat("DERIBIT:BTC_USDC_26SEP26_84000_C EVERY 1h"));
      expect(r.ticks.blocked[0]!.reason).toMatch(/declares no chain series/);
      writeFileSync(path.join(tmp, "instruments.yaml"), "options:\n  - root: DERIBIT:BTC_USDC\n    contractSize: 1\n    chains: book\n");
      r = readinessFor(await scanStore(tmp), "o.qkt", strat("DERIBIT:BTC_USDC_26SEP26_84000_C EVERY 1h"));
      expect(r.ticks.blocked[0]).toMatchObject({ fix: "chains", command: "qkt fetch DERIBIT:BTC_USDC --chains --live" });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("CFD behaviour is untouched", () => {
  it("a store with no derivatives has no derivatives report and no kinds", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "cfd-"));
    try {
      mkdirSync(path.join(tmp, "bars/BACKTEST/EURUSD/1h"), { recursive: true });
      copyFileSync(BAR_DAY, path.join(tmp, "bars/BACKTEST/EURUSD/1h/2024-02-05.bin"));
      const scan = await scanStore(tmp);
      expect(scan.derivatives).toBeUndefined();
      const r = readinessFor(scan, "c.qkt", strat("BACKTEST:EURUSD EVERY 1h"));
      expect(r.kinds).toBeUndefined();
      expect(r.needsAllowIncomplete).toBeUndefined();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
