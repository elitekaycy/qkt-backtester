import { promises as fs } from "node:fs";
import path from "node:path";
import type { RoundTrip, RunJson, Summary } from "@qkt-studio/core";
import type { Runner } from "./runner.js";
import type { ServerConfig } from "./config.js";

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
