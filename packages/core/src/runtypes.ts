/** The qkt backtest options the studio exposes. Everything else stays at qkt's defaults. */
export interface RunOptions {
  /** `--starting-balance` (both tiers). */
  startingBalance?: number;
  /** `--position-mode` (both tiers). */
  positionMode?: "hedging" | "netting";
  /** `--seed` for the execution model (both tiers). */
  seed?: number;
  /** Full (tick) runs only: qkt refuses `--bars` together with the MT5 simulator. */
  broker?: "paper" | "mt5-sim";
  execution?: "paper-fast" | "mt5-basic" | "mt5-realistic" | "stress";
  /** zero | instrument | fixed-points:N | uniform:N */
  slippage?: string;
  /** `--account-currency` (both tiers): the currency P&L is reported in. */
  accountCurrency?: string;
  /** `--fx-missing-policy` (both tiers): what to do when a P&L cannot be converted to the account currency. */
  fxMissingPolicy?: "warn" | "fail";
  /** Full (tick) runs with the MT5 simulator: `--execution-latency`, `--stop-latency` (ms or `250ms`/`1s`), `--tp-fill`, `--reject-every`, `--partial-fill`. */
  latency?: string;
  stopLatency?: string;
  tpFill?: "print" | "level";
  rejectEvery?: number;
  partialFill?: number;
  /**
   * `--funding off` (both tiers): backtest a perpetual without charging its funding. By default a perpetual's stored funding
   * is charged and a run whose stored rates do not cover it is refused (qkt names the `qkt fetch ... --funding`). Only
   * `"off"` is ever passed; `"on"` is the default and adds no flag.
   */
  funding?: "on" | "off";
}

export const EXECUTIONS = ["paper-fast", "mt5-basic", "mt5-realistic", "stress"] as const;
