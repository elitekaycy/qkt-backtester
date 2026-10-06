import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, parseInstruments, type ScanReport } from "@qkt-studio/core";
import { parseDocument } from "yaml";
import { CONFIG_TEMPLATE, ENV_TEMPLATE, completeConfig, configReferenceFor, instrumentsTemplate, pairsOf, scaffoldWorkspace } from "../src/scaffold.js";
import { discoverDerivatives, futuresConfig } from "../src/scaffold-derivatives.js";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), p)));
const put = (root: string, rel: string, text = "") => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

/** A scan with just what the scaffold reads: the symbols that have bars, and the data root. */
const scanOf = (dataRoot: string, syms: Array<[string, string, string]>): ScanReport => ({
  dataRoot, scannedAt: "", looksLikeStore: true, ms: 0,
  symbols: syms.map(([broker, symbol, tf]) => ({ symbol, ticks: null, bars: [{ broker, tf, files: 3, first: "2024-01-01", last: "2024-01-03", span: 3, ok: 3, closed: 0, thin: 0, missing: 0, status: "complete", usable: [], gaps: [], years: [], always: false }], status: "complete", market: "Mon-Fri", completeYears: 0, spanYears: 0, notes: [] })),
  totals: { symbols: syms.length, complete: syms.length, mostly: 0, incomplete: 0, ticksOnly: 0, empty: 0, barFiles: 0, tickFiles: 0 },
}) as ScanReport;

/** CFD bars, a futures root with dated contracts, a perpetual with funding, and an option root with trade chains. */
function derivativesStore(extraInstruments?: string): string {
  const root = tmp("dstore-");
  put(root, "bars/BACKTEST/XAUUSD/15m/2024-01-01.bin");
  put(root, "contracts/CME/ES.json", JSON.stringify({ root: "CME:ES", contracts: [{ symbol: "ESH19", expiryMs: 1552680000000 }] }));
  put(root, "contracts/CME/ES.rolls.json", JSON.stringify({ root: "CME:ES", rolls: [] }));
  put(root, "contracts/CME/XYZ.json", JSON.stringify({ root: "CME:XYZ", contracts: [] }));
  put(root, "bars/CME/ESH19/1d/2019-01-02.bin");
  put(root, "funding/BINANCE_UM/BTCUSDT.csv", "time,rate,price\n1,0.0001,\n");
  put(root, "bars/BINANCE_UM/BTCUSDT/1h/2024-01-01.bin");
  put(root, "contracts/DERIBIT/BTC_USDC.options.json", JSON.stringify({ root: "DERIBIT:BTC_USDC", contracts: [] }));
  put(root, "chains/DERIBIT/BTC_USDC/trade/2026-09-25.csv.gz");
  if (extraInstruments) put(root, "instruments.yaml", extraInstruments);
  return root;
}
const SYMS: Array<[string, string, string]> = [["BACKTEST", "XAUUSD", "15m"], ["CME", "ESH19", "1d"], ["BINANCE_UM", "BTCUSDT", "1h"]];

describe("a CFD-only data source", () => {
  it("is scaffolded exactly as before: same instruments.yaml, config and .env", async () => {
    const root = tmp("cfd-"), ws = tmp("ws-");
    put(root, "bars/BACKTEST/XAUUSD/15m/2024-01-01.bin");
    const scan = scanOf(root, [["BACKTEST", "XAUUSD", "15m"]]);
    await scaffoldWorkspace(ws, scan);
    expect(readFileSync(path.join(ws, "instruments.yaml"), "utf8")).toBe(instrumentsTemplate(pairsOf(scan)));
    expect(readFileSync(path.join(ws, "qkt.config.yaml"), "utf8")).toBe(CONFIG_TEMPLATE);
    expect(readFileSync(path.join(ws, ".env"), "utf8")).toBe(ENV_TEMPLATE);
    expect(readFileSync(path.join(ws, "instruments.yaml"), "utf8")).not.toMatch(/^futures:|^options:/m);
    expect(await configReferenceFor(root)).toBe(CONFIG_TEMPLATE);
  });
});

describe("a data source with futures, a perpetual and options", () => {
  it("finds the roots from the catalogs, the funding files and the chains", async () => {
    const d = await discoverDerivatives(derivativesStore());
    expect(d.futures.map((f) => `${f.venue}:${f.root}${f.catalog ? " catalog" : ""}${f.perpetual ? ` perp=${f.perpetual}` : ""}`)).toEqual(["BINANCE_UM:BTCUSDT perp=BTCUSDT", "CME:ES catalog", "CME:XYZ catalog"]);
    expect(d.options).toEqual([{ venue: "DERIBIT", root: "BTC_USDC", chains: ["trade"] }]);
  });

  it("seeds futures and options entries that qkt's own instruments parser reads, with no CFD entry for a contract or perpetual", async () => {
    const root = derivativesStore(), ws = tmp("ws-");
    await scaffoldWorkspace(ws, scanOf(root, SYMS));
    const text = readFileSync(path.join(ws, "instruments.yaml"), "utf8");
    expect(parseDocument(text).errors).toEqual([]);
    const c = parseInstruments(text);
    expect(c.errors).toEqual([]);
    expect(c.cfds.map((x) => x.qktSymbol)).toEqual(["BACKTEST:XAUUSD"]);
    const es = c.futures.find((f) => f.root === "CME:ES")!;
    expect(es).toMatchObject({ multiplier: 50, tickSize: 0.25, calendar: "cme_globex", volumeStep: 1 });
    expect(es.roll).toMatchObject({ adjust: "panama" });
    expect(c.futures.find((f) => f.root === "BINANCE_UM:BTCUSDT")).toMatchObject({ perpetual: "BTCUSDT", calendar: "crypto", multiplier: 1 });
    expect(c.futures.find((f) => f.root === "CME:XYZ")).toMatchObject({ multiplier: 1 });
    expect(c.options[0]).toMatchObject({ root: "DERIBIT:BTC_USDC", chains: "trade", currency: "USDC" });
  });

  it("marks what it could not know as GUESSED and never invents a margin", async () => {
    const root = derivativesStore(), ws = tmp("ws-");
    await scaffoldWorkspace(ws, scanOf(root, SYMS));
    const text = readFileSync(path.join(ws, "instruments.yaml"), "utf8");
    expect(text).toMatch(/root: CME:XYZ.*GUESSED/);
    expect(text).toMatch(/multiplier: 1 +# GUESSED/);
    expect(text).not.toMatch(/^\s+margin:/m);
    expect(text).toMatch(/# margin: \{ initial: 0/);
  });

  it("copies entries the data source's own instruments.yaml declares, margin included", async () => {
    const own = "futures:\n  - root: CME:ES\n    multiplier: 50\n    tickSize: 0.25\n    margin: { initial: 25713, maintenance: 23375, basis: per_contract }\n";
    const ws = tmp("ws-");
    await scaffoldWorkspace(ws, scanOf(derivativesStore(own), SYMS));
    const c = parseInstruments(readFileSync(path.join(ws, "instruments.yaml"), "utf8"));
    expect(c.futures.filter((f) => f.root === "CME:ES")).toHaveLength(1);
    expect(c.futures.find((f) => f.root === "CME:ES")!.margin).toEqual({ initial: 25713, maintenance: 23375, basis: "per_contract" });
  });

  it("tells the user when a perpetual's entry has no `perpetual:` (it would pay no funding and no root fees)", async () => {
    const own = "futures:\n  - root: BINANCE_UM:BTCUSDT\n    multiplier: 1\n    takerFeeRate: 0.0005\n";
    const ws = tmp("ws-");
    await scaffoldWorkspace(ws, scanOf(derivativesStore(own), SYMS));
    expect(readFileSync(path.join(ws, "instruments.yaml"), "utf8")).toContain('add "perpetual: BTCUSDT"');
  });

  it("copies an entry as written: quoted times stay strings, and a different dash column still reads", async () => {
    // YAML 1.1 reads an unquoted 00:00 as a base-60 number, so the quotes of atUtc must survive the copy
    const own = "futures:\n- root: CME:ES\n  multiplier: 50\n  roll: { daysBeforeExpiry: 7, atUtc: \"00:00\", adjust: panama }   # mine\n- root: CME:NQ\n  multiplier: 20\n";
    const ws = tmp("ws-");
    await scaffoldWorkspace(ws, scanOf(derivativesStore(own), SYMS));
    const text = readFileSync(path.join(ws, "instruments.yaml"), "utf8");
    expect(parseDocument(text).errors).toEqual([]);
    expect(text).toContain('atUtc: "00:00"');
    expect(text).toContain("# mine");
    const c = parseInstruments(text);
    expect(c.futures.find((f) => f.root === "CME:ES")).toMatchObject({ multiplier: 50, roll: { atUtc: "00:00", adjust: "panama" } });
    expect(c.futures.find((f) => f.root === "CME:NQ")).toMatchObject({ multiplier: 20 });
  });

  it("seeds a config whose risk caps do not silently block futures, and still parses", async () => {
    const ws = tmp("ws-");
    await scaffoldWorkspace(ws, scanOf(derivativesStore(), SYMS));
    const cfg = readFileSync(path.join(ws, "qkt.config.yaml"), "utf8");
    const doc = parseDocument(cfg).toJS() as { risk: Record<string, string>; starting_balance: string };
    expect(doc.risk).toEqual({ max_daily_loss: "5000", max_order_notional: "10000000", max_order_qty: "10000000" });
    expect(doc.starting_balance).toBe("${STARTING_BALANCE:-100000}");
    expect(cfg).not.toMatch(/^\s*# max_order_notional: "250000"/m); // the commented CFD hint is replaced by the active key
    expect(checkConfig(cfg, true, {}).filter((f) => f.severity === "error")).toEqual([]);
    expect(readFileSync(path.join(ws, ".env"), "utf8")).toContain("STARTING_BALANCE=100000");
  });

  it("the config completion keeps the user's own values over the futures reference", async () => {
    const root = derivativesStore();
    const ref = await configReferenceFor(root);
    expect(ref).toBe(futuresConfig(CONFIG_TEMPLATE));
    const done = completeConfig('starting_balance: 25000\nrisk:\n  max_daily_loss: "300"\n', ref);
    const doc = parseDocument(done).toJS() as { starting_balance: number; risk: Record<string, string> };
    expect(doc.starting_balance).toBe(25000);
    expect(doc.risk).toEqual({ max_daily_loss: "300" });
    // and a user who has not written a risk block gets the futures one
    expect((parseDocument(completeConfig("starting_balance: 25000\n", ref)).toJS() as { risk: Record<string, string> }).risk.max_order_notional).toBe("10000000");
  });

  it("falls back to the plain template when the config text is not the one it knows", () => {
    expect(futuresConfig("risk:\n  max_daily_loss: 1\n")).toBe("risk:\n  max_daily_loss: 1\n");
  });
});
