import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, lintAliases, normalizeError, relocate, type Diagnostic } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { execQkt } from "./proc.js";
import { resolveInJail } from "./jail.js";

const MAX_BYTES = 1024 * 1024;
const MAX_CONCURRENT = 3;

/**
 * Live checking of an UNSAVED buffer. The LSP covers syntax as you type but not what `qkt parse` catches
 * (unknown indicators, reported at 1:1) nor the alias mistake qkt silently accepts, so this route adds both.
 */
export function registerCheckRoutes(app: FastifyInstance, cfg: ServerConfig): void {
  let inflight = 0;

  app.post<{ Body: { kind?: "qkt" | "config"; content?: string; path?: string } }>("/api/check", async (req, reply) => {
    const { kind, content, path: rel } = req.body ?? {};
    if ((kind !== "qkt" && kind !== "config") || typeof content !== "string") return reply.code(400).send({ error: "kind ('qkt'|'config') and content are required" });
    if (Buffer.byteLength(content) > MAX_BYTES) return reply.code(413).send({ error: "content too large" });

    if (kind === "config") {
      const diagnostics: Diagnostic[] = checkConfig(content, true, { QKT_DATA_HOME: cfg.dataRoot }).map((f) => ({
        severity: f.severity, code: f.code, message: f.message, line: f.line ?? 1, col: f.col ?? 1, endCol: (f.col ?? 1) + 1,
      }));
      return { diagnostics };
    }

    if (inflight >= MAX_CONCURRENT) return reply.code(429).send({ error: "too many checks in flight" });
    inflight++;
    // Check the buffer from the file's own folder (as a hidden sibling), so relative IMPORTs resolve exactly as in a run; a
    // portfolio checked from /tmp would report its correct imports as missing. /tmp only when the folder is not writable.
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
      diagnostics.push(...lintAliases(content));
      return { diagnostics };
    } finally {
      inflight--;
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  });
}
