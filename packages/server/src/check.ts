import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintAliases, locateImport, normalizeError, type Diagnostic } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { execQkt } from "./proc.js";
import { rememberParsed } from "./parse-cache.js";
import { resolveInJail } from "./jail.js";
import { qktLanguage } from "./qkt-lang.js";
import { fieldKindErrors, kindContextFor } from "./kind-gate.js";

/** The identifier under `col` on `line` (1-based), so a position from qkt becomes a range the editor can underline. */
function wordEnd(content: string, line: number, col: number): number {
  const text = content.split(/\r?\n/)[line - 1] ?? "";
  const m = /^\w+/.exec(text.slice(col - 1));
  return col + Math.max(1, m?.[0].length ?? 0);
}

/**
 * `qkt parse` plus the studio's lint on a source string, checked as a hidden sibling of `rel` (so relative IMPORTs
 * resolve as in a run), or in /tmp. Shared by the editor's live check and every tool that writes or runs DSL.
 * qkt reports every compile error at its own position; the studio adds the range and points a missing IMPORT (the one
 * error qkt still reports at 1:1) at its line.
 */
export async function checkQktSource(cfg: ServerConfig, content: string, rel?: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  const name = `.qkt-check-${randomBytes(6).toString("hex")}.qkt`;
  const dir = typeof rel === "string" && rel.endsWith(".qkt") ? await resolveInJail(cfg.workspace, rel).then((abs) => path.dirname(abs), () => null) : null;
  let tmp = dir ? path.join(dir, name) : path.join(os.tmpdir(), name);
  const { vocabulary } = await qktLanguage(cfg.qktBin);
  try {
    try { await fs.writeFile(tmp, content, { flag: "wx" }); }
    catch { tmp = path.join(os.tmpdir(), name); await fs.writeFile(tmp, content, { flag: "wx" }); }
    const r = await execQkt(cfg.qktBin, ["parse", tmp], { cwd: cfg.workspace, timeoutMs: 20_000 });
    const diagnostics: Diagnostic[] = [];
    let flaggedLine: number | null = null;
    if (r.code !== 0) {
      const err = normalizeError(r.stderr || r.stdout, r.code);
      let { line = 1, col = 1 } = err;
      let endCol = wordEnd(content, line, col);
      if (err.kind === "file_not_found" && err.file) {
        err.message = `Imported file not found: ${path.relative(cfg.workspace, err.file).split(path.sep).join("/") || err.file}`;
        const at = locateImport(content, err.file);
        if (at) ({ line, col, endCol } = at);
      }
      flaggedLine = line;
      diagnostics.push({ severity: "error", code: err.kind, message: err.message, line, col, endCol });
    }
    if (r.code === 0) rememberParsed(content);
    // qkt stops at its first error; the lint reports every undeclared alias, but not the one qkt already named on that line
    diagnostics.push(...lintAliases(content, vocabulary).filter((d) => !(d.code === "unknown_alias" && d.line === flaggedLine)));
    // qkt accepts a derivatives field on a CFD stream and then never trades (kind-gate.ts)
    diagnostics.push(...fieldKindErrors(content, await kindContextFor(cfg.dataRoot), vocabulary));
    return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * At most MAX_CHECKS `qkt parse` processes at once, shared by the editor's live check (POST /api/check, which answers 429
 * when full) and every tool or variant check (which waits its turn instead).
 */
export const MAX_CHECKS = 3;
class CheckSlots {
  private inflight = 0;
  private waiting: Array<() => void> = [];
  get busy(): number { return this.inflight; }
  /** Run now if a slot is free, else null. */
  tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
    if (this.inflight >= MAX_CHECKS) return null;
    return this.hold(fn);
  }
  /** Run as soon as a slot frees up. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inflight >= MAX_CHECKS) await new Promise<void>((r) => this.waiting.push(r));
    return this.hold(fn);
  }
  private async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight++;
    try { return await fn(); }
    finally { this.inflight--; this.waiting.shift()?.(); }
  }
}
export const checkSlots = new CheckSlots();
/** checkQktSource through the shared limit, waiting for a slot: for tools and variants. */
export const checkQueued = (cfg: ServerConfig, content: string, rel?: string) => checkSlots.run(() => checkQktSource(cfg, content, rel));
