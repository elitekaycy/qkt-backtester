import type { ScanReport } from "../api/types.js";

/**
 * The studio's snippets. qkt's language server offers its own set everywhere at once (a whole-file template in the middle
 * of RULES, LET inside RULES, `FOR EACH s IN a, b` without the brackets qkt requires), so those are dropped and these are
 * offered instead: only where the result is valid, built from the file's own aliases and the data source's symbols and
 * timeframes, and each one checked by `qkt parse` in snippets.test.ts.
 */
export interface Snippet { label: string; detail: string; body: string; filter?: string }

const choice = (xs: string[]) => (xs.length > 1 ? `|${xs.map((x) => x.replace(/[|,$}\\]/g, "")).join(",")}|` : `:${xs[0] ?? ""}`);

/** Symbols with readable bars in the data source, finest built timeframe first; a demo default when there is no scan. */
function dataChoices(scan: ScanReport | null): { brokers: string[]; symbols: string[]; tfs: string[] } {
  const bars = (scan?.symbols ?? []).flatMap((s) => s.bars.filter((b) => b.files > 0 && !b.qktReads).map((b) => ({ ...b, symbol: s.symbol })));
  const uniq = (xs: string[]) => [...new Set(xs)];
  const ms = (tf: string) => { const m = /^(\d+)([smhd])$/.exec(tf); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s"] : Infinity; };
  return {
    brokers: uniq(bars.map((b) => b.broker)).length ? uniq(bars.map((b) => b.broker)) : ["BACKTEST"],
    symbols: uniq(bars.map((b) => b.symbol)).length ? uniq(bars.map((b) => b.symbol)) : ["XAUUSD"],
    tfs: uniq(bars.map((b) => b.tf)).sort((a, b) => ms(a) - ms(b)).concat(["15m", "1h", "4h", "1d"]).filter((t, i, a) => a.indexOf(t) === i),
  };
}

const bracketed = (a: string, n: number) =>
  `\n    BRACKET {\n        STOP_LOSS BY \${${n}:2} * atr(${a}, 14),\n        TAKE_PROFIT BY \${${n + 1}:4} * atr(${a}, 14)\n    }`;

/** A new file: the header and everything a runnable strategy or portfolio needs. */
export function fileSnippets(scan: ScanReport | null): Snippet[] {
  const d = dataChoices(scan);
  return [
    { label: "strategy", detail: "A complete strategy: one stream, an EMA cross entry with a stop and a target, an exit", body:
      `STRATEGY \${1:my_strategy} VERSION 1\n\nSYMBOLS\n    \${2:px} = \${3${choice(d.brokers)}}:\${4${choice(d.symbols)}} EVERY \${5${choice(d.tfs)}}\n\n` +
      `RULES\n    WHEN ema(\${2:px}.close, \${6:9}) CROSSES ABOVE ema(\${2:px}.close, \${7:21})\n     AND POSITION.\${2:px} = 0\n    THEN BUY \${2:px} SIZING \${8:0.1}` +
      `\n        BRACKET {\n            STOP_LOSS BY \${9:2} * atr(\${2:px}, 14),\n            TAKE_PROFIT BY \${10:4} * atr(\${2:px}, 14)\n        }\n\n` +
      `    WHEN ema(\${2:px}.close, \${6:9}) CROSSES BELOW ema(\${2:px}.close, \${7:21})\n     AND POSITION.\${2:px} > 0\n    THEN CLOSE \${2:px}\n$0` },
    { label: "portfolio", detail: "Run several strategy files together as one book", body:
      `PORTFOLIO \${1:my_book} VERSION 1\n\nIMPORT '\${2:first.qkt}' AS \${3:first}\nIMPORT '\${4:second.qkt}' AS \${5:second}\n\nRULES\n    RUN \${3:first}\n    RUN \${5:second}\n$0` },
  ];
}

/** A line in SYMBOLS: one stream, from the data source. */
export function streamSnippet(scan: ScanReport | null): Snippet {
  const d = dataChoices(scan);
  return { label: "stream", detail: "alias = BROKER:SYMBOL EVERY timeframe, from your data source", body: `\${1:px} = \${2${choice(d.brokers)}}:\${3${choice(d.symbols)}} EVERY \${4${choice(d.tfs)}}` };
}

/** Between SYMBOLS and RULES. */
export function declSnippets(alias: string): Snippet[] {
  return [
    { label: "PARAM", detail: "A tunable number (grid search and portfolio OVERRIDE change it)", body: "PARAM ${1:length} = ${2:20}" },
    { label: "LET", detail: "A named expression, reused in the rules", body: `LET \${1:trend} = ema(${alias}.close, \${2:50})` },
  ];
}

/** The start of a new rule. */
export function ruleSnippets(aliases: string[]): Snippet[] {
  const a = aliases[0] ?? "px";
  const out: Snippet[] = [
    { label: "rule", detail: "WHEN … THEN BUY …", filter: "WHEN rule", body: `WHEN \${1:${a}.close > ${a}.open}\nTHEN BUY \${2:${a}} SIZING \${3:0.1}` },
    { label: "cross entry", detail: "EMA cross, flat only, with a stop and a target", filter: "WHEN cross entry", body:
      `WHEN ema(\${1:${a}}.close, \${2:9}) CROSSES ABOVE ema(\${1:${a}}.close, \${3:21})\n AND POSITION.\${1:${a}} = 0\nTHEN BUY \${1:${a}} SIZING \${4:0.1}` +
      `\n    BRACKET {\n        STOP_LOSS BY \${5:2} * atr(\${1:${a}}, 14),\n        TAKE_PROFIT BY \${6:4} * atr(\${1:${a}}, 14)\n    }` },
    { label: "exit", detail: "Close the position when the trend turns", filter: "WHEN exit", body:
      `WHEN ema(\${1:${a}}.close, \${2:9}) CROSSES BELOW ema(\${1:${a}}.close, \${3:21})\n AND POSITION.\${1:${a}} > 0\nTHEN CLOSE \${1:${a}}` },
    { label: "flatten daily", detail: "Close everything at a fixed UTC hour", filter: "WHEN flatten", body: "WHEN NOW.hour_utc = ${1:21} THEN FLATTEN" },
  ];
  if (aliases.length > 1) out.push({ label: "for each", detail: `The same rule for ${aliases.join(", ")}`, filter: "FOR EACH", body:
    `FOR EACH s IN [${aliases.join(", ")}] DO\n  WHEN \${1:s.close > s.open}\n   AND POSITION.s = 0\n  THEN BUY s SIZING \${2:0.1}` });
  return out;
}

/** Right after THEN: an order with its bracket. */
export function orderSnippets(aliases: string[]): Snippet[] {
  const a = aliases[0] ?? "px";
  return (["BUY", "SELL"] as const).map((side) => ({
    label: `${side} with bracket`, detail: `${side === "BUY" ? "Long" : "Short"} entry with a stop and a target`, filter: `${side} bracket`,
    body: `${side} \${1:${a}} SIZING \${2:0.1}${bracketed(`\${1:${a}}`, 3)}`
  }));
}

/** Expand a snippet with its defaults, as accepting it without typing would: for tests and previews. */
export function expandSnippet(body: string): string {
  const vals = new Map<string, string>();
  let t = body;
  for (let k = 0; k < 6; k++) {
    t = t.replace(/\$\{(\d+)\|([^,|}]*)[^}]*\|\}/g, (_m, n: string, v: string) => { if (!vals.has(n)) vals.set(n, v); return v; });
    t = t.replace(/\$\{(\d+):([^${}]*)\}/g, (_m, n: string, v: string) => { if (!vals.has(n)) vals.set(n, v); return v; });
  }
  return t.replace(/\$(\d+)/g, (_m, n: string) => vals.get(n) ?? "");
}
