import { parseDocument } from "yaml";
import { isTradingDay, qktCalendarFor } from "./calendars.js";

/**
 * What a stream's symbol names. The DSL is the same for every kind (`alias = VENUE:SYMBOL EVERY tf`); only the symbol and the
 * fields a strategy may read differ, and qkt does not enforce the fields (a CFD alias reading `.dte` parses and never
 * trades), so the studio does.
 */
export type InstrumentKind = "cfd" | "future" | "continuous" | "perpetual" | "option" | "chain" | "analytic" | "hub";

export const DERIVATIVE_KINDS: ReadonlySet<InstrumentKind> = new Set(["future", "continuous", "perpetual", "option", "chain"]);

export interface KindContext {
  /** `VENUE:ROOT` of every `futures:` entry in instruments.yaml or contracts/ catalog. */
  futureRoots?: ReadonlySet<string>;
  /** `VENUE:NAME` of every perpetual (a root's `perpetual`, or a name the store holds funding for). */
  perpetuals?: ReadonlySet<string>;
  /** `VENUE:ROOT` of every `options:` entry. */
  optionRoots?: ReadonlySet<string>;
  /** Venue prefixes that are MT5 profiles or BACKTEST: always CFDs. */
  cfdBrokers?: ReadonlySet<string>;
}

const CFD_BROKERS = new Set(["BACKTEST", "EXNESS", "ICMARKETS", "FTMO", "PEPPERSTONE", "THE5ERS", "MT5"]);
const EXPIRY = /^(.+?)_(\d{6})$/;                       // BTCUSDT_241227
const CME_MONTH = /^(.+?)([FGHJKMNQUVXZ])(\d{2})$/;       // ESZ24

export interface StreamLike { broker: string; symbol: string }

/** `@front` / `@next` split off a continuous symbol, or null. */
export function continuousOf(symbol: string): { root: string; follow: "front" | "next" } | null {
  const m = /^(.+)@(front|next)$/.exec(symbol);
  return m ? { root: m[1]!, follow: m[2] as "front" | "next" } : null;
}

/** The root a listed contract belongs to (`BTCUSDT_241227` -> `BTCUSDT`, `ESZ24` -> `ES`), judged against the known roots. */
export function rootOfContract(venue: string, symbol: string, roots: ReadonlySet<string>): string | null {
  const dated = EXPIRY.exec(symbol);
  if (dated && roots.has(`${venue}:${dated[1]}`)) return dated[1]!;
  const cme = CME_MONTH.exec(symbol);
  if (cme && roots.has(`${venue}:${cme[1]}`)) return cme[1]!;
  return null;
}

export function kindOf(s: StreamLike, ctx: KindContext = {}): InstrumentKind {
  const venue = s.broker.toUpperCase();
  if (venue === "OPTIONS") return "chain";
  if (venue === "CHAIN") return "analytic";
  if (venue === "HUB") return "hub";
  if (continuousOf(s.symbol)) return "continuous";
  const key = `${venue}:${s.symbol}`;
  if (ctx.perpetuals?.has(key)) return "perpetual";
  if (ctx.futureRoots && rootOfContract(venue, s.symbol, ctx.futureRoots)) return "future";
  if (ctx.futureRoots?.has(key)) return "future"; // a bare root is read as its nearest/only contract
  if (/^[A-Z0-9_]+-\d{1,2}[A-Z]{3}\d{2}-[\d.]+-[CP]$/.test(s.symbol)) return "option"; // Deribit-style contract name
  // a qkt option code is the venue's name with each `-` written `_` (DERIBIT:BTC_USDC_26SEP26_84000_C)
  if (ctx.optionRoots && [...ctx.optionRoots].some((r) => key.startsWith(r + "-") || new RegExp(`^${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d`).test(key))) return "option";
  return "cfd";
}

export const isDerivative = (k: InstrumentKind) => DERIVATIVE_KINDS.has(k);

// ---- fields by kind -----------------------------------------------------------------------------------------------
//
// Mirrors `qkt dsl vocabulary` streamFields/metaFields and docs/reference/dsl/streams.md. A field absent from a kind is
// *undefined* there: the rule never fires and qkt says nothing.

const ALL = ["open", "high", "low", "close", "volume", "price", "timestamp", "value", "bid", "ask", "spread"] as const;
const META = ["contract_size", "multiplier", "tick_size", "tick_value", "volume_min", "volume_step", "swap_long_points", "swap_short_points"] as const;
const FUTURES_ONLY = ["contract", "dte", "days_to_roll"] as const;
const CONTRACT_FEEDS = ["mark", "index", "open_interest", "buy_volume", "sell_volume", "long_liq_volume", "short_liq_volume", "bid_depth", "ask_depth", "book_imbalance"] as const;
const OPTION_ONLY = ["iv", "delta", "gamma", "vega", "theta"] as const;

export const DERIVATIVE_FIELDS: ReadonlySet<string> = new Set([...FUTURES_ONLY, ...CONTRACT_FEEDS, ...OPTION_ONLY]);

const ALLOWED: Record<InstrumentKind, ReadonlySet<string>> = {
  cfd: new Set([...ALL, ...META]),
  future: new Set([...ALL, ...META, "contract", "dte", ...CONTRACT_FEEDS]),
  // a continuous series has no mark/tape/OI of its own: read a listed contract or a perpetual (qkt streams.md)
  continuous: new Set([...ALL, ...META, ...FUTURES_ONLY]),
  perpetual: new Set([...ALL, ...META, ...CONTRACT_FEEDS]),
  option: new Set([...ALL, ...META, "contract", "dte", "mark", "index", ...OPTION_ONLY]),
  chain: new Set(["timestamp"]),
  analytic: new Set(["open", "high", "low", "close", "value", "timestamp"]),
  hub: new Set(["open", "high", "low", "close", "value", "timestamp"]),
};

/** Every field any kind reads: what counts as a stream field when no vocabulary is at hand. */
export const STREAM_FIELD_NAMES: ReadonlySet<string> = new Set(Object.values(ALLOWED).flatMap((x) => [...x]));

export function fieldAllowed(kind: InstrumentKind, field: string): boolean {
  return ALLOWED[kind].has(field);
}

/** Which kinds read `field`, for a message that says where it does work. */
export function kindsReading(field: string): InstrumentKind[] {
  return (Object.keys(ALLOWED) as InstrumentKind[]).filter((k) => ALLOWED[k].has(field));
}

const KIND_LABEL: Record<InstrumentKind, string> = {
  cfd: "a CFD", future: "a listed futures contract", continuous: "a continuous futures stream (@front/@next)", perpetual: "a perpetual",
  option: "an option contract", chain: "an options chain", analytic: "a CHAIN: analytic", hub: "a HUB: record",
};
export const kindLabel = (k: InstrumentKind) => KIND_LABEL[k];

/** The one-line reason a field is not available on a kind, with where it is. */
export function fieldNotForKind(alias: string, kind: InstrumentKind, field: string): string {
  const where = kindsReading(field).filter((k) => k !== "cfd").map((k) => ({ future: "listed futures", continuous: "continuous futures", perpetual: "perpetuals", option: "option contracts", chain: "", analytic: "", hub: "" }[k])).filter(Boolean);
  const at = where.length ? ` It reads on ${where.join(", ")}.` : "";
  return `'${alias}' is ${kindLabel(kind)}, which has no '.${field}'.${at} qkt would run without error and the rule would never fire.`;
}

// ---- instruments.yaml ---------------------------------------------------------------------------------------------

export interface FutureTerms {
  root: string;                       // VENUE:ROOT
  currency?: string;
  multiplier?: number;
  tickSize?: number;
  volumeStep?: number;
  volumeMin?: number;
  takerFeeRate?: number;
  exchangeFeePerContract?: number;
  calendar?: string;
  perpetual?: string;
  margin?: { initial?: number; maintenance?: number; basis?: string };
  roll?: { daysBeforeExpiry?: number; atUtc?: string; adjust?: string };
  expiryGuardHours?: number;
}
export interface OptionTerms {
  root: string;
  currency?: string;
  contractSize?: number;
  tickSize?: number;
  volumeStep?: number;
  volumeMin?: number;
  underlyingIndex?: string;
  takerFeeRate?: number;
  chains?: "book" | "trade";
  maxQuoteAgeMinutes?: number;
}
export interface CfdTerms { qktSymbol: string; contractSize?: number; volumeStep?: number; volumeMin?: number; digits?: number; commissionPerLot?: number }

export interface InstrumentCatalog {
  cfds: CfdTerms[];
  futures: FutureTerms[];
  options: OptionTerms[];
  errors: string[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Read the three sections of an instruments.yaml; a section that is missing is empty, a malformed file reports `errors`. */
export function parseInstruments(text: string): InstrumentCatalog {
  const out: InstrumentCatalog = { cfds: [], futures: [], options: [], errors: [] };
  const doc = parseDocument(text);
  if (doc.errors.length) { out.errors = doc.errors.map((e) => e.message.split("\n")[0]!); return out; }
  const js = (doc.toJS() ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(js[k]) ? (js[k] as Array<Record<string, unknown>>) : []);
  for (const r of list("instruments")) {
    const sym = str(r.qktSymbol);
    if (sym) out.cfds.push({ qktSymbol: sym, contractSize: num(r.contractSize), volumeStep: num(r.volumeStep), volumeMin: num(r.volumeMin), digits: num(r.digits), commissionPerLot: num(r.commissionPerLot) });
  }
  for (const r of list("futures")) {
    const root = str(r.root);
    if (!root) { out.errors.push("a futures entry has no root"); continue; }
    const m = (r.margin ?? undefined) as Record<string, unknown> | undefined, ro = (r.roll ?? undefined) as Record<string, unknown> | undefined;
    out.futures.push({
      root, currency: str(r.currency), multiplier: num(r.multiplier), tickSize: num(r.tickSize), volumeStep: num(r.volumeStep), volumeMin: num(r.volumeMin),
      takerFeeRate: num(r.takerFeeRate), exchangeFeePerContract: num(r.exchangeFeePerContract), calendar: str(r.calendar), perpetual: str(r.perpetual),
      expiryGuardHours: num(r.expiryGuardHours),
      ...(m ? { margin: { initial: num(m.initial), maintenance: num(m.maintenance), basis: str(m.basis) } } : {}),
      ...(ro ? { roll: { daysBeforeExpiry: num(ro.daysBeforeExpiry), atUtc: str(ro.atUtc), adjust: str(ro.adjust) } } : {}),
    });
  }
  for (const r of list("options")) {
    const root = str(r.root);
    if (!root) { out.errors.push("an options entry has no root"); continue; }
    const chains = r.chains === "book" || r.chains === "trade" ? r.chains : undefined;
    out.options.push({
      root, currency: str(r.currency), contractSize: num(r.contractSize), tickSize: num(r.tickSize), volumeStep: num(r.volumeStep), volumeMin: num(r.volumeMin),
      underlyingIndex: str(r.underlyingIndex), takerFeeRate: num(r.takerFeeRate), chains, maxQuoteAgeMinutes: num(r.maxQuoteAgeMinutes),
    });
  }
  return out;
}

/**
 * Where two instruments.yaml files disagree about a futures or options root, by root key: the fields that differ, or which side
 * alone declares it. `data` is the data source's file and `workspace` the workspace's: a run reads the workspace's entirely, so a
 * root only the data source declares is one the run will not know.
 */
export function termsDifferences(data: InstrumentCatalog, workspace: InstrumentCatalog): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const index = (c: InstrumentCatalog) => new Map<string, Record<string, unknown>>([...c.futures, ...c.options].map((t) => [t.root, t as unknown as Record<string, unknown>]));
  const d = index(data), w = index(workspace);
  for (const key of new Set([...d.keys(), ...w.keys()])) {
    const a = d.get(key), b = w.get(key);
    if (!a || !b) { out[key] = [a ? "only in the data source" : "only in the workspace"]; continue; }
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => f !== "root" && JSON.stringify(a[f]) !== JSON.stringify(b[f])).sort();
    if (fields.length) out[key] = fields;
  }
  return out;
}

/** Everything `kindOf` needs from a parsed catalog. */
export function contextFromCatalog(c: InstrumentCatalog, extra: { perpetuals?: Iterable<string>; futureRoots?: Iterable<string> } = {}): KindContext {
  const futureRoots = new Set([...c.futures.map((f) => f.root), ...(extra.futureRoots ?? [])]);
  const perpetuals = new Set<string>(extra.perpetuals ?? []);
  for (const f of c.futures) if (f.perpetual) perpetuals.add(`${f.root.split(":")[0]}:${f.perpetual}`);
  return { futureRoots, perpetuals, optionRoots: new Set(c.options.map((o) => o.root)), cfdBrokers: CFD_BROKERS };
}

/**
 * Whether a futures root's exchange is expected to have data on a UTC day. `crypto` every day; `fx` and `nyse` as qkt's own
 * calendars; `cme_globex` (and any other name) Monday to Friday less NYSE holidays: its Sunday-evening session is folded into
 * Monday's bar by the archives the studio has met, so a missing Sunday file is not a hole, and a present one is simply kept.
 */
export function futuresDayExpected(calendar: string | undefined, day: string): boolean {
  if (calendar === "crypto") return true;
  if (calendar === "fx") return isTradingDay("fx", day);
  return isTradingDay("nyse", day);
}

/** The calendar a root trades on: its declared `calendar:`, else what its name says (crypto names are 24/7, the rest CME-like). */
export const calendarOf = (root: string, declared?: string): string => declared ?? (qktCalendarFor(root) === "crypto" ? "crypto" : "cme_globex");

