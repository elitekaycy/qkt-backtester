import type { FastifyInstance } from "fastify";
import { checkConfig, type Diagnostic } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { checkQktSource, checkSlots } from "./check.js";

const MAX_BYTES = 1024 * 1024;

/**
 * Live checking of an UNSAVED buffer: `qkt parse` on the exact text (so a run of the same text skips its own parse)
 * plus the studio's alias lint, which reports every undeclared alias where qkt stops at the first.
 */
export function registerCheckRoutes(app: FastifyInstance, cfg: ServerConfig): void {
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

    const running = checkSlots.tryRun(() => checkQktSource(cfg, content, rel));
    if (!running) return reply.code(429).send({ error: "too many checks in flight" });
    return { diagnostics: (await running).diagnostics };
  });
}
