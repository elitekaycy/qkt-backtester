import { describe, it, expect } from "vitest";
import { validateOptions, optionArgs, OptionsError } from "../src/run-options.js";

describe("validateOptions", () => {
  it("accepts the both-tier options", () => {
    expect(validateOptions("draft", { startingBalance: 25000, positionMode: "netting", seed: 7 })).toEqual({ startingBalance: 25000, positionMode: "netting", seed: 7 });
    expect(validateOptions("draft", undefined)).toEqual({});
    expect(validateOptions("draft", null)).toEqual({});
  });
  it("accepts execution options for Full only", () => {
    expect(validateOptions("full", { broker: "mt5-sim", execution: "mt5-realistic", slippage: "fixed-points:3" })).toEqual({ broker: "mt5-sim", execution: "mt5-realistic", slippage: "fixed-points:3" });
    for (const o of [{ broker: "mt5-sim" }, { execution: "stress" }, { slippage: "zero" }]) expect(() => validateOptions("draft", o)).toThrow(/only available in Full/);
  });
  it.each([
    [{ startingBalance: 0 }, /positive/], [{ startingBalance: -5 }, /positive/], [{ startingBalance: "abc" }, /positive/], [{ startingBalance: 1e12 }, /positive/],
    [{ positionMode: "both" }, /hedging/], [{ seed: 1.5 }, /integer/], [{ seed: -1 }, /integer/],
    [{ broker: "ib" }, /broker/], [{ execution: "turbo" }, /execution/], [{ slippage: "0.5" }, /slippage/], [{ slippage: "fixed-points:" }, /slippage/],
    [{ nope: 1 }, /unknown option/], ["x", /object/], [[1], /object/],
  ])("rejects %j", (o, msg) => {
    expect(() => validateOptions("full", o)).toThrow(msg);
    expect(() => validateOptions("full", o)).toThrow(OptionsError);
  });
  it("optionArgs is order-stable so equal options hash equal", () => {
    const a = optionArgs({ seed: 3, startingBalance: 500, broker: "mt5-sim", positionMode: "hedging" });
    const b = optionArgs({ broker: "mt5-sim", positionMode: "hedging", startingBalance: 500, seed: 3 });
    expect(a).toEqual(b);
    expect(a).toEqual(["--starting-balance", "500", "--position-mode", "hedging", "--seed", "3", "--broker", "mt5-sim"]);
    expect(optionArgs({})).toEqual([]);
  });
  it("cannot inject extra arguments through values", () => {
    expect(() => validateOptions("full", { slippage: "zero --report-dir /etc" })).toThrow();
    expect(() => validateOptions("full", { execution: "stress; rm" })).toThrow();
  });
});

describe("account and execution-model options", () => {
  it("accepts and orders them", () => {
    const o = validateOptions("full", { accountCurrency: "eur", fxMissingPolicy: "warn", latency: "250ms", stopLatency: "1s", tpFill: "level", rejectEvery: 10, partialFill: 0.5 });
    expect(optionArgs(o)).toEqual(["--account-currency", "EUR", "--fx-missing-policy", "warn", "--execution-latency", "250ms", "--stop-latency", "1s", "--tp-fill", "level", "--reject-every", "10", "--partial-fill", "0.5"]);
  });
  it("account currency works on bars; the simulator knobs are Full-only", () => {
    expect(validateOptions("draft", { accountCurrency: "USD" })).toEqual({ accountCurrency: "USD" });
    for (const k of [{ latency: "1s" }, { stopLatency: "1s" }, { tpFill: "level" }, { rejectEvery: 5 }, { partialFill: 0.5 }]) expect(() => validateOptions("draft", k)).toThrow(/only available in Full/);
  });
  it("rejects nonsense", () => {
    expect(() => validateOptions("full", { accountCurrency: "DOLLARS" })).toThrow();
    expect(() => validateOptions("full", { latency: "fast" })).toThrow();
    expect(() => validateOptions("full", { partialFill: 1.5 })).toThrow();
    expect(() => validateOptions("full", { rejectEvery: 0 })).toThrow();
  });
});
