import { scrub } from "./lint.js";

export interface StreamDecl {
  alias: string;
  /** Venue prefix as written (BACKTEST, MT5, EXNESS, ICMARKETS, HUB...). */
  broker: string;
  symbol: string;
  tf: string;
  warmupBars?: number;
}
export interface ParamDecl { name: string; default: string }
export interface ImportDecl { path: string; alias: string }

export interface StrategyInfo {
  kind: "strategy" | "portfolio" | "unknown";
  name?: string;
  streams: StreamDecl[];
  params: ParamDecl[];
  imports: ImportDecl[];
}

const STREAM = /^\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z0-9_]+):([A-Za-z0-9_.\-]+)\s+EVERY\s+(\d+[smhdw])(?:\s+WARMUP\s+(\d+)\s+BARS)?/;

/** Read the declarative headers of a .qkt file: what it trades, what it can be tuned by, what it imports. */
export function parseStrategyInfo(source: string): StrategyInfo {
  const info: StrategyInfo = { kind: "unknown", streams: [], params: [], imports: [] };
  let inSymbols = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = scrub(raw);
    if (info.kind === "unknown") {
      const h = /^(STRATEGY|PORTFOLIO)\s+(\w+)/.exec(line);
      if (h) { info.kind = h[1] === "STRATEGY" ? "strategy" : "portfolio"; info.name = h[2]; continue; }
    }
    if (/^SYMBOLS\b/.test(line)) { inSymbols = true; continue; }
    if (inSymbols) {
      if (line.trim() === "") continue;
      if (!/^\s/.test(line)) inSymbols = false;
      else {
        const m = STREAM.exec(line);
        if (m) info.streams.push({ alias: m[1]!, broker: m[2]!, symbol: m[3]!, tf: m[4]!, warmupBars: m[5] ? +m[5] : undefined });
        continue;
      }
    }
    const p = /^PARAM\s+(\w+)\s*=\s*(.*?)\s*$/.exec(line);
    if (p) { info.params.push({ name: p[1]!, default: p[2]! }); continue; }
    // IMPORT paths are quoted, and scrub() blanks string literals, so read this one from the raw line.
    const i = /^IMPORT\s+['"]([^'"]+)['"]\s+AS\s+(\w+)/.exec(raw);
    if (i) info.imports.push({ path: i[1]!, alias: i[2]! });
  }
  return info;
}

/** Streams may repeat across aliases; return each (broker, symbol, tf) once. */
export function uniqueStreams(streams: StreamDecl[]): StreamDecl[] {
  const seen = new Set<string>();
  return streams.filter((s) => { const k = `${s.broker}:${s.symbol}:${s.tf}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
