import type { Completeness, DayRange, YearRow } from "./ranges.js";
import type { StreamDecl } from "./strategy.js";

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

export interface ScanReport {
  dataRoot: string; scannedAt: string; looksLikeStore: boolean; ms: number;
  symbols: SymbolReport[];
  totals: { symbols: number; complete: number; mostly: number; incomplete: number; ticksOnly: number; empty: number; barFiles: number; tickFiles: number };
}

export interface ModeReadiness {
  runnable: boolean;
  /** Windows (exclusive end) where every stream the strategy reads is complete. */
  ranges: DayRange[];
  longest: DayRange | null;
  blocked: Array<{ stream: string; reason: string; fix?: "build-bars" | "fetch"; /** Portfolio children that read this stream. */ members?: string[] }>;
}

/** One child of a portfolio and whether it could run on its own data. */
export interface MemberReadiness { alias: string; rel: string | null; exists: boolean; hold: boolean; bars: boolean; ticks: boolean; streams: StreamDecl[] }
export interface Readiness { strategy: string; kind: string; streams: StreamDecl[]; bars: ModeReadiness; ticks: ModeReadiness; members?: MemberReadiness[] }
