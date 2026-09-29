import { promises as fs } from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInJail } from "../jail.js";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { Jobs } from "../jobs.js";
import type { RunData } from "../run-data.js";
import type { EventBus } from "../agent/events.js";
import type { ViewState } from "../agent/view-state.js";
import type { Proposals } from "../agent/proposals.js";
import type { Variants } from "../agent/variants.js";

export interface ToolCtx {
  cfg: ServerConfig; runner: Runner; jobs: Jobs; data: RunData; events: EventBus; view: ViewState; proposals: Proposals; variants: Variants;
  /** Run/job ids the tools themselves started (never a run the user started from the Run button, or a base run of a variant): cancel() only touches these. */
  started: Set<string>;
  /** How much run work the tools may have in flight at once. */
  budget: ToolBudget;
}
export const MAX_CHARS = 8000;
/** Compact JSON for the model; cut at MAX_CHARS with a note on how to ask for the rest. */
export function ok(value: unknown, more = "narrow it with limit/offset/fields"): CallToolResult {
  const full = JSON.stringify(value);
  if (full.length <= MAX_CHARS) return { content: [{ type: "text", text: full }] };
  // the head is escaped again when it is serialized (quotes, backslashes), so the cap is checked on the final text
  let n = MAX_CHARS - 200, text = "";
  for (;;) {
    text = JSON.stringify({ truncated: true, hint: more, head: full.slice(0, n) });
    if (text.length <= MAX_CHARS || n === 0) break;
    n = Math.max(0, n - Math.max(1, Math.ceil((text.length - MAX_CHARS) / 2)));
  }
  return { content: [{ type: "text", text }] };
}

// ---- the tools' path policy ---------------------------------------------------------------------------------

const SECRET_FILE = /^\.env(\..*)?$/i;
/**
 * Why a tool may not touch workspace path `rel` (already normalized, `/`-separated), or null when it may. Refused:
 * `.env` files (any `.env.*` but `.env.example`), anything in a dot-folder (`.qkt-studio/` holds the studio's own state and
 * variant copies, which only server code writes), and the run store `runs/`. `dir` = the path is itself a folder.
 */
export function toolPathRefusal(rel: string, dir = false): string | null {
  const parts = rel.split("/").filter((x) => x && x !== ".");
  const name = parts[parts.length - 1] ?? "";
  if (!dir && SECRET_FILE.test(name) && name.toLowerCase() !== ".env.example") return `${name} holds secrets; tools cannot read or change it`;
  if (parts[0] === "runs") return "runs/ is the studio's run store; use list_runs / get_run / run_summary instead";
  const folders = dir ? parts : parts.slice(0, -1);
  if (folders.some((p) => p.startsWith("."))) return `${rel} is inside a hidden folder (${folders.find((p) => p.startsWith("."))}/), which tools cannot use`;
  return null;
}

/**
 * Resolve a path given to a tool: inside the workspace (the jail: no `..`, absolute paths or symlink escapes) and allowed by
 * `toolPathRefusal`, checked on the path as written and on where it really leads (a symlink into `.qkt-studio/` is refused
 * too). `ext` requires an extension; `dir` treats the path as a folder. Every tool that takes a path goes through here.
 */
export async function toolPath(ws: string, rel: string, o: { ext?: string; dir?: boolean } = {}): Promise<{ rel: string; abs: string; real: string }> {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
  const norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  const refusal = toolPathRefusal(norm, o.dir);
  if (refusal) throw new Error(refusal);
  if (o.ext && !norm.toLowerCase().endsWith(o.ext)) throw new Error(`${rel} is not a ${o.ext} file`);
  const abs = await resolveInJail(ws, norm);
  const root = await fs.realpath(ws);
  const real = await fs.realpath(abs).catch(() => fs.realpath(path.dirname(abs)).then((d) => path.join(d, path.basename(abs)), () => abs));
  const realRel = path.relative(root, real).split(path.sep).join("/");
  const realRefusal = realRel && realRel !== norm ? toolPathRefusal(realRel, o.dir) : null;
  if (realRefusal) throw new Error(`${rel} leads to ${realRel}: ${realRefusal}`);
  return { rel: norm === "" ? "." : norm, abs, real: realRel || "." };
}

// ---- the tools' run budget ----------------------------------------------------------------------------------

interface BudgetDeps { isActive(id: string): boolean; jobRunning(id: string): boolean }
/**
 * Tool-started work in flight: at most `maxRuns` runs active or queued (2 x maxParallel in the studio) and one grid or
 * walk-forward job. Past that a tool gets "busy" instead of piling more onto the queue the user's own Run waits in.
 * Room is reserved synchronously before any await, so parallel tool calls cannot all slip past the check.
 */
export class ToolBudget {
  private runs = new Set<string>();
  private reserved = 0;
  private job: string | null = null;
  private jobPending = false;
  constructor(private deps: BudgetDeps, readonly maxRuns: number) {}

  /** Runs the tools started that are still queued or running. */
  inFlight(): number {
    for (const id of this.runs) if (!this.deps.isActive(id)) this.runs.delete(id);
    return this.runs.size;
  }
  /** Reserve room for `n` new runs or throw "busy"; call the returned release once their submits have resolved. */
  reserve(n: number): () => void {
    const used = this.inFlight() + this.reserved;
    if (used + n > this.maxRuns) throw new Error(`busy: ${used} runs queued; wait or cancel (at most ${this.maxRuns} tool runs at once)`);
    this.reserved += n;
    let released = false;
    return () => { if (!released) { released = true; this.reserved -= n; } };
  }
  /** A run a tool's submit just created (not a cached or joined one). */
  track(id: string): void { this.runs.add(id); }

  /** Start one grid / walk-forward job, or throw "busy" while a tool-started one still runs. */
  async startJob<J extends { id: string }>(start: () => Promise<J>): Promise<J> {
    if (this.jobPending || (this.job && this.deps.jobRunning(this.job))) throw new Error(`busy: a tool-started job (${this.job ?? "starting"}) is still running; wait for it (job_status) or cancel it`);
    this.jobPending = true;
    try { const j = await start(); this.job = j.id; return j; } finally { this.jobPending = false; }
  }
}
export const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
/** Run a tool body; any thrown error becomes a tool error the model can read and act on. */
export const guard = (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => fn().catch((e: unknown) => fail((e as Error).message));

/** Day names in Monday-first order, matching qkt's own weekday numbering (mon = 0 ... sun = 6). */
export const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayName = (typeof DAY_NAMES)[number];
const DAY_FULL = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * A weekday given as qkt's own numbering (Monday = 0 ... Sunday = 6) or a name (mon..sun / monday..sunday,
 * case-insensitive), converted to JS `Date#getUTCDay()` (Sunday = 0 ... Saturday = 6) — the convention `analyze()`
 * and `TripQuery` use internally. Tool boundaries take the qkt/name form; everything past that boundary stays JS-native.
 */
export function parseWeekday(input: string | number): number {
  let qktIndex: number;
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0 || input > 6) throw new Error(`weekday must be 0-6 (0 = Monday) or a day name (mon..sun); got ${input}`);
    qktIndex = input;
  } else {
    const s = input.trim().toLowerCase();
    const byAbbrev = DAY_NAMES.indexOf(s as DayName);
    const byFull = DAY_FULL.indexOf(s);
    qktIndex = byAbbrev !== -1 ? byAbbrev : byFull;
    if (qktIndex === -1) throw new Error(`unknown weekday "${input}"; use mon..sun, monday..sunday, or 0-6 (0 = Monday)`);
  }
  return (qktIndex + 1) % 7;
}

/** Buckets indexed by `Date#getUTCDay()` (0 = Sunday) to an object keyed by day name, Monday-first. */
export function weekdayByName<T>(buckets: ArrayLike<T>): Record<DayName, T> {
  const out = {} as Record<DayName, T>;
  DAY_NAMES.forEach((name, i) => { out[name] = buckets[(i + 1) % 7] as T; });
  return out;
}
