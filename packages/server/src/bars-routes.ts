import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { availableTimeframes, barDir, lodAggregate, packBars, readBars, tfToMs } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";

const DAY_MS = 86_400_000;
/** A plain identifier: never empty, never only dots (so `.` and `..` cannot become path segments). */
const NAME = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;
const TF = /^\d{1,4}[smhdw]$/;
export const MAX_BAR_DAYS = 3700;

export type DayStatus = "ok" | "thin" | "closed" | "missing";
export interface DayCoverage { day: string; bars: number; status: DayStatus }

const toMs = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && v.length > 8) return n;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : d;
};

/** Bar count of a day file from its header alone (no column reads). */
async function barCountOf(file: string): Promise<number | null> {
  let fh;
  try { fh = await fs.open(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await fh.read(buf, 0, 256, 0);
    if (bytesRead < 28 || buf.toString("latin1", 0, 4) !== "QKB1") return null;
    const symLen = buf.readInt32LE(20);
    const at = 24 + symLen;
    return at + 4 <= bytesRead ? buf.readInt32LE(at) : null;
  } finally { await fh.close(); }
}

/**
 * Per-day store coverage. A day file with 0 bars is one qkt wrote for a closed day; no file at all means the
 * bars were never built. "thin" flags a weekday with under half the typical bar count (a partial day).
 */
export async function dayCoverage(dataRoot: string, broker: string, symbol: string, tf: string, fromMs: number, toMsExcl: number): Promise<DayCoverage[]> {
  const dir = barDir(dataRoot, broker, symbol, tf);
  const days: Array<{ day: string; n: number | null; weekday: boolean }> = [];
  for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS; d < toMsExcl; d += DAY_MS) {
    const iso = new Date(d).toISOString().slice(0, 10);
    const dow = new Date(d).getUTCDay();
    days.push({ day: iso, n: await barCountOf(path.join(dir, `${iso}.bin`)), weekday: dow >= 1 && dow <= 5 });
  }
  const weekdayCounts = days.filter((x) => x.weekday && x.n).map((x) => x.n!).sort((a, b) => a - b);
  const median = weekdayCounts.length ? weekdayCounts[weekdayCounts.length >> 1]! : 0;
  return days.map((x) => ({
    day: x.day, bars: x.n ?? 0,
    status: x.n === null ? "missing" : x.n === 0 ? "closed" : x.weekday && median > 0 && x.n < median * 0.5 ? "thin" : "ok",
  }));
}

export function registerBarsRoutes(app: FastifyInstance, cfg: ServerConfig): void {
  const root = cfg.dataRoot;
  const bad = (msg: string) => ({ error: msg });

  app.get("/api/bars/symbols", async () => {
    const out: Array<{ broker: string; symbol: string; timeframes: string[] }> = [];
    const brokers = await fs.readdir(path.join(root, "bars")).catch(() => [] as string[]);
    for (const broker of brokers) {
      for (const symbol of await fs.readdir(path.join(root, "bars", broker)).catch(() => [] as string[])) {
        out.push({ broker, symbol, timeframes: await availableTimeframes(root, broker, symbol) });
      }
    }
    return { symbols: out };
  });

  /** First and last day that has a day file for this symbol/timeframe (names only; no file reads). */
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/bars/range", async (req, reply) => {
    const { broker, symbol, tf } = req.query;
    if (!broker || !symbol || !tf || !NAME.test(broker) || !NAME.test(symbol) || !TF.test(tf)) return reply.code(400).send(bad("broker, symbol and tf are required"));
    const days = (await fs.readdir(barDir(root, broker, symbol, tf)).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.bin$/.test(f)).map((f) => f.slice(0, 10)).sort();
    return { broker, symbol, tf, first: days[0] ?? null, last: days[days.length - 1] ?? null, files: days.length };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/bars", async (req, reply) => {
    const { broker, symbol, tf } = req.query;
    if (!broker || !symbol || !tf || !NAME.test(broker) || !NAME.test(symbol) || !TF.test(tf)) return reply.code(400).send(bad("broker, symbol and tf are required and must be plain identifiers"));
    const from = toMs(req.query.from), to = toMs(req.query.to);
    if (from === null || to === null || to <= from) return reply.code(400).send(bad("from/to required; to is exclusive and must be after from"));
    if ((to - from) / DAY_MS > MAX_BAR_DAYS) return reply.code(400).send(bad(`range longer than ${MAX_BAR_DAYS} days`));
    const max = Math.min(Math.max(Number(req.query.max ?? 5000) || 5000, 100), 20_000);
    const r = await readBars(root, broker, symbol, tf, from, to);
    const cols = lodAggregate(r.cols, max);
    const body = packBars(cols);
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("X-Bars-Count", String(cols.ts.length)).header("X-Bars-Source-Count", String(r.cols.ts.length))
      .header("X-Bars-Tf-Ms", String(cols.tfMs || tfToMs(tf))).header("X-Bars-Days", String(r.days.length))
      .header("X-Bars-Empty-Days", String(r.emptyDays.length)).header("X-Bars-Missing-Days", String(r.missingDays.length))
      .header("Cache-Control", "no-store")
      .send(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/bars/coverage", async (req, reply) => {
    const { broker, symbol, tf } = req.query;
    if (!broker || !symbol || !tf || !NAME.test(broker) || !NAME.test(symbol) || !TF.test(tf)) return reply.code(400).send(bad("broker, symbol and tf are required"));
    const from = toMs(req.query.from), to = toMs(req.query.to);
    if (from === null || to === null || to <= from) return reply.code(400).send(bad("from/to required; to is exclusive"));
    if ((to - from) / DAY_MS > MAX_BAR_DAYS) return reply.code(400).send(bad(`range longer than ${MAX_BAR_DAYS} days`));
    const days = await dayCoverage(root, broker, symbol, tf, from, to);
    const count = (s: DayStatus) => days.filter((d) => d.status === s).length;
    return { broker, symbol, tf, days, summary: { ok: count("ok"), thin: count("thin"), closed: count("closed"), missing: count("missing") } };
  });
}
