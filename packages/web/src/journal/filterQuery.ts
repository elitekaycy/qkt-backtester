import type { TripQuery } from "../api/types.js";

/**
 * Text form of the journal filters, GitHub/Linear style: `side:long exit:stop r:>=1 held:<1h day:2024-10-07 weekday:mon hour:14`.
 * Pure functions only: the filter bar owns the UI, this owns what the words mean. The store keeps a plain TripQuery;
 * the text is just another way to write one.
 */

export type FilterPatch = Partial<TripQuery>;
export interface ParsedToken { raw: string; key?: string; patch?: FilterPatch; error?: string }
export interface Chip { id: string; text: string; label: string; clear: FilterPatch }
export interface Suggestion { text: string; label: string; hint?: string; group: string; /** shown key portion for highlighting */ key: string }

const H = 3_600_000, M = 60_000, D = 86_400_000;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DOW_LONG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const KEY_ALIAS: Record<string, string> = {
  side: "side", direction: "side", dir: "side",
  outcome: "outcome", result: "outcome", is: "outcome",
  exit: "exit", ended: "exit", end: "exit",
  contract: "contract", contr: "contract",
  r: "r", risk: "r", rr: "r",
  held: "held", hold: "held", duration: "held",
  pnl: "pnl", profit: "pnl",
  day: "day", date: "day", exitday: "day",
  weekday: "weekday", dow: "weekday", wd: "weekday",
  hour: "hour", hr: "hour",
  symbol: "symbol", sym: "symbol",
  entry: "entry", entered: "entry", opened: "entry", open_date: "entry",
  exited: "exited", closed_on: "exited", out: "exited",
  size: "size", qty: "size", lots: "size", volume: "size",
  trade: "trade", id: "trade", no: "trade", n: "trade",
};
const VALUES = {
  side: { long: "long", buy: "long", short: "short", sell: "short" } as Record<string, "long" | "short">,
  outcome: { win: "win", wins: "win", winner: "win", winners: "win", loss: "loss", losses: "loss", loser: "loss", losers: "loss", breakeven: "breakeven", even: "breakeven", open: "open", closed: "closed" } as Record<string, NonNullable<TripQuery["outcome"]>>,
  exit: { target: "target", tp: "target", stop: "stop", sl: "stop", signal: "signal", rule: "signal", open: "open" } as Record<string, NonNullable<TripQuery["exit"]>>,
  // futures and options: the venue ended the trade (the API reads them as `exit=`; the query keeps them apart from the rule/order exits)
  venue: { expiry: "expiry", expired: "expiry", settled: "expiry", liquidation: "liquidation", liquidated: "liquidation", roll_failed: "roll_failed", rollfailed: "roll_failed" } as Record<string, NonNullable<TripQuery["venueExit"]>>,
};

const UNIT: Record<string, number> = { ms: 1, s: 1000, m: M, min: M, h: H, hr: H, d: D };
/** `90m`, `1.5h`, `2d` -> ms. */
export function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|min|m|hr|h|d)$/.exec(v.trim().toLowerCase());
  if (!m) return null;
  return Math.round(Number(m[1]) * UNIT[m[2]!]!);
}
export function formatDuration(ms: number): string {
  if (ms % D === 0) return `${ms / D}d`;
  if (ms % H === 0) return `${ms / H}h`;
  if (ms % M === 0) return `${ms / M}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Numeric comparison value: `>1`, `>=1`, `<0`, `<=-1`, `1..2`, `5`, with an optional parser for units. */
function parseRange(v: string, num: (s: string) => number | null): { min?: number; max?: number; strictLt?: boolean } | null {
  const rr = /^(.+)\.\.(.+)$/.exec(v);
  if (rr) { const a = num(rr[1]!), b = num(rr[2]!); return a === null || b === null ? null : { min: Math.min(a, b), max: Math.max(a, b) }; }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(v);
  if (!m) return null;
  const n = num(m[2]!);
  if (n === null) return null;
  switch (m[1]) {
    case ">": case ">=": return { min: n };
    case "<": return { max: n, strictLt: true };
    case "<=": return { max: n };
    default: return { min: n, max: n };
  }
}
/**
 * Hold times filter on [min, max), exactly like the hold buckets (1-4h holds 1h but not 4h). Durations are whole milliseconds,
 * so "<=" and ">" shift the bound by one ms: `<1h` [0,1h), `<=1h` [0,1h], `>1h` (1h,..), `>=1h` [1h,..), `1h..4h` [1h,4h), `90m` exactly.
 */
function heldRange(v: string): { min?: number; max?: number } | null {
  const rr = /^(.+)\.\.(.+)$/.exec(v);
  if (rr) { const a = parseDuration(rr[1]!), b = parseDuration(rr[2]!); return a === null || b === null || a === b ? null : { min: Math.min(a, b), max: Math.max(a, b) }; }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(v);
  const n = m ? parseDuration(m[2]!) : null;
  if (!m || n === null) return null;
  switch (m[1]) {
    case "<": return { max: n };
    case "<=": return { max: n + 1 };
    case ">": return { min: n + 1 };
    case ">=": return { min: n };
    default: return { min: n, max: n + 1 };
  }
}

const parseR = (s: string) => { const m = /^([+-]?\d+(?:\.\d+)?)r?$/i.exec(s.trim()); return m ? Number(m[1]) : null; };
const parseMoney = (s: string) => { const m = /^([+-]?)\$?(\d+(?:\.\d+)?)(k)?$/i.exec(s.trim()); return m ? Number(m[1] + m[2]) * (m[3] ? 1000 : 1) : null; };

const DAY_MS = D;
const dayStart = (iso: string) => Date.parse(iso + "T00:00:00Z");
/** `2024-10-07` -> that UTC day; `2024-10` -> that UTC month. [from, to) in epoch ms. */
export function parseSpan(s: string): { from: number; to: number } | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d && !Number.isNaN(dayStart(s))) return { from: dayStart(s), to: dayStart(s) + DAY_MS };
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) { const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1), to = Date.UTC(Number(m[1]), Number(m[2]), 1); return { from, to }; }
  return null;
}
/** A time filter: `2024-10-07`, `2024-10`, `>=2024-10-15`, `>2024-10-15`, `<2024-10-01`, `2024-10-01..2024-10-15` (both ends included). */
export function parseTimeWindow(v: string): { from?: number; to?: number } | null {
  const rr = /^(.+)\.\.(.+)$/.exec(v);
  if (rr) { const a = parseSpan(rr[1]!), b = parseSpan(rr[2]!); return a && b ? { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) } : null; }
  const m = /^(>=|<=|>|<)?(.+)$/.exec(v);
  if (!m) return null;
  const sp = parseSpan(m[2]!);
  if (!sp) return null;
  switch (m[1]) {
    case ">=": return { from: sp.from };
    case ">": return { from: sp.to };
    case "<": return { to: sp.from };
    case "<=": return { to: sp.to };
    default: return { from: sp.from, to: sp.to };
  }
}
const parseQty = (s: string) => { const m = /^(\d+(?:\.\d+)?)$/.exec(s.trim()); return m ? Number(m[1]) : null; };
const EPS = 0.0001; // "< 0R" is strictly negative, the same convention the preset buttons use

/** Interpret one `key:value` token. */
export function parseToken(raw: string, symbols: string[] = []): ParsedToken {
  const i = raw.indexOf(":");
  if (i < 0) {
    const bare = raw.toLowerCase();
    // a bare word is a value of an unambiguous filter: `stop`, `win`, `long`, `XAUUSD`
    for (const [key, table] of Object.entries(VALUES)) if (bare in table && !(key === "outcome" && bare === "open") && !(key === "exit" && bare === "open")) return parseToken(`${key}:${bare}`, symbols);
    const sym = symbols.find((s) => s.toLowerCase() === bare);
    if (sym) return { raw, key: "symbol", patch: { symbol: sym } };
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return parseToken(`day:${raw}`, symbols);
    if (/^\d{4}-\d{2}$/.test(raw)) return parseToken(`entry:${raw}`, symbols);
    if (/^#\d+$/.test(raw)) return parseToken(`trade:${raw.slice(1)}`, symbols);
    const wd = DOW.indexOf(bare.slice(0, 3));
    if (wd >= 0 && (bare.length === 3 || DOW_LONG[wd] === bare)) return { raw, key: "weekday", patch: { weekday: wd } };
    return { raw, error: `“${raw}” is not a filter. Try side:long, exit:stop, r:>=1 or held:<1h` };
  }
  const keyRaw = raw.slice(0, i).toLowerCase(), v = raw.slice(i + 1), lv = v.toLowerCase();
  const key = KEY_ALIAS[keyRaw];
  if (!key) return { raw, error: `Unknown filter “${keyRaw}”. Known: side, outcome, exit, contract, r, held, pnl, size, entry, exited, trade, day, weekday, hour, symbol` };
  if (!v) return { raw, key, error: `${key}: needs a value` };
  switch (key) {
    case "side": { const x = VALUES.side[lv]; return x ? { raw, key, patch: { side: x } } : { raw, key, error: "side: long or short" }; }
    case "outcome": { const x = VALUES.outcome[lv]; return x ? { raw, key, patch: { outcome: x } } : { raw, key, error: "outcome: win, loss, breakeven, open or closed" }; }
    case "exit": {
      const venue = VALUES.venue[lv];
      if (venue) return { raw, key, patch: { venueExit: venue, exit: undefined } };
      const x = VALUES.exit[lv];
      return x ? { raw, key, patch: { exit: x, venueExit: undefined } } : { raw, key, error: "exit: target, stop, signal, expiry, liquidation or roll_failed" };
    }
    case "contract": { const c = v.replace(/^[A-Za-z0-9_]+:/, ""); return /^[A-Za-z0-9_.\-]{1,60}$/.test(c) ? { raw, key, patch: { contract: c } } : { raw, key, error: "contract: a contract code like ESH19 (continuous futures)" }; }
    case "r": {
      const r = parseRange(lv, parseR);
      if (!r) return { raw, key, error: "r: like >=1, <0, -1..2 (multiples of the entry risk)" };
      return { raw, key, patch: { minR: r.min, maxR: r.max === undefined ? undefined : r.strictLt ? r.max - EPS : r.max } };
    }
    case "held": {
      const r = heldRange(lv);
      if (!r) return { raw, key, error: "held: like <1h, >=4h, 1h..4h (from 1h up to 4h), 30m, 2d" };
      return { raw, key, patch: { minHoldMs: r.min, maxHoldMs: r.max } };
    }
    case "pnl": {
      const r = parseRange(lv, parseMoney);
      if (!r) return { raw, key, error: "pnl: like >100, <-50, -20..80" };
      return { raw, key, patch: { minPnl: r.min, maxPnl: r.max } };
    }
    case "entry": {
      const w = parseTimeWindow(lv);
      return w ? { raw, key, patch: { fromTs: w.from, toTs: w.to } } : { raw, key, error: "entry: a date or month like 2024-10-07, 2024-10, >=2024-10-15 or 2024-10-01..2024-10-15 (UTC)" };
    }
    case "exited": {
      const w = parseTimeWindow(lv);
      return w ? { raw, key, patch: { exitFromTs: w.from, exitToTs: w.to } } : { raw, key, error: "exited: a date or month like 2024-10-07, 2024-10, >=2024-10-15 or 2024-10-01..2024-10-15 (UTC)" };
    }
    case "size": {
      const r = parseRange(lv, parseQty);
      return r ? { raw, key, patch: { minQty: r.min, maxQty: r.max } } : { raw, key, error: "size: like >=0.5, <1, 0.1..0.5 (lots as traded)" };
    }
    case "trade": { const n = Number(lv.replace(/^#/, "")); return Number.isInteger(n) && n > 0 ? { raw, key, patch: { id: n } } : { raw, key, error: "trade: the number in the # column, like trade:12 or #12" }; }
    case "day": return /^\d{4}-\d{2}-\d{2}$/.test(lv) && !Number.isNaN(Date.parse(lv)) ? { raw, key, patch: { day: lv } } : { raw, key, error: "day: a date like 2024-10-07 (UTC exit day)" };
    case "weekday": {
      let wd = DOW.indexOf(lv.slice(0, 3));
      if (wd < 0 || !(lv.length === 3 || DOW_LONG[wd] === lv)) wd = /^[0-6]$/.test(lv) ? Number(lv) : -1;
      return wd >= 0 ? { raw, key, patch: { weekday: wd } } : { raw, key, error: "weekday: mon … sun (of the entry, UTC)" };
    }
    case "hour": { const h = Number(lv); return Number.isInteger(h) && h >= 0 && h <= 23 && /^\d+$/.test(lv) ? { raw, key, patch: { hour: h } } : { raw, key, error: "hour: 0–23 (UTC hour of the entry)" }; }
    case "symbol": {
      const sym = symbols.find((s) => s.toLowerCase() === lv || s.split(":").pop()!.toLowerCase() === lv);
      return sym ? { raw, key, patch: { symbol: sym } } : { raw, key, error: symbols.length ? `symbol: one of ${symbols.map((s) => s.split(":").pop()).join(", ")}` : "symbol: no such symbol in this run" };
    }
  }
  return { raw, error: "unsupported" };
}

/** Split on whitespace, keeping `key:"a b"` together (quotes are stripped). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[0].replace(/"/g, ""));
  return out;
}

export interface Parsed { patch: FilterPatch; tokens: ParsedToken[]; errors: string[] }
/** Parse a whole line. Later tokens of the same filter win; errors never block the valid tokens. */
export function parseFilters(text: string, symbols: string[] = []): Parsed {
  const tokens = tokenize(text).map((t) => parseToken(t, symbols));
  const patch: FilterPatch = {};
  for (const t of tokens) if (t.patch) {
    // a filter that sets only one bound must clear the other, so `held:<1h` after `held:>4h` replaces it
    if (t.key === "r") { patch.minR = undefined; patch.maxR = undefined; }
    if (t.key === "held") { patch.minHoldMs = undefined; patch.maxHoldMs = undefined; }
    if (t.key === "pnl") { patch.minPnl = undefined; patch.maxPnl = undefined; }
    if (t.key === "entry") { patch.fromTs = undefined; patch.toTs = undefined; }
    if (t.key === "exited") { patch.exitFromTs = undefined; patch.exitToTs = undefined; }
    if (t.key === "size") { patch.minQty = undefined; patch.maxQty = undefined; }
    Object.assign(patch, t.patch);
  }
  return { patch, tokens, errors: tokens.flatMap((t) => (t.error ? [t.error] : [])) };
}

const rText = (lo?: number, hi?: number): string | null => {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  if (lo !== undefined && hi !== undefined) return lo === hi ? `r:${f(lo)}` : `r:${f(lo)}..${f(hi)}`;
  if (lo !== undefined) return `r:>=${f(lo)}`;
  if (hi !== undefined) return hi < 0 && hi > -0.001 ? "r:<0" : `r:<=${f(hi)}`;
  return null;
};
// the inverse of heldRange: a bound one ms off a round duration came from ">"/"<=" (or an exact match)
const heldText = (lo?: number, hi?: number): string | null => {
  const f = formatDuration;
  if (lo !== undefined && hi !== undefined) return hi === lo + 1 ? `held:${f(lo)}` : `held:${f(lo)}..${f(hi)}`;
  if (lo !== undefined) return lo % 1000 === 1 ? `held:>${f(lo - 1)}` : `held:>=${f(lo)}`;
  if (hi !== undefined) return hi % 1000 === 1 ? `held:<=${f(hi - 1)}` : `held:<${f(hi)}`;
  return null;
};
const pnlText = (lo?: number, hi?: number): string | null => {
  const f = (n: number) => String(Math.round(n));
  if (lo !== undefined && hi !== undefined) return `pnl:${f(lo)}..${f(hi)}`;
  if (lo !== undefined) return `pnl:>=${f(lo)}`;
  if (hi !== undefined) return `pnl:<=${f(hi)}`;
  return null;
};

/** The active filters as removable chips, in a stable order. `clear` is the patch that removes each. */
export function toChips(f: TripQuery): Chip[] {
  const c: Chip[] = [];
  const add = (id: string, text: string | null, label: string, clear: FilterPatch) => { if (text) c.push({ id, text, label, clear }); };
  if (f.side) add("side", `side:${f.side}`, f.side === "long" ? "Long" : "Short", { side: undefined });
  if (f.outcome) add("outcome", `outcome:${f.outcome}`, { win: "Winners", loss: "Losers", breakeven: "Breakeven", open: "Open", closed: "Closed" }[f.outcome], { outcome: undefined });
  if (f.exit) add("exit", `exit:${f.exit}`, { target: "Target hit", stop: "Stop hit", signal: "Signal exit", open: "Open" }[f.exit] ?? f.exit, { exit: undefined });
  if (f.venueExit) add("venue", `exit:${f.venueExit}`, { expiry: "Closed at expiry", liquidation: "Liquidated", roll_failed: "Roll failed" }[f.venueExit], { venueExit: undefined });
  if (f.contract) add("contract", `contract:${f.contract}`, `Contract ${f.contract}`, { contract: undefined });
  add("r", rText(f.minR, f.maxR), "Risk", { minR: undefined, maxR: undefined });
  add("held", heldText(f.minHoldMs, f.maxHoldMs), "Held", { minHoldMs: undefined, maxHoldMs: undefined });
  add("pnl", pnlText(f.minPnl, f.maxPnl), "P&L", { minPnl: undefined, maxPnl: undefined });
  const spanText = (key: string, lo?: number, hi?: number): string | null => {
    const iso = (n: number) => new Date(n).toISOString().slice(0, 10);
    const one = (a: number, b: number) => (b - a === D ? iso(a) : null);
    if (lo !== undefined && hi !== undefined) return one(lo, hi) ? `${key}:${one(lo, hi)}` : `${key}:${iso(lo)}..${iso(hi - D)}`;
    if (lo !== undefined) return `${key}:>=${iso(lo)}`;
    if (hi !== undefined) return `${key}:<${iso(hi)}`;
    return null;
  };
  add("entry", spanText("entry", f.fromTs, f.toTs), "Entered", { fromTs: undefined, toTs: undefined });
  add("exited", spanText("exited", f.exitFromTs, f.exitToTs), "Exited", { exitFromTs: undefined, exitToTs: undefined });
  if (f.minQty !== undefined || f.maxQty !== undefined) add("size", f.minQty !== undefined && f.maxQty !== undefined ? (f.minQty === f.maxQty ? `size:${f.minQty}` : `size:${f.minQty}..${f.maxQty}`) : f.minQty !== undefined ? `size:>=${f.minQty}` : `size:<=${f.maxQty}`, "Size", { minQty: undefined, maxQty: undefined });
  if (f.id !== undefined) add("trade", `trade:${f.id}`, `Trade #${f.id}`, { id: undefined });
  if (f.day) add("day", `day:${f.day}`, `Exit day ${f.day}`, { day: undefined });
  if (f.weekday !== undefined) add("weekday", `weekday:${DOW[f.weekday]}`, `Enters on ${DOW_LONG[f.weekday]![0]!.toUpperCase()}${DOW_LONG[f.weekday]!.slice(1)}`, { weekday: undefined });
  if (f.hour !== undefined) add("hour", `hour:${f.hour}`, `Enters ${String(f.hour).padStart(2, "0")}:00 UTC`, { hour: undefined });
  if (f.symbol) add("symbol", `symbol:${f.symbol.split(":").pop()}`, f.symbol.split(":").pop()!, { symbol: undefined });
  return c;
}

interface Cand { text: string; label: string; group: string; words: string; /** Only offered on a futures/options run. */ venue?: boolean }
const CANDS: Cand[] = [
  { text: "side:long", label: "Long trades", group: "Side", words: "buy long up" },
  { text: "side:short", label: "Short trades", group: "Side", words: "sell short down" },
  { text: "outcome:win", label: "Winners", group: "Outcome", words: "win wins winner profit green" },
  { text: "outcome:loss", label: "Losers", group: "Outcome", words: "loss losses loser losing red" },
  { text: "outcome:breakeven", label: "Breakeven", group: "Outcome", words: "even flat zero" },
  { text: "outcome:open", label: "Still open", group: "Outcome", words: "open running" },
  { text: "exit:target", label: "Hit the target", group: "Exit", words: "tp take profit target hit" },
  { text: "exit:stop", label: "Hit the stop", group: "Exit", words: "sl stop loss stopped hit" },
  { text: "exit:signal", label: "Closed by a rule", group: "Exit", words: "signal rule manual close" },
  { text: "exit:expiry", label: "Settled at the contract's expiry", group: "Exit", words: "expiry expired settled settlement delivery futures options", venue: true },
  { text: "exit:liquidation", label: "Liquidated by the venue", group: "Exit", words: "liquidation liquidated margin forced futures", venue: true },
  { text: "exit:roll_failed", label: "Closed because a roll failed", group: "Exit", words: "roll failed rollover futures", venue: true },
  { text: "r:>=1", label: "Made at least 1R", group: "Risk", words: "risk r multiple 1r" },
  { text: "r:>=2", label: "Made at least 2R", group: "Risk", words: "risk r multiple 2r" },
  { text: "r:<0", label: "Lost money vs risk (below 0R)", group: "Risk", words: "risk r multiple negative" },
  { text: "r:<=-1", label: "Lost 1R or more", group: "Risk", words: "risk r multiple beyond stop" },
  { text: "held:<1h", label: "Held under 1 hour", group: "Held", words: "hold duration short quick scalp" },
  { text: "held:1h..4h", label: "Held 1–4 hours", group: "Held", words: "hold duration" },
  { text: "held:4h..24h", label: "Held 4–24 hours", group: "Held", words: "hold duration" },
  { text: "held:>1d", label: "Held over a day", group: "Held", words: "hold duration long swing overnight" },
  { text: "size:>=1", label: "Size 1 or more", group: "Size", words: "size lots qty volume big" },
  { text: "trade:1", label: "Trade number… (#12)", group: "Trade", words: "trade number id index" },
  { text: "pnl:>0", label: "Profit above a value…", group: "P&L", words: "profit money pnl" },
  { text: "pnl:<0", label: "P&L below a value…", group: "P&L", words: "loss money pnl" },
  ...DOW_LONG.map((d, i) => ({ text: `weekday:${DOW[i]}`, label: `Entered on ${d[0]!.toUpperCase()}${d.slice(1)}`, group: "Weekday", words: `${d} day of week` })),
];

const score = (q: string, c: Cand): number => {
  if (!q) return 1;
  const t = c.text.toLowerCase();
  if (t.startsWith(q)) return 100 - t.length * 0.1;
  const val = t.slice(t.indexOf(":") + 1);
  if (val.startsWith(q)) return 90;
  if (t.includes(q)) return 70;
  if (c.words.split(" ").some((w) => w.startsWith(q))) return 60;
  if (c.label.toLowerCase().split(/[^a-z0-9<>=]+/).some((w) => w.startsWith(q))) return 40;
  return 0;
};

const valueMatches = (val: string, c: Cand): boolean => c.text.slice(c.text.indexOf(":") + 1).toLowerCase().startsWith(val) || c.words.split(" ").some((w) => w.startsWith(val));

export interface SuggestCtx { symbols?: string[]; /** Contracts a continuous-futures run traded, for `contract:`. */ contracts?: string[]; /** The run closed trades at the venue (expiry, liquidation): offer those exits. */ venue?: boolean; days?: string[]; active?: TripQuery; sizes?: number[]; /** the run window, YYYY-MM-DD, `to` exclusive: entry/exit-time suggestions come from it even before any analytics load */ window?: { from: string; to: string } }

/**
 * Suggestions for the word being typed (the last token of `input`). Nothing typed: the common filters.
 * `key:` typed: that key's values. Anything else: fuzzy across every filter, so `stop`, `win`, `sl`, `mon` all find their filter.
 */
export function suggest(input: string, ctx: SuggestCtx = {}, limit = 9): Suggestion[] {
  const word = (/(\S*)$/.exec(input)?.[1] ?? "").toLowerCase();
  const symbols = ctx.symbols ?? [];
  const taken = new Set(toChips(ctx.active ?? {}).map((c) => c.text));
  const out: Suggestion[] = [];
  const push = (c: Cand) => { if (!taken.has(c.text)) out.push({ text: c.text, label: c.label, group: c.group, key: c.text.split(":")[0]! }); };
  const symCands: Cand[] = symbols.map((s) => ({ text: `symbol:${s.split(":").pop()}`, label: `Only ${s.split(":").pop()}`, group: "Symbol", words: s.toLowerCase() }));
  const hours: Cand[] = Array.from({ length: 24 }, (_, h) => ({ text: `hour:${h}`, label: `Entered at ${String(h).padStart(2, "0")}:00 UTC`, group: "Hour", words: "hour time" }));
  const dayCands: Cand[] = (ctx.days ?? []).slice(-60).reverse().map((d) => ({ text: `day:${d}`, label: `Exited on ${d}`, group: "Day", words: d }));
  const span: string[] = [];
  if (ctx.window) for (let t = Date.parse(ctx.window.from + "T00:00:00Z"); t < Date.parse(ctx.window.to + "T00:00:00Z") && span.length < 800; t += 86_400_000) span.push(new Date(t).toISOString().slice(0, 10));
  const timeDays = span.length ? span : ctx.days ?? [];
  const months = [...new Set(timeDays.map((d) => d.slice(0, 7)))];
  const entryCands: Cand[] = [
    ...months.map((m) => ({ text: `entry:${m}`, label: `Entered in ${m}`, group: "Entry", words: `entered opened month ${m}` })),
    ...timeDays.slice(0, 40).map((d) => ({ text: `entry:${d}`, label: `Entered on ${d}`, group: "Entry", words: `entered opened ${d}` })),
  ];
  const exitedCands: Cand[] = [
    ...months.map((m) => ({ text: `exited:${m}`, label: `Exited in ${m}`, group: "Exit time", words: `exited closed month ${m}` })),
    ...timeDays.slice(0, 40).map((d) => ({ text: `exited:${d}`, label: `Exited on ${d}`, group: "Exit time", words: `exited closed ${d}` })),
  ];
  const sizeCands: Cand[] = [...new Set(ctx.sizes ?? [])].sort((a, b) => a - b).slice(0, 8).map((q) => ({ text: `size:${q}`, label: `Traded ${q}`, group: "Size", words: "size lots qty volume" }));
  const contractCands: Cand[] = [...new Set(ctx.contracts ?? [])].slice(0, 60).map((c) => ({ text: `contract:${c}`, label: `Traded on ${c}`, group: "Contract", words: `contract ${c} futures roll` }));
  const all = [...CANDS.filter((c) => !c.venue || ctx.venue), ...contractCands, ...symCands, ...hours, ...dayCands, ...entryCands, ...exitedCands, ...sizeCands];

  const colon = word.indexOf(":");
  if (colon >= 0) {
    const key = KEY_ALIAS[word.slice(0, colon)];
    const val = word.slice(colon + 1);
    if (!key) return [];
    if ((key === "held" || key === "r" || key === "pnl" || key === "size" || key === "entry" || key === "exited") && val) {
      // free-form comparison the user is typing: offer it as-is if it parses
      const t = parseToken(word, symbols);
      if (t.patch) out.push({ text: `${key}:${val}`, label: `Apply ${key}:${val}`, group: key === "r" ? "Risk" : key === "held" ? "Held" : key === "size" ? "Size" : key === "entry" ? "Entry" : key === "exited" ? "Exit time" : "P&L", key });
    }
    for (const c of all.filter((c) => c.text.startsWith(`${key}:`))) if ((!val || valueMatches(val, c)) && !out.some((o) => o.text === c.text)) push(c);
    if (key === "day" && /^\d{4}-\d{2}-\d{2}$/.test(val) && !out.some((o) => o.text === `day:${val}`)) out.unshift({ text: `day:${val}`, label: `Exited on ${val}`, group: "Day", key });
    return out.slice(0, limit);
  }
  if (!word) {
    for (const t of ["side:long", "side:short", "outcome:win", "outcome:loss", "exit:stop", "exit:target", "r:>=1", "held:<1h"]) { const c = CANDS.find((x) => x.text === t)!; push(c); }
    return out.slice(0, limit);
  }
  // typing just a key name: list the keys as templates
  for (const [k, hint] of [["side:", "long / short"], ["outcome:", "win / loss / breakeven"], ["exit:", "target / stop / signal"], ["r:", "like >=1, <0"], ["held:", "like <1h, 1h..4h"], ["pnl:", "like >100, <-50"], ["entry:", "date, month or range: 2024-10, >=2024-10-15"], ["exited:", "date, month or range"], ["size:", "like >=0.5, 0.1..0.5"], ["trade:", "#12"], ["day:", "2024-10-07 (exit day)"], ["weekday:", "mon … sun"], ["hour:", "0–23"], ["symbol:", symbols.map((s) => s.split(":").pop()).join(" / ")]] as const) {
    if (k.startsWith(word) && word.length < k.length) out.push({ text: k, label: `Filter by ${k.slice(0, -1)}`, hint, group: "Filters", key: k.slice(0, -1) });
  }
  const scored = all.map((c) => ({ c, s: score(word, c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  for (const { c } of scored) { if (out.length >= limit) break; if (!taken.has(c.text) && !out.some((o) => o.text === c.text)) push(c); }
  return out.slice(0, limit);
}
