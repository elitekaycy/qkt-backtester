import { canonicalTf } from "./strategy.js";

export type RuleRef = number | string;
export type Change =
  | { op: "set_bracket"; rule?: RuleRef; stop?: string | number; target?: string | number }
  | { op: "set_param"; name: string; value: string | number | boolean }
  | { op: "set_sizing"; rule?: RuleRef; sizing: string }
  | { op: "add_condition"; rule?: RuleRef; expr: string; mode?: "and" | "or" }
  | { op: "remove_condition"; rule?: RuleRef; match: string }
  | { op: "exclude"; rule?: RuleRef; dates?: string[]; weekdays?: Array<string | number>; hours_utc?: number[]; calendar_window?: [number, number, number, number] }
  | { op: "add_rule"; source: string }
  | { op: "remove_rule"; match: string }
  | { op: "add_symbol"; alias: string; symbol: string; tf: string }
  | { op: "replace_text"; find: string; replace: string }
  | { op: "source"; text: string };

export class ChangeError extends Error {}

interface Rule { n: number; start: number; end: number; when: number; then: number; bracket: [number, number] | null; entry: boolean }
interface Seg { kind: "strategy" | "portfolio" | "unknown"; lines: string[]; rulesLine: number; rules: Rule[]; symbols: [number, number] | null; params: number[] }

const indentOf = (l: string) => /^\s*/.exec(l)![0];
const isTop = (l: string) => /^\S/.test(l) && !/^--/.test(l);
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function segment(src: string): Seg {
  const lines = src.split("\n");
  const first = lines.find((l) => l.trim() && !l.trim().startsWith("--")) ?? "";
  const kind = /^STRATEGY\b/.test(first) ? "strategy" : /^PORTFOLIO\b/.test(first) ? "portfolio" : "unknown";
  const rulesLine = lines.findIndex((l) => /^RULES\b/.test(l));
  const symLine = lines.findIndex((l) => /^SYMBOLS\b/.test(l));
  let symbols: [number, number] | null = null;
  if (symLine >= 0) { let e = symLine + 1; while (e < lines.length && !isTop(lines[e]!)) e++; symbols = [symLine, e]; }
  const params = lines.flatMap((l, i) => (/^PARAM\s/.test(l) ? [i] : []));
  const rules: Rule[] = [];
  if (rulesLine >= 0) {
    let regionEnd = rulesLine + 1;
    while (regionEnd < lines.length && !isTop(lines[regionEnd]!)) regionEnd++;
    const starts: number[] = [];
    for (let i = rulesLine + 1; i < regionEnd; i++) if (/^\s+WHEN\b/.test(lines[i]!)) starts.push(i);
    starts.forEach((s, k) => {
      let end = k + 1 < starts.length ? starts[k + 1]! : regionEnd;
      while (end > s && (!lines[end - 1]!.trim() || /^\s*--/.test(lines[end - 1]!))) end--;
      const then = lines.slice(s, end).findIndex((l) => /^\s+THEN\b/.test(l));
      const thenAt = then < 0 ? end : s + then;
      let bracket: [number, number] | null = null;
      for (let i = thenAt; i < end; i++) if (/\bBRACKET\b/.test(lines[i]!)) {
        let depth = 0, j = i;
        for (; j < end; j++) { for (const ch of lines[j]!) { if (ch === "{") depth++; else if (ch === "}") depth--; } if (depth <= 0 && lines[j]!.includes("}")) break; }
        bracket = [i, Math.min(j, end - 1) + 1]; break;
      }
      rules.push({ n: k + 1, start: s, end, when: s, then: thenAt, bracket, entry: /\b(BUY|SELL)\b/.test(lines.slice(thenAt, end).join("\n")) });
    });
  }
  return { kind, lines, rulesLine, rules, symbols, params };
}

export function describeRules(src: string): Array<{ n: number; entry: boolean; text: string }> {
  const g = segment(src);
  return g.rules.map((r) => ({ n: r.n, entry: r.entry, text: g.lines.slice(r.start, r.end).map((l) => l.trim()).join(" ").slice(0, 120) }));
}

function pick(g: Seg, ref: RuleRef | undefined, entryOnly: boolean): Rule[] {
  const list = () => g.rules.map((r) => `${r.n}: ${g.lines[r.when]!.trim().slice(0, 60)}`).join("; ");
  if (ref === undefined) {
    const rs = entryOnly ? g.rules.filter((r) => r.entry) : g.rules;
    if (!rs.length) throw new ChangeError(`no ${entryOnly ? "entry (BUY/SELL) " : ""}rules; rules: ${list()}`);
    return rs;
  }
  if (typeof ref === "number") { const r = g.rules.find((x) => x.n === ref); if (!r) throw new ChangeError(`no rule ${ref}; rules: ${list()}`); return [r]; }
  const rs = g.rules.filter((r) => norm(g.lines.slice(r.start, r.end).join(" ")).includes(norm(ref)));
  if (!rs.length) throw new ChangeError(`no rule matches "${ref}"; rules: ${list()}`);
  return rs;
}

function bracketSpec(v: string | number): string {
  if (typeof v === "number" && v > 0) return `BY ${v}`;
  const s = String(v).trim();
  const pct = /^(?:BY\s+)?(\d+(?:\.\d+)?)\s*(?:%|pct|percent)$/i.exec(s);
  if (pct) return `BY ${pct[1]} PCT`;
  const num = /^(?:BY\s+)?(\d+(?:\.\d+)?)$/i.exec(s);
  if (num) return `BY ${num[1]}`;
  if (/^AT\s+\S/i.test(s)) return `AT ${s.replace(/^AT\s+/i, "")}`;
  if (/^BY\s+\S/i.test(s)) return `BY ${s.replace(/^BY\s+/i, "")}`;
  throw new ChangeError(`cannot read the bracket level "${s}": use a distance (12), a percent ("2%"), "BY <expr>" or "AT <price expression>"`);
}

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function weekdayOf(w: string | number): number {
  if (typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 6) return w;
  const k = String(w).trim().toLowerCase().slice(0, 3), i = WEEKDAYS.indexOf(k);
  if (i < 0 || (String(w).length > 3 && !["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(String(w).trim().toLowerCase()))) throw new ChangeError(`"${w}" is not a weekday (use Monday..Sunday, or 0..6 with Monday = 0)`);
  return i;
}
function epochDay(d: string): number {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(d.trim());
  if (!m) throw new ChangeError(`"${d}" is not a date (use YYYY-MM-DD)`);
  const [y, mo, da] = [+m[1]!, +m[2]!, +m[3]!], t = Date.UTC(y, mo - 1, da), back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) throw new ChangeError(`"${d}" is not a real date`);
  return t / 86_400_000;
}

function addCondition(g: Seg, rules: Rule[], expr: string, mode: "and" | "or"): string[] {
  const lines = [...g.lines];
  for (const r of [...rules].sort((a, b) => b.then - a.then)) {
    const andLine = lines.slice(r.when + 1, r.then).find((l) => /^\s+(AND|OR)\b/.test(l));
    const ind = andLine ? indentOf(andLine) : `${indentOf(lines[r.when]!)} `;
    lines.splice(r.then, 0, `${ind}${mode === "or" ? "OR" : "AND"} ${expr.trim()}`);
  }
  return lines;
}

function apply1(src: string, c: Change, notes: string[]): string {
  const g = segment(src);
  if (c.op === "source") return c.text;
  if (g.kind === "portfolio") throw new ChangeError("change operations work on STRATEGY files; open the child strategy");
  if (c.op === "replace_text") {
    const n = src.split(c.find).length - 1;
    if (n !== 1) throw new ChangeError(n === 0 ? `"${c.find}" is not in the file` : `"${c.find}" is in ${n} places; give more of the surrounding text`);
    return src.replace(c.find, c.replace);
  }
  const lines = [...g.lines];
  switch (c.op) {
    case "set_bracket": {
      if (c.stop === undefined && c.target === undefined) throw new ChangeError("set_bracket needs stop or target");
      const stop = c.stop !== undefined ? bracketSpec(c.stop) : null, target = c.target !== undefined ? bracketSpec(c.target) : null;
      const done: string[] = [];
      for (const r of [...pick(g, c.rule, true)].sort((a, b) => b.start - a.start)) {
        if (r.bracket) {
          const [a, z] = r.bracket, text = lines.slice(a, z).join(" ");
          const inner = /\{([\s\S]*)\}/.exec(text)?.[1] ?? "";
          const parts = splitTop(inner).map((p) => p.replace(/\s+/g, " "));
          const set = (regex: RegExp, keyUnderscore: string, spec: string | null) => { if (!spec) return; const i = parts.findIndex((p) => regex.test(p)); if (i >= 0) parts[i] = `${keyUnderscore} ${spec}`; else parts.push(`${keyUnderscore} ${spec}`); };
          set(/^STOP[ _]LOSS\b/i, "STOP_LOSS", stop); set(/^TAKE[ _]PROFIT\b/i, "TAKE_PROFIT", target);
          lines.splice(a, z - a, `${indentOf(lines[a]!)}BRACKET { ${parts.join(", ")} }`);
          done.unshift(`rule ${r.n}`);
        } else {
          const parts = [stop && `STOP_LOSS ${stop}`, target && `TAKE_PROFIT ${target}`].filter(Boolean);
          lines.splice(r.end, 0, `${indentOf(lines[r.then]!)}    BRACKET { ${parts.join(", ")} }`);
          done.unshift(`rule ${r.n} (added a BRACKET)`);
        }
      }
      notes.push(`set_bracket: ${done.join(", ")}`);
      return lines.join("\n");
    }
    case "set_param": {
      if (!/^[A-Za-z_]\w*$/.test(c.name)) throw new ChangeError(`"${c.name}" is not a parameter name`);
      const v = typeof c.value === "string" && !/^-?\d+(\.\d+)?$/.test(c.value) && !/^(true|false)$/.test(c.value) ? `"${c.value.replace(/"/g, "")}"` : String(c.value);
      const at = lines.findIndex((l) => new RegExp(`^PARAM\\s+${c.name}\\s*=`).test(l));
      if (at >= 0) { lines[at] = `PARAM ${c.name} = ${v}`; notes.push(`set_param: ${c.name} = ${v}`); return lines.join("\n"); }
      const after = g.params.length ? g.params[g.params.length - 1]! + 1 : g.rulesLine;
      if (after < 0) throw new ChangeError("no RULES section to put a PARAM before");
      lines.splice(after, 0, ...(g.params.length ? [`PARAM ${c.name} = ${v}`] : [`PARAM ${c.name} = ${v}`, ""]));
      notes.push(`set_param: added ${c.name} = ${v}`);
      return lines.join("\n");
    }
    case "set_sizing": {
      const sizing = c.sizing.replace(/^\s*SIZING\s+/i, "").trim();
      if (!sizing) throw new ChangeError("set_sizing needs a sizing, e.g. 0.1 or \"0.5 PCT RISK\"");
      const rs = pick(g, c.rule, true);
      for (const r of rs) for (let i = r.then; i < r.end; i++) lines[i] = lines[i]!.replace(/\bSIZING\s+.*?(?=\s+BRACKET\b|\s*;|\s*$)/, `SIZING ${sizing}`);
      notes.push(`set_sizing: rules ${rs.map((r) => r.n).join(", ")}`);
      return lines.join("\n");
    }
    case "add_condition": {
      if (!c.expr.trim()) throw new ChangeError("add_condition needs an expression");
      const rs = pick(g, c.rule, true);
      notes.push(`add_condition: rules ${rs.map((r) => r.n).join(", ")}`);
      return addCondition(g, rs, c.expr, c.mode ?? "and").join("\n");
    }
    case "remove_condition": {
      const rs = pick(g, c.rule, false);
      for (const r of [...rs].sort((a, b) => b.start - a.start)) {
        const at = lines.slice(r.when, r.then).findIndex((l) => norm(l).includes(norm(c.match)));
        if (at < 0) throw new ChangeError(`rule ${r.n} has no condition matching "${c.match}"`);
        const i = r.when + at;
        if (i === r.when) {
          if (r.then - r.when < 2) throw new ChangeError(`rule ${r.n} needs a condition: this is its only one`);
          lines[i + 1] = lines[i + 1]!.replace(/^(\s*)(AND|OR)\b/, `${indentOf(lines[i]!)}WHEN`);
        }
        lines.splice(i, 1);
      }
      notes.push(`remove_condition: rules ${rs.map((r) => r.n).join(", ")}`);
      return lines.join("\n");
    }
    case "exclude": {
      const exprs: string[] = [];
      if (c.dates?.length) exprs.push(`NOT (NOW.date_utc IN [${c.dates.map(epochDay).join(", ")}])`);
      if (c.weekdays?.length) exprs.push(`NOT (NOW.weekday IN [${[...new Set(c.weekdays.map(weekdayOf))].sort().join(", ")}])`);
      if (c.hours_utc?.length) {
        for (const h of c.hours_utc) if (!Number.isInteger(h) || h < 0 || h > 23) throw new ChangeError(`${h} is not an hour (0-23 UTC)`);
        exprs.push(`NOT (NOW.hour_utc IN [${[...new Set(c.hours_utc)].sort((a, b) => a - b).join(", ")}])`);
      }
      if (c.calendar_window) exprs.push(`NOT CALENDAR_WINDOW(${c.calendar_window.join(", ")})`);
      if (!exprs.length) throw new ChangeError("exclude needs dates, weekdays, hours_utc or calendar_window");
      let cur = src;
      for (const e of exprs) { const gg = segment(cur); cur = addCondition(gg, pick(gg, c.rule, true), e, "and").join("\n"); }
      notes.push(`exclude: ${exprs.join(" AND ")} on entry rules (exits still happen on those days)`);
      return cur;
    }
    case "add_rule": {
      const body = c.source.replace(/\s+$/, "").split("\n");
      if (!/^\s*WHEN\b/.test(body[0] ?? "")) throw new ChangeError("a rule starts with WHEN");
      if (g.rulesLine < 0) throw new ChangeError("no RULES section");
      const minInd = Math.min(...body.filter((l) => l.trim()).map((l) => indentOf(l).length));
      const ind = g.rules.length ? indentOf(lines[g.rules[0]!.when]!) : "    ";
      const shaped = body.map((l) => (l.trim() ? ind + l.slice(minInd) : ""));
      const at = g.rules.length ? g.rules[g.rules.length - 1]!.end : g.rulesLine + 1;
      lines.splice(at, 0, "", ...shaped.map((l, i) => (i > 0 && /^\s*(AND|OR)\b/.test(l) ? ` ${l}` : l)));
      notes.push(`add_rule: rule ${g.rules.length + 1}`);
      return lines.join("\n");
    }
    case "remove_rule": {
      const rs = g.rules.filter((r) => norm(lines.slice(r.start, r.end).join(" ")).includes(norm(c.match)));
      if (rs.length !== 1) throw new ChangeError(rs.length ? `${rs.length} rules match "${c.match}": give text only one of them has` : `no rule matches "${c.match}"`);
      const r = rs[0]!, blankBefore = r.start > 0 && !lines[r.start - 1]!.trim() ? 1 : 0;
      lines.splice(r.start - blankBefore, r.end - r.start + blankBefore);
      notes.push(`remove_rule: rule ${r.n}`);
      return lines.join("\n");
    }
    case "add_symbol": {
      if (!/^[A-Za-z_]\w*$/.test(c.alias)) throw new ChangeError(`"${c.alias}" is not an alias name`);
      if (!g.symbols) throw new ChangeError("no SYMBOLS section");
      const [a, z] = g.symbols;
      if (lines.slice(a + 1, z).some((l) => new RegExp(`^\\s+${c.alias}\\s*=`).test(l))) throw new ChangeError(`alias "${c.alias}" is already declared`);
      const tf = canonicalTf(c.tf);
      if (!tf) throw new ChangeError(`"${c.tf}" is not a timeframe (1m 5m 15m 30m 1h 4h 1d)`);
      const sym = c.symbol.includes(":") ? c.symbol : `BACKTEST:${c.symbol}`;
      let last = z - 1; while (last > a && !lines[last]!.trim()) last--;
      lines.splice(last + 1, 0, `    ${c.alias} = ${sym} EVERY ${tf}`);
      notes.push(`add_symbol: ${c.alias} = ${sym} EVERY ${tf}`);
      return lines.join("\n");
    }
  }
}

/** Apply operations in order. Atomic: any error throws ChangeError and the caller keeps the original text. */
export function applyChanges(source: string, changes: Change[]): { source: string; notes: string[] } {
  const notes: string[] = [];
  let cur = source;
  for (const c of changes) cur = apply1(cur, c, notes);
  return { source: cur, notes };
}

/** What changed, block by block: `@@ line N` (N = first changed line of the original), removed lines, then added lines. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n"), n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));   // LCS table; strategy files are small
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let out = "", i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    const at = i + 1, del: string[] = [], add: string[] = [];
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) add.push(b[j++]!); else del.push(a[i++]!);
    }
    out += `@@ line ${at}\n${del.map((l) => `-${l}\n`).join("")}${add.map((l) => `+${l}\n`).join("")}`;
  }
  return out;
}
