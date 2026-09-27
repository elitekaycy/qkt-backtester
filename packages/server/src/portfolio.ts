import { promises as fs } from "node:fs";
import path from "node:path";
import { parseStrategyInfo, uniqueStreams, type StreamDecl } from "@qkt-studio/core";
import { JailError, resolveInJail, toRel } from "./jail.js";

/** One child of a portfolio, as written in its IMPORT line. */
export interface Member {
  alias: string;
  /** Path as written in the IMPORT. */
  path: string;
  /** Workspace-relative path, or null when it escapes the workspace. */
  rel: string | null;
  hold: boolean;
  exists: boolean;
  /** Streams the member declares (its own SYMBOLS plus anything it imports). */
  streams: StreamDecl[];
  error?: string;
}

export interface ResolvedStrategy {
  rel: string;
  kind: "strategy" | "portfolio" | "unknown";
  name?: string;
  /** Every stream the file reads, its children's included, each once. */
  streams: StreamDecl[];
  /** Direct children (empty for a plain strategy). */
  members: Member[];
}

/**
 * A strategy file with its imports followed (transitively, inside the workspace jail), like the runner does before a run.
 * A missing or escaping import is reported on the member instead of throwing, so a half-written portfolio still lists.
 */
export async function resolveStrategy(workspace: string, rel: string, seen = new Set<string>()): Promise<ResolvedStrategy> {
  const ws = await fs.realpath(workspace);
  let abs: string;
  try { abs = await resolveInJail(ws, rel); } catch { return { rel, kind: "unknown", streams: [], members: [] }; }
  const text = await fs.readFile(abs, "utf8").catch(() => null);
  if (text === null) return { rel, kind: "unknown", streams: [], members: [] };
  const info = parseStrategyInfo(text);
  const streams: StreamDecl[] = [...info.streams];
  const members: Member[] = [];
  seen.add(abs);
  for (const imp of info.imports) {
    const m: Member = { alias: imp.alias, path: imp.path, rel: null, hold: imp.hold === true, exists: false, streams: [] };
    try {
      const child = await resolveInJail(ws, path.relative(ws, path.resolve(path.dirname(abs), imp.path)));
      m.rel = toRel(ws, child);
      if (await fs.stat(child).then((s) => s.isFile(), () => false)) {
        m.exists = true;
        if (!seen.has(child)) { const r = await resolveStrategy(ws, m.rel, seen); m.streams = r.streams; streams.push(...r.streams); }
      }
    } catch (e) { m.error = e instanceof JailError ? "the import escapes the workspace" : (e as Error).message; }
    members.push(m);
  }
  return { rel, kind: info.kind, name: info.name, streams: uniqueStreams(streams), members };
}

export interface PortfolioListing {
  path: string; name?: string; members: Member[];
}

/** Whether a file is a PORTFOLIO, by mtime: sniffed once per edit so a big workspace costs a stat per file. */
const sniffed = new Map<string, { sig: string; portfolio: boolean }>();

/**
 * Every PORTFOLIO file among `files` with its members (resolved fresh: a child appearing or vanishing shows at once),
 * plus which portfolios use each strategy file.
 */
export async function listPortfolios(workspace: string, files: string[]): Promise<{ portfolios: PortfolioListing[]; usedIn: Record<string, string[]> }> {
  const portfolios: PortfolioListing[] = [];
  for (const rel of files) {
    const abs = path.join(workspace, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) continue;
    const sig = `${st.mtimeMs}:${st.size}`;
    let hit = sniffed.get(abs);
    if (!hit || hit.sig !== sig) {
      const head = (await fs.readFile(abs, "utf8").catch(() => "")).slice(0, 4000);
      hit = { sig, portfolio: /^\s*PORTFOLIO\s+\w+/m.test(head.replace(/--.*$/gm, "")) };
      sniffed.set(abs, hit);
    }
    if (!hit.portfolio) continue;
    const r = await resolveStrategy(workspace, rel);
    if (r.kind === "portfolio") portfolios.push({ path: rel, name: r.name, members: r.members });
  }
  const usedIn: Record<string, string[]> = {};
  for (const p of portfolios) for (const m of p.members) if (m.rel) (usedIn[m.rel] ??= []).push(p.path);
  return { portfolios, usedIn };
}
