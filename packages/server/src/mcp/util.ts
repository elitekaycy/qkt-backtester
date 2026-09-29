import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { Jobs } from "../jobs.js";
import type { RunData } from "../run-data.js";
import type { EventBus } from "../agent/events.js";
import type { ViewState } from "../agent/view-state.js";

export interface ToolCtx { cfg: ServerConfig; runner: Runner; jobs: Jobs; data: RunData; events: EventBus; view: ViewState }
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
