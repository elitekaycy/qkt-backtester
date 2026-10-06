import {
  barBaseTf, canonicalTf, continuousOf, dayMs, intersectAll, isoDay, kindOf, rootOfContract, runsOf, scrub, tfMs,
  type BlockFix, type DayRange, type DerivativesReport, type FutureRootReport, type InstrumentKind, type KindContext, type OptionRootReport, type StreamDecl,
} from "@qkt-studio/core";
import { futuresDayExpected, calendarOf } from "./derivatives-scan.js";

/**
 * What a derivatives stream needs before qkt will run it, judged from the scan alone (no file I/O: the scan keeps each
 * series' covered windows). Each kind asks its own question; the answer is either windows (exclusive end) or one block with
 * the `qkt fetch` that closes it. CFD streams never come through here.
 *
 * Probed against qkt 0.55.0 on small stores:
 *  - a continuous stream's own coverage check is meaningless (`bars/<V>/<ROOT>@front`, 0/N days), in bars and ticks runs alike;
 *    the run only starts with --allow-incomplete, so the per-contract check below is the real one;
 *  - a root with no `roll:` fails with "has no roll policy; a continuous stream needs one";
 *  - an option contract is read from the stored chain, never from bars: a bars run looks for bars/<V>/<CONTRACT> and reports
 *    0/N days, a full run reports "chain coverage 2/2 days (trade chain)" and refuses a missing day naming the exact
 *    `qkt fetch ... --chains` that fills it; a root without `chains:` fails with "declares no chain series to trade on".
 */

export type Tier = "bars" | "ticks";
export type DPick = { ranges: DayRange[] } | { blocked: string; fix?: BlockFix; command?: string };
export interface DerivativePlan { replace?: DPick; extra?: DPick[]; needsAllowIncomplete?: boolean }

const DAY = 86_400_000;
const blocked = (reason: string, fix?: BlockFix, command?: string): DPick => ({ blocked: reason, ...(fix ? { fix } : {}), ...(command ? { command } : {}) });
const spanCmd = (r: DayRange | null | undefined) => (r ? `--from ${r.from} --to ${r.to}` : "--from <from> --to <to>");
const outer = (rs: DayRange[] | undefined): DayRange | null => (rs && rs.length ? { from: rs[0]!.from, to: rs[rs.length - 1]!.to } : null);

/** Which fields each alias reads: `<alias>.<field>` in the strategy text, comments and strings blanked. */
export function fieldUses(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const raw of source.split(/\r?\n/)) {
    for (const m of scrub(raw).matchAll(/(?<![\w.])([A-Za-z_]\w*)\.([a-z_]\w*)/g)) {
      if (!out.has(m[1]!)) out.set(m[1]!, new Set());
      out.get(m[1]!)!.add(m[2]!);
    }
  }
  return out;
}

/** The alias is the object of an order verb somewhere in the source. */
function isTraded(source: string, alias: string): boolean {
  return new RegExp(`\\b(?:BUY|SELL|CLOSE|SHORT|COVER)\\s+${alias}\\b`).test(scrub(source));
}

const futureRootOf = (d: DerivativesReport, key: string): FutureRootReport | undefined => d.futures.find((f) => f.key === key);
const optionRootOf = (d: DerivativesReport, key: string): OptionRootReport | undefined => d.options.find((o) => o.key === key);

const tfBase = (built: string[], finest: string): string | null => barBaseTf(built.filter((t) => canonicalTf(t) === t), finest);

// ---- listed contract -----------------------------------------------------------------------------------------------

function listedFuture(d: DerivativesReport, s: StreamDecl, finest: string, ctx: KindContext): DPick {
  const root = rootOfContract(s.broker, s.symbol, ctx.futureRoots ?? new Set()) ?? s.symbol;
  const key = `${s.broker}:${root}`;
  const rr = futureRootOf(d, key);
  if (!rr) return blocked(`${key} is not a known futures root`, "catalog", `qkt fetch ${key} --catalog`);
  if (!rr.terms) return blocked(`${key} has no \`futures:\` entry in instruments.yaml (multiplier, tick size, fees)`, "terms");
  const c = rr.contracts.find((x) => x.symbol === s.symbol);
  if (!c) return blocked(`${s.symbol} is not in ${key}'s catalog`, "catalog", `qkt fetch ${key} --catalog`);
  const base = tfBase(c.bars.map((b) => b.tf), finest);
  if (!base) return blocked(`no ${finest} bars for ${s.symbol}`, "fetch", `qkt fetch ${s.broker}:${s.symbol} --tf ${finest} ${c.expiry ? `--from <from> --to ${c.expiry}` : "--from <from> --to <to>"}`);
  return { ranges: c.bars.find((b) => b.tf === base)!.present ?? [] };
}

// ---- perpetual: its bars come from the CFD path; these are the extras --------------------------------------------------

/** A perpetual's bars as its root reports them (null when the root shows none: the plain symbol carries them then). */
function perpetualBars(d: DerivativesReport, s: StreamDecl, finest: string): DPick | null {
  const rr = d.futures.find((f) => f.venue === s.broker && f.perpetual?.name === s.symbol);
  if (!rr?.perpetual?.bars.length) return null;
  const key = `${s.broker}:${s.symbol}`, base = tfBase(rr.perpetual.bars.map((b) => b.tf), finest);
  if (!base) return blocked(`no ${finest} bars for ${key}: build ${finest} (or a finer timeframe that divides it)`, "fetch", `qkt fetch ${key} --tf ${finest}`);
  return { ranges: rr.perpetual.bars.find((b) => b.tf === base)!.present ?? [] };
}

const TAPE = new Set(["buy_volume", "sell_volume"]);
const LIQ = new Set(["long_liq_volume", "short_liq_volume"]);
const DEPTH = new Set(["bid_depth", "ask_depth", "book_imbalance"]);

function perpetualExtras(d: DerivativesReport, s: StreamDecl, uses: Set<string>): DPick[] {
  const rr = d.futures.find((f) => f.venue === s.broker && f.perpetual?.name === s.symbol);
  if (!rr?.perpetual) return [];
  const p = rr.perpetual, key = `${s.broker}:${s.symbol}`, win = spanCmd(outer(p.bars.find((b) => b.tf === s.tf)?.present ?? p.bars[0]?.present));
  const out: DPick[] = [];
  if (!rr.terms) out.push(blocked(`${rr.key} has no \`futures:\` entry in instruments.yaml (multiplier, tick size, fees)`, "terms"));
  // qkt refuses a run whose stored rates leave a gap over a day; `--funding off` runs without them
  out.push(p.funding?.present?.length ? { ranges: p.funding.present } : blocked(`${key} is a perpetual and pays funding: no stored funding rates (or run with funding off)`, "funding", `qkt fetch ${key} --funding ${win}`));
  const need = (field: Set<string>, what: string, fix: BlockFix, series: { present?: DayRange[] } | null | undefined, flag: string) => {
    if (![...uses].some((u) => field.has(u))) return;
    out.push(series?.present?.length ? { ranges: series.present } : blocked(`the strategy reads ${what} of ${key} and none is stored`, fix, `qkt fetch ${key} ${flag} ${win}`));
  };
  if (uses.has("mark") || uses.has("index")) {
    const m = p.marks.find((x) => x.tf === s.tf);
    out.push(m?.present?.length ? { ranges: m.present } : blocked(`the strategy reads the mark or index of ${key} and no ${s.tf} marks are stored`, "marks", `qkt fetch ${key} --marks --tf ${s.tf} ${win}`));
  }
  need(new Set(["open_interest"]), "the open interest", "open-interest", p.openInterest, "--open-interest");
  need(TAPE, "the trade tape", "tape", p.tape, "--tape");
  need(LIQ, "the liquidation prints", "tape", p.liquidations, "--liquidations");
  need(DEPTH, "the order-book depth", "depth", p.depth, "--depth");
  return out;
}

// ---- continuous (@front / @next) -------------------------------------------------------------------------------------

function continuous(d: DerivativesReport, s: StreamDecl, finest: string, source: string): DPick {
  const c = continuousOf(s.symbol)!;
  const key = `${s.broker}:${c.root}`;
  const rr = futureRootOf(d, key);
  if (!rr) return blocked(`${key} is not a known futures root`, "catalog", `qkt fetch ${key} --catalog`);
  if (!rr.terms) return blocked(`${key} has no \`futures:\` entry in instruments.yaml (multiplier, tick size, fees)`, "terms");
  if (!rr.terms.roll) return blocked(`${key} has no roll policy; a continuous stream needs \`roll: { daysBeforeExpiry, atUtc, adjust: panama }\``, "terms");
  if (rr.terms.roll.adjust !== "panama" && isTraded(source, s.alias)) return blocked(`${key} rolls with adjust: ${rr.terms.roll.adjust ?? "none"}; trading a continuous stream needs adjust: panama (ratio and none can only be read)`, "terms");
  const at = rr.terms.roll.atUtc;
  if (at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(at), step = tfMs(finest);
    if (m && step && ((+m[1]! * 60 + +m[2]!) * 60_000) % step !== 0) return blocked(`${key} rolls at ${at} UTC, which a ${finest} bar does not divide: use a finer timeframe (an 08:00 roll works with 15m or 1h bars, not 1d)`, "terms");
  }
  if (!rr.catalog) return blocked(`no contract catalog for ${key}`, "catalog", `qkt fetch ${key} --catalog`);
  if (!rr.rolls || !rr.rolls.schedule.length) return blocked(`no measured rolls for ${key}`, "rolls", `qkt fetch ${key} --rolls${finest === "1d" ? " --tf 1d" : ""}`);

  // front contract of each interval: from a roll to the next, the last until its expiry. `@next` is the one after it.
  const byExpiry = [...rr.contracts].filter((x) => x.expiry).sort((a, b) => a.expiry!.localeCompare(b.expiry!));
  const after = (sym: string) => { const i = byExpiry.findIndex((x) => x.symbol === sym); return i >= 0 ? byExpiry[i + 1]?.symbol ?? null : null; };
  const sched = rr.rolls.schedule;
  const intervals: Array<{ contract: string; from: string; to: string }> = [];
  for (let i = 0; i < sched.length; i++) {
    const front = sched[i]!.to, contract = c.follow === "front" ? front : after(front);
    if (!contract) break; // the stream ends where its last listed contract does
    const end = i + 1 < sched.length ? isoDay(sched[i + 1]!.atMs) : byExpiry.find((x) => x.symbol === front)?.expiry ?? isoDay(sched[i]!.atMs);
    intervals.push({ contract, from: isoDay(sched[i]!.atMs), to: end });
  }
  if (!intervals.length) return blocked(`${key} has no listed contract for ${s.symbol} after its first roll`, "catalog", `qkt fetch ${key} --catalog`);

  const first = intervals[0]!.from, last = intervals[intervals.length - 1]!.to;
  const cal = calendarOf(c.root, rr.terms.calendar);
  const ok = new Map<string, boolean>();
  const missing: Array<{ contract: string; from: string; to: string }> = [];
  for (const iv of intervals) {
    const cb = rr.contracts.find((x) => x.symbol === iv.contract);
    const base = cb ? tfBase(cb.bars.map((b) => b.tf), finest) : null;
    const present = base ? cb!.bars.find((b) => b.tf === base)!.present ?? [] : [];
    if (!present.length) { missing.push(iv); }
    for (let t = dayMs(iv.from); t <= dayMs(iv.to); t += DAY) {
      const day = isoDay(t);
      const covered = present.some((r) => day >= r.from && day < r.to) || !futuresDayExpected(cal, day);
      ok.set(day, (ok.get(day) ?? true) && covered);
    }
  }
  const flags: Array<{ day: string; ok: boolean }> = [];
  for (let t = dayMs(first); t <= dayMs(last); t += DAY) { const day = isoDay(t); flags.push({ day, ok: ok.get(day) ?? false }); }
  const ranges = runsOf(flags);
  if (!ranges.length) {
    const m = missing[0];
    return m
      ? blocked(`no ${finest} bars for ${missing.length} of ${intervals.length} contracts the stream follows (first: ${m.contract})`, "fetch", `qkt fetch ${s.broker}:${m.contract} --tf ${finest} --from ${m.from} --to ${m.to}`)
      : blocked(`no stretch where every contract the stream follows has ${finest} bars`, "fetch");
  }
  return { ranges };
}

// ---- options ---------------------------------------------------------------------------------------------------------

function chainRootKey(s: StreamDecl, kind: InstrumentKind, ctx: KindContext): string | null {
  if (kind === "chain") { const i = s.symbol.indexOf("."); return i > 0 ? `${s.symbol.slice(0, i)}:${s.symbol.slice(i + 1)}` : null; }
  if (kind === "analytic") { const p = s.symbol.split("."); return p.length >= 4 ? `${p[0]}:${p.slice(1, -2).join(".")}` : null; }
  const key = `${s.broker}:${s.symbol}`;
  return [...(ctx.optionRoots ?? [])].find((r) => key.startsWith(r + "-") || key.startsWith(r + "_")) ?? null;
}

function options(d: DerivativesReport, s: StreamDecl, kind: InstrumentKind, ctx: KindContext, tier: Tier): DPick {
  if (tier === "bars") return blocked("options read the stored chain, not bars: run them as Full (a bars run looks for bars/<venue>/<contract> and finds none)");
  const key = chainRootKey(s, kind, ctx);
  const or = key ? optionRootOf(d, key) : undefined;
  if (!key || !or) return blocked(`${key ?? s.symbol} is not a known options root`, "catalog", key ? `qkt fetch ${key} --catalog` : undefined);
  if (!or.terms) return blocked(`${key} has no \`options:\` entry in instruments.yaml`, "terms");
  const series = or.terms.chains ?? (kind === "analytic" ? (or.chains.trade ? "trade" : or.chains.book ? "book" : undefined) : undefined);
  if (!series) return blocked(`${key} declares no chain series to trade on: add \`chains: trade\` or \`chains: book\``, "terms");
  if (!or.catalog) return blocked(`no contract catalog for ${key}`, "catalog", `qkt fetch ${key} --catalog`);
  const stored = or.chains[series];
  if (!stored?.present?.length) return blocked(`no stored ${series} chain days for ${key}`, "chains", series === "book" ? `qkt fetch ${key} --chains --live` : `qkt fetch ${key} --chains ${spanCmd(null)}`);
  return { ranges: stored.present };
}

// ---- the plan for one stream -------------------------------------------------------------------------------------------

/** What a derivatives stream adds to (or replaces in) the CFD readiness, or null for a CFD / HUB stream. */
export function planFor(d: DerivativesReport | undefined, s: StreamDecl, tier: Tier, ctx: KindContext, finest: string, source: string, uses: Map<string, Set<string>>): DerivativePlan | null {
  if (!d) return null;
  const kind = kindOf(s, ctx);
  switch (kind) {
    case "future": return { replace: listedFuture(d, s, finest, ctx) };
    case "perpetual": {
      // a bars run reads the perpetual's bars where its root shows them, because the plain symbol list no longer carries them
      const extras = perpetualExtras(d, s, uses.get(s.alias) ?? new Set()), bars = tier === "bars" ? perpetualBars(d, s, finest) : null;
      return bars ? { replace: combine(bars, extras) } : { extra: extras };
    }
    case "continuous": return { replace: continuous(d, s, finest, source), needsAllowIncomplete: true };
    case "option": case "chain": case "analytic": return { replace: options(d, s, kind, ctx, tier) };
    default: return null;
  }
}

/** Intersect a CFD pick with the extras a perpetual adds: the first block wins, otherwise the windows all of them share. */
export function combine(base: DPick, extra: DPick[]): DPick {
  if ("blocked" in base) return base;
  const hit = extra.find((e): e is Extract<DPick, { blocked: string }> => "blocked" in e);
  if (hit) return hit;
  return { ranges: intersectAll([base.ranges, ...extra.map((e) => (e as { ranges: DayRange[] }).ranges)]) };
}
