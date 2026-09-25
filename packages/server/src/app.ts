import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "./config.js";
import { registerFsRoutes } from "./fs-routes.js";

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the HTTP app. Route groups are registered by their own modules so tests can mount subsets. */
export async function buildApp(cfg: ServerConfig, register?: (app: FastifyInstance) => void | Promise<void>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });

  if (cfg.token) {
    const expected = cfg.token;
    app.addHook("onRequest", async (req, reply) => {
      const url = req.url;
      if (!url.startsWith("/api") && !url.startsWith("/ws")) return; // static UI loads so it can ask for the token
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const q = /[?&]token=([^&]+)/.exec(url)?.[1];
      if (!tokenOk(bearer ?? (q ? decodeURIComponent(q) : undefined), expected)) return reply.code(401).send({ error: "unauthorized" });
    });
  }

  registerFsRoutes(app, cfg);
  if (register) await register(app);

  app.get("/api/health", async () => ({ ok: true }));
  return app;
}
