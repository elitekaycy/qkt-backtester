// packages/web/src/chat/convert.ts
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage, Usage } from "@qkt-studio/core/chat";

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type ToolArgs = Extract<Part, { type: "tool-call" }>["args"];
export interface FooterData { status: ChatMessage["status"]; error: string | null; usage: Usage | null; model: string | null }

function statusOf(m: ChatMessage): ThreadMessageLike["status"] {
  switch (m.status) {
    case "running": return { type: "running" };
    case "done": return { type: "complete", reason: "stop" };
    case "stopped": return { type: "incomplete", reason: "cancelled" };
    case "error": return { type: "incomplete", reason: "error", error: m.error ?? undefined };
    default: return { type: "incomplete", reason: "other" };
  }
}

/** Our stored message -> the chat UI's message: text, tool steps, notices, and a footer (status, usage) once finished. */
export function toThreadMessage(m: ChatMessage): ThreadMessageLike {
  if (m.role === "user") return { id: m.id, role: "user", content: [{ type: "text", text: m.text }], createdAt: new Date(m.created) };
  const content: Part[] = m.items.map((i): Part => {
    if (i.type === "text") return { type: "text", text: i.text };
    if (i.type === "notice") return { type: "data-notice", data: { text: i.text } };
    const args = (i.input && typeof i.input === "object" && !Array.isArray(i.input) ? i.input : {}) as ToolArgs;
    return { type: "tool-call", toolCallId: i.id, toolName: i.name, args, result: i.result?.text, isError: i.result?.isError, artifact: { ms: i.result?.ms ?? null } };
  });
  if (m.status !== "running") content.push({ type: "data-footer", data: { status: m.status, error: m.error, usage: m.usage, model: m.model } satisfies FooterData });
  return { id: m.id, role: "assistant", content, createdAt: new Date(m.created), status: statusOf(m) };
}

const VERBS: Record<string, string> = {
  try_change: "tried a change", try_variants: "tried variants", run_backtest: "ran backtest", run_walkforward: "started a walk-forward",
  sweep: "started a sweep", job_status: "checked a job", cancel: "cancelled", get_context: "read the view", list_files: "listed files",
  read_file: "read a file", list_runs: "listed runs", get_run: "read a run", dsl_reference: "read the DSL reference", dsl_examples: "looked up examples",
  config_reference: "read the config reference", instruments_reference: "read the instruments reference", data_status: "checked the data",
  run_summary: "read the run summary", diagnose_exits: "diagnosed exits", diagnose_entries: "diagnosed entries", trades: "listed trades",
  trade_detail: "read a trade", compare_runs: "compared runs", check_strategy: "checked DSL", create_strategy: "created a strategy",
  propose_strategy_edit: "proposed an edit", get_config: "read the config", propose_config: "proposed a config change", get_instrument: "read an instrument",
  propose_instrument: "proposed an instrument change", get_split: "read the split", set_split: "changed the split", list_variants: "listed variants",
  discard_variant: "discarded a variant", propose_build_bars: "proposed a data build",
};
export const stepLabel = (name: string): string => VERBS[name] ?? name.replace(/_/g, " ");
