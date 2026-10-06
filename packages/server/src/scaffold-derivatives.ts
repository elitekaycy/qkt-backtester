import { promises as fs } from "node:fs";
import path from "node:path";
import { isMap, isSeq, parseDocument, stringify } from "yaml";
import { parseInstruments, rootOfContract } from "@qkt-studio/core";

/**
 * The futures and options part of a seeded workspace. A CFD-only data source gets none of it (the files stay exactly as
 * they were); a source that holds contracts, perpetuals or option chains gets `futures:` / `options:` entries for them, a
 * config whose risk caps do not silently block futures orders, and a bigger starting balance.
 *
 * Terms the studio cannot know are marked GUESSED like the CFD specs. Margin is never invented: a root without `margin`
 * is never refused for it and never liquidated, which the entry says.
 */

export interface FutureRoot {
  venue: string; root: string;
  /** contracts/<VENUE>/<ROOT>.json exists: dated contracts the roll policy can chain. */
  catalog: boolean;
  /** The perpetual a funding file exists for (funding/<VENUE>/<NAME>.csv). */
  perpetual?: string;
}
export interface OptionRoot { venue: string; root: string; chains: Array<"trade" | "book"> }
export interface Derivatives {
  futures: FutureRoot[]; options: OptionRoot[];
  /** Raw yaml of the entries the data source's own instruments.yaml already declares, by `VENUE:ROOT`: copied, never regenerated, so margin and fees survive. */
  declaredFutures: Map<string, string>; declaredOptions: Map<string, string>;
}

const ls = (d: string) => fs.readdir(d).catch(() => [] as string[]);
const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);
const SAFE = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;

export async function discoverDerivatives(dataRoot: string | undefined): Promise<Derivatives> {
  const out: Derivatives = { futures: [], options: [], declaredFutures: new Map(), declaredOptions: new Map() };
  if (!dataRoot) return out;
  const futures = new Map<string, FutureRoot>(), options = new Map<string, OptionRoot>();

  for (const venue of (await ls(path.join(dataRoot, "contracts"))).filter((v) => SAFE.test(v))) {
    for (const f of (await ls(path.join(dataRoot, "contracts", venue))).filter((x) => x.endsWith(".json"))) {
      if (f.endsWith(".rolls.json")) continue;
      if (f.endsWith(".options.json")) { const root = f.slice(0, -".options.json".length); options.set(`${venue}:${root}`, { venue, root, chains: [] }); continue; }
      const root = f.slice(0, -".json".length);
      futures.set(`${venue}:${root}`, { venue, root, catalog: true });
    }
  }
  for (const venue of (await ls(path.join(dataRoot, "funding"))).filter((v) => SAFE.test(v))) {
    for (const f of (await ls(path.join(dataRoot, "funding", venue))).filter((x) => x.endsWith(".csv"))) {
      const name = f.slice(0, -4), key = `${venue}:${name}`;
      const have = futures.get(key);
      if (have) have.perpetual = name; else futures.set(key, { venue, root: name, catalog: false, perpetual: name });
    }
  }
  for (const venue of (await ls(path.join(dataRoot, "chains"))).filter((v) => SAFE.test(v))) {
    for (const root of (await ls(path.join(dataRoot, "chains", venue))).filter((r) => SAFE.test(r))) {
      const have: Array<"trade" | "book"> = [];
      for (const s of ["trade", "book"] as const) if (await isDir(path.join(dataRoot, "chains", venue, root, s))) have.push(s);
      const key = `${venue}:${root}`, cur = options.get(key);
      if (cur) cur.chains = have; else options.set(key, { venue, root, chains: have });
    }
  }

  // entries the source's own instruments.yaml already declares: carried over as written
  const text = await fs.readFile(path.join(dataRoot, "instruments.yaml"), "utf8").catch(() => "");
  if (text) {
    const cat = parseInstruments(text);
    for (const [section, into] of [["futures", out.declaredFutures], ["options", out.declaredOptions]] as const) {
      const doc = parseDocument(text);
      const seq = doc.get(section, true);
      if (!isSeq(seq)) continue;
      for (const item of seq.items) {
        const root = isMap(item) ? item.get("root") : undefined;
        if (typeof root !== "string" || !isMap(item) || !item.range) continue;
        // the entry as the user wrote it (quotes such as atUtc: "00:00" and comments survive), moved to the dash column the
        // sections below use; stringify only if that text cannot be re-read
        const lineStart = text.lastIndexOf("\n", item.range[0] - 1) + 1;
        const dashCol = text.slice(lineStart, item.range[0]).indexOf("-");
        const raw = text.slice(item.range[0], item.range[1]).replace(/\s+$/, "").split("\n");
        const shift = 2 - Math.max(dashCol, 0);
        const shifted = raw.map((l, i) => (i === 0 ? l : shift >= 0 ? " ".repeat(shift) + l : l.slice(Math.min(-shift, l.length - l.trimStart().length))));
        const entry = `  - ${shifted[0]}${shifted.length > 1 ? "\n" + shifted.slice(1).join("\n") : ""}`;
        const reread = parseDocument(`${section}:\n${entry}`);
        const ok = reread.errors.length === 0 && (reread.toJS() as Record<string, Array<{ root?: string }>>)[section]?.[0]?.root === root;
        into.set(root, ok ? entry : stringify([item.toJS(doc)], { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).replace(/\s+$/, "").split("\n").map((l) => `  ${l}`).join("\n"));
      }
    }
    for (const f of cat.futures) if (!futures.has(f.root)) { const [venue, root] = [f.root.slice(0, f.root.indexOf(":")), f.root.slice(f.root.indexOf(":") + 1)]; futures.set(f.root, { venue, root, catalog: false, perpetual: f.perpetual }); }
    for (const o of cat.options) if (!options.has(o.root)) options.set(o.root, { venue: o.root.slice(0, o.root.indexOf(":")), root: o.root.slice(o.root.indexOf(":") + 1), chains: o.chains ? [o.chains] : [] });
  }
  out.futures = [...futures.values()].sort((a, b) => a.venue.localeCompare(b.venue) || a.root.localeCompare(b.root));
  out.options = [...options.values()].sort((a, b) => a.venue.localeCompare(b.venue) || a.root.localeCompare(b.root));
  return out;
}

export const hasFutures = (d: Derivatives | null | undefined): boolean => Boolean(d && d.futures.length);
export const hasDerivatives = (d: Derivatives | null | undefined): boolean => Boolean(d && (d.futures.length || d.options.length));

/** Symbols that are a contract, a root or a perpetual of a discovered futures root: they are not CFDs and get no CFD entry. */
export function isDerivativeSymbol(d: Derivatives, broker: string, symbol: string): boolean {
  const roots = new Set(d.futures.map((f) => `${f.venue}:${f.root}`));
  if (rootOfContract(broker, symbol, roots)) return true;
  return d.futures.some((f) => f.venue === broker && (f.root === symbol || f.perpetual === symbol));
}

interface FutureSpec { multiplier: number; tickSize: number; note: string }
/** Published contract specifications of the common CME roots. Fees and margin are not here: they depend on the broker and the day. */
const CME: Record<string, FutureSpec> = {
  ES: { multiplier: 50, tickSize: 0.25, note: "E-mini S&P 500" }, NQ: { multiplier: 20, tickSize: 0.25, note: "E-mini Nasdaq-100" },
  MES: { multiplier: 5, tickSize: 0.25, note: "Micro E-mini S&P 500" }, MNQ: { multiplier: 2, tickSize: 0.25, note: "Micro E-mini Nasdaq-100" },
  YM: { multiplier: 5, tickSize: 1, note: "E-mini Dow" }, RTY: { multiplier: 50, tickSize: 0.1, note: "E-mini Russell 2000" },
  CL: { multiplier: 1000, tickSize: 0.01, note: "WTI crude oil" }, GC: { multiplier: 100, tickSize: 0.1, note: "Gold" },
  SI: { multiplier: 5000, tickSize: 0.005, note: "Silver" }, NG: { multiplier: 10000, tickSize: 0.001, note: "Natural gas" },
  HG: { multiplier: 25000, tickSize: 0.0005, note: "Copper" }, ZN: { multiplier: 1000, tickSize: 0.015625, note: "10-year T-Note" },
  ZB: { multiplier: 1000, tickSize: 0.03125, note: "30-year T-Bond" }, "6E": { multiplier: 125000, tickSize: 0.00005, note: "Euro FX" },
};
const CRYPTO_VENUES = /^(BINANCE_UM|BINANCE|DERIBIT|BYBIT|BYBIT_LINEAR|OKX|BITMEX)/;

function futureEntry(f: FutureRoot, declared: Map<string, string>): string {
  const key = `${f.venue}:${f.root}`;
  const own = declared.get(key);
  if (own) {
    // a funding file for this root's name but no `perpetual:`: the entry is read as a plain symbol (no funding, no root fees) [probed]
    const hint = f.perpetual && !/^\s+perpetual:/m.test(own) ? `\n    # funding/${f.venue}/${f.perpetual}.csv exists: add "perpetual: ${f.perpetual}" above to charge it (a perpetual without it pays no funding and no root fees)` : "";
    return `  # ${key}: copied from the data source's own instruments.yaml\n${own}${hint}\n`;
  }
  const cme = f.venue === "CME" ? CME[f.root] : undefined;
  const crypto = CRYPTO_VENUES.test(f.venue);
  const spec: FutureSpec = cme ?? { multiplier: 1, tickSize: crypto ? 0.1 : 0.01, note: "GUESSED: check the multiplier, tick size and lot rules on the venue's contract page" };
  const lots = crypto ? { step: 0.001, min: 0.001 } : { step: 1, min: 1 };
  const lines = [
    `  - root: ${key}          # ${spec.note}`,
    `    currency: ${crypto ? "USDT" : "USD"}          # P&L currency of the contract${crypto ? " (GUESSED)" : ""}`,
    `    multiplier: ${spec.multiplier}${cme ? "" : "          # GUESSED"}`,
    `    tickSize: ${spec.tickSize}${cme ? "" : "          # GUESSED"}`,
    `    volumeStep: ${lots.step}`,
    `    volumeMin: ${lots.min}`,
    `    calendar: ${crypto ? "crypto" : f.venue === "CME" ? "cme_globex" : "nyse"}${crypto || f.venue === "CME" ? "" : "          # GUESSED"}`,
    crypto ? "    takerFeeRate: 0          # fraction of notional per fill; set your venue's taker rate (Binance USDⓈ-M VIP 0 is 0.0005)"
      : "    exchangeFeePerContract: 0          # account currency per contract per fill: exchange + clearing + broker, set yours",
  ];
  if (f.catalog) lines.push("    roll: { daysBeforeExpiry: 7, atUtc: \"00:00\", adjust: panama }   # how @front/@next chains contracts; measure the rolls once: qkt fetch " + `${key} --rolls`);
  if (f.perpetual) lines.push(`    perpetual: ${f.perpetual}          # the root's perpetual: charged funding from funding/${f.venue}/${f.perpetual}.csv`);
  lines.push("    # margin: { initial: 0, maintenance: 0, basis: per_contract }   # your broker's numbers. Without it the run is never refused for margin and the account is never liquidated.");
  return lines.join("\n") + "\n";
}

function optionEntry(o: OptionRoot, declared: Map<string, string>): string {
  const key = `${o.venue}:${o.root}`;
  const own = declared.get(key);
  if (own) return `  # ${key}: copied from the data source's own instruments.yaml\n${own}\n`;
  const quote = o.root.includes("_") ? o.root.split("_").pop()! : "USD";
  const chains = o.chains.includes("book") ? "book" : "trade";
  return [
    `  - root: ${key}          # option contracts are named ${o.root}_<expiry>_<strike>_<C|P>; terms below are Deribit's linear options: GUESSED for any other venue`,
    `    currency: ${quote}`,
    "    contractSize: 1",
    "    tickSize: 5          # GUESSED: the venue's tick schedule can step (tickSteps)",
    "    volumeStep: 0.01",
    "    volumeMin: 0.01",
    `    underlyingIndex: ${o.root.toLowerCase()}`,
    `    chains: ${chains}          # the stored series the backtest trades on (${o.chains.length ? o.chains.join(" and ") + " found" : "none stored yet"})`,
    ...(chains === "trade" ? ["    markSpread: 0.05          # trade series only: half-spread as a fraction of the mark"] : []),
    "    maxQuoteAgeMinutes: 60          # older marks are not tradeable",
    "    takerFeeRate: 0.0003          # of the underlying index per contract (Deribit's published rate: check yours)",
    "    deliveryFeeRate: 0.00015",
    "    feeCapRate: 0.125",
  ].join("\n") + "\n";
}

/** The `futures:` and `options:` sections to append to instruments.yaml; empty when the source holds neither. */
export function derivativesSections(d: Derivatives): string {
  let out = "";
  if (d.futures.length) {
    out += `
# ---------------------------------------------------------------------------------------------------------------------
# Futures: one entry per root found in the data source (contracts/, funding/). A strategy trades a listed contract
# (CME:ESH19), a root's perpetual, or follows the root (CME:ES@front / @next, chained by the roll policy).
#   multiplier       P&L = price move x multiplier x quantity
#   tickSize         order prices are snapped to this grid
#   takerFeeRate / exchangeFeePerContract   charged on every fill
#   margin           optional. With it, an order the account cannot margin is refused and an account below maintenance
#                    margin is liquidated (reported as exit reason LIQUIDATION); without it neither happens
#   roll             how @front/@next chains dated contracts (adjust: panama is required to trade a continuous stream)
#   perpetual        the root's perpetual, which never expires and pays funding
# Futures fill on qkt's exchange simulator whatever the broker option says.
# ---------------------------------------------------------------------------------------------------------------------
futures:
${d.futures.map((f) => futureEntry(f, d.declaredFutures)).join("\n")}`;
  }
  if (d.options.length) {
    out += `
# ---------------------------------------------------------------------------------------------------------------------
# Options: one entry per root with a catalog or stored chains. Fills happen at the next stored quote (a buy at the ask, a
# sell at the bid); a contract held to expiry settles in cash at the delivery price; equity must cover the worst-case
# expiry loss of what is open.
# ---------------------------------------------------------------------------------------------------------------------
options:
${d.options.map((o) => optionEntry(o, d.declaredOptions)).join("\n")}`;
  }
  return out;
}

/**
 * qkt's defaults are sized for a small CFD account and silently block futures orders: the per-order notional cap (250,000 by
 * default) is below one ES contract's value on a good day, the per-order quantity cap blocks coin-denominated perpetuals,
 * and the 1,000 daily-loss halt trips on a single move [probed on qkt 0.55 with ES and Binance perpetuals]. The seeded
 * futures config raises them to safeguards that no single sensible order reaches; tune them to the account.
 */
export function futuresConfig(template: string): string {
  const risk = `risk:
  max_daily_loss: "1000"            # "0" disables`;
  const balance = "starting_balance: ${STARTING_BALANCE:-10000}";
  if (!template.includes(risk) || !template.includes(balance)) return template;
  const futuresRisk = `risk:
  # Futures: qkt's defaults are sized for a small CFD account and silently block (never submit, never log a rejection) orders
  # above them, or halt the run on the first big move. These are safeguards no single sensible order reaches; tune to your account.
  max_daily_loss: "5000"            # "0" disables; 5% of the default starting balance above
  max_order_notional: "10000000"    # per-order value cap (quantity x price x multiplier); qkt's default is 250000
  max_order_qty: "10000000"         # per-order size cap; qkt's default blocks coin-denominated perpetuals`;
  return template
    .replace(balance, () => "starting_balance: ${STARTING_BALANCE:-100000}   # futures need real margin: one E-mini S&P contract is ~250k of notional")
    .replace(risk, () => futuresRisk)
    .replace('  # max_order_notional: "250000"   # per-order value cap (size x price x contract size); applies to backtests too\n', () => "")
    .replace('  # max_order_qty: "100"            # per-order size cap; applies to backtests too\n', () => "");
}

/** The `.env` value that goes with {@link futuresConfig}. */
export const futuresEnv = (env: string): string => env.replace("STARTING_BALANCE=10000", "STARTING_BALANCE=100000");
