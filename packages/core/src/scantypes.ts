import type { Completeness, DayRange, YearRow } from "./ranges.js";
import type { StreamDecl } from "./strategy.js";
import type { FutureTerms, InstrumentKind, OptionTerms } from "./instruments.js";

/** Shapes of the data-source scan, shared by the server (which computes them) and the browser (which shows them). */
export type DayStatus = "ok" | "closed" | "thin" | "missing";

export interface TfReport {
  broker: string; tf: string; files: number; first: string | null; last: string | null;
  /** Calendar days from first to last inclusive. */
  span: number; ok: number; closed: number; thin: number; missing: number;
  status: Completeness;
  /** Windows with no missing day (exclusive end): what a bars run can use. */
  usable: DayRange[];
  gaps: DayRange[];
  years: YearRow[];
  /** The market trades on Saturdays (crypto): a weekend or empty day is a hole here, not a closure. */
  always: boolean;
  /**
   * Set when qkt cannot read this folder because it is not qkt's name for the timeframe: the name qkt looks for instead
   * (a `1440m` folder is invisible to qkt, which reads `1d`). Such bars never count as available.
   */
  qktReads?: string;
}

export interface TickReport {
  files: number; first: string | null; last: string | null; span: number; present: number;
  /** Mon-Fri days with no file. Weekend gaps are treated as normal. Holidays therefore show as gaps, as they do in qkt. */
  missing: number;
  status: Completeness; usable: DayRange[]; gaps: DayRange[]; years: YearRow[]; source?: string; lastUpdated?: string; always: boolean;
}

export interface SymbolReport {
  symbol: string; ticks: TickReport | null; bars: TfReport[];
  /** Best available source. `ticks-only` means ticks exist but no bars are built. */
  status: Completeness | "ticks-only";
  /** Mon-Fri markets treat weekends and holidays as closed; 24/7 markets treat any empty day as a gap. */
  market: "24/7" | "Mon-Fri";
  completeYears: number; spanYears: number; notes: string[];
}

/** A stored per-day or single-file series (funding rates, open interest, marks, option chains): what is on disk, not a verdict. */
export interface SeriesReport {
  files: number; first: string | null; last: string | null; rows?: number;
  /** Windows (exclusive end) the series covers by the engine's own rule: a stored day, or no gap over the series' tolerance. */
  present?: DayRange[];
}

/** One built timeframe of one contract's bars. */
export interface ContractBars {
  tf: string; files: number; first: string | null; last: string | null;
  /** Runs of consecutive days that have a bar file (an empty file counts: qkt writes one for a closed day). */
  present?: DayRange[];
}

export interface ContractReport {
  /** The qkt symbol: `ESZ24`, `BTCUSDT_241227`. */
  symbol: string; expiry: string | null; deliveryPrice: string | null; bars: ContractBars[];
}

export interface PerpetualReport {
  /** The venue's name for it (`BTCUSDT`), the key funding/marks/open interest are stored under. */
  name: string; bars: ContractBars[]; funding: SeriesReport | null; openInterest: SeriesReport | null; marks: Array<{ tf: string } & SeriesReport>;
  /** Per-day trade tape, liquidation prints and order-book snapshots (the fields buy_volume, *_liq_volume, bid_depth read). */
  tape: SeriesReport | null; liquidations: SeriesReport | null; depth: SeriesReport | null;
}

/** A futures root (`CME:ES`): its catalog, measured rolls, contracts with bars, and the terms instruments.yaml gives it. */
export interface FutureRootReport {
  key: string; venue: string; root: string;
  terms: FutureTerms | null;
  catalog: { contracts: number; first: string | null; last: string | null; delivered: number } | null;
  rolls: { count: number; first: string | null; last: string | null; policy: string | null; schedule: Array<{ atMs: number; from: string; to: string }> } | null;
  contracts: ContractReport[];
  perpetual: PerpetualReport | null;
  notes: string[];
}

export interface OptionRootReport {
  key: string; venue: string; root: string;
  terms: OptionTerms | null;
  catalog: { contracts: number; first: string | null; last: string | null } | null;
  chains: { trade: SeriesReport | null; book: SeriesReport | null };
  notes: string[];
}

export interface DerivativesReport {
  futures: FutureRootReport[]; options: OptionRootReport[];
  /** instruments.yaml in the data root: where futures/options terms live. */
  instruments: { path: string; exists: boolean; errors: string[] };
}

export interface ScanReport {
  dataRoot: string; scannedAt: string; looksLikeStore: boolean; ms: number;
  symbols: SymbolReport[];
  /** Futures and options roots found in the store or declared in instruments.yaml. Absent on a CFD-only source. */
  derivatives?: DerivativesReport;
  totals: { symbols: number; complete: number; mostly: number; incomplete: number; ticksOnly: number; empty: number; barFiles: number; tickFiles: number };
}

/** What closes a block: the CFD fixes, plus one per derivatives dataset the engine refuses to run without. */
export type BlockFix = "build-bars" | "fetch" | "catalog" | "rolls" | "terms" | "funding" | "marks" | "open-interest" | "chains" | "tape" | "depth";

export interface ModeReadiness {
  runnable: boolean;
  /** Windows (exclusive end) where every stream the strategy reads is complete. */
  ranges: DayRange[];
  longest: DayRange | null;
  blocked: Array<{
    stream: string; reason: string; fix?: BlockFix;
    /** The `qkt fetch ...` (or build) command that fills it, when there is one. */
    command?: string;
    /** Portfolio children that read this stream. */ members?: string[];
  }>;
}

/** One child of a portfolio and whether it could run on its own data. */
export interface MemberReadiness { alias: string; rel: string | null; exists: boolean; hold: boolean; bars: boolean; ticks: boolean; streams: StreamDecl[] }
export interface Readiness {
  strategy: string; kind: string; streams: StreamDecl[]; bars: ModeReadiness; ticks: ModeReadiness; members?: MemberReadiness[];
  /** What each declared stream is (by alias), so the UI says "continuous future" without parsing symbols itself. */
  kinds?: Record<string, InstrumentKind>;
  /**
   * qkt's own coverage check is meaningless for a continuous stream (it looks for bars/<V>/<ROOT>@front and reports 0/N days), so
   * a run of this strategy must pass --allow-incomplete; the studio's per-contract check here is the real one.
   */
  needsAllowIncomplete?: boolean;
}
