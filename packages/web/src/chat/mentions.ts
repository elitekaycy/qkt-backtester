// packages/web/src/chat/mentions.ts
import type { Mention } from "@qkt-studio/core/chat";

export interface MentionOption { label: string; ref: string; hint: string }
const stem = (p: string) => p.split("/").pop()!.replace(/\.qkt$/, "");

/** What "@" can refer to. Mentions are optional precision: the view reference already names what is on screen. */
export function mentionOptions(c: { strategies: string[]; runId: string | null; selectedTrade: number | null; symbols: string[] }): MentionOption[] {
  const out: MentionOption[] = [
    { label: "@config", ref: "qkt.config.yaml", hint: "qkt.config.yaml" },
    { label: "@instruments", ref: "instruments.yaml", hint: "instruments.yaml" },
    { label: "@chart", ref: "the chart: the run on screen, visible range, selected trade and variant (get_context)", hint: "what the chart shows" },
    { label: "@split", ref: "the split into a first part and a test part (get_split)", hint: "the split" },
  ];
  if (c.runId) out.push({ label: "@run", ref: `run ${c.runId}`, hint: c.runId });
  if (c.selectedTrade !== null) out.push({ label: `@trade#${c.selectedTrade}`, ref: `trade #${c.selectedTrade} of the run on screen`, hint: "the selected trade" });
  for (const p of c.strategies) out.push({ label: `@${stem(p)}`, ref: p, hint: p });
  for (const s of c.symbols) out.push({ label: `@${s}`, ref: `symbol ${s}`, hint: "symbol" });
  const seen = new Set<string>();
  return out.filter((o) => { const k = o.label.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The "@word" being typed at the caret: "@" at the start or after whitespace, up to the caret. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\w#.-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

export function filterMentions(opts: MentionOption[], query: string, max = 8): MentionOption[] {
  const q = query.toLowerCase();
  const starts = opts.filter((o) => o.label.slice(1).toLowerCase().startsWith(q));
  const has = opts.filter((o) => !starts.includes(o) && o.label.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, max);
}

export function insertMention(text: string, start: number, caret: number, label: string): { text: string; caret: number } {
  return { text: `${text.slice(0, start)}${label} ${text.slice(caret)}`, caret: start + label.length + 1 };
}

/** The mentions a message carries: each known "@label" once, plus "@trade#N" for any N. */
export function mentionsIn(text: string, opts: MentionOption[]): Mention[] {
  const out: Mention[] = [], seen = new Set<string>();
  for (const m of text.matchAll(/(^|\s)(@[\w#.-]+)/g)) {
    const label = m[2]!.replace(/[.,;:!?]+$/, ""), key = label.toLowerCase();
    if (seen.has(key)) continue;
    const o = opts.find((x) => x.label.toLowerCase() === key), trade = /^@trade#(\d+)$/i.exec(label);
    if (o) out.push({ label: o.label, ref: o.ref });
    else if (trade) out.push({ label, ref: `trade #${trade[1]} of the run on screen` });
    else continue;
    seen.add(key);
  }
  return out;
}
