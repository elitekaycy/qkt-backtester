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

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** The page's own origin (same host:port), a listed origin, or, only when the studio itself is on loopback, another loopback page (the Vite dev server proxies from :5173). */
export function originAllowed(origin: string, host: string, allowed: readonly string[]): boolean {
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (o.host.toLowerCase() === host) return true;
  if (allowed.includes(origin.replace(/\/$/, "").toLowerCase())) return true;
  const hostName = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_NAMES.has(o.hostname.replace(/^\[(.*)\]$/, "$1")) && LOOPBACK_NAMES.has(hostName);
}

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the HTTP app. Route groups are registered by their own modules so tests can mount subsets. */
export async function buildApp(cfg: ServerConfig, register?: (app: FastifyInstance) => void | Promise<void>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  // Cross-site protection, for every /api and /ws request, before the token check:
  //  - a WebSocket handshake or state-changing request that carries an Origin must come from the studio's own page (browsers
  //    always send Origin there, so a random web page can never open the terminal or submit a run);
  //  - without a token, only a loopback Host (or one listed in STUDIO_ALLOWED_HOSTS) is served, so DNS rebinding cannot turn an
  //    attacker's page into "same origin".
  // Browser hardening on every response: no framing (clickjacking), no MIME sniffing, no referrer leaks, and a CSP that only
  // runs the studio's own bundle (Monaco injects <style> tags and runs its worker from a same-origin file or blob).
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
    "worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY").header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", CSP);
    return payload;
  });

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url;
    if (!url.startsWith("/api") && !url.startsWith("/ws")) return;
    const host = (req.headers.host ?? "").toLowerCase();
    const hostName = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
    if (!cfg.token && host && !LOOPBACK_NAMES.has(hostName) && !(cfg.allowedHosts ?? []).includes(hostName)) {
      return reply.code(403).send({ error: `This studio has no STUDIO_TOKEN, so it only answers to localhost. Open it as http://localhost:${host.split(":").pop()} or set STUDIO_TOKEN (or STUDIO_ALLOWED_HOSTS=${hostName}).` });
    }
    const origin = req.headers.origin;
    const risky = url.startsWith("/ws") || !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (origin && risky && !originAllowed(origin, host, cfg.allowedOrigins ?? [])) return reply.code(403).send({ error: "cross-site request refused" });
  });

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
    await app.register(fastifyStatic, {
      root: cfg.webRoot, index: ["index.html"], preCompressed: true, cacheControl: false,
      // hashed build output never changes under the same name; index.html must always be revalidated
      setHeaders: (res, file) => res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html", path.resolve(cfg.webRoot!));
    });
  }
  return app;
}
