import type { FastifyInstance } from "fastify";
import { checkConfig, type Diagnostic } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { checkQktSource } from "./check.js";

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
    try { return { diagnostics: (await checkQktSource(cfg, content, rel)).diagnostics }; }
    finally { inflight--; }
  });
}
