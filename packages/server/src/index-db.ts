import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunJson } from "@qkt-studio/core";

export interface IndexRow {
  id: string; hash: string; strategy: string; status: string; tier: string; from_d: string; to_d: string;
  created_at: string; seq: number; total_pnl: number | null; sharpe: number | null; trades: number | null; win_rate: number | null; duration_ms: number | null;
}

/**
 * Derived run index. Files under runs/ are the truth; this only makes listing, cache lookup, sequence numbers
 * and ETA estimation instant. It can be deleted at any time and rebuilt with reindex().
 */
export class RunIndex {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL, strategy TEXT NOT NULL, status TEXT NOT NULL, tier TEXT NOT NULL,
        from_d TEXT NOT NULL, to_d TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL,
        total_pnl REAL, sharpe REAL, trades INTEGER, win_rate REAL, duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_hash ON runs(hash);
      CREATE INDEX IF NOT EXISTS runs_strategy ON runs(strategy, seq);
    `);
  }

  upsert(r: RunJson, s?: { totalPnl?: number; sharpe?: number; trades?: number; winRate?: number }): void {
    this.db.prepare(`
      INSERT INTO runs (id, hash, strategy, status, tier, from_d, to_d, created_at, seq, total_pnl, sharpe, trades, win_rate, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, total_pnl=COALESCE(excluded.total_pnl, total_pnl),
        sharpe=COALESCE(excluded.sharpe, sharpe), trades=COALESCE(excluded.trades, trades),
        win_rate=COALESCE(excluded.win_rate, win_rate), duration_ms=COALESCE(excluded.duration_ms, duration_ms)
    `).run(r.id, r.hash, r.strategy, r.status, r.tier, r.from, r.to, r.createdAt, r.seq,
      s?.totalPnl ?? null, s?.sharpe ?? null, s?.trades ?? null, s?.winRate ?? null, r.durationMs ?? null);
  }

  remove(id: string): void { this.db.prepare("DELETE FROM runs WHERE id = ?").run(id); }

  get(id: string): IndexRow | undefined { return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as IndexRow | undefined; }

  /** A finished run with the same inputs, newest first. */
  findDone(hash: string): IndexRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE hash = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1").get(hash) as IndexRow | undefined;
  }
  findActive(hash: string): IndexRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE hash = ? AND status IN ('queued','checking','running','postprocessing') LIMIT 1").get(hash) as IndexRow | undefined;
  }

  nextSeq(strategy: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM runs WHERE strategy = ?").get(strategy) as { n: number };
    return r.n;
  }

  list(opts: { strategy?: string; limit?: number } = {}): IndexRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    return (opts.strategy
      ? this.db.prepare("SELECT * FROM runs WHERE strategy = ? ORDER BY created_at DESC LIMIT ?").all(opts.strategy, limit)
      : this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit)) as unknown as IndexRow[];
  }

  /** Average wall-clock ms per calendar day for finished runs of this tier (ETA for the next one). */
  msPerDay(tier: string, strategy?: string): number | null {
    const rows = (strategy
      ? this.db.prepare("SELECT from_d, to_d, duration_ms FROM runs WHERE status='done' AND tier=? AND strategy=? AND duration_ms > 0 ORDER BY created_at DESC LIMIT 5").all(tier, strategy)
      : this.db.prepare("SELECT from_d, to_d, duration_ms FROM runs WHERE status='done' AND tier=? AND duration_ms > 0 ORDER BY created_at DESC LIMIT 5").all(tier)) as Array<{ from_d: string; to_d: string; duration_ms: number }>;
    const per = rows.map((r) => r.duration_ms / Math.max(1, (Date.parse(r.to_d) - Date.parse(r.from_d)) / 86_400_000)).filter((x) => Number.isFinite(x));
    return per.length ? per.reduce((a, b) => a + b, 0) / per.length : null;
  }

  /** Rebuild every row from runs/<id>/run.json (+ derived/summary.json). */
  async reindex(runsDir: string): Promise<number> {
    this.db.exec("DELETE FROM runs");
    let n = 0;
    let dirs: string[] = [];
    try { dirs = await fs.readdir(runsDir); } catch { return 0; }
    for (const d of dirs) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(runsDir, d, "run.json"), "utf8")) as RunJson;
        let s: { totalPnl?: number; sharpe?: number; trades?: number; winRate?: number } | undefined;
        try { s = JSON.parse(await fs.readFile(path.join(runsDir, d, "derived", "summary.json"), "utf8")); } catch { /* not finished */ }
        this.upsert(run, s);
        n++;
      } catch { /* not a run directory */ }
    }
    return n;
  }

  close(): void { this.db.close(); }
}
