import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScanReport } from "@qkt-studio/core";

/** Files a qkt research workspace is made of. The studio creates the ones that are missing and never overwrites any. */
export type ScaffoldFile = "qkt.config.yaml" | "instruments.yaml" | ".env" | ".env.example" | ".gitignore" | "strategies";

export const CONFIG_TEMPLATE = `# qkt.config.yaml - read by every backtest the studio runs (it always passes --config explicitly).
# Reference: qkt/docs/reference/config-schema.md
#
# Values may use \${VAR} or \${VAR:-default}; the variables come from the .env file next to this one, then the environment.
# Lines that are ACTIVE below equal qkt's defaults, so the file changes nothing until you edit it.
# Sections marked (live) only matter when you deploy; they are here so one file describes the whole setup.

# ---------------------------------------------------------------------------------------------------------------------
# General
# ---------------------------------------------------------------------------------------------------------------------
source: local
# The studio owns the data folder (Data section / QKT_DATA_HOME). Bars ignore data_root, so leave it out.
# data_root: ./data

# Starting cash. qkt backtest ignores this key on its own; the studio passes it as --starting-balance so this number is used.
starting_balance: \${STARTING_BALANCE:-10000}
log_level: info                     # debug | info | warn | error

runtime:
  mode: dev                         # dev | paper | production (production = fail-closed checks)
  # candle_close_grace_ms: 2000     # how long after a bar ends a quiet symbol's bar is closed

# ---------------------------------------------------------------------------------------------------------------------
# Accounting: currency P&L is reported in, and how non-USD P&L is converted
# ---------------------------------------------------------------------------------------------------------------------
account:
  currency: USD

fx_conversion:
  # missing_policy: fail            # fail (default, safe) | warn (compat: unconvertible P&L is reported as-is)
  # symbols:                        # marks used to convert, e.g. a JPY-quoted pair to USD
  #   USDJPY: BACKTEST:USDJPY

# ---------------------------------------------------------------------------------------------------------------------
# Execution model (Ticks runs with the MT5 simulator; bars runs are the paper model and refuse these presets)
# ---------------------------------------------------------------------------------------------------------------------
execution:
  position_mode: hedging            # hedging (every entry is its own leg, like retail MT5) | netting (one signed position)
  # preset: mt5-realistic           # paper-fast | mt5-basic | mt5-realistic | stress
  # seed: 42                        # reproducible random slippage
  # latency: 250ms                  # order placement delay
  # stop_latency: 260ms             # delay between a stop triggering and filling
  # tp_fill: print                  # print | level: how a gapped take-profit is priced
  # slippage: instrument            # zero | instrument | fixed-points:N | uniform:N
  # reject_every: 10                # reject every Nth order (stress test)
  # partial_fill: 0.5               # fraction (0,1) of each order filled

# ---------------------------------------------------------------------------------------------------------------------
# Risk halts. These apply to BACKTESTS too: a run halts when a limit is hit. The daily-loss default is 1000 in account
# currency, so a big-position strategy can stop trading early without any message. Set 0 to disable, or size it to your
# account.
# ---------------------------------------------------------------------------------------------------------------------
risk:
  max_daily_loss: "1000"            # "0" disables
  # max_drawdown_pct: "20"          # halt at this total drawdown, percent of the basis below
  # max_daily_drawdown_pct: "5"
  # total_dd_basis: static          # static = initial balance | trailing = high-water equity
  # daily_dd_basis: balance         # balance | equity
  # max_round_trips_10m: 10         # 0 disables the runaway-loop breaker
  # max_broker_rejections_1m: 5
  # (live) max_order_qty, max_order_notional, price_collar_pct, margin_floor_pct, measured_usage_hours, measured_usage_max_qty
  # per_strategy:
  #   my_strategy:                  # the STRATEGY name in the .qkt file
  #     max_daily_loss: "300"
  #     max_position_size: "1.0"
  #     max_open_positions: "2"
  #     max_trades_per_day: 20
  #     cooldown_after_loss: 30m
  #     loss_streak_halt: 5

# ---------------------------------------------------------------------------------------------------------------------
# (live) Brokers, market-data gate, notifications, telemetry, portfolio limits, promotion gates
# ---------------------------------------------------------------------------------------------------------------------
# brokers:
#   mt5:
#     type: mt5
#     gateway_url: \${QKT_BROKER_GATEWAY_URL:-http://localhost:5001}
#     api_key: \${QKT_BROKER_API_KEY}            # put the value in .env, not here
#     server_time_zone: \${QKT_BROKER_SERVER_TIME_ZONE:-new_york_close}
#     symbol_suffix: \${QKT_BROKER_SYMBOL_SUFFIX:-}
#     magic: \${QKT_BROKER_MAGIC:-10001}
#     calendars:
#       "BTC*": crypto
#       "*": fx
#     aliases:
#       NAS100: USTEC
#     instrument_overrides:
#       XAUUSD: { min_volume: "0.01", max_volume: "50", volume_step: "0.01", point_size: "0.001", digits: "3", trade_stops_level_points: "50" }
#
# market_data: { stale_age_multiple: 5.0, min_stale_age_ms: 10000, outlier_sigma: 6.0, max_clock_skew_ms: 60000 }
#
# notify:
#   telegram:
#     enabled: false
#     bot_token: \${TELEGRAM_BOT_TOKEN}
#     chat_id: \${TELEGRAM_CHAT_ID}
#     events: [order_rejected, halted, resumed, strategy_error]
#
# insights: { enabled: false, url: \${INSIGHTS_URL:-}, token: \${INSIGHTS_TOKEN:-} }
#
# book_risk:                                     # portfolio deployments only
#   capital: "100000"
#   limits: { max_gross_exposure: "300000", max_net_exposure: "150000", max_symbol_concentration: "0.35" }
#
# promotion: { enforce: false }
`;

export const ENV_EXAMPLE = `# Copy to .env (the studio and every qkt command it runs read .env from the workspace folder).
# Reference these in qkt.config.yaml as \${NAME} or \${NAME:-default}. Never commit the real .env.

STARTING_BALANCE=10000

# QKT_BROKER_GATEWAY_URL=http://localhost:5001
# QKT_BROKER_API_KEY=
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
`;

export const ENV_TEMPLATE = `# Workspace environment. Read by qkt.config.yaml (\${NAME} / \${NAME:-default}) and by every qkt command the studio runs.
# Edit and save: the next run picks the change up (and re-runs instead of reusing a cached result).
# Keep secrets here, not in qkt.config.yaml. This file is git-ignored.

STARTING_BALANCE=10000
`;

export const GITIGNORE = `.env
runs/
.qkt-studio/
`;

interface Spec { contractSize: number; digits: number; step: number; min: number; max?: number; note: string }
const FX = (digits: number): Spec => ({ contractSize: 100_000, digits, step: 0.01, min: 0.01, note: "standard FX lot: 100,000 units" });
const KNOWN: Record<string, Spec> = {
  XAUUSD: { contractSize: 100, digits: 3, step: 0.01, min: 0.01, note: "gold: 100 oz per lot" },
  XAGUSD: { contractSize: 5000, digits: 3, step: 0.01, min: 0.01, note: "silver: 5,000 oz per lot" },
  EURUSD: FX(5), GBPUSD: FX(5), AUDUSD: FX(5), NZDUSD: FX(5), USDCHF: FX(5), USDCAD: FX(5),
  USDJPY: FX(3), EURJPY: FX(3), GBPJPY: FX(3),
  BTCUSD: { contractSize: 1, digits: 2, step: 0.01, min: 0.01, max: 100, note: "crypto CFD: 1 coin per lot" },
  ETHUSD: { contractSize: 1, digits: 2, step: 0.01, min: 0.01, max: 500, note: "crypto CFD: 1 coin per lot" },
  BTCUSDT: { contractSize: 1, digits: 2, step: 0.001, min: 0.001, max: 100, note: "crypto spot: 1 coin per lot" },
  CL: { contractSize: 1000, digits: 2, step: 0.01, min: 0.01, note: "WTI crude: 1,000 barrels per lot (check your broker)" },
  USOIL: { contractSize: 1000, digits: 2, step: 0.01, min: 0.01, note: "WTI crude CFD: 1,000 barrels per lot" },
  HG: { contractSize: 25_000, digits: 4, step: 0.01, min: 0.01, note: "copper: 25,000 lb per lot (check your broker)" },
};
const GENERIC: Spec = { contractSize: 1, digits: 2, step: 0.01, min: 0.01, note: "GUESSED: check the contract size, lot step and digits with your broker" };
const num = (n: number) => String(n);

/** An instruments.yaml with an editable entry for every symbol in the data store, plus the fields you would tune. */
export function instrumentsTemplate(pairs: Array<{ broker: string; symbol: string }>): string {
  const head = `# instruments.yaml - contract specs the backtest uses for sizing, P&L, costs and swap.
# The studio passes this file to every run (qkt --instruments). A symbol listed here overrides qkt's built-in table; a symbol
# not listed falls back to it (FX majors, gold and silver only), and any other symbol makes qkt refuse to run.
#
#   contractSize   units of the instrument per 1.0 lot (P&L = price move x contractSize x lots)
#   volumeStep/Min/Max   order size rules: sizes are rounded to the step, below Min they are rejected
#   pointSize / digits   price granularity; stop and slippage distances are counted in points
#   tradeStopsLevelPoints  minimum distance of a stop from the price (MT5 simulator)
#   commissionPerLot     account currency per 1.0 lot per side (e.g. 3.5); 0 = commission-free
#   slippagePoints       adverse slip in points on every fill (MT5 simulator only)
#   swapLongPoints / swapShortPoints   signed points per lot per night (negative = you pay); swapRolloverHourUtc, swapTripleDay
#
# Venue specs differ by broker: treat the numbers below as starting points and check them against yours.
instruments:
`;
  const seen = new Set<string>();
  const items = pairs.filter((p) => { const k = `${p.broker}:${p.symbol}`; if (seen.has(k)) return false; seen.add(k); return true; }).map(({ broker, symbol }) => {
    const spec = KNOWN[symbol] ?? GENERIC;
    return `  - qktSymbol: ${broker}:${symbol}          # ${spec.note}
    contractSize: ${num(spec.contractSize)}
    volumeStep: ${num(spec.step)}
    volumeMin: ${num(spec.min)}
${spec.max !== undefined ? `    volumeMax: ${num(spec.max)}\n` : ""}    pointSize: ${num(Number((10 ** -spec.digits).toFixed(spec.digits)))}
    digits: ${spec.digits}
    tradeStopsLevelPoints: 0
    commissionPerLot: 0
    slippagePoints: 0
    swapLongPoints: 0
    swapShortPoints: 0
    swapRolloverHourUtc: 21
    swapTripleDay: WEDNESDAY
`;
  });
  return head + (items.join("\n") || "  []\n");
}

export const pairsOf = (scan: ScanReport | null): Array<{ broker: string; symbol: string }> =>
  (scan?.symbols ?? []).flatMap((s) => (s.bars.filter((b) => b.files > 0).length ? [...new Set(s.bars.filter((b) => b.files > 0).map((b) => b.broker))] : ["BACKTEST"]).map((broker) => ({ broker, symbol: s.symbol })));

const pickTf = (tfs: string[], want: string) => (tfs.includes(want) ? want : tfs.sort((a, b) => Number.parseInt(a) - Number.parseInt(b))[0]);

/** Two sample strategies on a symbol that is really in the data source (never a symbol that would fail the run). */
export function sampleStrategies(scan: ScanReport | null): Record<string, string> {
  const usable = (scan?.symbols ?? []).filter((s) => s.bars.some((b) => b.files > 0));
  const order = ["XAUUSD", "EURUSD", "BTCUSD", "DEMOUSD"];
  const s = order.map((n) => usable.find((x) => x.symbol === n)).find(Boolean) ?? usable[0];
  const tfs = s ? [...new Set(s.bars.filter((b) => b.files > 0).map((b) => b.tf))] : [];
  const tf = pickTf([...tfs], "15m") ?? "15m";
  const sym = s?.symbol ?? "XAUUSD";
  const broker = s?.bars.find((b) => b.files > 0)?.broker ?? "BACKTEST";
  const hi = tfs.find((t) => t !== tf && Number.parseInt(t) > Number.parseInt(tf));
  const size = sym === "DEMOUSD" ? "10" : "0.1";
  const files: Record<string, string> = {
    "strategies/ema_cross.qkt": `-- EMA cross on ${broker}:${sym} ${tf}. Edit anything, Ctrl+S to save, Ctrl+Enter to run. Errors show up as you type.
-- Contract size and lot rules come from instruments.yaml; account and risk settings from qkt.config.yaml.
STRATEGY ema_cross VERSION 1

SYMBOLS
    px = ${broker}:${sym} EVERY ${tf}

PARAM fast = 9
PARAM slow = 21

RULES
    WHEN ema(px.close, fast) CROSSES ABOVE ema(px.close, slow)
     AND POSITION.px = 0
    THEN BUY px SIZING ${size}

    WHEN ema(px.close, fast) CROSSES BELOW ema(px.close, slow)
     AND POSITION.px > 0
    THEN CLOSE px
`,
  };
  if (hi) files["strategies/two_timeframes.qkt"] = `-- Two timeframes of the same symbol: the ${hi} trend filters the ${tf} entries. The Chart shows one chart per timeframe.
STRATEGY two_timeframes VERSION 1

SYMBOLS
    px = ${broker}:${sym} EVERY ${tf}
    hr = ${broker}:${sym} EVERY ${hi}

PARAM trend = 20

RULES
    WHEN ema(px.close, 9) CROSSES ABOVE ema(px.close, 21)
     AND px.close > ema(hr.close, trend)
     AND POSITION.px = 0
    THEN BUY px SIZING ${size} ; LOG "long with the ${hi} trend"

    WHEN ema(px.close, 9) CROSSES BELOW ema(px.close, 21)
     AND POSITION.px > 0
    THEN CLOSE px
`;
  return files;
}

export interface ScaffoldResult { created: string[]; skipped: string[] }

/** Create what is missing (never overwrite). `wanted` limits it to some files; omitted means all of them. */
export async function scaffoldWorkspace(workspace: string, scan: ScanReport | null, wanted?: ScaffoldFile[]): Promise<ScaffoldResult> {
  const want = (f: ScaffoldFile) => !wanted || wanted.includes(f);
  const out: ScaffoldResult = { created: [], skipped: [] };
  const put = async (rel: string, text: string) => {
    const abs = path.join(workspace, rel);
    if (await fs.stat(abs).then(() => true, () => false)) { out.skipped.push(rel); return; }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, { flag: "wx" });
    out.created.push(rel);
  };
  if (want("qkt.config.yaml")) await put("qkt.config.yaml", CONFIG_TEMPLATE);
  if (want("instruments.yaml")) await put("instruments.yaml", instrumentsTemplate(pairsOf(scan)));
  if (want(".env")) await put(".env", ENV_TEMPLATE);
  if (want(".env.example")) await put(".env.example", ENV_EXAMPLE);
  if (want(".gitignore")) await put(".gitignore", GITIGNORE);
  if (want("strategies")) for (const [rel, text] of Object.entries(sampleStrategies(scan))) await put(rel, text);
  return out;
}

/** Which of the standard project files are absent. Drives the Files section's "add missing files" prompt. */
export async function missingFiles(workspace: string): Promise<ScaffoldFile[]> {
  const out: ScaffoldFile[] = [];
  for (const f of ["qkt.config.yaml", "instruments.yaml", ".env"] as const) if (!(await fs.stat(path.join(workspace, f)).then(() => true, () => false))) out.push(f);
  return out;
}
