import type { FastifyInstance, FastifyReply } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isTerminal, MC_MAX_SIMS, overlayTrips, queryTrips, runMonteCarlo, type McMethod, type RoundTrip, type TripQuery, type TripSort,
} from "@qkt-studio/core";
import { resolveInJail } from "./jail.js";
import { Runner, RunRequestError, type RunRequest } from "./runner.js";

const TRIP_CACHE_MAX = 6;
const ARTIFACT_TOPS = new Set(["logs", "engine", "source", "robustness", "derived"]);
const MIME: Record<string, string> = {
  ".json": "application/json", ".html": "text/html; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".qkt": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8", ".jsonl": "text/plain; charset=utf-8", ".ndjson": "text/plain; charset=utf-8",
};
const DERIVED = new Set(["summary", "monthly", "integrity", "equity", "meta"]);

const num = (v: unknown): number | undefined => (v === undefined || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const time = (v: unknown): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(String(v));
  return Number.isNaN(d) ? undefined : d;
};

export function parseTripQuery(q: Record<string, string | undefined>): TripQuery {
  const sorts: TripSort[] = ["entryTs", "exitTs", "pnl", "holdMs", "qty"];
  return {
    side: q.side === "long" || q.side === "short" ? q.side : undefined,
    outcome: (["win", "loss", "breakeven", "open", "closed"] as const).find((o) => o === q.outcome),
    symbol: q.symbol || undefined, strategy: q.strategy || undefined,
    fromTs: time(q.from), toTs: time(q.to), minHoldMs: num(q.minHold), maxHoldMs: num(q.maxHold), minPnl: num(q.minPnl), maxPnl: num(q.maxPnl),
    sort: sorts.find((s) => s === q.sort), dir: q.dir === "desc" ? "desc" : "asc", offset: num(q.offset), limit: num(q.limit),
  };
}

export function registerRunRoutes(app: FastifyInstance, runner: Runner): void {
  const tripCache = new Map<string, RoundTrip[]>();
  const loadTrips = async (id: string): Promise<RoundTrip[] | null> => {
    const hit = tripCache.get(id);
    if (hit) { tripCache.delete(id); tripCache.set(id, hit); return hit; }
    try {
      const trips = JSON.parse(await fs.readFile(path.join(runner.runDir(id), "derived", "roundtrips.json"), "utf8")) as RoundTrip[];
      tripCache.set(id, trips);
      if (tripCache.size > TRIP_CACHE_MAX) tripCache.delete(tripCache.keys().next().value as string);
      return trips;
    } catch { return null; }
  };
  const notFound = (reply: FastifyReply, what = "not found") => reply.code(404).send({ error: what });

  app.get<{ Querystring: { strategy?: string; limit?: string } }>("/api/runs", async (req) => ({
    runs: runner.list(req.query.strategy, num(req.query.limit)),
  }));

  app.post<{ Body: RunRequest }>("/api/runs", async (req, reply) => {
    const r = await runner.submit(req.body);
    return reply.code(r.cached ? 200 : 202).send(r);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = await runner.getRun(req.params.id);
    return run ?? notFound(reply, "run not found");
  });

  app.delete<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const dir = runner.runDir(req.params.id);
    if (await runner.cancel(req.params.id)) await runner.waitFor(req.params.id).catch(() => undefined);
    if (!(await fs.stat(dir).then(() => true, () => false))) return notFound(reply, "run not found");
    await fs.rm(dir, { recursive: true, force: true });
    runner.index.remove(req.params.id);
    tripCache.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const ok = await runner.cancel(req.params.id);
    return ok ? { cancelled: true } : reply.code(409).send({ error: "run is not active" });
  });

  // Server-sent events: run snapshots, progress ticks and log lines. Reconnect with Last-Event-ID.
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (req, reply) => {
    const after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || 0;
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    raw.write(": ok\n\n");
    let closed = false;
    let unsub: (() => void) | undefined;
    const end = () => { if (closed) return; closed = true; clearInterval(beat); unsub?.(); raw.end(); };
    const beat = setInterval(() => { if (!closed) raw.write(": ping\n\n"); }, 15_000);
    req.raw.on("close", end);
    try {
      unsub = await runner.subscribe(req.params.id, (e) => {
        if (closed) return;
        raw.write(`id: ${e.id}\nevent: ${e.t}\ndata: ${JSON.stringify(e)}\n\n`);
        if (e.t === "run" && isTerminal(e.run.status)) setTimeout(end, 50);
      }, after);
    } catch (e) {
      raw.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
      end();
    }
  });

  app.get<{ Params: { id: string; name: string } }>("/api/runs/:id/derived/:name", async (req, reply) => {
    if (!DERIVED.has(req.params.name)) return notFound(reply);
    try {
      const text = await fs.readFile(path.join(runner.runDir(req.params.id), "derived", `${req.params.name}.json`), "utf8");
      return reply.type("application/json").send(text);
    } catch { return notFound(reply, "not available (run not finished?)"); }
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/api/runs/:id/trades", async (req, reply) => {
    const trips = await loadTrips(req.params.id);
    if (!trips) return notFound(reply, "trades not available");
    return queryTrips(trips, parseTripQuery(req.query));
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/api/runs/:id/overlay", async (req, reply) => {
    const trips = await loadTrips(req.params.id);
    if (!trips) return notFound(reply, "trades not available");
    const q = parseTripQuery(req.query);
    const from = time(req.query.from) ?? -Infinity, to = time(req.query.to) ?? Infinity;
    return overlayTrips(trips, { ...q, fromTs: undefined, toTs: undefined }, from, to, Math.min(num(req.query.cap) ?? 5000, 20_000));
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; tail?: string } }>("/api/runs/:id/artifact", async (req, reply) => {
    const dir = runner.runDir(req.params.id);
    const rel = req.query.path ?? "";
    const top = rel.split("/")[0] ?? "";
    if (!ARTIFACT_TOPS.has(top)) return reply.code(403).send({ error: "path not allowed" });
    const abs = await resolveInJail(dir, rel).catch(() => null);
    if (!abs) return reply.code(403).send({ error: "path not allowed" });
    let st;
    try { st = await fs.stat(abs); } catch { return notFound(reply); }
    if (!st.isFile()) return reply.code(400).send({ error: "not a file" });
    const ext = path.extname(abs).toLowerCase();
    const tail = num(req.query.tail);
    let body: Buffer;
    if (tail && st.size > tail) {
      const fh = await fs.open(abs, "r");
      try { body = Buffer.alloc(tail); await fh.read(body, 0, tail, st.size - tail); } finally { await fh.close(); }
    } else body = await fs.readFile(abs);
    reply.header("Content-Type", MIME[ext] ?? "application/octet-stream").header("X-Content-Type-Options", "nosniff");
    // Engine-generated HTML is served sandboxed: scripts may run but never with this origin's identity.
    if (ext === ".html") reply.header("Content-Security-Policy", "sandbox allow-scripts");
    return reply.send(body);
  });

  // ---- Monte Carlo (trade-list methods; results are files under robustness/) -----------------------------------
  app.post<{ Params: { id: string }; Body: { method?: McMethod; sims?: number; seed?: number; blockLen?: number; skipPct?: number; ruinDrawdown?: number } }>(
    "/api/runs/:id/montecarlo", async (req, reply) => {
      const trips = await loadTrips(req.params.id);
      if (!trips) return notFound(reply, "trades not available");
      const b = req.body ?? {};
      const method = (["shuffle", "bootstrap", "block", "skip"] as const).find((m) => m === b.method) ?? "bootstrap";
      const sims = Math.floor(b.sims ?? 1000), seed = Math.floor(b.seed ?? 42);
      const pnls = trips.filter((t) => !t.open).sort((a, c) => (a.exitTs ?? 0) - (c.exitTs ?? 0)).map((t) => t.pnl);
      if (sims * Math.max(pnls.length, 1) > 5e7) return reply.code(400).send({ error: `sims × trades exceeds the safety cap (max sims ${MC_MAX_SIMS}, ~5e7 steps)` });
      const equity = JSON.parse(await fs.readFile(path.join(runner.runDir(req.params.id), "derived", "equity.json"), "utf8").catch(() => "null")) as { equity: number[] } | null;
      const startEquity = equity?.equity[0] ?? 10_000;
      const res = runMonteCarlo(pnls, { method, sims, seed, startEquity, blockLen: b.blockLen, skipPct: b.skipPct, ruinDrawdown: b.ruinDrawdown });
      const dir = path.join(runner.runDir(req.params.id), "robustness");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `montecarlo-${method}-${seed}-${sims}.json`), JSON.stringify(res));
      return res;
    });

  app.get<{ Params: { id: string } }>("/api/runs/:id/montecarlo", async (req) => {
    const dir = path.join(runner.runDir(req.params.id), "robustness");
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("montecarlo-"));
    return { results: await Promise.all(files.map(async (f) => ({ file: f, ...(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as object) }))) };
  });
}

export { RunRequestError };
