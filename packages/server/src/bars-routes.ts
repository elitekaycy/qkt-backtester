import { rootFor } from "./settings.js";
import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { availableTimeframes, barDir, lodAggregate, packBars, readBarsVia, tfToMs } from "@qkt-studio/core";
import { barCountOf } from "./barfile.js";
import type { ServerConfig } from "./config.js";

const DAY_MS = 86_400_000;
/** A plain identifier: never empty, never only dots (so `.` and `..` cannot become path segments). */
const NAME = /^(?!\.+$)[A-Za-z0-9_.\-]{1,40}$/;
const TF = /^\d{1,4}[smhd]$/;
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
  /** The data source can be changed from the UI at runtime, so it is read on every request. */
  const rootOf = (symbol?: string) => (symbol ? rootFor(cfg, symbol) : cfg.dataRoot);
  const bad = (msg: string) => ({ error: msg });
  /** `base`: the folder to read `tf` from (a finer timeframe that divides it, as qkt aggregates); defaults to `tf` itself. */
  const baseOf = (tf: string, base: string | undefined): string | null => (base === undefined || base === "" || base === tf ? tf : TF.test(base) && tfToMs(tf) % tfToMs(base) === 0 ? base : null);

  /**
   * Inventory of the data store for the Data section: per symbol, the tick files (with the fetcher's manifest) and every
   * bar timeframe that has been built, each with its first/last day and file count. Names only; no data is read.
   */
  app.get("/api/data/symbols", async () => {
    const days = async (dir: string, ext: RegExp) => (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => ext.test(f)).map((f) => f.slice(0, 10)).sort();
    const bySymbol = new Map<string, { symbol: string; ticks: null | { files: number; first: string | null; last: string | null; source?: string; ranges?: unknown }; bars: Array<{ broker: string; tf: string; files: number; first: string | null; last: string | null }> }>();
    const entry = (symbol: string) => { let e = bySymbol.get(symbol); if (!e) { e = { symbol, ticks: null, bars: [] }; bySymbol.set(symbol, e); } return e; };
    for (const symbol of await fs.readdir(path.join(rootOf(), "symbols")).catch(() => [] as string[])) {
      if (!NAME.test(symbol)) continue;
      const dir = path.join(rootOf(), "symbols", symbol);
      const d = await days(dir, /^\d{4}-\d{2}-\d{2}\.csv(\.gz)?$/);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "null")) as { source?: string; ranges?: unknown } | null;
      entry(symbol).ticks = { files: d.length, first: d[0] ?? null, last: d[d.length - 1] ?? null, source: manifest?.source, ranges: manifest?.ranges };
    }
    for (const broker of await fs.readdir(path.join(rootOf(), "bars")).catch(() => [] as string[])) {
      if (!NAME.test(broker)) continue;
      for (const symbol of await fs.readdir(path.join(rootOf(), "bars", broker)).catch(() => [] as string[])) {
        if (!NAME.test(symbol)) continue;
        for (const tf of await availableTimeframes(rootOf(), broker, symbol)) {
          const d = await days(barDir(rootOf(), broker, symbol, tf), /^\d{4}-\d{2}-\d{2}\.bin$/);
          entry(symbol).bars.push({ broker, tf, files: d.length, first: d[0] ?? null, last: d[d.length - 1] ?? null });
        }
      }
    }
    return { dataRoot: rootOf(), symbols: [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)) };
  });

  /** Which tick day files exist in [from, to). Ticks have no calendar here: a weekend without a file is normal. */
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/data/ticks/coverage", async (req, reply) => {
    const { symbol } = req.query;
    const from = toMs(req.query.from), to = toMs(req.query.to);
    if (!symbol || !NAME.test(symbol)) return reply.code(400).send(bad("symbol is required"));
    if (from === null || to === null || to <= from) return reply.code(400).send(bad("from/to required; to is exclusive"));
    if ((to - from) / DAY_MS > MAX_BAR_DAYS) return reply.code(400).send(bad(`range longer than ${MAX_BAR_DAYS} days`));
    const dir = path.join(rootOf(), "symbols", symbol);
    const present = new Map<string, number>();
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      const m = /^(\d{4}-\d{2}-\d{2})\.csv(\.gz)?$/.exec(f);
      if (m) present.set(m[1]!, (await fs.stat(path.join(dir, f)).catch(() => null))?.size ?? 0);
    }
    const days: Array<{ day: string; present: boolean; bytes: number }> = [];
    for (let d = Math.floor(from / DAY_MS) * DAY_MS; d < to; d += DAY_MS) {
      const iso = new Date(d).toISOString().slice(0, 10);
      days.push({ day: iso, present: present.has(iso), bytes: present.get(iso) ?? 0 });
    }
    return { symbol, days, summary: { present: days.filter((x) => x.present).length, absent: days.filter((x) => !x.present).length } };
  });

  app.get("/api/bars/symbols", async () => {
    const out: Array<{ broker: string; symbol: string; timeframes: string[] }> = [];
    const brokers = await fs.readdir(path.join(rootOf(), "bars")).catch(() => [] as string[]);
    for (const broker of brokers) {
      for (const symbol of await fs.readdir(path.join(rootOf(), "bars", broker)).catch(() => [] as string[])) {
        out.push({ broker, symbol, timeframes: await availableTimeframes(rootOf(), broker, symbol) });
      }
    }
    return { symbols: out };
  });

  /** First and last day that has a day file for this symbol/timeframe (names only; no file reads). */
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/bars/range", async (req, reply) => {
    const { broker, symbol, tf } = req.query;
    if (!broker || !symbol || !tf || !NAME.test(broker) || !NAME.test(symbol) || !TF.test(tf)) return reply.code(400).send(bad("broker, symbol and tf are required"));
    const days = (await fs.readdir(barDir(rootOf(symbol), broker, symbol, tf)).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.bin$/.test(f)).map((f) => f.slice(0, 10)).sort();
    return { broker, symbol, tf, first: days[0] ?? null, last: days[days.length - 1] ?? null, files: days.length };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/bars", async (req, reply) => {
    const { broker, symbol, tf } = req.query;
    if (!broker || !symbol || !tf || !NAME.test(broker) || !NAME.test(symbol) || !TF.test(tf)) return reply.code(400).send(bad("broker, symbol and tf are required and must be plain identifiers"));
    const from = toMs(req.query.from), to = toMs(req.query.to);
    if (from === null || to === null || to <= from) return reply.code(400).send(bad("from/to required; to is exclusive and must be after from"));
    if ((to - from) / DAY_MS > MAX_BAR_DAYS) return reply.code(400).send(bad(`range longer than ${MAX_BAR_DAYS} days`));
    const max = Math.min(Math.max(Number(req.query.max ?? 5000) || 5000, 100), 20_000);
    const base = baseOf(tf, req.query.base);
    if (!base) return reply.code(400).send(bad("base must be a timeframe that divides tf"));
    const r = await readBarsVia(rootOf(symbol), broker, symbol, tf, base, from, to);
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
    const base = baseOf(tf, req.query.base);
    if (!base) return reply.code(400).send(bad("base must be a timeframe that divides tf"));
    const days = await dayCoverage(rootOf(symbol), broker, symbol, base, from, to);
    const count = (s: DayStatus) => days.filter((d) => d.status === s).length;
    return { broker, symbol, tf, base, days, summary: { ok: count("ok"), thin: count("thin"), closed: count("closed"), missing: count("missing") } };
  });
}
