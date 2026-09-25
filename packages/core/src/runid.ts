import { createHash } from "node:crypto";

export type Tier = "draft" | "full";

export interface RunHashInput {
  /** path -> file text, for the strategy and everything it imports. */
  strategySources: Record<string, string>;
  /** Effective config file bytes (before redaction). Empty string when running on defaults. */
  config: string;
  params: Record<string, string>;
  /** Half-open window [from, to), ISO dates. */
  from: string;
  to: string;
  tier: Tier;
  engine: { version: string; gitSha?: string };
  /** Extra qkt flags that change results (e.g. --broker mt5-sim, --seed). */
  flags: string[];
  /** See dataFingerprint(). */
  dataFingerprint: string;
}

/** JSON with sorted keys at every depth, so key order can never change a hash. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

export function runHash(input: RunHashInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** Filesystem-safe strategy label: basename, no extension, no dots-only, bounded length. */
export function safeName(strategy: string): string {
  const base = strategy.split(/[\\/]/).pop() ?? "";
  const noExt = base.replace(/\.qkt$/i, "");
  const cleaned = noExt.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "").slice(0, 40);
  return cleaned || "run";
}

const pad = (x: number, n = 2) => String(x).padStart(n, "0");

/** `YYYYMMDDTHHMMSSZ_<strategy>_<hash8>`: sorts by time, human-readable, unique per input set. */
export function makeRunId(now: Date, strategy: string, hash: string): string {
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${ts}_${safeName(strategy)}_${hash.slice(0, 8)}`;
}

export const hashOfRunId = (id: string): string | null => /_([0-9a-f]{8})$/.exec(id)?.[1] ?? null;

/** Cheap change detector for the data a run reads: file path, size and mtime. New/edited data => new hash. */
export function dataFingerprint(files: Array<{ path: string; size: number; mtimeMs: number }>): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}|${f.size}|${Math.floor(f.mtimeMs)}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
