import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import type { ScanReport } from "../api/types.js";
import { declSnippets, fileSnippets, orderSnippets, ruleSnippets, streamSnippet, type Snippet } from "./snippets.js";
import { actionKeywords, membersOf, streamFields } from "./vocabulary.js";

/**
 * Completions the studio adds to qkt's own. qkt's language server answers with the same ~250 keywords and functions
 * wherever the cursor is (and nothing at all right after `gold.` or `POSITION.`), so the useful, context-specific
 * ones come from here and are sorted first: stream fields, stream aliases, the symbols and timeframes in the data
 * source, sizing and bracket forms.
 */
export interface LocalItem { label: string; insert: string; detail: string; doc?: string; kind: "field" | "alias" | "symbol" | "timeframe" | "keyword" | "snippet"; sort: string; snippet?: boolean; /** What typing matches against (defaults to the label). */ filter?: string }

const FIELD_DOC: Record<string, string> = {
  close: "Close of the latest completed bar", open: "Open of the latest completed bar", high: "High of the latest completed bar", low: "Low of the latest completed bar",
  volume: "Volume of the latest completed bar", price: "Last price", bid: "Bid", ask: "Ask", spread: "Ask minus bid", value: "Value of the stream", timestamp: "Timestamp of the bar",
  tick_size: "Smallest price increment", contract_size: "Units per lot (from instruments.yaml)", volume_step: "Lot step", volume_min: "Smallest lot",
  swap_long_points: "Swap for a long position, in points", swap_short_points: "Swap for a short position, in points",
};
// The studio's one-line descriptions for names the vocabulary lists; a name the vocabulary lacks is never offered,
// and a name it has without a line here is offered without one.
const ACTION_DOC: Record<string, string> = { BUY: "Open a long position", SELL: "Open a short position", CLOSE: "Close the position of a stream", CLOSE_ALL: "Close everything", FLATTEN: "Close every position and cancel every order", LOG: "Write a message to the run log", CANCEL: "Cancel pending orders", CANCEL_ALL: "Cancel every pending order", RESIZE: "Change the size of the open position" };
const POSITION_DOC: Record<string, string> = { count: "Number of open legs", mfe: "Best unrealised profit of the open position", mae: "Worst unrealised loss of the open position", holding_duration: "How long the position has been open", qty: "Signed open quantity", avg_price: "Average entry price", unrealized_pnl: "Open profit or loss" };
// The order the price fields are offered in (close first); everything else follows in qkt's order.
const FIELD_ORDER = ["close", "open", "high", "low", "volume", "spread", "bid", "ask", "price"];
const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

/** The text of the current line up to the cursor, and the section (SYMBOLS / RULES) it sits in. */
function context(text: string, line: number, col: number): { before: string; section: "symbols" | "rules" | "other"; block: string } {
  const lines = text.split(/\r?\n/);
  const before = (lines[line - 1] ?? "").slice(0, Math.max(0, col - 1));
  let section: "symbols" | "rules" | "other" = "other";
  for (let i = line - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (/^SYMBOLS\b/.test(l)) { section = "symbols"; break; }
    if (/^RULES\b/.test(l)) { section = "rules"; break; }
    if (/^[A-Z]/.test(l) && i < line - 1) break;
  }
  // words of the rule being written: everything since the last WHEN/blank line, so THEN after WHEN is known
  let start = line - 1;
  while (start > 0 && lines[start - 1]!.trim() !== "" && !/^\s*WHEN\b/.test(lines[start]!)) start--;
  const block = [...lines.slice(start, line - 1), before].join("\n");
  return { before, section, block };
}

function rawCompletions(text: string, line: number, col: number, scan: ScanReport | null, qktFiles: string[] = [], selfPath?: string): LocalItem[] {
  const { before, section, block } = context(text, line, col);
  const info = parseStrategyInfo(text);
  const aliases = [...new Set(info.streams.map((s) => s.alias))];
  const out: LocalItem[] = [];
  const add = (i: Omit<LocalItem, "sort"> & { sort?: string }) => out.push({ sort: "0", ...i });
  const addSnippets = (xs: Snippet[], from = 0) => xs.forEach((x, i) => add({ label: x.label, insert: x.body, detail: x.detail, kind: "snippet", sort: `0${String(from + i).padStart(2, "0")}`, snippet: true, filter: x.filter }));
  const lineStart = /^\s*\w*$/.test(before);
  const lines = text.split(/\r?\n/);

  // an empty file: the whole thing, from the data source
  if (info.kind === "unknown" && lineStart && lines.slice(0, line - 1).every((l) => /^\s*(#.*)?$/.test(l))) { addSnippets(fileSnippets(scan)); return out; }
  // before RULES, at the left margin: PARAM and LET (qkt refuses them inside RULES)
  const rulesAbove = lines.slice(0, line - 1).some((l) => /^RULES\b/.test(l));
  if (info.kind === "strategy" && section !== "rules" && !rulesAbove && /^\w*$/.test(before) && lines.slice(0, line - 1).some((l) => /^SYMBOLS\b/.test(l))) {
    addSnippets(declSnippets(aliases[0] ?? "px"));
    ["RULES", "PARAM", "LET"].forEach((k, i) => add({ label: k, insert: k === "RULES" ? "RULES\n    " : `${k} `, detail: k === "RULES" ? "Start the rules" : "", kind: "keyword", sort: `1${i}` }));
    return out;
  }

  // a portfolio's own vocabulary: IMPORT '<path>' and RUN <alias>
  if (info.kind === "portfolio") {
    const imp = /\bIMPORT\s+'([^']*)$/.exec(before);
    if (imp) {
      const q = imp[1]!.toLowerCase();
      const dir = selfPath?.includes("/") ? selfPath.slice(0, selfPath.lastIndexOf("/") + 1) : "";
      const rel = (p: string) => (dir && p.startsWith(dir) ? p.slice(dir.length) : p);
      const already = new Set(info.imports.map((i) => i.path));
      qktFiles.filter((f) => f !== selfPath && !already.has(rel(f))).forEach((f, i) => add({ label: rel(f), insert: `${rel(f)}' AS `, detail: f, kind: "symbol", sort: `0${String(i).padStart(3, "0")}` }));
      return out;
    }
    const run = /\bRUN\s+(\w*)$/.exec(before);
    if (run && !/OVERRIDE/.test(before)) {
      info.imports.forEach((m, i) => add({ label: m.alias, insert: m.alias, detail: m.path, kind: "alias", sort: `0${i}` }));
      return out;
    }
  }

  // alias.<field>
  const dot = /(?<![\w.])([A-Za-z_]\w*)\.(\w*)$/.exec(before);
  if (dot && dot[1] !== "POSITION" && aliases.includes(dot[1]!)) {
    const known = streamFields();
    const fields = [...FIELD_ORDER.filter((f) => known.includes(f)), ...known.filter((f) => !FIELD_ORDER.includes(f))];
    fields.forEach((f, i) => add({ label: f, insert: f, detail: `${dot[1]}.${f}`, doc: FIELD_DOC[f], kind: "field", sort: `0${String(i).padStart(2, "0")}` }));
    return out;
  }
  // POSITION.<alias>[.member]
  const pos = /\bPOSITION\.(\w*)$/.exec(before), posMember = /\bPOSITION\.(\w+)\.(\w*)$/.exec(before);
  if (posMember && aliases.includes(posMember[1]!)) { membersOf("POSITION").forEach((m, i) => add({ label: m, insert: m, detail: `POSITION.${posMember[1]}.${m}`, doc: POSITION_DOC[m], kind: "field", sort: `0${String(i).padStart(2, "0")}` })); return out; }
  if (pos) { aliases.forEach((a, i) => add({ label: a, insert: a, detail: `Position of ${a}`, kind: "alias", sort: `0${i}` })); return out; }

  // SYMBOLS:  alias = BROKER:SYMBOL EVERY tf
  if (section === "symbols") {
    if (/^\s+\w*$/.test(before)) { addSnippets([streamSnippet(scan)]); return out; }
    const every = /=\s*([A-Za-z0-9_]+):([A-Za-z0-9_.]+)\s+EVERY\s+(\w*)$/.exec(before);
    if (every) {
      const sym = scan?.symbols.find((s) => s.symbol === every[2]);
      const have = [...new Set((sym?.bars ?? []).filter((b) => b.files > 0 && b.broker === every[1] && !b.qktReads).map((b) => b.tf))];
      const tfs = [...have, ...TFS.filter((t) => !have.includes(t))];
      tfs.forEach((t, i) => add({ label: t, insert: t, detail: have.includes(t) ? "bars built in your data source" : "not built in your data source", kind: "timeframe", sort: `0${String(i).padStart(2, "0")}` }));
      return out;
    }
    const sy = /=\s*([A-Za-z0-9_]+):(\w*)$/.exec(before);
    if (sy) {
      for (const s of scan?.symbols ?? []) {
        const brokers = [...new Set(s.bars.filter((b) => b.files > 0).map((b) => b.broker))];
        if (!brokers.includes(sy[1]!) && !(brokers.length === 0 && sy[1] === "BACKTEST")) continue;
        const span = s.bars.find((b) => b.files > 0);
        add({ label: s.symbol, insert: s.symbol, detail: `${s.market} · ${span?.first ?? ""} → ${span?.last ?? ""} · ${s.status}`, kind: "symbol", sort: "0" });
      }
      return out;
    }
    if (/=\s*(\w*)$/.test(before)) {
      const brokers = new Set<string>(["BACKTEST"]);
      for (const s of scan?.symbols ?? []) for (const b of s.bars) if (b.files > 0) brokers.add(b.broker);
      [...brokers].forEach((b, i) => add({ label: `${b}:`, insert: `${b}:`, detail: "data source / venue", kind: "keyword", sort: `0${i}` }));
      return out;
    }
    return out;
  }

  // RULES
  const word = /(\w*)$/.exec(before)?.[1] ?? "";
  const stem = before.slice(0, before.length - word.length).trimEnd();
  const afterCondKeyword = /(^|\s)(WHEN|AND|OR|NOT)$/.test(stem) || /\b(CROSSES\s+(ABOVE|BELOW)|>=|<=|>|<|=|\+|-|\*|\/|\()$/.test(stem);
  const thenNow = /(^|\s)THEN$/.test(stem) || /;$/.test(stem);
  if (thenNow) {
    const actions = actionKeywords();
    actions.forEach((a, i) => add({ label: a, insert: a, detail: ACTION_DOC[a] ?? "", kind: "keyword", sort: `0${String(i).padStart(2, "0")}` }));
    addSnippets(orderSnippets(aliases), actions.length);
    return out;
  }
  if (section === "rules" && lineStart && info.kind === "strategy") {
    const prev = [...lines.slice(0, line - 1)].reverse().find((l) => l.trim() !== "") ?? "";
    const openWhen = /\bWHEN\b/.test(block) && !/\bTHEN\b/.test(block);
    if (openWhen) {
      [["THEN", "What to do when the condition holds"], ["AND", "Another condition that must also hold"], ["OR", "An alternative condition"]].forEach(([k, d], i) => add({ label: k!, insert: `${k} `, detail: d!, kind: "keyword", sort: `0${i}` }));
      return out;
    }
    if (/^RULES\b/.test(prev) || lines[line - 2]?.trim() === "") {
      add({ label: "WHEN", insert: "WHEN ", detail: "Start a rule", kind: "keyword", sort: "00" });
      addSnippets(ruleSnippets(aliases), 1);
      return out;
    }
  }
  const act = /\b(BUY|SELL|CLOSE|CANCEL)$/.exec(stem);
  if (act && act[1] !== "CLOSE") { aliases.forEach((a, i) => add({ label: a, insert: a, detail: `${a}: ${info.streams.find((s) => s.alias === a)?.symbol ?? ""}`, kind: "alias", sort: `0${i}` })); return out; }
  if (act) { aliases.forEach((a, i) => add({ label: a, insert: a, detail: `${act[1] === "CANCEL" ? "Cancel the pending orders of" : "Close"} ${a}`, kind: "alias", sort: `0${i}` })); return out; }
  if (/\b(BUY|SELL)\s+\w+$/.test(stem)) {
    add({ label: "SIZING", insert: "SIZING ", detail: "Order size", kind: "keyword", sort: "00" });
    return out;
  }
  if (/\bSIZING$/.test(stem)) {
    add({ label: "0.1", insert: "0.1", detail: "0.1 lots", kind: "snippet", sort: "00" });
    add({ label: "0.5 PCT RISK", insert: "0.5 PCT RISK", detail: "Size so a stop-out loses 0.5% of equity: needs a BRACKET with a STOP_LOSS", kind: "snippet", sort: "01" });
    add({ label: "1 PCT OF EQUITY", insert: "1 PCT OF EQUITY", detail: "1% of equity as position value", kind: "snippet", sort: "02" });
    return out;
  }
  if (/\bSIZING\s+[\w.]+(\s+(PCT|USD)\b.*)?$/.test(stem) && !/BRACKET/.test(block)) {
    add({ label: "BRACKET", insert: "BRACKET {\n    STOP_LOSS BY ${1:12},\n    TAKE_PROFIT BY ${2:24}\n}", detail: "Attach a stop and a target", kind: "snippet", sort: "00", snippet: true });
    return out;
  }
  if (/\bBRACKET\s*\{[^}]*$/.test(block) && !/\}\s*$/.test(before)) {
    add({ label: "STOP_LOSS BY", insert: "STOP_LOSS BY ", detail: "Stop at a distance in price units (or PCT)", kind: "keyword", sort: "00" });
    add({ label: "STOP_LOSS AT", insert: "STOP_LOSS AT ", detail: "Stop at an absolute price or expression", kind: "keyword", sort: "01" });
    add({ label: "TAKE_PROFIT BY", insert: "TAKE_PROFIT BY ", detail: "Target at a distance", kind: "keyword", sort: "02" });
    add({ label: "TAKE_PROFIT AT", insert: "TAKE_PROFIT AT ", detail: "Target at an absolute price or expression", kind: "keyword", sort: "03" });
    return out;
  }
  if (afterCondKeyword || (word && /^\s*(WHEN|AND)\b/.test(before))) {
    aliases.forEach((a, i) => add({ label: a, insert: a, detail: `${a}: ${info.streams.find((s) => s.alias === a)?.symbol ?? ""}`, kind: "alias", sort: `0${i}` }));
    add({ label: "POSITION", insert: "POSITION.", detail: "Your open position in a stream", kind: "keyword", sort: "05" });
    return out;
  }
  return out;
}

/** `exclusive`: the position calls for exactly these (a field, a symbol, an action...), so qkt's generic keyword dump is left out. */
export function localCompletions(text: string, line: number, col: number, scan: ScanReport | null, qktFiles: string[] = [], selfPath?: string): { items: LocalItem[]; exclusive: boolean } {
  const items = rawCompletions(text, line, col, scan, qktFiles, selfPath);
  return { items, exclusive: items.length > 0 && !items.some((i) => i.label === "POSITION") };
}
