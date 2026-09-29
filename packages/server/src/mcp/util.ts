import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { Jobs } from "../jobs.js";
import type { RunData } from "../run-data.js";
import type { EventBus } from "../agent/events.js";
import type { ViewState } from "../agent/view-state.js";
import type { Proposals } from "../agent/proposals.js";
import type { Variants } from "../agent/variants.js";

export interface ToolCtx { cfg: ServerConfig; runner: Runner; jobs: Jobs; data: RunData; events: EventBus; view: ViewState; proposals: Proposals; variants: Variants }
export const MAX_CHARS = 8000;
/** Compact JSON for the model; cut at MAX_CHARS with a note on how to ask for the rest. */
export function ok(value: unknown, more = "narrow it with limit/offset/fields"): CallToolResult {
  let text = JSON.stringify(value);
  if (text.length > MAX_CHARS) text = JSON.stringify({ truncated: true, hint: more, head: text.slice(0, MAX_CHARS - 200) });
  return { content: [{ type: "text", text }] };
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
