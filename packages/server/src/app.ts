import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { TooFewTrades, UnsupportedResultError } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { registerFsRoutes } from "./fs-routes.js";
import { JailError } from "./jail.js";
import { RunRequestError } from "./runner.js";

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the HTTP app. Route groups are registered by their own modules so tests can mount subsets. */
export async function buildApp(cfg: ServerConfig, register?: (app: FastifyInstance) => void | Promise<void>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  if (cfg.token) {
    const expected = cfg.token;
    app.addHook("onRequest", async (req, reply) => {
      const url = req.url;
      if (!url.startsWith("/api") && !url.startsWith("/ws")) return; // the static UI loads so it can ask for the token
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const q = /[?&]token=([^&]+)/.exec(url)?.[1];
      if (!tokenOk(bearer ?? (q ? decodeURIComponent(q) : undefined), expected)) return reply.code(401).send({ error: "unauthorized" });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RunRequestError || err instanceof JailError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof TooFewTrades) return reply.code(422).send({ error: err.message, have: err.have });
    if (err instanceof UnsupportedResultError) return reply.code(422).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  registerFsRoutes(app, cfg);
  if (register) await register(app);
  app.get("/api/health", async () => ({ ok: true }));

  if (cfg.webRoot && existsSync(cfg.webRoot)) {
    await app.register(fastifyStatic, { root: cfg.webRoot, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html", path.resolve(cfg.webRoot!));
    });
  }
  return app;
}
