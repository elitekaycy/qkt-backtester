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
