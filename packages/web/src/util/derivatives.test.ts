import { describe, it, expect } from "vitest";
import type { CostBridge, DerivativesReport, FutureRootReport, MarginDay, OptionRootReport, RollRow } from "@qkt-studio/core";
import { parseInstruments } from "@qkt-studio/core";
import type { InstrumentsInfo } from "../api/client.js";
import { commandsIn, contractNames, costLines, effectiveTier, fetchLabel, fetchRequestFrom, fieldsFor, futureRootLine, kindContextFrom, kindMarks, marginView, optionRootLine, qtyUnit, readsRoot, rollSummary, rootKeyFor, showKind, streamKinds, streamsPerpetual, tierRule } from "./derivatives.js";

const YAML = `
futures:
  - root: CME:ES
    multiplier: 50
  - root: BINANCE_UM:BTCUSDT
    perpetual: BTCUSDT
options:
  - root: DERIBIT:BTC_USDC
`;
const catalog = parseInstruments(YAML);
const info: InstrumentsInfo = { exists: true, catalog, futureRoots: ["BINANCE_UM:BTCUSDT", "CME:ES"], perpetuals: ["BINANCE_UM:BTCUSDT"], optionRoots: ["DERIBIT:BTC_USDC"] };
const ctx = kindContextFrom(info);

const SRC = `STRATEGY s VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 1h
    es = CME:ES@front EVERY 1d
    perp = BINANCE_UM:BTCUSDT EVERY 1h
    ch = OPTIONS:DERIBIT.BTC_USDC EVERY 1h

RULES
    WHEN gold.close > 1 THEN BUY gold
`;

describe("stream kinds in the editor", () => {
  it("tells a CFD, a continuous future, a perpetual and a chain apart", () => {
    const k = streamKinds(SRC, ctx);
    expect([...k]).toEqual([["gold", "cfd"], ["es", "continuous"], ["perp", "perpetual"], ["ch", "chain"]]);
  });
  it("with no catalog loaded, only what the symbol settles is judged", () => {
    const k = streamKinds(SRC, kindContextFrom(null));
    expect(k.get("es")).toBe("continuous");
    expect(k.get("perp")).toBe("cfd");
  });
  it("marks the line each stream is declared on, and calls out only what is not a CFD", () => {
    const marks = kindMarks(SRC, ctx);
    expect(marks.map((m) => [m.line, m.alias, showKind(m.kind)])).toEqual([[4, "gold", false], [5, "es", true], [6, "perp", true], [7, "ch", true]]);
  });
  it("ignores a stream-looking line outside SYMBOLS", () => {
    expect(kindMarks("STRATEGY s VERSION 1\n\nRULES\n    x = CME:ES@front EVERY 1d\n", ctx)).toEqual([]);
  });
});

describe("fields offered after `alias.`", () => {
  const vocab = ["close", "open", "dte", "iv", "mark", "contract", "contract_size", "open_interest", "delta"];
  it("keeps derivatives fields off a CFD", () => {
    expect(fieldsFor("cfd", vocab)).toEqual(["close", "open", "contract_size"]);
  });
  it("offers a continuous future its contract fields but no mark or option fields", () => {
    expect(fieldsFor("continuous", vocab)).toEqual(["close", "open", "dte", "contract", "contract_size"]);
  });
  it("offers a perpetual mark and open interest, an option its greeks", () => {
    expect(fieldsFor("perpetual", vocab)).toEqual(expect.arrayContaining(["mark", "open_interest"]));
    expect(fieldsFor("perpetual", vocab)).not.toContain("delta");
    expect(fieldsFor("option", vocab)).toEqual(expect.arrayContaining(["iv", "delta", "mark"]));
  });
  it("offers everything while the kind is unknown", () => {
    expect(fieldsFor(undefined, vocab)).toEqual(vocab);
  });
});

describe("tier rules", () => {
  const cont = [{ broker: "CME", symbol: "ES@front" }], opt = [{ broker: "OPTIONS", symbol: "DERIBIT.BTC_USDC" }], cfd = [{ broker: "BACKTEST", symbol: "XAUUSD" }];
  it("a continuous stream refuses ticks, an options chain refuses bars, a CFD refuses neither", () => {
    expect(tierRule(cont)).toMatchObject({ draft: null, full: expect.stringContaining("continuous") });
    expect(tierRule(opt)).toMatchObject({ draft: expect.stringContaining("option chains"), full: null });
    expect(tierRule(cfd)).toEqual({ draft: null, full: null });
  });
  it("switches to the only tier a strategy can use, and says why; leaves a CFD alone", () => {
    expect(effectiveTier("full", cont)).toMatchObject({ tier: "draft", note: expect.stringContaining("Draft") });
    expect(effectiveTier("draft", opt)).toMatchObject({ tier: "full", note: expect.any(String) });
    expect(effectiveTier("full", cfd)).toEqual({ tier: "full", note: null });
    expect(effectiveTier("draft", cont)).toEqual({ tier: "draft", note: null });
  });
  it("leaves the request alone when both tiers are refused: the server says what to do", () => {
    expect(effectiveTier("draft", [...cont, ...opt]).tier).toBe("draft");
  });
});

describe("the Funding option", () => {
  it("only means something when a perpetual is streamed", () => {
    expect(streamsPerpetual(SRC, ctx)).toBe(true);
    expect(streamsPerpetual(SRC.replace("BINANCE_UM:BTCUSDT", "BACKTEST:BTCUSD"), ctx)).toBe(false);
  });
});

describe("derivatives results", () => {
  const bridge: CostBridge = { totalPnl: 500, commission: 12, swap: 0, rollCosts: 8.92, funding: 0, preCostPnl: 520.92 };
  it("lists only the costs that were charged, then what they sum to", () => {
    const rows = costLines(bridge);
    expect(rows.map((r) => r.key)).toEqual(["pnl", "commission", "rollCosts", "preCost"]);
    expect(rows[0]!.value + rows[1]!.value + rows[2]!.value).toBeCloseTo(rows[3]!.value, 10);
  });
  it("shows funding for a perpetual and never a roll cost it did not have", () => {
    expect(costLines({ ...bridge, rollCosts: 0, funding: 76.43, preCostPnl: 588.43 }).map((r) => r.key)).toEqual(["pnl", "commission", "funding", "preCost"]);
  });
  it("margin: counts calls and finds the day the account was tightest", () => {
    const days: MarginDay[] = [
      { date: "2019-01-22", marginUsed: 51426, maintenance: 46750, equity: 496270, marginCall: false },
      { date: "2019-01-23", marginUsed: 51426, maintenance: 46750, equity: 60000, marginCall: true },
      { date: "2019-01-24", marginUsed: 51426, maintenance: 46750, equity: 300000, marginCall: false },
    ];
    const v = marginView(days);
    expect(v.calls).toBe(1);
    expect(v.tightest).toEqual({ date: "2019-01-23", headroom: 60000 - 46750 });
    expect(v.points[1]).toMatchObject({ call: true, equity: 60000 });
    expect(marginView([])).toEqual({ points: [], calls: 0, tightest: null });
  });
  it("rolls: summed per stream", () => {
    const r = (stream: string, gap: number, cost: number): RollRow => ({ ts: 1, stream, strategy: "s", from: "A", to: "B", quantity: 2, multiplier: 50, fromReference: 1, toReference: 2, gap, fromFill: 1, toFill: 2, fees: 4.46, rollCost: cost });
    const s = rollSummary([r("CME:ES@front", 5, 8.92), r("CME:ES@front", 4.25, 8.92), r("CME:NQ@front", 10, 8)]);
    expect(s).toEqual([
      { stream: "CME:ES@front", count: 2, cost: 17.84, fees: 8.92, avgGap: 4.625 },
      { stream: "CME:NQ@front", count: 1, cost: 8, fees: 4.46, avgGap: 10 },
    ]);
  });
  it("contracts a run traded, bare and in first-use order", () => {
    expect(contractNames({ contracts: [{ contract: "CME:ESH19" }, { contract: "CME:ESH19" }], rolls: [{ from: "CME:ESH19", to: "CME:ESM19" }] })).toEqual(["ESH19", "ESM19"]);
    expect(contractNames(null)).toEqual([]);
  });
  it("sizes are lots for a CFD, contracts for a future or option, units for a perpetual", () => {
    expect([undefined, "cfd", "continuous", "option", "perpetual"].map((k) => qtyUnit(k as never))).toEqual(["lots", "lots", "contracts", "contracts", "units"]);
  });
});

describe("the fix a blocked stream names", () => {
  it("a command with everything it needs becomes a job", () => {
    expect(fetchRequestFrom("qkt fetch CME:ES --catalog")).toEqual({ target: "CME:ES", kind: "catalog" });
    expect(fetchRequestFrom("qkt fetch CME:ES --rolls --tf 1d")).toEqual({ target: "CME:ES", kind: "rolls", tf: "1d" });
    expect(fetchRequestFrom("qkt fetch BINANCE_UM:BTCUSDT --funding --from 2024-01-01 --to 2024-03-01")).toEqual({ target: "BINANCE_UM:BTCUSDT", kind: "funding", from: "2024-01-01", to: "2024-03-01" });
    expect(fetchRequestFrom("qkt fetch BINANCE_UM:BTCUSDT_240927 --tf 15m --from 2024-06-01 --to 2024-09-27")).toEqual({ target: "BINANCE_UM:BTCUSDT_240927", kind: "bars", tf: "15m", from: "2024-06-01", to: "2024-09-27" });
    expect(fetchRequestFrom("qkt fetch DERIBIT:BTC_USDC --chains --live")).toEqual({ target: "DERIBIT:BTC_USDC", kind: "chains", live: true });
  });
  it("a command that still has a placeholder, or no range, is only copied, never run", () => {
    expect(fetchRequestFrom("qkt fetch CME:ESZ19 --tf 1d --from <from> --to 2019-12-20")).toBeNull();
    expect(fetchRequestFrom("qkt fetch BINANCE_UM:BTCUSDT --funding")).toBeNull();
    expect(fetchRequestFrom("qkt fetch DERIBIT:BTC_USDC --marks --from 2024-01-01 --to 2024-02-01")).toBeNull(); // marks need a timeframe
    expect(fetchRequestFrom("rm -rf /")).toBeNull();
    expect(fetchRequestFrom("qkt backtest x.qkt")).toBeNull();
  });
  it("finds the commands inside a scan note", () => {
    expect(commandsIn("No contract catalog for CME:ES: `qkt fetch CME:ES --catalog`.")).toEqual(["qkt fetch CME:ES --catalog"]);
    expect(commandsIn("nothing here")).toEqual([]);
  });
  it("labels a job by what it fetches", () => {
    expect(fetchLabel({ target: "CME:ES", kind: "rolls" })).toBe("Fetch rolls · CME:ES");
    expect(fetchLabel({ target: "X:Y", kind: "bars", tf: "1h" })).toBe("Fetch 1h bars · X:Y");
  });
});

describe("roots in the Data section", () => {
  const es = { key: "CME:ES", venue: "CME", root: "ES", terms: null, catalog: { contracts: 92, first: "1999-12-17", last: "2022-12-16", delivered: 90 }, rolls: { count: 88, first: null, last: null, policy: "7d@00:00" },
    contracts: [{ symbol: "ESZ22", expiry: "2022-12-16", deliveryPrice: null, bars: [{ tf: "1d", files: 200, first: "2022-01-03", last: "2022-12-16" }] }, { symbol: "ESH23", expiry: "2023-03-17", deliveryPrice: null, bars: [] }], perpetual: null, notes: [] } as unknown as FutureRootReport;
  it("summarises a root and flags the first thing that needs doing", () => {
    const l = futureRootLine(es);
    expect(l).toMatchObject({ key: "CME:ES", title: "ES", status: "ok", attention: null });
    expect(l.facts).toEqual(["92 contracts", "1999–22", "88 rolls", "1 with bars"]);
    expect(futureRootLine({ ...es, notes: ["No `futures:` entry for CME:ES in instruments.yaml"] })).toMatchObject({ status: "warn", attention: expect.stringContaining("futures:") });
    expect(futureRootLine({ ...es, catalog: null, contracts: [], rolls: null })).toMatchObject({ status: "bad" });
  });
  it("a perpetual is described by its funding", () => {
    const p = { ...es, catalog: null, rolls: null, contracts: [], perpetual: { name: "BTCUSDT", bars: [{ tf: "1h", files: 60, first: null, last: null }], funding: null, openInterest: null, marks: [] } } as unknown as FutureRootReport;
    expect(futureRootLine(p).facts).toEqual(["perpetual BTCUSDT", "no funding stored"]);
  });
  it("options: chains stored or not", () => {
    const o = { key: "DERIBIT:BTC_USDC", venue: "DERIBIT", root: "BTC_USDC", terms: null, catalog: { contracts: 40, first: null, last: null }, chains: { trade: { files: 5, first: "2026-09-24", last: "2026-09-30" }, book: null }, notes: [] } as unknown as OptionRootReport;
    expect(optionRootLine(o)).toMatchObject({ status: "ok", facts: ["40 contracts", "trade chains 2026"] });
    expect(optionRootLine({ ...o, chains: { trade: null, book: null } } as OptionRootReport)).toMatchObject({ status: "warn", attention: "no chain history stored" });
  });
  it("which streams read which root", () => {
    const r = { venue: "CME", root: "ES", contracts: [{ symbol: "ESZ22" }] };
    expect(readsRoot({ broker: "CME", symbol: "ES@front" }, r)).toBe(true);
    expect(readsRoot({ broker: "CME", symbol: "ESZ22" }, r)).toBe(true);
    expect(readsRoot({ broker: "CME", symbol: "NQ@front" }, r)).toBe(false);
    expect(readsRoot({ broker: "EXNESS", symbol: "ES@front" }, r)).toBe(false);
    expect(readsRoot({ broker: "OPTIONS", symbol: "DERIBIT.BTC_USDC" }, { venue: "DERIBIT", root: "BTC_USDC" })).toBe(true);
    expect(readsRoot({ broker: "BINANCE_UM", symbol: "BTCUSDT" }, { venue: "BINANCE_UM", root: "BTCUSDT", perpetual: { name: "BTCUSDT" } })).toBe(true);
  });
  it("a stream's root key is found in the scan, and a CFD has none", () => {
    const d = { futures: [es], options: [], instruments: { path: "", exists: true, errors: [] } } as unknown as DerivativesReport;
    expect(rootKeyFor({ broker: "CME", symbol: "ES@front" }, d)).toBe("CME:ES");
    expect(rootKeyFor({ broker: "BACKTEST", symbol: "XAUUSD" }, d)).toBeNull();
    expect(rootKeyFor({ broker: "CME", symbol: "ES@front" }, undefined)).toBeNull();
  });
});
