import { LineCounter, parseDocument, isMap, isScalar } from "yaml";
import { DERIVATIVE_FIELDS, fieldAllowed, fieldNotForKind, kindOf, type KindContext } from "./instruments.js";

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

// Mirrors ExprCompiler.CANDLE_FIELDS + META_FIELDS in qkt (a stream reference is `<alias>.<field>`).
export const STREAM_FIELDS = new Set([
  "close", "open", "high", "low", "volume", "price", "bid", "ask", "spread", "value", "timestamp",
  "tick_size", "contract_size", "volume_step", "volume_min", "swap_long_points", "swap_short_points", "multiplier", "tick_value",
  ...DERIVATIVE_FIELDS,
]);

/** Blank out string literals and `--` comments while preserving column positions. */
export function scrub(line: string): string {
  let out = "", i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      out += " ".repeat(Math.min(j + 1, line.length) - i);
      i = Math.min(j + 1, line.length);
    } else if (c === "-" && line[i + 1] === "-") {
      out += " ".repeat(line.length - i);
      break;
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
 * qkt runs a strategy that references an undeclared stream alias inside a rule condition WITHOUT any error
 * (it just never trades) [probed]. Catch it while the user types.
 */
export function lintAliases(source: string): Diagnostic[] {
  const lines = source.split(/\r?\n/);
  if (!lines.some((l) => /^STRATEGY\b/.test(scrub(l)))) return [];
  const aliases = declaredAliases(lines);
  // alias -> bare symbol, from "alias = BROKER:SYMBOL EVERY tf"
  const symbols = new Map<string, string>();
  for (const raw of lines) { const m = /^\s+([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_.@\-]+)\s+EVERY\b/.exec(scrub(raw)); if (m) symbols.set(m[1]!, m[2]!); }
  const out: Diagnostic[] = [];
  lines.forEach((raw, idx) => {
    const l = scrub(raw);
    const stream = /(?<![\w.])([a-z_]\w*)\.([a-z_]\w*)/g;
    for (let m = stream.exec(l); m; m = stream.exec(l)) {
      if (aliases.has(m[1]!) || !STREAM_FIELDS.has(m[2]!)) continue;
      out.push({
        severity: "error", code: "unknown_alias", line: idx + 1, col: m.index + 1, endCol: m.index + 1 + m[1]!.length,
        message: `Unknown stream alias '${m[1]}'. Declared in SYMBOLS: ${[...aliases].join(", ") || "(none)"}. qkt would run without error and never trade.`,
      });
    }
    // CROSSES between the prices of two different symbols (gold near 4,400 and a pair near 0.6) can never happen: the
    // rule is silently dead. Only raw prices and price-scale moving averages count; RSI and the like share a 0-100 scale.
    const cross = /^(.*?)\bCROSSES\s+(?:ABOVE|BELOW)\b(.*?)(?:\bAND\b|\bOR\b|$)/.exec(l);
    if (cross) {
      const priceOf = (side: string) => {
        const t = side.replace(/^\s*(WHEN|AND|OR)\b/, "").trim();
        const m = /^(?:(?:ema|sma|wma|hma|vwma|dema|tema|kama|smma|rma)\s*\(\s*)?([a-z_]\w*)\.(open|high|low|close)\b/.exec(t);
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
 * qkt parses `fx.dte` on a CFD (or `es.iv` on a future) and then runs without error: the field is undefined there, so the
 * rule never fires. The DSL is one language for every instrument, so the studio refuses a field the stream's kind does not
 * have. `ctx` says which symbols are futures or options (the server knows from the store and instruments.yaml); without it
 * only certain kinds are judged (BACKTEST/MT5 brokers are CFDs, `@front` is continuous, OPTIONS/CHAIN/HUB are what they say).
 */
export function lintFieldKinds(source: string, ctx: KindContext = {}): Diagnostic[] {
  const lines = source.split(/\r?\n/);
  const kinds = new Map<string, ReturnType<typeof kindOf>>();
  for (const raw of lines) {
    const m = /^\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z0-9_]+):([A-Za-z0-9_.@\-]+)\s+EVERY\b/.exec(scrub(raw));
    if (!m) continue;
    const k = kindOf({ broker: m[2]!, symbol: m[3]! }, ctx);
    // Without a catalog a bare symbol on an unknown broker could be a future: only judge what the prefix settles.
    const settled = k !== "cfd" || ctx.futureRoots !== undefined || ["BACKTEST", "EXNESS", "ICMARKETS", "FTMO", "PEPPERSTONE", "THE5ERS", "MT5"].includes(m[2]!.toUpperCase());
    if (settled) kinds.set(m[1]!, k);
  }
  const out: Diagnostic[] = [];
  lines.forEach((raw, idx) => {
    const l = scrub(raw);
    if (/^\s+[A-Za-z_]\w*\s*=\s*[A-Za-z0-9_]+:/.test(l) && /\bEVERY\b/.test(l)) return;
    const use = /(?<![\w.])([A-Za-z_]\w*)\.([a-z_]\w*)/g;
    for (let m = use.exec(l); m; m = use.exec(l)) {
      const kind = kinds.get(m[1]!);
      if (!kind || !STREAM_FIELDS.has(m[2]!) || fieldAllowed(kind, m[2]!)) continue;
      const col = m.index + m[1]!.length + 2;
      out.push({ severity: "error", code: "field_not_for_kind", line: idx + 1, col, endCol: col + m[2]!.length, message: fieldNotForKind(m[1]!, kind, m[2]!) });
    }
  });
  return out;
}

/** qkt reports some semantic errors at 1:1. Find the identifier in the source and return its real range. */
export function relocate(source: string, message: string): Range | null {
  const lines = source.split(/\r?\n/);
  let re: RegExp | null = null;
  let m = /^Unknown indicator:\s*(\w+)/i.exec(message);
  if (m) re = new RegExp(`(?<![\\w.])(${m[1]})\\s*\\(`);
  else if ((m = /^Unknown stream alias:\s*(\w+)/i.exec(message))) re = new RegExp(`(?<![\\w.])(${m[1]})(?=\\.|\\b)`);
  else if ((m = /^Unknown (?:function|constant):\s*(\w+)/i.exec(message))) re = new RegExp(`(?<![\\w.])(${m[1]})\\b`);
  // qkt reports these without a position: point at the text they are about
  else if ((m = /^Unknown stream field for (\w+):\s*(\w+)/i.exec(message))) re = new RegExp(`(?<![\\w.])(${m[1]}\\.${m[2]})\\b`);
  else if ((m = /^Indicator (\w+) expects/i.exec(message))) re = new RegExp(`(?<![\\w.])(${m[1]})\\s*\\(`);
  else if (/SIZING RISK|PCT RISK/i.test(message)) re = /\b(SIZING\s+[\w.]+\s+PCT\s+RISK)\b/;
  else if (/BRACKET requires/i.test(message)) re = /\b(BRACKET)\b/;
  else if ((m = /(?:^|\/|Imported file not found: )([\w.-]+\.qkt)$/.exec(message))) re = new RegExp(`\\b(IMPORT\\s+'[^']*${m[1]!.replace(/\./g, "\\.")}')`);
  if (!re) return null;
  for (let i = 0; i < lines.length; i++) {
    const l = scrub(lines[i]!);
    if (/^\s*SYMBOLS\b/.test(l) || (/^\s+\w+\s*=\s*\S+:/.test(l) && !/WHEN|AND|THEN/.test(l))) continue;
    const mm = re.exec(l);
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
