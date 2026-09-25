export type {
  RunJson, StepRecord, StepId, RunError, RunStatus, Summary, RoundTrip, IntegrityReport, IntegrityCheck, McResult, MonthRow,
  Diagnostic, TripQuery, HoleDay, Tier, McMethod, Analytics, Bucket, Histogram, ExitReason, RunOptions,
  ScanReport, SymbolReport, TfReport, TickReport, Readiness, ModeReadiness, DayRange, YearRow, Completeness,
} from "@qkt-studio/core";
import type { RunOptions } from "@qkt-studio/core";
import type { Tier } from "@qkt-studio/core";

export interface RunRequest {
  strategy: string;
  from: string;
  to: string;
  tier: Tier;
  params?: Record<string, string>;
  allowIncomplete?: boolean;
  force?: boolean;
  auto?: boolean;
  options?: RunOptions;
}
