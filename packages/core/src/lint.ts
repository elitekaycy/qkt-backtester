import { LineCounter, parseDocument, isMap, isScalar } from "yaml";
import { priceScaleIndicators, streamFieldSet, type QktVocabulary } from "./vocabulary.js";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  /** 1-based, like qkt's own parse errors. */
  line: number;
  col: number;
  endCol: number;
}
export interface Range { line: number; col: number; endCol: number }

/** Blank out string literals and comments (`--`, `#`, and a block comment within the line) while preserving column positions. */
export function scrub(line: string): string {
  let out = "", i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      out += " ".repeat(Math.min(j + 1, line.length) - i);
      i = Math.min(j + 1, line.length);
    } else if ((c === "-" && line[i + 1] === "-") || c === "#") {
      out += " ".repeat(line.length - i);
      break;
    } else if (c === "/" && line[i + 1] === "*") {
      const j = line.indexOf("*/", i + 2);
      const end = j < 0 ? line.length : j + 2;
      out += " ".repeat(end - i);
      i = end;
    } else { out += c; i++; }
  }
  return out;
}

function declaredAliases(lines: string[]): Set<string> {
  const aliases = new Set<string>();
  let inSymbols = false;
  for (const raw of lines) {
    const l = scrub(raw);
    if (/^SYMBOLS\b/.test(l)) { inSymbols = true; continue; }
    if (inSymbols) {
      if (l.trim() === "") continue;
      if (!/^\s/.test(l)) { inSymbols = false; continue; } // next top-level section
      const m = /^\s+([A-Za-z_]\w*)\s*=/.exec(l);
      if (m) aliases.add(m[1]!);
    }
  }
  return aliases;
}

/**
 * Stream aliases against the file's own SYMBOLS, with no JVM: every undeclared alias (qkt stops at the first), naming the
 * aliases that ARE declared; POSITION.<not an alias>; and a CROSSES between two symbols' prices. The stream fields and
 * price-scale indicators are the vocabulary's, never a list of the studio's own.
 */
export function lintAliases(source: string, vocab: QktVocabulary): Diagnostic[] {
  const lines = source.split(/\r?\n/);
  if (!lines.some((l) => /^STRATEGY\b/.test(scrub(l)))) return [];
  const fields = streamFieldSet(vocab), averages = [...priceScaleIndicators(vocab)];
  // `alias.close`, possibly inside a price-scale moving average: `ema(alias.close, n)`
  const priceRef = new RegExp(`^${averages.length ? `(?:(?:${averages.join("|")})\\s*\\(\\s*)?` : ""}([a-z_]\\w*)\\.(open|high|low|close)\\b`);
  const aliases = declaredAliases(lines);
  // alias -> bare symbol, from "alias = BROKER:SYMBOL EVERY tf"
  const symbols = new Map<string, string>();
  for (const raw of lines) { const m = /^\s+([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_.\-]+)\s+EVERY\b/.exec(scrub(raw)); if (m) symbols.set(m[1]!, m[2]!); }
  const out: Diagnostic[] = [];
  lines.forEach((raw, idx) => {
    const l = scrub(raw);
    const stream = /(?<![\w.])([a-z_]\w*)\.([a-z_]\w*)/g;
    for (let m = stream.exec(l); m; m = stream.exec(l)) {
      if (aliases.has(m[1]!) || !fields.has(m[2]!)) continue;
      out.push({
        severity: "error", code: "unknown_alias", line: idx + 1, col: m.index + 1, endCol: m.index + 1 + m[1]!.length,
        message: `Unknown stream alias '${m[1]}'. Declared in SYMBOLS: ${[...aliases].join(", ") || "(none)"}.`,
      });
    }
    // CROSSES between the prices of two different symbols (gold near 4,400 and a pair near 0.6) can never happen: the
    // rule is silently dead. Only raw prices and price-scale moving averages count; RSI and the like share a 0-100 scale.
    const cross = /^(.*?)\bCROSSES\s+(?:ABOVE|BELOW)\b(.*?)(?:\bAND\b|\bOR\b|$)/.exec(l);
    if (cross) {
      const priceOf = (side: string) => {
        const m = priceRef.exec(side.replace(/^\s*(WHEN|AND|OR)\b/, "").trim());
        return m && aliases.has(m[1]!) ? m[1]! : null;
      };
      const a = priceOf(cross[1]!), b = priceOf(cross[2]!);
      const sa = a ? symbols.get(a) : undefined, sb = b ? symbols.get(b) : undefined;
      if (a && b && sa && sb && sa !== sb) {
        const col = l.indexOf("CROSSES") + 1;
        out.push({ severity: "warning", code: "cross_scales", line: idx + 1, col, endCol: col + "CROSSES".length,
          message: `This compares ${sa} prices ('${a}') with ${sb} prices ('${b}'). Different symbols trade on different price scales, so one line may never cross the other and the rule would never fire. Compare each symbol with itself, or use a scale-free measure (RSI, % change).` });
      }
    }
    const pos = /\bPOSITION\.([a-z_]\w*)/g;
    for (let m = pos.exec(l); m; m = pos.exec(l)) {
      if (aliases.has(m[1]!)) continue;
      const col = m.index + "POSITION.".length + 1;
      out.push({ severity: "warning", code: "unknown_alias", line: idx + 1, col, endCol: col + m[1]!.length, message: `POSITION.${m[1]}: '${m[1]}' is not a declared stream alias` });
    }
  });
  return out;
}

/**
 * The one error qkt still reports at 1:1: a missing IMPORT, whose message is only the file's absolute path (`qkt parse`
 * and `qkt lsp` alike). Point at the IMPORT line that names it. Every other compile error carries its own position.
 */
export function locateImport(source: string, missingPath: string): Range | null {
  const base = missingPath.split("/").pop();
  if (!base) return null;
  const re = new RegExp(`\\b(IMPORT\\s+'[^']*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}')`);
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const mm = re.exec(scrub(lines[i]!));
    if (mm) { const col = mm.index + 1; return { line: i + 1, col, endCol: col + mm[1]!.length }; }
  }
  return null;
}

/**
 * qkt reports "expected X, got 'TOKEN'" at the token it stumbled on, which is usually the first token of the NEXT line
 * (e.g. `RULES`) while the mistake is an unfinished line above it. When the reported token starts a line, move the
 * marker to the end of the previous non-blank line and say so, so the squiggle sits where the user has to type.
 */
export function anchorParseError(source: string, d: { line: number; col: number; endCol: number; message: string }): { line: number; col: number; endCol: number; message: string } {
  if (!/^expected\b.*\bgot\b/i.test(d.message)) return d;
  const lines = source.split(/\r?\n/);
  const at = lines[d.line - 1];
  if (at === undefined || at.slice(0, Math.max(0, d.col - 1)).trim() !== "") return d; // the offending token does not start its line
  let j = d.line - 2;
  while (j >= 0 && scrub(lines[j]!).trim() === "") j--;
  if (j < 0) return d;
  const prev = lines[j]!.replace(/\s+$/, "");
  if (prev.length === 0) return d;
  const col = prev.length + 1;
  return { line: j + 1, col, endCol: col + 1, message: `${d.message} (unfinished line ${j + 1}, before line ${d.line})` };
}

const SECRET_KEY = /(api[_-]?key|secret|password|passwd|token|private[_-]?key|credential|auth)/i;

/** Hide secrets and env-expansions while keeping the file's structure, for the per-run config snapshot. */
export function redactConfig(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const m = /^(\s*(?:-\s+)?)([\w.-]+)(\s*:\s*)(.*)$/.exec(line);
      let out = line;
      if (m && SECRET_KEY.test(m[2]!)) {
        const val = m[4]!;
        const comment = /\s+#.*$/.exec(val)?.[0] ?? "";
        const core = val.replace(/\s+#.*$/, "");
        if (core.trim() !== "" && !/^[|>][-+]?$/.test(core.trim())) out = `${m[1]}${m[2]}${m[3]}***${comment}`;
      }
      return out.replace(/\$\{[^}]*\}/g, "${***}");
    })
    .join("\n");
}

export const KNOWN_CONFIG_KEYS = new Set([
  "source", "data_root", "starting_balance", "log_level", "runtime", "account", "fx_conversion", "execution", "promotion", "tv", "fetchers",
  "brokers", "risk", "state", "notify", "insights", "book_risk", "market_data", "hub", "bybit",
]);

export interface Finding { severity: "error" | "warning" | "info"; code: string; message: string; line?: number; col?: number }

export function checkConfig(yaml: string | null, fileExists: boolean, env: { QKT_DATA_HOME?: string }): Finding[] {
  const out: Finding[] = [];
  if (!fileExists || yaml === null) {
    out.push({ severity: "error", code: "missing_config", message: "qkt.config.yaml not found. qkt would silently run on built-in defaults, so the studio blocks the run." });
    return out;
  }
  const lc = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter: lc });
  for (const e of doc.errors) {
    const p = e.linePos?.[0];
    out.push({ severity: "error", code: "bad_config_yaml", message: e.message.split("\n")[0]!, line: p?.line, col: p?.col });
  }
  if (out.length) return out;
  const root = doc.contents;
  if (!isMap(root)) {
    if (yaml.trim() !== "") out.push({ severity: "error", code: "bad_config_yaml", message: "Config must be a YAML mapping (key: value pairs)" });
    return out;
  }
  for (const pair of root.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : null;
    if (key === null) continue;
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      const p = isScalar(pair.key) && pair.key.range ? lc.linePos(pair.key.range[0]) : undefined;
      out.push({ severity: "warning", code: "unknown_key", message: `Unknown top-level key '${key}'. qkt ignores it silently (only unknown 'risk' keys are rejected).`, line: p?.line, col: p?.col });
    }
  }
  const dr: unknown = root.get("data_root");
  const home = env.QKT_DATA_HOME;
  if (typeof dr === "string" && home && dr.replace(/\/+$/, "") !== home.replace(/\/+$/, "")) {
    out.push({ severity: "warning", code: "data_root_mismatch", message: `data_root is '${dr}' but bar data is read from QKT_DATA_HOME '${home}'. --bars ignores data_root [probed].` });
  }
  return out;
}

/** qkt's `${VAR}` / `${VAR:-default}` substitution, for the few values the studio reads itself. */
export function substitute(v: string, env: Record<string, string | undefined>): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => env[name] ?? def ?? "");
}

/**
 * `qkt backtest` ignores the config's `starting_balance` and uses its own default (probed: 10000 whatever the file says).
 * The studio reads the file's value, with `.env` substitution applied, and passes it as `--starting-balance`, so the
 * number in qkt.config.yaml is the number the run actually uses.
 */
export function configStartingBalance(configText: string, env: Record<string, string | undefined>): number | undefined {
  try {
    const doc = parseDocument(configText).toJS() as { starting_balance?: unknown } | null;
    const raw = doc?.starting_balance;
    if (raw === undefined || raw === null) return undefined;
    const n = Number(typeof raw === "string" ? substitute(raw, env) : raw);
    return Number.isFinite(n) && n > 0 && n <= 1e9 ? n : undefined;
  } catch { return undefined; }
}
