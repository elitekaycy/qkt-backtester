import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  attachContracts, availableTimeframes, barBases, barBaseTf, bookInfo, buildDerivatives, canonicalTf, contextFromCatalog, integrity, kindOf, loadResult, monthlyPnl, pairRoundTrips, parseContracts, parseInstruments,
  parseRolls, parseTradesFile, readBarsVia, strategyBreakdown, summarize, summarizeRejections, tfToMs, verifyManifest,
  type BarCols, type DerivativesSection, type InstrumentKind, type IntegrityReport, type RunJson, type Summary,
} from "@qkt-studio/core";

/** The studio's version: packages/server/package.json (one source; the release workflow checks the tag against it). */
export const STUDIO_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
/**
 * Version of everything under derived/. Derived files are a pure function of qkt's own output (kept in engine/), so a finished
 * run derived by an older version is re-derived on first access instead of serving numbers computed by old rules.
 * Bump when a derived value changes meaning (2: exit reasons read from the closing order's class; trip-based loss streak;
 * 3: each stream's bar base, so charts and checks read the bars qkt read; 4: the account currency money is reported in;
 * 5: the orders qkt rejected, summarised by reason; 6: no Sharpe/Sortino/Calmar for a blown account;
 * 7: a tick run's charts read the dividing bar folder that covers the window best; 8: an aggregated chart drops the
 * final candle qkt never closed; 9: futures and options runs: derivatives.json, venue exits and contracts on trips,
 * roll costs and funding in the reconcile check).
 */
export const DERIVED_VERSION = 9;
/** Above this many fills the round-trip file is too large to page from memory. */
export const MAX_FILLS = 2_000_000;

export class PostprocessError extends Error {}

export interface StreamRef {
  key: string; broker: string; symbol: string; tf: string;
  /** Only set for futures and options streams (`continuous`, `future`, ...): a CFD stream carries no kind, so its meta is unchanged. */
  kind?: InstrumentKind;
  /** The bar folder the chart reads for this stream: in a bars run, the one qkt itself read (it aggregates coarser streams from it). */
  base?: string | null;
}

/** `BACKTEST:XAUUSD:15m` -> parts. The symbol may itself contain dots or dashes but never a colon. */
export function parseStreamKey(key: string): StreamRef | null {
  const first = key.indexOf(":"), last = key.lastIndexOf(":");
  if (first <= 0 || last <= first) return null;
  return { key, broker: key.slice(0, first), symbol: key.slice(first + 1, last), tf: key.slice(last + 1) };
}

export interface EquitySeries { ts: number[]; equity: number[]; drawdown: number[] }

/** Min/max-preserving downsample so spikes and troughs survive. */
export function downsampleEquity(ts: number[], eq: number[], maxPoints = 4000): EquitySeries {
  const n = ts.length;
  const dd = new Array<number>(n);
  let peak = -Infinity;
  for (let i = 0; i < n; i++) { peak = Math.max(peak, eq[i]!); dd[i] = peak > 0 ? (eq[i]! - peak) / peak : 0; }
  if (n <= maxPoints) return { ts, equity: eq, drawdown: dd };
  const buckets = Math.floor(maxPoints / 2), size = n / buckets;
  const keep = new Set<number>([0, n - 1]);
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size), e = Math.min(n, Math.floor((b + 1) * size));
    let lo = s, hi = s;
    for (let i = s; i < e; i++) { if (eq[i]! < eq[lo]!) lo = i; if (eq[i]! > eq[hi]!) hi = i; }
    keep.add(lo); keep.add(hi);
  }
  const idx = [...keep].sort((a, b) => a - b);
  return { ts: idx.map((i) => ts[i]!), equity: idx.map((i) => eq[i]!), drawdown: idx.map((i) => dd[i]!) };
}

async function readEquity(file: string): Promise<{ ts: number[]; eq: number[] }> {
  const text = await fs.readFile(file, "utf8");
  const ts: number[] = [], eq: number[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l) continue;
    const c = l.indexOf(",");
    ts.push(Number(l.slice(0, c))); eq.push(Number(l.slice(c + 1)));
  }
  return { ts, eq };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1]! : 0; };

export interface PostprocessResult { summary: Summary; integrity: IntegrityReport; fills: number; trips: number; warnings: string[] }

/** Day files of a bar folder inside [from, to). */
async function daysWithFiles(dataRoot: string, broker: string, symbol: string, tf: string, from: string, to: string): Promise<number> {
  const names = await fs.readdir(path.join(dataRoot, "bars", broker, symbol, tf)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".bin") && n.slice(0, 10) >= from && n.slice(0, 10) < to).length;
}

/** `VENUE:ROOT` of every futures catalog in the data root (`contracts/<VENUE>/<ROOT>.json`; `.rolls.json` and `.options.json` are other files). */
async function storeRoots(dataRoot: string): Promise<string[]> {
  const out: string[] = [];
  const dir = path.join(dataRoot, "contracts");
  for (const venue of await fs.readdir(dir).catch(() => [] as string[])) {
    for (const f of await fs.readdir(path.join(dir, venue)).catch(() => [] as string[])) {
      if (f.endsWith(".json") && !f.endsWith(".rolls.json") && !f.endsWith(".options.json")) out.push(`${venue}:${f.slice(0, -5)}`);
    }
  }
  return out;
}

/** The instruments.yaml a run used: the workspace's own wins over the data source's (the same rule as `--instruments`). */
export async function readInstrumentsText(workspace: string | null, dataRoot: string): Promise<string> {
  if (workspace) { const t = await fs.readFile(path.join(workspace, "instruments.yaml"), "utf8").catch(() => ""); if (t) return t; }
  return fs.readFile(path.join(dataRoot, "instruments.yaml"), "utf8").catch(() => "");
}

const NO_BARS_BY_KIND: Partial<Record<InstrumentKind, string>> = {
  continuous: "a continuous futures stream is built from each contract's bars, so there is no bar folder of its own",
  chain: "an options chain is read from stored snapshots, not bars",
  analytic: "a CHAIN: analytic is read from stored snapshots, not bars",
  hub: "a HUB: record is not a bar series",
};

export async function postprocess(args: { runDir: string; run: RunJson; dataRoot: string; instrumentsText?: string }): Promise<PostprocessResult> {
  const { runDir, run, dataRoot } = args;
  const engineDir = path.join(runDir, "engine"), derivedDir = path.join(runDir, "derived");
  await fs.mkdir(derivedDir, { recursive: true });
  const warnings: string[] = [];

  const result = loadResult(JSON.parse(await fs.readFile(path.join(engineDir, "result.json"), "utf8")));

  const st = await fs.stat(path.join(engineDir, "trades.csv"));
  if (st.size > 1.5 * 1024 * 1024 * 1024) throw new PostprocessError(`trades.csv is ${(st.size / 1e9).toFixed(1)} GB, too large for the studio`);
  const fills = await parseTradesFile(path.join(engineDir, "trades.csv"));
  if (fills.length > MAX_FILLS) throw new PostprocessError(`${fills.length.toLocaleString()} fills exceeds the studio limit of ${MAX_FILLS.toLocaleString()}`);
  const trips = pairRoundTrips(fills);
  // Futures and options: the files qkt writes beside the CFD ones, each only when it has rows. Read here so the contracts
  // behind a continuous stream's fills land on the trips before roundtrips.json is written.
  const readEngine = (name: string) => fs.readFile(path.join(engineDir, name), "utf8").catch(() => undefined);
  const dfiles = {
    rolls: await readEngine("rolls.csv"), contracts: await readEngine("contracts.csv"), settlements: await readEngine("settlements.csv"),
    margin: await readEngine("margin_daily.csv"), liquidations: await readEngine("liquidations.csv"), structures: await readEngine("structures.csv"),
    financing: await readEngine("financing.csv"),
  };
  const derivatives = buildDerivatives(dfiles, result);
  if (derivatives?.liquidations?.length) warnings.push(`The venue liquidated ${derivatives.liquidations.length} position${derivatives.liquidations.length === 1 ? "" : "s"}: account equity fell below the maintenance margin (see Derivatives, Liquidations). Orders that add risk were refused while it stayed below.`);
  if (derivatives?.margin?.some((d) => d.marginCall)) warnings.push("The account was on a margin call on at least one day (see Derivatives, Margin).");
  if (dfiles.contracts !== undefined || dfiles.rolls !== undefined) attachContracts(trips, dfiles.contracts ? parseContracts(dfiles.contracts) : [], dfiles.rolls ? parseRolls(dfiles.rolls) : []);
  // orders qkt refused (risk caps, halts): without these a run that rejected every order reads as "no trades"
  const rejections = summarizeRejections(await fs.readFile(path.join(engineDir, "rejections.csv"), "utf8").catch(() => ""));
  if (rejections.count) {
    const top = rejections.reasons[0]!;
    warnings.push(`qkt rejected ${rejections.count.toLocaleString()} order${rejections.count === 1 ? "" : "s"}${fills.length === 0 ? ", every order this run placed, so it made no trades" : ""}: `
      + rejections.reasons.slice(0, 3).map((x) => `${x.count.toLocaleString()} × ${x.label}`).join("; ") + (top.hint ? `. ${top.hint}` : "."));
  } else if (fills.length === 0) warnings.push("The strategy produced no trades in this window: its conditions never held (qkt rejected no orders). Check the rule conditions and the data range.");

  // Chart-side evidence: bars for every stream the engine evaluated.
  const fromMs = Date.parse(run.from + "T00:00:00Z"), toMs = Date.parse(run.to + "T00:00:00Z");
  const streams = Object.keys(result.inputSummary.streamCandles ?? {}).map(parseStreamKey).filter((s): s is StreamRef => s !== null);
  const kctx = contextFromCatalog(parseInstruments(args.instrumentsText ?? ""), { futureRoots: await storeRoots(dataRoot) });
  for (const s of streams) { const k = kindOf(s, kctx); if (k !== "cfd") s.kind = k; }
  // which bar folder each stream's candles come from: in a bars run exactly qkt's choice; in a tick run the stream's own folder
  // when it is built, else the coarsest built one that divides it (for display: qkt built those candles from ticks)
  const built = new Map<string, string[]>();
  for (const s of streams) if (!built.has(`${s.broker}:${s.symbol}`)) built.set(`${s.broker}:${s.symbol}`, await availableTimeframes(dataRoot, s.broker, s.symbol));
  const builtOf = (b: string, sy: string) => built.get(`${b}:${sy}`) ?? [];
  const draftBases = run.tier === "draft" ? barBases(streams, builtOf) : null;
  // a bars run reads exactly qkt's folder; a tick run builds its candles from ticks, so the chart shows the built folder that
  // covers the most of the window among those that divide the stream (the coarsest on a tie): a coarse folder with a hole
  // in the window would draw an empty chart where a finer one has every day
  for (const s of streams) {
    if (draftBases) { s.base = draftBases.get(`${s.broker}:${s.symbol}`) ?? null; continue; }
    const want = tfToMs(s.tf);
    const cands = builtOf(s.broker, s.symbol).filter((tf) => canonicalTf(tf) === tf && want % tfToMs(tf) === 0).sort((a, b) => tfToMs(b) - tfToMs(a));
    let best: string | null = null, bestDays = -1;
    for (const tf of cands) {
      const days = await daysWithFiles(dataRoot, s.broker, s.symbol, tf, run.from, run.to);
      if (days > bestDays) { best = tf; bestDays = days; }
    }
    s.base = best ?? barBaseTf(builtOf(s.broker, s.symbol), s.tf);
  }
  const barCounts: Record<string, number> = {};
  const bars: Record<string, BarCols> = {};
  const streamNotes: string[] = [];
  for (const s of streams) {
    if (s.kind && NO_BARS_BY_KIND[s.kind]) { streamNotes.push(`${s.key}: ${NO_BARS_BY_KIND[s.kind]}, chart checks skipped`); s.base = null; continue; }
    if (!s.base) { streamNotes.push(`${s.key}: no bar folder qkt can read for it, chart checks skipped`); continue; }
    const r = await readBarsVia(dataRoot, s.broker, s.symbol, s.tf, s.base, fromMs, toMs);
    if (r.days.length === 0) { streamNotes.push(`${s.key}: no bar files in the store, chart checks skipped`); continue; }
    bars[s.key] = r.cols;
    if (r.missingDays.length === 0) barCounts[s.key] = r.cols.ts.length;
    else streamNotes.push(`${s.key}: ${r.missingDays.length} day file(s) absent, bar-count check skipped`);
  }
  const allCloses = Object.values(bars).flatMap((b) => Array.from(b.close.subarray(0, 2000)));
  const priceTol = run.tier === "full" ? 0.0005 * median(allCloses) : 0;

  const manifest = await verifyManifest(engineDir);
  const rep = integrity({
    result, trips, fills,
    barCounts: Object.keys(barCounts).length ? barCounts : undefined,
    bars: Object.keys(bars).length ? bars : undefined,
    priceTol, manifest, softFillsInBars: run.tier === "draft",
  });
  if (streamNotes.length) rep.checks.push({ id: "streams", label: "Bar store coverage", ok: null, detail: streamNotes.join("; ") });

  if (rep.checks.some((c) => c.id === "fillsInBars" && c.ok === false && c.soft)) warnings.push("Some fills fall outside their bar. Draft mode approximates stop and target fills from bars, so verify this strategy with a Full run.");
  const summary = summarize(result, trips);
  const eqRaw = await readEquity(path.join(engineDir, "equity_global.csv")).catch(() => ({ ts: [] as number[], eq: [] as number[] }));
  const equity = downsampleEquity(eqRaw.ts, eqRaw.eq);

  const write = (name: string, v: unknown) => fs.writeFile(path.join(derivedDir, name), JSON.stringify(v));
  // Portfolio runs only: per-strategy rows, equity per strategy and the book's own numbers. A plain strategy writes none of
  // these, so nothing downstream has to special-case an old or single-strategy run beyond "the file is absent".
  const strategyIds = Object.keys(result.perStrategy ?? {});
  const portfolioFiles: Array<Promise<void>> = [];
  if (strategyIds.length > 1) {
    portfolioFiles.push(write("strategies.json", strategyBreakdown(result, trips)));
    const book = bookInfo(result);
    if (book) portfolioFiles.push(write("book.json", book));
    const series: Record<string, EquitySeries> = {};
    for (const id of strategyIds) {
      const raw = await readEquity(path.join(engineDir, `equity_${encodeURIComponent(id)}.csv`)).catch(() => null);
      if (raw && raw.ts.length) series[id] = downsampleEquity(raw.ts, raw.eq);
    }
    portfolioFiles.push(write("equity-by-strategy.json", { ids: strategyIds, series }));
  }
  // Futures/options runs only (like the portfolio files): the UI branches on `meta.derivatives` or a 404, never on the stream kinds alone.
  const sections: DerivativesSection[] = derivatives?.sections ?? [];
  if (derivatives) portfolioFiles.push(write("derivatives.json", derivatives));
  else await fs.rm(path.join(derivedDir, "derivatives.json"), { force: true });
  await Promise.all([
    ...portfolioFiles,
    write("roundtrips.json", trips),
    write("summary.json", summary),
    write("monthly.json", monthlyPnl(trips)),
    write("integrity.json", rep),
    write("equity.json", equity),
    write("meta.json", {
      runId: run.id, tier: run.tier, from: run.from, to: run.to, streams, strategies: Object.keys(result.perStrategy),
      fills: fills.length, trips: trips.length, qktVersion: result.evidence.qktVersion, studioVersion: STUDIO_VERSION,
      currency: result.accounting?.accountCurrency ?? null,
      rejections,
      monteCarloEngine: result.global.monteCarlo ?? null, derivedVersion: DERIVED_VERSION,
      ...(sections.length ? { derivatives: sections } : {}),
    }),
  ]);
  return { summary, integrity: rep, fills: fills.length, trips: trips.length, warnings };
}
