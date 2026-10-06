import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { attachContracts, buildDerivatives, costBridge, parseContracts, parseRolls, parseStructures } from "../src/derivatives.js";
import { integrity, loadResult, summarize } from "../src/results.js";
import { pairRoundTrips, parseTradesCsv, reconcile, venueExitOf } from "../src/roundtrips.js";
import { filterTrips, matches } from "../src/tripquery.js";

// Real qkt 0.55.0 report bundles, trimmed: ES@front 2019-2021 (rolls, margin), a Binance perpetual with stored funding,
// a listed ES contract held to expiry, one liquidated, an option held to expiry, and an option structure.
const dir = (n: string) => new URL(`./fixtures/futures/${n}/`, import.meta.url);
const read = (n: string, f: string) => (existsSync(new URL(f, dir(n))) ? readFileSync(new URL(f, dir(n)), "utf8") : undefined);
const result = (n: string) => loadResult(JSON.parse(read(n, "result.json")!));
const fills = (n: string) => parseTradesCsv(read(n, "trades.csv")!);

describe("continuous futures (CME:ES@front)", () => {
  const f = fills("es-front"), trips = pairRoundTrips(f);
  it("pairs the fills into trips whose P&L is what qkt booked, multiplier included", () => {
    expect(f).toHaveLength(13);
    // qkt books roll costs inside realizedTotal but in no fill: the integrity check adds them back
    const chk = integrity({ result: result("es-front"), trips, fills: f }).checks.find((c) => c.id === "reconcile")!;
    expect(chk.ok, chk.detail).toBe(true);
    expect(reconcile(trips, Number(result("es-front").global.realizedTotal)).ok).toBe(false);
  });
  it("reads the rolls and the contract behind each fill", () => {
    const rolls = parseRolls(read("es-front", "rolls.csv")!), contracts = parseContracts(read("es-front", "contracts.csv")!);
    expect(rolls[0]).toMatchObject({ stream: "CME:ES@front", from: "CME:ESH19", to: "CME:ESM19", quantity: 2, multiplier: 50, rollCost: 8.92 });
    expect(contracts[0]).toMatchObject({ contract: "CME:ESH19", side: "BUY", contractPrice: 2669.25, streamPrice: 2564.25 });
  });
  it("puts the entry contract, the exit contract and the rolls carried on the trip", () => {
    const t = pairRoundTrips(fills("es-front"));
    attachContracts(t, parseContracts(read("es-front", "contracts.csv")!), parseRolls(read("es-front", "rolls.csv")!));
    const first = t[0]!;
    expect(first.contract).toBe("CME:ESH19");
    expect(first.exitContract).toBe("CME:ESM19");
    expect(first.rolls).toBe(1); // 2019-03-08 roll sits between the 2019-01-22 entry and the 2019-05-14 exit
    expect(filterTrips(t, { contract: "ESM19" }).length).toBeGreaterThan(0);
    expect(filterTrips(t, { contract: "ESZ19" }).length).toBeLessThan(t.length);
  });
  it("leaves trips of a run with no continuous stream untouched", () => {
    const t = pairRoundTrips(fills("expiry"));
    const before = JSON.stringify(t);
    attachContracts(t, [], []);
    expect(JSON.stringify(t)).toBe(before);
  });
  it("builds the cost bridge: pre-cost P&L adds every cost back", () => {
    const c = costBridge(result("es-front"))!;
    expect(c.rollCosts).toBeCloseTo(62.44, 6);
    expect(c.preCostPnl).toBeCloseTo(c.totalPnl + c.commission + c.swap + c.rollCosts + c.funding, 9);
    expect(summarize(result("es-front"), trips).costs).toEqual(c);
  });
  it("margin days are read when the root declares margin", () => {
    const d = buildDerivatives({ rolls: read("es-front", "rolls.csv"), contracts: read("es-front", "contracts.csv"), margin: read("es-front", "margin_daily.csv"), financing: read("es-front", "financing.csv") }, result("es-front"))!;
    expect(d.sections).toEqual(["rolls", "contracts", "margin", "costs"]);
    expect(d.margin![0]).toMatchObject({ date: "2019-01-22", marginUsed: 51426, maintenance: 46750, marginCall: false });
    expect(d.financing).toBeUndefined(); // swap is 0 and not a derivatives cost
  });
});

describe("a perpetual with stored funding", () => {
  it("shows funding as a financing component and in the cost bridge", () => {
    const d = buildDerivatives({ financing: read("perp-funding", "financing.csv"), margin: read("perp-funding", "margin_daily.csv") }, result("perp-funding"))!;
    expect(d.financing).toEqual([{ component: "funding", paid: 76.43010555, netPnlImpact: -76.43010555 }]);
    expect(d.costs!.funding).toBeCloseTo(76.43010555, 8);
  });
});

describe("the venue ending a position", () => {
  it("names the reason from the closing fill's order id", () => {
    expect(venueExitOf("expiry:CME:ESH19:es_hold")).toBe("expiry");
    expect(venueExitOf("liquidation:CME:ESH20:es_hold:1582696800000")).toBe("liquidation");
    expect(venueExitOf("ORD-es_hold-0")).toBeUndefined();
    expect(venueExitOf("dsl-spread--3")).toBeUndefined();
  });
  it("marks an expiry settlement and keeps the engine's P&L", () => {
    const trips = pairRoundTrips(fills("expiry"));
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ venueExit: "expiry", exit: "signal", pnl: 5629.77 });
    expect(reconcile(trips, Number(result("expiry").global.realizedTotal)).ok).toBe(true);
    expect(matches(trips[0]!, { venueExit: "expiry" })).toBe(true);
    expect(matches(trips[0]!, { exit: "signal" })).toBe(true);
    expect(matches(trips[0]!, { venueExit: "liquidation" })).toBe(false);
  });
  it("marks a liquidation and reads the row that triggered it", () => {
    const trips = pairRoundTrips(fills("liquidation"));
    expect(trips[0]).toMatchObject({ venueExit: "liquidation" });
    const d = buildDerivatives({ liquidations: read("liquidation", "liquidations.csv"), margin: read("liquidation", "margin_daily.csv") }, result("liquidation"))!;
    expect(d.liquidations![0]).toMatchObject({ symbol: "CME:ESH20", side: "SELL", equity: 22335.27, maintenance: 23375 });
  });
  it("an option held to expiry settles at the delivery price", () => {
    const d = buildDerivatives({ settlements: read("option-expiry", "settlements.csv") }, result("option-expiry"))!;
    expect(d.settlements![0]).toMatchObject({ contract: "DERIBIT:BTC_USDC_26SEP26_84500_P", price: 457.17, deliveryPriceKnown: true });
    expect(pairRoundTrips(fills("option-expiry"))[0]!.venueExit).toBe("expiry");
  });
});

describe("option structures", () => {
  it("reads the legs, outcome and credit; an open structure has empty close fields", () => {
    const s = parseStructures(read("structure", "structures.csv")!);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ alias: "ps", outcome: "CLOSED", credit: 40.5, realized: -8 });
    expect(s[0]!.legs).toEqual([
      { side: "SELL", quantity: 0.1, symbol: "DERIBIT:BTC_USDC_9OCT26_82000_P", entry: 645 },
      { side: "BUY", quantity: 0.1, symbol: "DERIBIT:BTC_USDC_9OCT26_79000_P", entry: 240 },
    ]);
    expect(s[1]).toMatchObject({ outcome: null, closedAt: null, realized: null });
  });
  it("each leg pairs on its own, since trades.csv is one row per fill", () => {
    const trips = pairRoundTrips(fills("structure"));
    expect(trips.map((t) => t.symbol).sort()).toEqual([
      "DERIBIT:BTC_USDC_9OCT26_79000_P", "DERIBIT:BTC_USDC_9OCT26_79000_P", "DERIBIT:BTC_USDC_9OCT26_82000_P", "DERIBIT:BTC_USDC_9OCT26_82000_P",
    ]);
  });
});

describe("integrity on a funded perpetual", () => {
  it("reconciles once funding, which no fill carries, is added back", () => {
    const f = fills("perp-funding");
    const chk = integrity({ result: result("perp-funding"), trips: pairRoundTrips(f), fills: f }).checks.find((c) => c.id === "reconcile")!;
    expect(chk.ok, chk.detail).toBe(true);
    expect(chk.detail).toContain("funding");
  });
});

describe("CFD runs", () => {
  it("add nothing: no derivatives report, no cost bridge, no venue exit", () => {
    const r = loadResult(JSON.parse(readFileSync(new URL("./fixtures/result-oct.json", import.meta.url), "utf8")));
    const trips = pairRoundTrips(parseTradesCsv(readFileSync(new URL("./fixtures/trades-oct.csv", import.meta.url), "utf8")));
    expect(buildDerivatives({ financing: "component,paid,netPnlImpact\nswap,0.0,0.0\n" }, r)).toBeNull();
    expect(summarize(r, trips)).not.toHaveProperty("costs");
    expect(trips.some((t) => "venueExit" in t || "contract" in t)).toBe(false);
  });
});
