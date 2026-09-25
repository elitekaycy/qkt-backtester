import type { RunError } from "./runjson.js";

/**
 * qkt has no structured progress channel: it prints coverage lines, warnings, engine log lines (one per
 * order/fill) and, on failure, either `qkt: error: ...` or a raw Java stack trace. This module turns that
 * text into events and errors. Every pattern here is taken from real captures (test/fixtures).
 */

export type LineEvent =
  | { kind: "coverage"; source: "tick" | "bar"; symbol: string; covered: number; requested: number; tf?: string }
  | { kind: "fill"; orderId: string; strategy: string; symbol: string; side: "BUY" | "SELL"; qty: number; price: number }
  | { kind: "order"; symbol: string; side: "BUY" | "SELL" }
  | { kind: "strategyLog"; strategy: string; message: string }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string }
  | { kind: "incomplete"; message: string }
  | { kind: "log"; message: string };

// The em dash qkt prints after WARNING/error positions becomes '?' or U+FFFD in a non-UTF-8 container locale.
const DASH = "[\\u2014\\u2013?\\uFFFD-]+";

export function classifyLine(line: string): LineEvent {
  let m = /qkt: (tick|bar) coverage (\S+) (\d+)\/(\d+) trading days(?: \((\w+)\))?/.exec(line);
  if (m) return { kind: "coverage", source: m[1] as "tick" | "bar", symbol: m[2]!, covered: +m[3]!, requested: +m[4]!, tf: m[5] };

  m = /order filled order_id=(\S+) strategy_id=(\S+) symbol=(\S+) side=(BUY|SELL) qty=(\S+) price=(\S+)/.exec(line);
  if (m) return { kind: "fill", orderId: m[1]!, strategy: m[2]!, symbol: m[3]!, side: m[4] as "BUY" | "SELL", qty: +m[5]!, price: +m[6]! };

  m = /TradingPipeline - submit \w+ \S+ (\S+) (BUY|SELL)/.exec(line);
  if (m) return { kind: "order", symbol: m[1]!, side: m[2] as "BUY" | "SELL" };

  m = /\[[^\]]*\] \w+\s+\[[^\]]*\] com\.qkt\.dsl\.strategy\.(\S+) - (.*)$/.exec(line);
  if (m) return { kind: "strategyLog", strategy: m[1]!, message: m[2]! };

  if (/^qkt: WARNING/.test(line) || /\bWARNING\b/.test(line)) return { kind: "warning", message: line.replace(new RegExp(`^qkt: WARNING ${DASH}\\s*`), "").trim() };
  if (/incomplete (data|built bars) for/.test(line)) return { kind: "incomplete", message: line.trim() };
  if (/^qkt: error:/.test(line) || /^Exception in thread/.test(line)) return { kind: "error", message: line.replace(/^qkt: error:\s*/, "").trim() };
  return { kind: "log", message: line };
}

export interface HoleDay { day: string; status: "missing" | "incomplete"; emptyHours: number[] }

/** Parse the per-day list qkt prints under `incomplete data for <symbol>:`. */
export function parseIncomplete(text: string): HoleDay[] {
  const out: HoleDay[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\d{4}-\d{2}-\d{2})\s+(missing|incomplete)(?: \(empty hours ([\d,]+)\))?/.exec(line);
    if (m) out.push({ day: m[1]!, status: m[2] as "missing" | "incomplete", emptyHours: m[3] ? m[3].split(",").map(Number) : [] });
  }
  return out;
}

/** Days named in `missing 2024-10-01,2024-10-02,...` of a bars IncompleteDataException. */
export function parseMissingBarDays(text: string): string[] {
  const m = /missing (\d{4}-\d{2}-\d{2}(?:,\d{4}-\d{2}-\d{2})*)/.exec(text);
  return m ? m[1]!.split(",") : [];
}

/** The `Run: qkt data build-bars ...` remedy qkt embeds in bar-coverage failures, if any. */
export function parseBuildBarsHint(text: string): string | null {
  const m = /Run: (qkt data build-bars [^\n]*?)(?:\s*$|\n)/m.exec(text);
  return m ? m[1]!.trim() : null;
}

/** Turn qkt's failure text into one stable, UI-friendly error. */
export function normalizeError(stderr: string, exitCode: number | null): RunError {
  const text = stderr.replace(/\r/g, "");
  const parseRe = new RegExp(`^(.+?):(\\d+):(\\d+) ${DASH} (.*)$`, "m");
  const pm = parseRe.exec(text);
  if (pm) {
    const message = pm[4]!;
    const kind = /^Unknown indicator:/i.test(message) ? "unknown_indicator" : "parse";
    return { kind, message, file: pm[1], line: +pm[2]!, col: +pm[3]! };
  }
  const risk = /unknown risk key\(s\): (.*)/.exec(text);
  if (risk) return { kind: "bad_config_key", message: `Unknown risk key(s) in config: ${risk[1]!.trim()}` };

  if (/Exception in thread "main" (while parsing|while scanning|mapping values|found character)/.test(text) || /in reader, line \d+, column \d+/.test(text)) {
    const pos = /line (\d+), column (\d+)/.exec(text);
    const detail = text.split("\n").find((l) => /^(expected|could not|found|mapping values|did not find)/.test(l.trim()))?.trim();
    return { kind: "bad_config_yaml", message: `Config is not valid YAML${detail ? `: ${detail}` : ""}`, line: pos ? +pos[1]! : undefined, col: pos ? +pos[2]! : undefined };
  }

  const cov = /incomplete (?:built bars|data) for ([^\n:]+?)(?::| \(|\s)/.exec(text);
  const covLine = /(\d+)\/(\d+) trading days/.exec(text);
  if (/IncompleteDataException|incomplete (built bars|data) for/.test(text)) {
    const hint = parseBuildBarsHint(text);
    const covered = covLine ? +covLine[1]! : null;
    const kind = covered === 0 ? "missing_data" : "incomplete_data";
    return { kind, message: `${kind === "missing_data" ? "No data" : "Incomplete data"}${cov ? ` for ${cov[1]!.trim()}` : ""}${hint ? `. Fix: ${hint}` : ""}` };
  }
  const nomkt = /no market data for (\S+)/.exec(text);
  if (nomkt) return { kind: "missing_data", message: `No market data for ${nomkt[1]} in the requested range` };

  const nf = /qkt: error: file not found: (.*)/.exec(text);
  if (nf) return { kind: "file_not_found", message: `File not found: ${nf[1]!.trim()}`, file: nf[1]!.trim() };

  const generic = /qkt: error: (.*)/.exec(text);
  if (generic) return { kind: "engine_crash", message: generic[1]!.trim() };
  const ex = /Exception in thread "main" (.*)/.exec(text);
  if (ex) return { kind: "engine_crash", message: ex[1]!.trim().slice(0, 300) };
  return { kind: "engine_crash", message: `qkt exited with code ${exitCode ?? "?"}` };
}

/** End index (exclusive) of the JSON value starting at `start`, or -1. String- and escape-aware. */
function scanJson(s: string, start: number): number {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * `qkt sweep --json` prints its JSON document interleaved with thousands of engine log lines on stdout.
 * Find every line that starts a JSON object/array and decode it; log lines never start with { or [.
 */
export function extractJsonDocs(stdout: string): unknown[] {
  const docs: unknown[] = [];
  let i = 0;
  while (i < stdout.length) {
    const atLineStart = i === 0 || stdout[i - 1] === "\n";
    const c = stdout[i];
    if (atLineStart && (c === "{" || c === "[")) {
      const end = scanJson(stdout, i);
      if (end > 0) {
        try { docs.push(JSON.parse(stdout.slice(i, end))); i = end; continue; } catch { /* not JSON: keep scanning */ }
      }
    }
    const nl = stdout.indexOf("\n", i);
    if (nl < 0) break;
    i = nl + 1;
  }
  return docs;
}
