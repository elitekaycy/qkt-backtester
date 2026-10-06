import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyze } from "../src/analytics.js";
import { parseTradesCsv, pairRoundTrips, classifyExit, type RoundTrip } from "../src/roundtrips.js";
import { filterTrips } from "../src/tripquery.js";

const fx = (n: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");
const both = pairRoundTrips(parseTradesCsv(fx("trades-both.csv")));
const oct = pairRoundTrips(parseTradesCsv(fx("trades-oct.csv")));
const sum = (a: Array<{ pnl: number }>) => a.reduce((x, y) => x + y.pnl, 0);
const cnt = (a: Array<{ trades: number }>) => a.reduce((x, y) => x + y.trades, 0);

describe("exit classification on real bracket trades", () => {
  it("every closed bracket trade is a target, a stop or (never here) a signal", () => {
    const closed = both.filter((t) => !t.open);
    expect(closed.every((t) => t.exit === "target" || t.exit === "stop")).toBe(true);
    const targets = closed.filter((t) => t.exit === "target");
    expect(targets.length).toBe(17); // the 17 exits that land exactly on the take-profit price
    expect(targets.every((t) => t.pnl > 0)).toBe(true);
    expect(closed.filter((t) => t.exit === "stop").every((t) => t.pnl < 0)).toBe(true);
  });
  it("records entry risk and R multiples: a target is exactly +2R; Draft stops can lose MORE than 1R (bar-approximated fills)", () => {
    const closed = both.filter((t) => !t.open);
    expect(closed.every((t) => t.risk === 120 && t.r !== undefined)).toBe(true);
    for (const t of closed.filter((x) => x.exit === "target")) expect(t.r!).toBeCloseTo(2, 6);
    const stops = closed.filter((x) => x.exit === "stop");
    for (const t of stops) expect(t.r!).toBeLessThan(0);
    expect(Math.min(...stops.map((t) => t.r!))).toBeLessThan(-1); // measured: down to about -2.4R in Draft
  });
  it("a strategy without brackets only ever exits on signals and has no R", () => {
    expect(oct.filter((t) => !t.open).every((t) => t.exit === "signal" && t.r === undefined)).toBe(true);
    expect(oct.find((t) => t.open)!.exit).toBe("open");
  });
  it("classifyExit reads the closing order's class when the engine writes it", () => {
    const base = { open: false, side: "long" as const, entryPx: 100, sl: 95, tp: 110 };
    expect(classifyExit(base, 96, "Market")).toBe("signal");    // a rule closed it at a loss: NOT a stop
    expect(classifyExit(base, 110, "Limit")).toBe("target");
    expect(classifyExit(base, 95, "Stop")).toBe("stop");
    expect(classifyExit(base, 104, "TrailingStop")).toBe("stop"); // a trailing stop that locked in profit is still a stop
    for (const k of ["StopLimit", "ArmedTrailingStop", "SteppedStop", "TimeTighteningStop", "TrailingStopLimit"]) expect(classifyExit(base, 104, k)).toBe("stop");
    expect(classifyExit(base, 104, "IfTouched")).toBe("target");
    expect(classifyExit({ ...base, open: true }, null, "Stop")).toBe("open");
  });
  it("on real engine output, every trade's exit matches the order type of its closing fill (bracket + rule exit)", () => {
    const text = fx("trades-bracket-rule-exit.csv");
    const lines = text.trim().split("\n"), hdr = lines[0]!.split(",");
    const ot = hdr.indexOf("orderType"), ts = hdr.indexOf("timestamp"), eff = hdr.indexOf("positionEffect");
    const closeType = new Map(lines.slice(1).map((l) => l.split(",")).filter((r) => r[eff]!.startsWith("CLOSE")).map((r) => [Number(r[ts]), r[ot]!]));
    const trips = pairRoundTrips(parseTradesCsv(text)).filter((t) => !t.open);
    const want = (o: string) => (o === "Stop" ? "stop" : o === "Limit" ? "target" : "signal");
    expect(trips.length).toBe(20);
    for (const t of trips) expect(t.exit, `trade #${t.id}`).toBe(want(closeType.get(t.exitTs!)!));
    const n = (r: string) => trips.filter((t) => t.exit === r).length;
    expect([n("stop"), n("target"), n("signal")]).toEqual([3, 1, 16]); // measured: price inference used to call 11 of the rule exits "stop"
  });
  it("classifyExit rules (price fallback for engines without orderType)", () => {
    const base = { open: false, side: "long" as const, entryPx: 100 };
    expect(classifyExit({ ...base, sl: 95, tp: 110 }, 110)).toBe("target");
    expect(classifyExit({ ...base, sl: 95, tp: 110 }, 96)).toBe("stop");
    expect(classifyExit({ ...base, sl: 95, tp: 110 }, 104)).toBe("signal"); // closed by a rule in profit
    expect(classifyExit({ ...base, side: "short", sl: 105, tp: 90 }, 104)).toBe("stop");
    expect(classifyExit({ ...base }, 90)).toBe("signal");
    expect(classifyExit({ ...base, open: true, sl: 95 }, null)).toBe("open");
  });
});

describe("analyze: invariants on real data", () => {
  const a = analyze(both);
  const closed = both.filter((t) => !t.open);
  it("counts and headline numbers agree with the trips", () => {
    expect(a.count).toBe(60); expect(a.closed).toBe(59); expect(a.open).toBe(1);
    expect(a.wins + a.losses + a.breakeven).toBe(59);
    expect(a.pnl).toBeCloseTo(sum(closed), 9);
    expect(a.winRate).toBeCloseTo(17 / 59, 9);
    expect(a.profitFactor).toBeCloseTo(a.grossWin / -a.grossLoss, 9);
  });
  it("every breakdown partitions the same closed trades and the same P&L", () => {
    for (const parts of [a.daily, a.monthly, a.weekday, a.hour, a.exit, a.hold, [a.side.long, a.side.short]]) {
      expect(cnt(parts)).toBe(59); expect(sum(parts)).toBeCloseTo(a.pnl, 6);
    }
    expect(a.pnlHistogram.counts.reduce((x, y) => x + y, 0)).toBe(59);
    expect(a.rHistogram!.counts.reduce((x, y) => x + y, 0)).toBe(59);
  });
  it("the cumulative curve ends at total P&L and is ordered in time", () => {
    expect(a.cumulative.pnl.at(-1)!).toBeCloseTo(a.pnl, 6);
    for (let i = 1; i < a.cumulative.ts.length; i++) expect(a.cumulative.ts[i]!).toBeGreaterThanOrEqual(a.cumulative.ts[i - 1]!);
  });
  it("R stats: 17 targets at +2R dominate, average R is negative for this losing strategy", () => {
    expect(a.rTrades).toBe(59);
    expect(a.totalR!).toBeCloseTo(a.avgR! * 59, 9);
    expect(a.exit.map((e) => e.reason)).toEqual(["target", "stop"]);
    expect(a.exit[0]!.wins).toBe(17);
  });
  it("streaks are consistent", () => {
    expect(a.maxLossStreak).toBeGreaterThanOrEqual(1);
    expect(a.maxWinStreak + a.maxLossStreak).toBeLessThanOrEqual(59);
  });
});

describe("analyze: filtering reacts", () => {
  it("analytics of shorts only equals analytics of the short trades", () => {
    const shorts = filterTrips(both, { side: "short" });
    const a = analyze(shorts);
    expect(a.side.long.trades).toBe(0);
    expect(a.side.short.trades).toBe(a.closed);
    expect(a.pnl).toBeCloseTo(sum(shorts.filter((t) => !t.open)), 9);
  });
  it("exit / R / weekday / hour / day filters", () => {
    expect(filterTrips(both, { exit: "target" }).length).toBe(17);
    expect(filterTrips(both, { minR: 1.5 }).every((t) => t.exit === "target")).toBe(true);
    expect(filterTrips(both, { maxR: -0.0001 }).every((t) => t.pnl < 0)).toBe(true);
    const total = [0, 1, 2, 3, 4, 5, 6].reduce((n, d) => n + filterTrips(both, { weekday: d }).length, 0);
    expect(total).toBe(both.length);
    const byHour = Array.from({ length: 24 }, (_, h) => filterTrips(both, { hour: h }).length).reduce((x, y) => x + y, 0);
    expect(byHour).toBe(both.length);
    const day = analyze(both).daily[3]!.day;
    expect(filterTrips(both, { day }).length).toBe(analyze(both).daily[3]!.trades);
    expect(filterTrips(oct, { minR: 0 }).length).toBe(0); // no risk recorded -> never matches an R filter
  });
});

describe("analyze: edges", () => {
  it("empty input is all zeros and nulls, not NaN", () => {
    const a = analyze([]);
    expect(a).toMatchObject({ count: 0, closed: 0, pnl: 0, winRate: 0, profitFactor: null, payoff: null, avgHoldMs: null, avgR: null, rHistogram: null, expectancy: 0 });
    expect(a.cumulative).toEqual({ ts: [], pnl: [] });
    expect(a.weekday.length).toBe(7); expect(a.hour.length).toBe(24);
  });
  it("only open trades", () => {
    const open: RoundTrip = { id: 1, strategy: "s", symbol: "X", side: "long", entryTs: 1, entryPx: 1, exitTs: null, exitPx: null, qty: 1, pnl: 5, fills: 1, holdMs: null, open: true, exit: "open" };
    const a = analyze([open]);
    expect(a).toMatchObject({ count: 1, closed: 0, open: 1, pnl: 0 });
  });
  it("a single trade and identical values do not break the histogram", () => {
    const t: RoundTrip = { id: 1, strategy: "s", symbol: "X", side: "long", entryTs: 0, entryPx: 1, exitTs: 1000, exitPx: 2, qty: 1, pnl: 3, fills: 2, holdMs: 1000, open: false, exit: "signal" };
    const a = analyze([t, { ...t, id: 2 }]);
    expect(a.pnlHistogram.counts.reduce((x, y) => x + y, 0)).toBe(2);
    expect(a.pnlHistogram.edges.every(Number.isFinite)).toBe(true);
  });
  it("thins a long curve to at most ~600 points and keeps the end", () => {
    const many: RoundTrip[] = Array.from({ length: 5000 }, (_, i) => ({ id: i, strategy: "s", symbol: "X", side: "long", entryTs: i * 1000, entryPx: 1, exitTs: i * 1000 + 500, exitPx: 1, qty: 1, pnl: i % 3 ? 1 : -1, fills: 2, holdMs: 500, open: false, exit: "signal" }));
    const a = analyze(many);
    expect(a.cumulative.ts.length).toBeLessThanOrEqual(602);
    expect(a.cumulative.pnl.at(-1)!).toBeCloseTo(a.pnl, 9);
  });
});

describe("very large trade lists", () => {
  // Math.max(...a) throws RangeError at ~150k elements; summarize/analyze must not spread.
  const N = 400_000;
  const trips: RoundTrip[] = Array.from({ length: N }, (_, i) => ({
    id: i + 1, strategy: "s", symbol: "BACKTEST:X", side: i % 2 ? "long" : "short", entryTs: i * 60_000, entryPx: 100, exitTs: i * 60_000 + 30_000, exitPx: 101,
    qty: 1, pnl: (i % 7) - 3, fills: 2, holdMs: 30_000, open: false, exit: "signal",
  }));
  it("analyze handles 400k trades and gets the extremes right", () => {
    const a = analyze(trips);
    expect(a.closed).toBe(N);
    expect(a.largestWin).toBe(3);
    expect(a.largestLoss).toBe(-3);
    expect(a.pnlHistogram.counts.reduce((x, y) => x + y, 0)).toBe(N);
  });
});

import { binRange, binOf, nextDown } from "../src/analytics.js";
describe("histogram bars and their click filters agree", () => {
  const mk = (pnls: number[], r?: number[]): RoundTrip[] => pnls.map((pnl, i) => ({
    id: i + 1, strategy: "s", symbol: "BACKTEST:X", side: "long", entryTs: i * 1000, entryPx: 100, exitTs: i * 1000 + 500, exitPx: 101,
    qty: 1, pnl, fills: 2, holdMs: 500, open: false, exit: "signal", ...(r ? { risk: 120, r: r[i] } : {}),
  }));
  it("every bar lists exactly the trades it counts, even with many trades exactly on the edges and at the maximum", () => {
    // fixed-bracket shape: every stop loses exactly -120, every target wins exactly +240
    const pnls = [...Array(30).fill(-120), ...Array(12).fill(240), -45.5, 13.2, 80, 199.99, 0];
    const trips = mk(pnls, pnls.map((p) => p / 120));
    const a = analyze(trips);
    for (const [h, key] of [[a.pnlHistogram, "Pnl"], [a.rHistogram!, "R"]] as const) {
      expect(h.edges[h.edges.length - 1]).toBe(key === "Pnl" ? 240 : 2);
      h.counts.forEach((c, i) => {
        const { min, max } = binRange(h, i);
        const q = key === "Pnl" ? { minPnl: min, maxPnl: max } : { minR: min, maxR: max };
        expect(filterTrips(trips, q).length, `${key} bar ${i}`).toBe(c);
      });
      expect(h.counts.reduce((x, y) => x + y, 0)).toBe(trips.length);
    }
  });
  it("nextDown is the largest double below x; binOf puts an edge value in the upper bin", () => {
    expect(nextDown(240)).toBeLessThan(240);
    expect(nextDown(240)).toBeGreaterThan(239.99999999999);
    expect(nextDown(-120)).toBeLessThan(-120);
    expect(binOf([0, 1, 2, 3], 1)).toBe(1);
    expect(binOf([0, 1, 2, 3], 3)).toBe(2);
    expect(binOf([0, 1, 2, 3], 0.999)).toBe(0);
  });
});

describe("trades the venue closed", () => {
  it("a CFD run has no venue breakdown at all, so its analytics are unchanged", () => {
    expect(analyze(both).venue).toBeUndefined();
  });
  it("counts expiry, liquidation and failed-roll closes with their P&L, in a fixed order", () => {
    const mk = (i: number, pnl: number, venueExit?: RoundTrip["venueExit"]): RoundTrip => ({ ...both.find((t) => !t.open)!, id: i, pnl, ...(venueExit ? { venueExit } : {}) });
    const a = analyze([mk(1, 100), mk(2, -50, "liquidation"), mk(3, 30, "expiry"), mk(4, -20, "expiry")]);
    expect(a.venue).toEqual([
      { reason: "expiry", pnl: 10, trades: 2, wins: 1 },
      { reason: "liquidation", pnl: -50, trades: 1, wins: 0 },
    ]);
  });
});
