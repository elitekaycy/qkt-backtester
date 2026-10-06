import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import { invalidateScan, listStrategies, readinessFor, scanCached, scanStore, scanSymbolIn, seriesDays } from "./data-scan.js";
import type { Jobs } from "./jobs.js";
import type { Runner } from "./runner.js";
import { applySettings, dataRootAllowed, loadSettings, savePrefs, updateSettings } from "./settings.js";
import type { SymbolPref } from "./config.js";
import { listPortfolios, resolveStrategy } from "./portfolio.js";
import { completeConfig, missingFiles, scaffoldWorkspace, type ScaffoldFile } from "./scaffold.js";
import { rangeDays, longest, parseInstruments } from "@qkt-studio/core";
import { derivativesCached, kindContextOf } from "./derivatives-scan.js";
import { acceptNoData, readAccepted, undoNoData } from "./no-data.js";

const looksLikeStore = async (dir: string) =>
  (await fs.stat(path.join(dir, "bars")).then((s) => s.isDirectory(), () => false)) || (await fs.stat(path.join(dir, "symbols")).then((s) => s.isDirectory(), () => false));

export function registerDataRoutes(app: FastifyInstance, cfg: ServerConfig, runner: Runner, jobs: Jobs): void {
  const settingsView = async () => {
    const s = await loadSettings(cfg);
    const perm = dataRootAllowed(cfg, cfg.dataRoot);
    return {
      dataRoot: cfg.dataRoot, defaultDataRoot: cfg.defaultDataRoot ?? cfg.dataRoot, fromSettings: Boolean(s.dataRoot) && s.dataRoot === cfg.dataRoot,
      canChangeAnywhere: perm.trusted, openRoots: perm.trusted ? [] : [cfg.defaultDataRoot ?? cfg.dataRoot, "/data", "/mnt", "/media", "/srv"],
      sources: cfg.sources ?? [], symbolPrefs: cfg.symbolPrefs ?? {},
      looksLikeStore: await looksLikeStore(cfg.dataRoot), exists: await fs.stat(cfg.dataRoot).then((x) => x.isDirectory(), () => false),
    };
  };

  app.get("/api/settings", async () => settingsView());

  /** Point the studio at another qkt data folder. It is validated first and the change is remembered across restarts. */
  app.put<{ Body: { dataRoot?: string | null } }>("/api/settings/data-root", async (req, reply) => {
    const raw = req.body?.dataRoot;
    if (raw === null || raw === "") { // reset to the default
      await updateSettings(cfg, ({ dataRoot: _d, ...s }) => s);
      cfg.dataRoot = cfg.defaultDataRoot ?? cfg.dataRoot; invalidateScan();
      return { ...(await settingsView()), warnings: [] as string[] };
    }
    if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.includes("\0")) return reply.code(400).send({ error: "dataRoot must be an absolute path" });
    const target = path.resolve(raw);
    const perm = dataRootAllowed(cfg, target);
    if (!perm.ok) return reply.code(403).send({ error: perm.reason });
    const st = await fs.stat(target).catch(() => null);
    if (!st?.isDirectory()) return reply.code(400).send({ error: `${target} is not a folder the server can read. In Docker, mount it first (-v /host/path:/data).` });
    const warnings: string[] = [];
    if (!(await looksLikeStore(target))) warnings.push("This folder has no `symbols/` or `bars/` directory yet. It looks empty or is not a qkt data store.");
    cfg.dataRoot = target; invalidateScan();
    await updateSettings(cfg, (s) => ({ ...s, dataRoot: target }));
    await applySettings(cfg);
    return { ...(await settingsView()), warnings };
  });

  /** Folder browser for choosing a data source. Names only; restricted like the setting itself. */
  app.get<{ Querystring: { path?: string } }>("/api/fs/dirs", async (req, reply) => {
    const p = path.resolve(req.query.path || cfg.dataRoot);
    const perm = dataRootAllowed(cfg, p);
    if (!perm.ok) return reply.code(403).send({ error: perm.reason });
    const ents = await fs.readdir(p, { withFileTypes: true }).catch(() => null);
    if (!ents) return reply.code(404).send({ error: "cannot read that folder" });
    const dirs = await Promise.all(ents.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map(async (e) => ({ name: e.name, store: await looksLikeStore(path.join(p, e.name)) })));
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { path: p, parent: p === path.dirname(p) ? null : path.dirname(p), store: await looksLikeStore(p), dirs: dirs.slice(0, 500) };
  });

  /** Full completeness scan of the data source: per symbol, timeframe and year, with green/amber/red status. */
  app.get<{ Querystring: { refresh?: string } }>("/api/data/scan", async (req) => scanCached(cfg.dataRoot, req.query.refresh === "1"));

  /** Futures and options roots: catalogs, rolls, contract bars, funding, open interest, marks, chains, and the terms instruments.yaml gives them. */
  app.get<{ Querystring: { refresh?: string } }>("/api/data/derivatives", async (req) => derivativesCached(cfg.dataRoot, req.query.refresh === "1" ? 0 : 10_000));

  /**
   * What the browser's lint needs to tell a CFD stream from a futures or options one: instruments.yaml's three sections and the
   * roots and perpetuals the store knows (a contract's kind cannot be read from its name alone).
   */
  app.get("/api/instruments", async () => {
    const d = await derivativesCached(cfg.dataRoot);
    const text = await fs.readFile(path.join(cfg.dataRoot, "instruments.yaml"), "utf8").catch(() => null);
    const ctx = kindContextOf(d);
    return {
      exists: text !== null,
      catalog: text === null ? { cfds: [], futures: [], options: [], errors: [] } : parseInstruments(text),
      futureRoots: [...(ctx.futureRoots ?? [])].sort(), perpetuals: [...(ctx.perpetuals ?? [])].sort(), optionRoots: [...(ctx.optionRoots ?? [])].sort(),
    };
  });

  /** For every strategy in the workspace: can it run on bars and on ticks, and over which windows. */
  app.get<{ Querystring: { refresh?: string } }>("/api/data/readiness", async (req) => {
    const report = await scanCached(cfg.dataRoot, req.query.refresh === "1");
    const files = await listStrategies(cfg.workspace);
    const out = [];
    for (const f of files) out.push(readinessFor(report, f, await fs.readFile(path.join(cfg.workspace, f), "utf8").catch(() => ""), await resolveStrategy(cfg.workspace, f)));
    return { scannedAt: report.scannedAt, strategies: out };
  });


  // ---- project files: qkt.config.yaml, instruments.yaml, .env ---------------------------------------------------------
  app.get("/api/workspace/missing", async () => ({ missing: await missingFiles(cfg.workspace) }));
  // the given qkt.config.yaml text merged into the full reference (read-only: the editor applies it as an undoable edit)
  app.post<{ Body: { content?: string } }>("/api/workspace/config-complete", async (req, reply) => {
    const content = req.body?.content;
    if (typeof content !== "string" || content.length > 1_000_000) return reply.code(400).send({ error: "content must be the config text" });
    return { content: completeConfig(content) };
  });
  /** Create the standard project files that are missing (never overwrites). `files` limits which. */
  app.post<{ Body: { files?: ScaffoldFile[] } }>("/api/workspace/scaffold", async (req) => {
    const scan = await scanCached(cfg.dataRoot).catch(() => null);
    // sample strategies are only ever created when asked for by name: "add the missing project files" must not litter a workspace with them
    const files = Array.isArray(req.body?.files) ? req.body.files.filter((f) => [".env", ".env.example", ".gitignore", "qkt.config.yaml", "instruments.yaml", "strategies"].includes(f)) : ["qkt.config.yaml", "instruments.yaml", ".env", ".env.example", ".gitignore"] as ScaffoldFile[];
    const r = await scaffoldWorkspace(cfg.workspace, scan, files);
    return { ...r, missing: await missingFiles(cfg.workspace) };
  });

  // ---- extra sources and per-symbol preferences ---------------------------------------------------------------------
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const SYM = /^[A-Za-z0-9_.\-]{1,40}$/;
  const validSource = async (raw: unknown): Promise<{ ok: true; path: string } | { ok: false; status: number; error: string }> => {
    if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.includes("\0")) return { ok: false, status: 400, error: "source must be an absolute folder path" };
    const target = path.resolve(raw);
    const perm = dataRootAllowed(cfg, target);
    if (!perm.ok) return { ok: false, status: 403, error: perm.reason ?? "not allowed" };
    if (!(await fs.stat(target).then((x) => x.isDirectory(), () => false))) return { ok: false, status: 400, error: `${target} is not a folder the server can read` };
    return { ok: true, path: target };
  };

  /** Add a data folder symbols can be pointed at (the default source stays as it is). */
  app.post<{ Body: { path?: string } }>("/api/settings/sources", async (req, reply) => {
    const v = await validSource(req.body?.path);
    if (!v.ok) return reply.code(v.status).send({ error: v.error });
    cfg.sources = [...new Set([...(cfg.sources ?? []), v.path])].filter((p) => p !== cfg.dataRoot);
    await savePrefs(cfg);
    return { ...(await settingsView()), warnings: (await looksLikeStore(v.path)) ? [] : ["This folder has no `symbols/` or `bars/` directory."] };
  });
  app.delete<{ Body: { path?: string } }>("/api/settings/sources", async (req) => {
    const p = req.body?.path;
    cfg.sources = (cfg.sources ?? []).filter((x) => x !== p);
    for (const pref of Object.values(cfg.symbolPrefs ?? {})) if (pref.source === p) delete pref.source;
    await savePrefs(cfg);
    return settingsView();
  });

  /** Set or clear one symbol's source and usable date range. `null` clears a field; omitted fields are left alone. */
  app.put<{ Params: { symbol: string }; Body: { source?: string | null; from?: string | null; to?: string | null } }>("/api/settings/symbol/:symbol", async (req, reply) => {
    const { symbol } = req.params;
    if (!SYM.test(symbol)) return reply.code(400).send({ error: "bad symbol" });
    const b = req.body ?? {};
    const cur: SymbolPref = { ...(cfg.symbolPrefs?.[symbol] ?? {}) };
    if (b.source !== undefined) {
      if (b.source === null || b.source === cfg.dataRoot) delete cur.source;
      else {
        const v = await validSource(b.source);
        if (!v.ok) return reply.code(v.status).send({ error: v.error });
        if ((await scanSymbolIn(v.path, symbol)) === null) return reply.code(400).send({ error: `${v.path} has no data for ${symbol}` });
        cur.source = v.path;
        cfg.sources = [...new Set([...(cfg.sources ?? []), v.path])].filter((p) => p !== cfg.dataRoot);
      }
    }
    for (const k of ["from", "to"] as const) {
      const v = b[k];
      if (v === undefined) continue;
      if (v === null || v === "") delete cur[k];
      else if (typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v))) cur[k] = v;
      else return reply.code(400).send({ error: `${k} must be a YYYY-MM-DD date` });
    }
    if (cur.from && cur.to && cur.from >= cur.to) return reply.code(400).send({ error: "the start must be before the end (the end day is exclusive, like qkt --to)" });
    cfg.symbolPrefs = { ...(cfg.symbolPrefs ?? {}), [symbol]: cur };
    if (!cur.source && !cur.from && !cur.to) delete cfg.symbolPrefs[symbol];
    await savePrefs(cfg);
    return settingsView();
  });

  /** "Reset all": every symbol back to the default source and the full range it has. */
  app.post("/api/settings/reset-symbols", async () => { cfg.symbolPrefs = {}; await savePrefs(cfg); return settingsView(); });

  /** Everything known about one symbol across the default source and every added source, plus the effective preference. */
  app.get<{ Params: { symbol: string } }>("/api/data/symbol/:symbol", async (req, reply) => {
    const { symbol } = req.params;
    if (!SYM.test(symbol)) return reply.code(400).send({ error: "bad symbol" });
    const roots = [cfg.dataRoot, ...(cfg.sources ?? [])];
    const sources = await Promise.all(roots.map(async (root) => ({ root, isDefault: root === cfg.dataRoot, report: await scanSymbolIn(root, symbol) })));
    return { symbol, pref: cfg.symbolPrefs?.[symbol] ?? {}, sources };
  });

  /** One character per day (o ok, c closed, t thin, m missing) from the series' first day: the calendar in the symbol dialog. */
  app.get<{ Params: { symbol: string }; Querystring: { source?: string; kind?: string } }>("/api/data/symbol/:symbol/days", async (req, reply) => {
    const { symbol } = req.params;
    const root = req.query.source ? path.resolve(req.query.source) : cfg.dataRoot;
    if (root !== cfg.dataRoot && !(cfg.sources ?? []).includes(root)) return reply.code(400).send({ error: "unknown source" });
    const kind = req.query.kind ?? "ticks";
    const spec = kind === "ticks" ? "ticks" as const : (() => { const [broker, tf] = kind.split(":"); return broker && tf ? { broker, tf } : null; })();
    if (!spec) return reply.code(400).send({ error: "kind is `ticks` or `BROKER:TF`" });
    const r = await seriesDays(root, symbol, spec);
    return r ?? reply.code(404).send({ error: "no data" });
  });

  /**
   * "Auto-find": for every symbol, pick the source (default or added) whose data is best - longest complete run, then the most
   * complete days - and point the symbol there. Symbols already best in the default source are cleared back to it.
   */
  app.post("/api/data/auto-find", async () => {
    const roots = [cfg.dataRoot, ...(cfg.sources ?? [])];
    const reports = await Promise.all(roots.map(async (root) => ({ root, scan: await scanStore(root) })));
    const names = new Set(reports.flatMap((r) => r.scan.symbols.map((s) => s.symbol)));
    const score = (r: { scan: { symbols: Array<{ symbol: string; bars: Array<{ usable: Array<{ from: string; to: string }>; files: number }>; ticks: { usable: Array<{ from: string; to: string }> } | null }> } }, sym: string) => {
      const s = r.scan.symbols.find((x) => x.symbol === sym);
      if (!s) return -1;
      const ranges = [...s.bars.filter((b) => b.files > 0).flatMap((b) => b.usable), ...(s.ticks ? s.ticks.usable : [])];
      const l = longest(ranges);
      return l ? rangeDays(l) : 0;
    };
    const changes: Array<{ symbol: string; source: string; days: number }> = [];
    cfg.symbolPrefs = cfg.symbolPrefs ?? {};
    for (const sym of names) {
      let best = reports[0]!, bestScore = score(best, sym);
      for (const r of reports.slice(1)) { const sc = score(r, sym); if (sc > bestScore) { best = r; bestScore = sc; } }
      const pref = { ...(cfg.symbolPrefs[sym] ?? {}) };
      if (best.root === cfg.dataRoot) delete pref.source; else { pref.source = best.root; changes.push({ symbol: sym, source: best.root, days: bestScore }); }
      delete pref.from; delete pref.to; // auto = the whole range the chosen source has
      if (pref.source) cfg.symbolPrefs[sym] = pref; else delete cfg.symbolPrefs[sym];
    }
    await savePrefs(cfg);
    return { changes, sourcesChecked: roots.length, ...(await settingsView()) };
  });

  /** Every PORTFOLIO in the workspace with its members, and which portfolios each strategy file belongs to (for the Files tree). */
  app.get("/api/portfolios", async () => listPortfolios(cfg.workspace, await listStrategies(cfg.workspace)));

  /** Days accepted as having no data in the default source (see no-data.ts). */
  app.get("/api/data/no-data", async () => ({ dataRoot: cfg.dataRoot, entries: await readAccepted(cfg.dataRoot) }));
  type NoDataBody = { broker: string; symbol: string; tf: string; days: string[] };
  const noData = (fn: typeof acceptNoData | typeof undoNoData) => async (req: { body: NoDataBody }, reply: import("fastify").FastifyReply) => {
    try {
      const r = await fn(cfg.dataRoot, req.body ?? ({} as NoDataBody));
      if ("error" in r) return reply.code(400).send(r);
      invalidateScan();
      return r;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EROFS" || code === "EPERM") return reply.code(409).send({ error: `The data source is read-only here (${code}), so no day file can be written. Mount it writable to accept days.` });
      throw e;
    }
  };
  app.post<{ Body: NoDataBody }>("/api/data/no-data", noData(acceptNoData));
  app.post<{ Body: NoDataBody }>("/api/data/no-data/undo", noData(undoNoData));

  /** Kill switch: stop every run and job, and remove the partial output they leave behind. */
  app.post("/api/kill", async () => {
    const runs = await runner.cancelAll({ purge: true });
    const stopped = await jobs.cancelAll();
    invalidateScan();
    return { runs, jobs: stopped };
  });
}
