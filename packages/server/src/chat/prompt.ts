// packages/server/src/chat/prompt.ts
import type { Mention, ViewKey } from "@qkt-studio/core";
import type { View } from "../agent/view-state.js";

/**
 * Fixed text, never per message: Claude Code records a conversation's system prompt on its first request and reuses it
 * verbatim on --resume, so what changes (open file, run...) goes in each message's <studio-view> block instead.
 */
export const SYSTEM_PROMPT = [
  "You work inside the qkt backtesting studio. The user brings the idea; you turn their words into the exact change and show it.",
  "Use only the studio's tools. Map each request onto the fewest tool calls: for any strategy change prefer try_change (one call changes a copy, runs it and shows it on the user's chart).",
  "Each message starts with a <studio-view> block: resolve \"this file\", \"this run\", \"this trade\" from it; find other files and runs with list_files and list_runs. If a name is ambiguous, ask one short question.",
  "Do what the user asks. When a tool returns a warning (different scales, fitting the past, a refused value), relay it in one line; never refuse a legal change.",
  "Change only what the user asked for; leave every other value as it is (asked for a stop, do not set a target).",
  "Numbers come from the tools only; never estimate them. Read dsl_reference before writing DSL.",
  "When you pick among sweep rows, judge them on the first part (what job_status gives you); do not open the rows' runs to look at the test part: it is the user's check on your pick.",
  "Be brief: a sentence or two; a small table only to compare.",
].join("\n");

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** What the user is looking at, as references (never file contents): the model fetches what it needs with the tools. */
export function viewReference(v: View, split: string | null, omit: readonly ViewKey[], mentions: readonly Mention[]): string {
  const skip = new Set<ViewKey>(omit), lines: string[] = [];
  if (!skip.has("file") && v.openFile) lines.push(`open file: ${v.openFile}${v.cursorLine ? ` (cursor on line ${v.cursorLine})` : ""}${v.selection ? " (text selected; get_context has it)" : ""}`);
  if (!skip.has("run") && v.runId) lines.push(`run on screen: ${v.runId}${v.runWindow ? ` (${v.runWindow.from} to ${v.runWindow.to}, ${v.runWindow.tier})` : ""}`);
  if (!skip.has("range") && v.visibleFrom !== null && v.visibleTo !== null) lines.push(`chart shows: ${minute(v.visibleFrom)} to ${minute(v.visibleTo)} UTC`);
  if (!skip.has("trade") && v.selectedTrade !== null) lines.push(`selected trade: #${v.selectedTrade}`);
  if (!skip.has("variant") && v.variantId) lines.push(`variant showing: ${v.variantId}`);
  if (!skip.has("split") && split) lines.push(`split: ${split}`);
  for (const m of mentions.slice(0, 10)) lines.push(`mentioned ${m.label}: ${m.ref}`);
  return lines.length ? `<studio-view>\n${lines.join("\n")}\n</studio-view>` : "";
}

export const composePrompt = (ref: string, text: string): string => (ref ? `${ref}\n\n${text}` : text);
