import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintAliases, normalizeError, relocate, type Diagnostic } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { execQkt } from "./proc.js";
import { rememberParsed } from "./parse-cache.js";
import { resolveInJail } from "./jail.js";

/**
 * `qkt parse` plus the studio's lint on a source string, checked as a hidden sibling of `rel` (so relative IMPORTs
 * resolve as in a run), or in /tmp. Shared by the editor's live check and every tool that writes or runs DSL.
 */
export async function checkQktSource(cfg: ServerConfig, content: string, rel?: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  const name = `.qkt-check-${randomBytes(6).toString("hex")}.qkt`;
  const dir = typeof rel === "string" && rel.endsWith(".qkt") ? await resolveInJail(cfg.workspace, rel).then((abs) => path.dirname(abs), () => null) : null;
  let tmp = dir ? path.join(dir, name) : path.join(os.tmpdir(), name);
  try {
    try { await fs.writeFile(tmp, content, { flag: "wx" }); }
    catch { tmp = path.join(os.tmpdir(), name); await fs.writeFile(tmp, content, { flag: "wx" }); }
    const r = await execQkt(cfg.qktBin, ["parse", tmp], { cwd: cfg.workspace, timeoutMs: 20_000 });
    const diagnostics: Diagnostic[] = [];
    if (r.code !== 0) {
      const err = normalizeError(r.stderr || r.stdout, r.code);
      if (err.kind === "file_not_found" && err.file) err.message = `Imported file not found: ${path.relative(cfg.workspace, err.file).split(path.sep).join("/") || err.file}`;
      let { line, col } = err;
      let endCol = (col ?? 1) + 1;
      if (err.kind === "unknown_indicator") { const loc = relocate(content, err.message); if (loc) { line = loc.line; col = loc.col; endCol = loc.endCol; } }
      diagnostics.push({ severity: "error", code: err.kind, message: err.message, line: line ?? 1, col: col ?? 1, endCol });
    }
    if (r.code === 0) rememberParsed(content);
    diagnostics.push(...lintAliases(content));
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
