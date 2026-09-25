import type { Tier } from "./runid.js";
import type { HoleDay } from "./outputs.js";

export type RunStatus = "queued" | "checking" | "running" | "postprocessing" | "done" | "failed" | "cancelled" | "interrupted";

const NEXT: Record<RunStatus, RunStatus[]> = {
  queued: ["checking", "cancelled", "failed", "interrupted"],
  checking: ["running", "failed", "cancelled", "interrupted"],
  running: ["postprocessing", "failed", "cancelled", "interrupted"],
  postprocessing: ["done", "failed", "cancelled", "interrupted"],
  done: [], failed: [], cancelled: [], interrupted: [],
};

export class IllegalTransition extends Error {}

export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (!NEXT[from].includes(to)) throw new IllegalTransition(`illegal run transition ${from} -> ${to}`);
  return to;
}
export const isTerminal = (s: RunStatus) => NEXT[s].length === 0;
export const isActive = (s: RunStatus) => !isTerminal(s);

export type StepId = "project" | "config" | "parse" | "coverage" | "backtest" | "postprocess" | "render";
export const STEP_ORDER: StepId[] = ["project", "config", "parse", "coverage", "backtest", "postprocess", "render"];
export type StepStatus = "pending" | "running" | "ok" | "warn" | "failed" | "skipped";

export interface StepRecord {
  id: StepId;
  status: StepStatus;
  startedAt?: string;
  ms?: number;
  /** The exact command line (copyable), when the step runs a process. */
  command?: string;
  message?: string;
}

export type ErrorKind =
  | "parse" | "unknown_indicator" | "unknown_alias" | "missing_config" | "bad_config_yaml" | "bad_config_key"
  | "missing_data" | "incomplete_data" | "file_not_found" | "engine_crash" | "unsupported_result" | "cancelled" | "internal";

export interface RunError { kind: ErrorKind; message: string; file?: string; line?: number; col?: number }

export interface RunJson {
  schema: "qkt-studio-run-v1";
  id: string;
  hash: string;
  status: RunStatus;
  tier: Tier;
  strategy: string;
  from: string;
  to: string;
  params: Record<string, string>;
  engine: { version: string; gitSha?: string };
  createdAt: string;
  finishedAt?: string;
  steps: StepRecord[];
  waivedDays: string[];
  warnings: string[];
  exitCode?: number | null;
  error?: RunError;
  /** Monotonic sequence within a strategy so the UI can drop results from superseded runs. */
  seq: number;
  /** Provenance for derived data: which studio build produced `derived/`. */
  studioVersion?: string;
  /** True when a newer save of the same strategy may cancel this run (auto-run on save). */
  auto?: boolean;
  /** Engine coverage lines and the per-day holes qkt reported (empty when data was complete). */
  coverage?: Array<{ source: "tick" | "bar"; symbol: string; covered: number; requested: number; tf?: string }>;
  holes?: HoleDay[];
  /** qkt's own remedy for missing bars, e.g. `qkt data build-bars XAUUSD --tf 15m --from ... --to ...`. */
  buildBarsHint?: string;
  /** Live counters from the engine's log stream. */
  counts?: { fills: number; orders: number };
  durationMs?: number;
  /** Extra qkt options this run was started with (see server run-options). */
  options?: Record<string, string | number>;
}

export function newRunJson(p: Pick<RunJson, "id" | "hash" | "tier" | "strategy" | "from" | "to" | "params" | "engine" | "seq"> & { now?: Date }): RunJson {
  return {
    schema: "qkt-studio-run-v1", id: p.id, hash: p.hash, status: "queued", tier: p.tier, strategy: p.strategy,
    from: p.from, to: p.to, params: p.params, engine: p.engine, createdAt: (p.now ?? new Date()).toISOString(),
    steps: STEP_ORDER.map((id) => ({ id, status: "pending" as StepStatus })), waivedDays: [], warnings: [], seq: p.seq,
  };
}
