# qkt-backtester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, chosen by the owner's `/goal`
> directive to run straight through). Steps use checkbox syntax.

**Goal:** A one-container browser workspace to write qkt strategies/config, run Draft/Full backtests, and study
results (multi-timeframe charts, trade table, metrics, Monte Carlo) — without modifying qkt.

**Architecture:** TypeScript pnpm monorepo. `core` = pure, fixture-tested logic (bars, round trips, hashing,
parsers, Monte Carlo). `server` = Fastify (HTTP, SSE, WebSocket) spawning `qkt` child processes in their own process
groups and post-processing bundles into `runs/<id>/derived`. `web` = React + dockview + Monaco/Shiki + Lightweight
Charts + ECharts + xterm. Files are truth; `node:sqlite` is a rebuildable index.

**Tech Stack:** Node 22, TypeScript, pnpm workspaces, Fastify 5, ws, vitest, React 19, Vite, dockview-react 8,
monaco-editor 0.56 (slim imports), shiki + @shikijs/monaco, lightweight-charts 5, echarts 6, @xterm/xterm 6,
puppeteer-core (e2e, system Chrome). Engine: `ghcr.io/elitekaycy/qkt:<tag>` (0.53.0 at time of writing).

**Spec:** `docs/specs/2026-09-25-qkt-backtester-design.md` (evidence in its Appendix A; probes in `probes/`).

## Global Constraints

- Never modify qkt; consume only its CLI, `qkt lsp` (stdio) and files on disk.
- Window semantics are `[from, to)` — qkt `--to` is exclusive.
- UTC everywhere; no gap filling in charts.
- Trades shown to users are round trips; engine `tradeCount` counts fills and must be labelled as such.
- Every run/metric/chart carries its tier (Draft = `--bars`, Full = ticks); tier is part of the run hash.
- No auto-fetch: always pass `--no-fetch`; fetching/building data is an explicit user action.
- Set `QKT_DATA_HOME` for every qkt child (bar store ignores config `data_root`); always pass an explicit `--config` and
  block the run if that file does not exist.
- Lightweight Charts attribution logo stays visible.
- Secrets (`api_key`, `${VAR}` expansions) are redacted in `runs/*/source/` snapshots and never sent to the browser.
- Monaco imports use `monaco-editor/editor/editor.api.js` and `.../editor.worker.js` only.
- Node ≥ 22.5 (`node:sqlite`); pnpm workspace; ESM only.

## Review Focus

1. **Empty / weird workspaces** — no config, empty `strategies/`, no data store: UI must guide, not crash (task 8, 12).
2. **Path escape** — `../`, absolute paths, symlinks out of `/workspace` in every fs endpoint (task 7).
3. **Huge outputs** — 1M-fill `trades.csv`, multi-year 1m bars: paging/LOD, no full-file JSON to the browser (tasks 1, 9, 12).
4. **Stale/racing runs** — save-spam with auto-run, cancel during post-process, server restart mid-run (task 8).
5. **Numeric drift** — scaled-int prices, float PnL sums: reconciliation must use a tolerance stated in one place (task 3).

---

## File structure

```
package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts
packages/core/src/
  bars.ts          QKB1 decode, day-store reader, LOD aggregate
  roundtrips.ts    fills -> round trips, reconcile
  results.ts       result.json gate, summary, monthly, integrity checks
  runid.ts         canonical hash, run id, data fingerprint
  runjson.ts       run.json types + state machine
  outputs.ts       stdout/stderr classifier, error normaliser, sweep JSON extractor
  lint.ts          alias lint, parse-error relocation, config redaction, config checks
  montecarlo.ts    seeded PRNG + 4 methods + stats
  index.ts
packages/core/test/  *.test.ts  + fixtures/ (real qkt outputs)
packages/server/src/
  main.ts config.ts jail.ts fs-routes.ts runner.ts pipeline.ts postprocess.ts index-db.ts
  lsp-bridge.ts terminal.ts bars-routes.ts run-routes.ts data-routes.ts jobs.ts
packages/web/src/   shell/ editor/ charts/ panels/ api/ main.tsx
docker/Dockerfile  docker-compose.yml  sample-workspace/  scripts/e2e.mjs
```

---

### Task 1: Monorepo scaffold + real-output fixtures

**Files:** Create root configs above; `packages/core/test/fixtures/{bars-2024-10-02.bin, trades-oct.csv, result-oct.json, manifest-oct.json, sweep-mixed-stdout.txt, err-*.txt}` copied from real runs
(`~/.qkt/data/bars/BACKTEST/XAUUSD/15m/2024-10-02.bin`, `/tmp/rb_oct/*`, `/tmp/sw_out.json`, captured stderr of the error cases).

**Interfaces:** Produces the workspace layout and `pnpm -r test` / `pnpm -r build`.

- [ ] Init workspaces, tsconfig (strict, ESM, NodeNext for server/core; bundler for web), vitest.
- [ ] Copy fixtures (trim `trades-oct.csv` to the real 81 rows; keep result JSON whole).
- [ ] `pnpm -r test` runs (0 tests OK). Commit `chore: scaffold + fixtures`.

### Task 2: core/bars — decoder, store, LOD

**Files:** `core/src/bars.ts`, `core/test/bars.test.ts`.

**Interfaces:** Produces
```ts
type BarCols = { ts: Float64Array; open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array; volume: Float64Array; tfMs: number };
decodeBarDay(buf: Uint8Array): BarCols                    // throws QktFormatError on bad magic/version
readBars(dataRoot, broker, symbol, tf, fromMs, toMsExclusive): Promise<{cols: BarCols; days: string[]; missingDays: string[]}>
availableTimeframes(dataRoot, broker, symbol): Promise<string[]>
lodAggregate(cols: BarCols, maxBars: number): BarCols      // OHLCV-correct bucket merge
```
- [ ] Tests: fixture day decodes to 92 bars, tfMs 900000, first ts/prices match a known value from the Node probe; bad magic and version 2 throw `QktFormatError`; `lodAggregate(92 bars,23)` keeps first open/last close/max high/min low and ts strictly increasing; reading Oct with `to` exclusive returns 2021 bars (skip if store absent).
- [ ] Implement (DataView, little-endian, scale from header, BigInt→Number). Run tests. Commit.

### Task 3: core/roundtrips — pairing and reconciliation

**Files:** `core/src/roundtrips.ts`, `core/test/roundtrips.test.ts`.

**Interfaces:** Produces
```ts
type Fill = { ts:number; strategy:string; symbol:string; side:'BUY'|'SELL'; effect:string; qty:number; price:number; realized:number; posQtyAfter:number; legId?:string; orderId:string; sl?:number; tp?:number };
type RoundTrip = { id:number; strategy:string; symbol:string; side:'long'|'short'; entryTs:number; entryPx:number; exitTs:number|null; exitPx:number|null; qty:number; pnl:number; fills:number; holdMs:number|null; open:boolean };
parseTradesCsv(text: string): Fill[]
pairRoundTrips(fills: Fill[]): RoundTrip[]
reconcile(roundTrips, engineRealized:number, tol?:number): {ok:boolean; diff:number}
```
- [ ] Tests (each with explicit fills): real fixture → 40 round trips + 1 open, Σpnl 376.85 = engine realized; partial close (2 lots in, 1 out, 1 out → 1 round trip, 3 fills); scale-in (2 opens, 1 close → 1 trip, avg entry weighted); reversal in one fill (long→short: closes long trip, opens short); two symbols interleaved; hedged opposite legs kept separate by `legId`; still-open position at end → `open:true` excluded from realized; empty input → [].
- [ ] Implement per (strategy,symbol[,legId]) position state machine using `posQtyAfter`. Tolerance constant `PNL_TOL = 0.005` exported. Commit.

### Task 4: core/results — gate, summary, monthly, integrity

**Files:** `core/src/results.ts`, `core/test/results.test.ts`.

**Interfaces:** Produces
```ts
loadResult(json: unknown): QktResult                       // throws on schema != 'qkt-backtest-result-v1' or schemaVersion != 1
summarize(result: QktResult, trips: RoundTrip[]): Summary  // winRate, PF, expectancy, avgHold, long/short split, sharpe, sortino, calmar, maxDD, realized, unrealized, fills, trades
monthlyPnl(trips: RoundTrip[]): {month:string; pnl:number; trades:number}[]
integrity(input:{result:QktResult; trips:RoundTrip[]; fills:Fill[]; barCount?:number; bars?:BarCols}): IntegrityReport // {barCount, fillsInBars, reconcile, manifest} each {ok,detail}
```
- [ ] Tests: fixture result loads; unknown schema/version throws; summary fixture = winRate 0.425, 40 trips, tradeCount label 81 fills; monthly sums equal total; integrity: bar count 2021 == `liveCandles`, 81/81 fills inside bars (with synthetic bars when store absent), tampered pnl → reconcile fails; Draft-only spread tolerance parameter.
- [ ] Implement. Commit.

### Task 5: core/runid + runjson

**Files:** `core/src/runid.ts`, `core/src/runjson.ts`, tests.

**Interfaces:** Produces
```ts
canonicalJson(v: unknown): string                          // sorted keys, stable numbers
runHash(input: RunHashInput): string                       // sha256 hex
makeRunId(now: Date, strategy: string, hash: string): string   // YYYYMMDDTHHMMSSZ_<strategy>_<hash8>
dataFingerprint(files: {path:string;size:number;mtimeMs:number}[]): string
type RunStatus = 'queued'|'checking'|'running'|'postprocessing'|'done'|'failed'|'cancelled'|'interrupted'
transition(from: RunStatus, to: RunStatus): RunStatus      // throws on illegal
```
- [ ] Tests: key-order independence; changing tier/param/data fingerprint/engine version changes hash; strategy name sanitised (`../x` → `x`); legal/illegal transitions; `done`/`failed`/`cancelled` terminal.
- [ ] Implement. Commit.

### Task 6: core/outputs — classifier, error normaliser, sweep extractor

**Files:** `core/src/outputs.ts`, tests with the real captured stderr fixtures.

**Interfaces:** Produces
```ts
classifyLine(line: string): {kind:'coverage'|'barCoverage'|'fill'|'order'|'warning'|'error'|'log'|'incomplete'; data?: any}
parseIncomplete(text: string): {day:string; status:'missing'|'incomplete'; emptyHours:number[]}[]
normalizeError(stderr: string, exitCode: number): {kind:ErrorKind; message:string; file?:string; line?:number; col?:number}
extractJsonDocs(stdout: string): unknown[]                  // line-start { or [ + raw decode
```
- [ ] Tests from real captures: tick coverage `26/27`; bar coverage line; incomplete list (MLK day hours 20,21,22; Good Friday `missing`); Java stack for bad YAML → `bad_config_yaml`; `IncompleteDataException` for unknown venue symbol → `missing_data`; `unknown risk key(s): nope` → `bad_config_key`; `Unknown indicator: emaa` → `unknown_indicator`; parse error `file:6:1 — …` → kind `parse` with line/col; sweep stdout with 3678 log lines yields exactly 1 array of 6.
- [ ] Implement. Commit.

### Task 7: core/lint — alias lint, relocation, config checks, redaction

**Files:** `core/src/lint.ts`, tests.

**Interfaces:** Produces
```ts
lintAliases(source: string): Diagnostic[]                  // uses declared SYMBOLS aliases; flags `x.close` where x undeclared
relocate(source: string, msg: string): Range | null        // 'Unknown indicator: emaa' -> range of `emaa`
redactConfig(yaml: string): string                         // api_key/secret/password/token values and ${VAR} -> ***
checkConfig(yaml: string, fileExists:boolean, env:{QKT_DATA_HOME?:string}): Finding[] // missing file, bad YAML, data_root mismatch, unknown top-level key
```
- [ ] Tests: `gld.close` flagged, `gold.close` not; alias declared in SYMBOLS with prefix `BACKTEST:` parsed; relocation finds `emaa(` on line 6 col 10; redaction keeps structure, hides `api_key: abc` and `${TOKEN}`; unknown top-level key flagged, known keys (`source data_root starting_balance runtime account execution promotion tv fetchers brokers risk state notify insights book_risk market_data hub bybit log_level`) pass; data_root ≠ env warns.
- [ ] Implement (line-oriented; no YAML dependency in core except `yaml` package for parsing). Commit.

### Task 8: core/montecarlo

**Files:** `core/src/montecarlo.ts`, tests.

**Interfaces:** Produces
```ts
mulberry32(seed:number): () => number
runMonteCarlo(pnls:number[], opt:{method:'shuffle'|'bootstrap'|'block'|'skip'; sims:number; seed:number; startEquity:number; blockLen?:number; skipPct?:number}): McResult // {paths quantiles P5/25/50/75/95 by index, finalEquity quantiles, maxDD quantiles, probNegative, probRuin(threshold), seed, method}
```
- [ ] Tests: same seed ⇒ identical result; shuffle preserves final equity for every path; bootstrap final varies; block length respected; skip 0% = original; <30 trades ⇒ throws `TooFewTrades` (UI disables); quantile ordering P5≤P50≤P95.
- [ ] Implement. Commit.

### Task 9: server foundation — config, path jail, fs routes, etag

**Files:** `server/src/{main,config,jail,fs-routes}.ts`, tests with tmp dirs.

**Interfaces:** Produces `resolveInJail(root, rel): string` (throws `JailError`); routes `GET /api/tree`, `GET/PUT/POST/DELETE /api/file?path=` with `If-Match: <mtime-etag>`; server config from env (`QKT_BIN`, `WORKSPACE`, `DATA_ROOT`, `PORT`, `TOKEN`).
- [ ] Tests: `../etc/passwd`, absolute path, symlink to outside, NUL byte → 400; write with stale etag → 412; create/rename/delete; tree hides `runs/` internals lazily and `.qkt-studio`; token required when configured.
- [ ] Implement (realpath prefix check both on existing path and on parent for creation). Commit.

### Task 10: server runner + pipeline

**Files:** `server/src/{runner,pipeline,postprocess,index-db}.ts`, integration tests against real qkt (skipped if `QKT_BIN` unavailable).

**Interfaces:** Consumes core. Produces
```ts
type RunRequest = { strategy:string; from:string; to:string; tier:'draft'|'full'; params:Record<string,string>; allowIncomplete?:boolean; waived?:string[]; force?:boolean };
class Runner { submit(req):Promise<{runId:string; cached:boolean}>; cancel(runId):Promise<void>; on(runId, cb):Unsub; recover():Promise<void> }
```
- [ ] Tests (real qkt, Draft, Oct 2024): submit → steps project/config/parse/coverage/backtest/postprocess/render all `done`, `derived/*` exist, integrity all ok; resubmit ⇒ `cached:true` with no child spawned; missing config ⇒ fails at step 1 (never spawns qkt); unknown alias ⇒ step 3 warning + zero-trade warning; cancel mid-Full run ⇒ status `cancelled`, no `engine/` debris, no surviving child pid; newer submit for same strategy cancels older auto-run; kill the server mid-run then `recover()` ⇒ `interrupted`; two identical concurrent submits ⇒ one child.
- [ ] Implement: child in `detached` process group, env `QKT_DATA_HOME`, cwd=workspace, args include `--no-fetch --config <abs>`; `--bars` for draft; stdout/stderr tail → `classifyLine` → events (ndjson file + SSE); SIGTERM→SIGKILL after 3 s; only PIDs we spawned are ever signalled; index rows in `node:sqlite`. Commit.

### Task 11: server routes — runs, results, bars, trades, data, jobs, LSP, terminal

**Files:** `server/src/{run-routes,bars-routes,data-routes,jobs,lsp-bridge,terminal}.ts`, tests.

**Interfaces:** Produces HTTP:
`GET /api/runs`, `GET /api/runs/:id` (run.json), `GET /api/runs/:id/summary|monthly|integrity`, `GET /api/runs/:id/trades?offset&limit&side&outcome&from&to&minHold&maxHold&sort`, `GET /api/runs/:id/events` (SSE, `Last-Event-ID` replay), `POST /api/runs`, `DELETE /api/runs/:id`, `GET /api/bars?broker&symbol&tf&from&to&max` (binary columnar, `X-Bars-*` headers incl. `missingDays`), `GET /api/data/coverage?symbol&tf&from&to`, `POST /api/data/build-bars`, `POST /api/data/fetch`, `POST /api/jobs/grid|walkforward|montecarlo`, `GET /api/jobs/:id`; WS `/ws/lsp` (spawns `qkt lsp`, supervised restart) and `/ws/term`.
- [ ] Tests: trades paging + filters against the real run; 1M synthetic round trips paged in <200 ms/page (perf guard); bars endpoint honours `[from,to)` and LOD `max`; LSP bridge round-trips `initialize` + diagnostics for a bad doc; killed LSP child is respawned; grid job with 6 scenarios makes 6 run dirs and a ranked summary; walkforward job reads `walkforward_summary.json`; MC job persists seed.
- [ ] Implement. Terminal via `script -qfc bash /dev/null` (pty without native modules) only when token set or bound to localhost; otherwise qkt-only. Commit.

### Task 12: web shell — layout, files, editor, diagnostics, pipeline, terminal

**Files:** `web/src/shell/*`, `web/src/editor/{monaco.ts,lsp-client.ts,markers.ts}`, `web/src/panels/{Pipeline,Problems,Terminal}.tsx`.

- [ ] dockview layout with the spike's regions; every group collapsible/maximisable; layout persisted in `localStorage` (try/catch); file tree with create/rename/delete; tabs; `qkt.config.yaml` opens like any file.
- [ ] Monaco slim + Shiki (`qkt.tmLanguage.json`) + thin LSP adapter (markers, hover, completion with client-side prefix filter), 250 ms debounce for LSP, 600 ms idle for `qkt parse`+lint; Problems panel; unsaved-buffer and etag conflict banner.
- [ ] Run bar: tier switch (Draft default), range presets, params form from `PARAM`s, Run/Cancel, auto-run toggle (Draft only, off by default); Pipeline panel with per-step status/duration/command/log fed by SSE.
- [ ] Verify with puppeteer script: type a bad token → squiggle within 1 s; fix → clears; Run → pipeline all green. Commit.

### Task 13: web results — charts, table, metrics, compare, Monte Carlo

**Files:** `web/src/charts/{PriceChart,TradeBoxPrimitive,sync.ts}.tsx`, `web/src/panels/{TradeTable,Metrics,Equity,Monthly,MonteCarlo,Runs,Coverage}.tsx`.

- [ ] One price chart per traded (symbol, tf) from `/api/bars`; boxes + arrows from round trips; time-range sync with re-entrancy guard; maximise; viewport preserved across runs; stale results dimmed until the new run lands, then atomic swap; tier + integrity badges.
- [ ] Trade table (virtualised, server-paged) with side/outcome/date/duration filters that also filter chart overlays; click row ⇒ chart jumps to trade.
- [ ] Right panel: headline metrics, equity+drawdown, monthly heatmap, IS/OOS (walk-forward stitched equity), Monte Carlo (method/sims/seed form → fan chart, drawdown histogram, P(ruin)), run history with compare (metric deltas, equity overlay).
- [ ] Coverage strip under each chart: non-trading hatched / expected break faint / holes red with hours, with Build bars / Fetch / Waive actions.
- [ ] Puppeteer e2e assertions: boxes drawn == round trips, filter to shorts reduces boxes, table row click moves chart, MC produces fan. Commit.

### Task 14: Docker image, sample workspace, e2e, docs

**Files:** `docker/Dockerfile`, `docker-compose.yml`, `sample-workspace/`, `scripts/e2e.mjs`, `README.md`, `AGENTS.md`.

- [ ] Dockerfile: multi-stage — node build stage; final `FROM ghcr.io/elitekaycy/qkt:<pinned>` + Node 22 + studio; `ENV QKT_DATA_HOME=/data HOME=/tmp/home`; entrypoint checks `/workspace` and `/data` writability and prints a fix hint (`--user $(id -u):$(id -g)`).
- [ ] Sample workspace (config + two strategies) and a bundled tiny bar fixture so first run works with zero data.
- [ ] `docker build`, run with host UID and `~/.qkt/data` mounted; e2e script drives the running container (Draft run, chart boxes, filters, MC, cancel, restart recovery).
- [ ] README: one-command quickstart, mounts, tiers, troubleshooting (permissions, missing data, holidays). Commit.

### Task 15: Final verification

- [ ] `pnpm -r test`, `pnpm -r build`, docker e2e all green; re-run spec's Appendix-A probes against the container as a regression.
- [ ] Walk the edge-case register (§13): each E-row has a passing test or a documented UI disclosure; update the register with actual status.
- [ ] Save project memory. Report honestly what is verified vs assumed.

## Self-review

- **Spec coverage:** §4 tiers → tasks 10/12; §5 editor → 7/12; §6 pipeline → 6/10/12; §7 results/MC/grid/OOS → 3/4/8/11/13; §8 charts → 2/13; §9 data → 6/11/13; §10 packaging → 14; §11 security → 9/11/14; §13 register → 15.
- **Placeholders:** none; unverified items (bar side, offline fetch, Draft vs Full on stop/TP strategies, Docker Desktop watchers, non-XAUUSD calendars) are disclosed in the UI/README, not silently assumed.
- **Type consistency:** `Fill`, `RoundTrip`, `BarCols`, `RunStatus`, `RunRequest` are defined once (tasks 2–5, 10) and reused verbatim.
