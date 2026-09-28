/**
 * qkt's `rejections.csv`: orders the engine refused (risk caps, halts). Without them a run that rejected every order reads as
 * "no trades", which sends the user to their rule conditions instead of their config.
 */
export interface RejectionReason {
  /** Stable id for the known reasons; "other" for anything else. */
  kind: "notional-cap" | "qty-cap" | "daily-loss-halt" | "drawdown-halt" | "other";
  /** The reason with its numbers taken out, e.g. "order notional exceeds cap". */
  label: string;
  count: number;
  /** One reason exactly as qkt wrote it. */
  example: string;
  /** What to change, when the reason is a known one. */
  hint?: string;
}
export interface RejectionSummary { count: number; reasons: RejectionReason[] }

const KNOWN: Array<{ re: RegExp; kind: RejectionReason["kind"]; hint: string }> = [
  { re: /order notional .* exceeds cap/i, kind: "notional-cap",
    hint: "Each order's value (size × price × contract size) is above risk.max_order_notional (250,000 unless set). Trade a smaller size, or set risk.max_order_notional in qkt.config.yaml." },
  { re: /order qty .* exceeds|quantity .* exceeds cap/i, kind: "qty-cap",
    hint: "The order size is above risk.max_order_qty. Trade a smaller size, or raise risk.max_order_qty in qkt.config.yaml." },
  { re: /halted: daily loss/i, kind: "daily-loss-halt",
    hint: "The daily loss limit (risk.max_daily_loss) was hit, so qkt stopped trading for the rest of that day. Raise it, or set it to \"0\" in qkt.config.yaml if that is not what you want." },
  { re: /halted: .*drawdown/i, kind: "drawdown-halt",
    hint: "A drawdown limit (risk.max_drawdown_pct / max_daily_drawdown_pct) was hit, so qkt stopped trading. Raise it in qkt.config.yaml if that is not what you want." },
];

/** Split one CSV line, honouring double quotes (a reason can contain commas). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Group the rejections by reason, most frequent first. `text` is the file's contents (header line included). */
export function summarizeRejections(text: string): RejectionSummary {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length <= 1) return { count: 0, reasons: [] };
  const head = cells(lines[0]!), ri = head.indexOf("reason");
  const by = new Map<string, RejectionReason>();
  for (const line of lines.slice(1)) {
    const reason = (cells(line)[ri < 0 ? 1 : ri] ?? "").trim();
    const known = KNOWN.find((k) => k.re.test(reason));
    const label = reason.replace(/\s*\(.*\)\s*$/, "").replace(/-?\d+(\.\d+)?/g, "").replace(/\s+/g, " ").trim();
    const key = known?.kind ?? label;
    const cur = by.get(key);
    if (cur) cur.count++;
    else by.set(key, { kind: known?.kind ?? "other", label, count: 1, example: reason, ...(known ? { hint: known.hint } : {}) });
  }
  const reasons = [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { count: lines.length - 1, reasons };
}
