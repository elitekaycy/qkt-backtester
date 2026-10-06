import { promises as fs } from "node:fs";
import path from "node:path";
import { readBars, tfToMs, type BarCols, type RoundTrip, type RunJson, type Summary, type TripQuery, type TripSort } from "@qkt-studio/core";
import type { Runner } from "./runner.js";
import type { ServerConfig } from "./config.js";
import { rootFor } from "./settings.js";

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
    symbol: q.symbol || undefined, strategy: q.strategy || undefined, strategies: q.strategies !== undefined ? q.strategies.split(",").filter(Boolean) : undefined,
    fromTs: time(q.from), toTs: time(q.to), minHoldMs: num(q.minHold), maxHoldMs: num(q.maxHold), minPnl: num(q.minPnl), maxPnl: num(q.maxPnl),
    exit: (["stop", "target", "signal", "open", "expiry", "liquidation", "roll_failed"] as const).find((x) => x === q.exit),
    contract: q.contract || undefined,
    exitFromTs: time(q.exitFrom), exitToTs: time(q.exitTo), minQty: num(q.minQty), maxQty: num(q.maxQty), id: num(q.id), minR: num(q.minR), maxR: num(q.maxR), weekday: num(q.weekday), hour: num(q.hour), day: /^\d{4}-\d{2}-\d{2}$/.test(q.day ?? "") ? q.day : undefined,
    sort: sorts.find((s) => s === q.sort), dir: q.dir === "desc" ? "desc" : "asc", offset: num(q.offset), limit: num(q.limit),
  };
}

export interface RunMeta {
  runId: string; tier: string; from: string; to: string;
  streams: Array<{ key: string; broker: string; symbol: string; tf: string; base: string }>;
  strategies: string[]; fills: number; trips: number; currency?: string;
}

/** Round trips kept parsed in memory, summed over cached runs (~250 bytes each): a size cap, not a run count, since one run
 *  can hold 800k trips. The run being read is always kept, however large. */
const TRIP_CACHE_MAX_TRIPS = 1_500_000;

/** A run's derived files, read once and shared by the run routes and the MCP tools. */
export class RunData {
  private tripCache = new Map<string, RoundTrip[]>();
  private loading = new Map<string, Promise<RoundTrip[] | null>>();
  private cachedTrips = 0;
  constructor(private runner: Runner, private cfg: ServerConfig) {}

  private async json<T>(id: string, rel: string): Promise<T | null> {
    await this.runner.ensureDerived(id).catch(() => undefined);
    try { return JSON.parse(await fs.readFile(path.join(this.runner.runDir(id), rel), "utf8")) as T; } catch { return null; }
  }
  summary(id: string) { return this.json<Summary>(id, "derived/summary.json"); }
  meta(id: string) { return this.json<RunMeta>(id, "derived/meta.json"); }
  run(id: string): Promise<RunJson | null> { return this.runner.getRun(id); }

  /** Bars of `symbol` ("BROKER:SYM" or "SYM") over [fromMs, toMs), from the finest stream this run read for it. */
  async barsFor(runId: string, symbol: string, fromMs: number, toMs: number): Promise<{ tf: string; cols: BarCols } | null> {
    const meta = await this.meta(runId);
    const [broker, sym] = symbol.includes(":") ? symbol.split(":") as [string, string] : ["BACKTEST", symbol];
    const streams = (meta?.streams ?? []).filter((s) => s.broker === broker && s.symbol === sym).sort((a, b) => tfToMs(a.base) - tfToMs(b.base));
    const s = streams[0];
    if (!s) return null;
    const r = await readBars(rootFor(this.cfg, sym), broker, sym, s.base, fromMs, toMs);
    return r.cols.ts.length ? { tf: s.base, cols: r.cols } : null;
  }

  evict(id: string): void { const t = this.tripCache.get(id); if (t) { this.cachedTrips -= t.length; this.tripCache.delete(id); } }

  async trips(id: string): Promise<RoundTrip[] | null> {
    await this.runner.ensureDerived(id).catch(() => undefined);
    const hit = this.tripCache.get(id);
    if (hit) { this.tripCache.delete(id); this.tripCache.set(id, hit); return hit; }
    // one parse per run however many requests arrive together (the UI asks for trades, analytics and overlay at once)
    const inflight = this.loading.get(id);
    if (inflight) return inflight;
    const job = (async () => {
      try {
        const trips = JSON.parse(await fs.readFile(path.join(this.runner.runDir(id), "derived", "roundtrips.json"), "utf8")) as RoundTrip[];
        this.tripCache.set(id, trips); this.cachedTrips += trips.length;
        for (const k of this.tripCache.keys()) { if (this.cachedTrips <= TRIP_CACHE_MAX_TRIPS || k === id) break; this.evict(k); }
        return trips;
      } catch { return null; }
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, job);
    return job;
  }
}
