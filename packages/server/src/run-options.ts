import type { Tier } from "@qkt-studio/core";

import type { RunOptions } from "@qkt-studio/core";
import { EXECUTIONS } from "@qkt-studio/core";
export type { RunOptions } from "@qkt-studio/core";
export { EXECUTIONS } from "@qkt-studio/core";
const FULL_ONLY: Array<keyof RunOptions> = ["broker", "execution", "slippage", "latency", "stopLatency", "tpFill", "rejectEvery", "partialFill"];
const DURATION = /^(fixed:)?\d+(ms|s)?$/;
const SLIPPAGE = /^(zero|instrument|fixed-points:\d+(\.\d+)?|uniform:\d+(\.\d+)?)$/;

export class OptionsError extends Error {}

/** Validate and normalise; unknown keys are rejected so a typo never silently changes a run. */
export function validateOptions(tier: Tier, raw: unknown): RunOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OptionsError("options must be an object");
  const o = raw as Record<string, unknown>;
  const known = new Set(["startingBalance", "positionMode", "seed", "broker", "execution", "slippage", "accountCurrency", "fxMissingPolicy", "latency", "stopLatency", "tpFill", "rejectEvery", "partialFill", "funding"]);
  for (const k of Object.keys(o)) if (!known.has(k)) throw new OptionsError(`unknown option '${k}'`);
  const out: RunOptions = {};
  if (o.startingBalance !== undefined) {
    const n = Number(o.startingBalance);
    if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new OptionsError("startingBalance must be a positive number");
    out.startingBalance = n;
  }
  if (o.positionMode !== undefined) {
    if (o.positionMode !== "hedging" && o.positionMode !== "netting") throw new OptionsError("positionMode must be 'hedging' or 'netting'");
    out.positionMode = o.positionMode;
  }
  if (o.seed !== undefined) {
    const n = Number(o.seed);
    if (!Number.isInteger(n) || n < 0 || n > 2_147_483_647) throw new OptionsError("seed must be a non-negative integer");
    out.seed = n;
  }
  if (o.broker !== undefined) {
    if (o.broker !== "paper" && o.broker !== "mt5-sim") throw new OptionsError("broker must be 'paper' or 'mt5-sim'");
    out.broker = o.broker;
  }
  if (o.execution !== undefined) {
    if (!EXECUTIONS.includes(o.execution as never)) throw new OptionsError(`execution must be one of ${EXECUTIONS.join(", ")}`);
    out.execution = o.execution as RunOptions["execution"];
  }
  if (o.slippage !== undefined) {
    if (typeof o.slippage !== "string" || !SLIPPAGE.test(o.slippage)) throw new OptionsError("slippage must be zero, instrument, fixed-points:N or uniform:N");
    out.slippage = o.slippage;
  }
  if (o.accountCurrency !== undefined) {
    if (typeof o.accountCurrency !== "string" || !/^[A-Za-z]{3}$/.test(o.accountCurrency)) throw new OptionsError("accountCurrency must be a 3-letter currency code such as USD");
    out.accountCurrency = o.accountCurrency.toUpperCase();
  }
  if (o.fxMissingPolicy !== undefined) {
    if (o.fxMissingPolicy !== "warn" && o.fxMissingPolicy !== "fail") throw new OptionsError("fxMissingPolicy must be 'warn' or 'fail'");
    out.fxMissingPolicy = o.fxMissingPolicy;
  }
  for (const k of ["latency", "stopLatency"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string" || !DURATION.test(o[k] as string)) throw new OptionsError(`${k} must be milliseconds, 250ms, 1s or fixed:250ms`);
    out[k] = o[k] as string;
  }
  if (o.tpFill !== undefined) {
    if (o.tpFill !== "print" && o.tpFill !== "level") throw new OptionsError("tpFill must be 'print' or 'level'");
    out.tpFill = o.tpFill;
  }
  if (o.rejectEvery !== undefined) {
    const n = Number(o.rejectEvery);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new OptionsError("rejectEvery must be a positive integer");
    out.rejectEvery = n;
  }
  if (o.partialFill !== undefined) {
    const n = Number(o.partialFill);
    if (!(n > 0 && n < 1)) throw new OptionsError("partialFill must be a fraction between 0 and 1 (exclusive)");
    out.partialFill = n;
  }
  if (o.funding !== undefined) {
    if (o.funding !== "on" && o.funding !== "off") throw new OptionsError("funding must be 'on' or 'off'");
    if (o.funding === "off") out.funding = "off"; // "on" is qkt's default: no option, so a run is not given a second identity
  }
  if (tier === "draft") for (const k of FULL_ONLY) if (out[k] !== undefined) throw new OptionsError(`'${k}' is only available in Full (tick) runs: qkt refuses the MT5 simulator with --bars`);
  return out;
}

/** CLI arguments in a fixed order so equal options always hash equal. */
export function optionArgs(o: RunOptions): string[] {
  const a: string[] = [];
  if (o.startingBalance !== undefined) a.push("--starting-balance", String(o.startingBalance));
  if (o.positionMode) a.push("--position-mode", o.positionMode);
  if (o.seed !== undefined) a.push("--seed", String(o.seed));
  if (o.broker) a.push("--broker", o.broker);
  if (o.execution) a.push("--execution", o.execution);
  if (o.slippage) a.push("--slippage", o.slippage);
  if (o.accountCurrency) a.push("--account-currency", o.accountCurrency);
  if (o.fxMissingPolicy) a.push("--fx-missing-policy", o.fxMissingPolicy);
  if (o.latency) a.push("--execution-latency", o.latency);
  if (o.stopLatency) a.push("--stop-latency", o.stopLatency);
  if (o.tpFill) a.push("--tp-fill", o.tpFill);
  if (o.rejectEvery !== undefined) a.push("--reject-every", String(o.rejectEvery));
  if (o.partialFill !== undefined) a.push("--partial-fill", String(o.partialFill));
  if (o.funding === "off") a.push("--funding", "off");
  return a;
}
