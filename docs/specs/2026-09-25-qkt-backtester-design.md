# qkt-backtester — design spec

Status: approved to build by the owner's `/goal` directive (2026-09-25). Every technical claim below is
tagged **[probed]** (verified against a real qkt run in this session, evidence in Appendix A) or
**[assumed]** (not yet verified; listed in §13).

## 1. What we are building

A browser workspace where a qkt user writes strategies and config, runs backtests, and studies the results,
all from **one Docker container** with **files as the only source of truth**.

```
┌ Explorer / Editor / Terminal ─┬ Charts (multi-timeframe) + Trades ─┬ Metrics / Equity / Monthly ─┐
│ qkt.config.yaml, *.qkt        │ TradingView-style, boxes, markers  │ Sharpe, PF, IS/OOS, Monte   │
│ live diagnostics (LSP)        │ trade table filters the chart      │ Carlo, run history/compare  │
└───────────────────────────────┴────────────────────────────────────┴─────────────────────────────┘
        every region collapsible / maximisable (dockview)      bottom: run pipeline + terminal
```

Users: the owner and other qkt users, **self-hosted, one container per user/team** (no accounts in v1;
optional access token). Priority order: correctness of what is shown > time-to-first-result > polish.

### Hard constraint: never modify qkt

The studio is a pure consumer of qkt's public surface: the CLI, `qkt lsp` (stdio), and files on disk.
Anything qkt lacks is built inside the studio. If a real upstream need appears it is recorded in §12,
not done here.

## 2. Architecture

```
browser (React + dockview + Monaco/Shiki + Lightweight Charts + ECharts + xterm)
   │ HTTP JSON · SSE (run events) · WebSocket (LSP bridge, terminal)
studio-server (Node 22, TypeScript, Fastify)
   ├─ fs API        /workspace (path-jailed)
   ├─ lsp bridge    WS ⇄ `qkt lsp` (stdio, one child per editor session)
   ├─ runner        queue → `qkt …` child processes (own process group), event tail, cancel
   ├─ postprocess   fills→round trips, metrics, monthly, integrity checks → runs/<id>/derived/
   ├─ bars service  reads qkt bar store (.bin), LOD aggregation, on-demand `qkt data build-bars`
   ├─ montecarlo    trade-list resampling (worker thread)
   └─ index         node:sqlite  runs/../.qkt-studio/index.sqlite  (derived; deletable) [probed: works on Node 22]
qkt engine: ghcr.io/elitekaycy/qkt:<tag> copied into the image (jlink runtime) [probed: 0.53.0 image runs]
```

Monorepo (pnpm workspaces): `packages/core` (pure, tested logic), `packages/server`, `packages/web`.

## 3. Workspace and file layout

Container mounts: `/workspace` (user files + runs), `/data` (qkt data store; default host `~/.qkt/data`).
Env set by the image: `QKT_DATA_HOME=/data` **[probed: bars store ignores config `data_root`; needs this env]**.

```
/workspace
  qkt.config.yaml                 user-owned, edited in the IDE
  strategies/*.qkt                user-owned
  .qkt-studio/index.sqlite        derived run index (rebuildable from runs/)
  runs/<runId>/
    run.json                      status, steps, params, hashes, engine version, waived days, timings
    source/  <strategy>.qkt  qkt.config.yaml (secrets redacted)
    engine/  result.json manifest.json trades.csv equity_*.csv orders.jsonl report.html …   (untouched qkt bundle)
    derived/ roundtrips.json summary.json monthly.json integrity.json bars-index.json
    robustness/ montecarlo-<method>-<seed>.json  walkforward/  grid/
    logs/    stdout.log stderr.log events.ndjson
```

**Run ID** `YYYYMMDDTHHMMSSZ_<strategy>_<hash8>`; `hash8` = sha256 over canonical JSON of
{strategy source, effective config bytes, params, from, to, tier, engine version+sha, execution flags,
data fingerprint}. Data fingerprint = sorted (file, size, mtime) of the bar/tick day files the run reads.
Same hash ⇒ cache hit (reuse, instant) unless "force re-run". The engine's own `manifest.json`
(sha256 per artifact, strategyHash, configHash) is verified after every run **[probed: fields exist]**.

`runs/` is append-only from the engine's point of view; `derived/` is always rebuildable from `engine/`.

## 4. Fidelity tiers (new, from probes)

| Tier | qkt flags | Measured speed [probed] | Use |
|---|---|---|---|
| **Draft** | `--bars` | 1 month 1.1 s, 1 year 2.5 s, 6-scenario grid 1.9 s | iterate |
| **Full** | ticks (default) | 1 month 13–31 s (+~7 s silent coverage check per month) | verify |

On a market-order strategy Draft and Full gave **identical** trades, P&L, win rate and drawdown for
Oct and Nov 2024 **[probed]**. qkt itself warns Draft is "bar-approximated intrabar fills" so stop/TP
strategies may differ. Rules: every run, chart and metric carries its tier badge; Draft results show a
"verify with Full" action; tier is part of the run hash. Auto-run on save uses Draft only.

## 5. Editor and diagnostics

- **Monaco** via slim imports (`monaco-editor/editor/editor.api.js` + `editor.worker.js` only; avoids the
  7 MB TS/CSS/HTML workers) **[probed]**. Highlighting: **Shiki + qkt's own `qkt.tmLanguage.json`**
  (`@shikijs/monaco`) so the studio matches the VS Code extension **[probed: renders]**.
- **LSP bridge**: WebSocket ⇄ `qkt lsp` stdio, own thin Monaco adapter (markers, hover, completion),
  not `monaco-languageclient` (fewer moving parts; qkt LSP offers only sync/hover/completion).
  Measured **[probed]**: init 360 ms, diagnostics 1–29 ms, hover 8 ms, completion 30 ms (254 unfiltered
  items ⇒ client filters), 30 rapid edits fully diagnosed in 26 ms, RSS ≈ 92 MB.
- **What the LSP misses [probed] and our fixes**:
  1. Unknown indicator: only `qkt parse` reports it, at `file:1:1` ⇒ run `qkt parse` on 600 ms idle and
     relocate the error by finding the offending identifier in the source.
  2. **Unknown stream alias produces a silent 0-trade run** ⇒ studio-side lint against declared
     `SYMBOLS` aliases, plus a "0 trades" result warning.
  3. One parse error at a time ⇒ show it; do not pretend completeness.
- `qkt.config.yaml` in the same editor: YAML syntax + JSON Schema written from `docs/reference/config-schema.md`
  (completion, unknown-key warnings; engine only rejects unknown `risk` keys **[probed]**), guarded by a
  contract test against `Config.kt` keys.

## 6. Run pipeline (every step visible)

Each row has status, duration, log and the exact command (copyable). Failure stops the pipeline.

1. **Project & config** — cwd = project root, explicit `--config`; error if the file is missing
   (**qkt silently uses defaults for a missing explicit `--config`** [probed]); warn if config `data_root`
   ≠ `QKT_DATA_HOME`.
2. **Config check** — YAML + schema.
3. **`qkt parse <file>`** + alias lint.
4. **Data coverage** — Draft: engine bar coverage (fast, calendar-aware, prints `qkt data build-bars …`
   remedy); Full: engine tick coverage. **Silent for ~9 s on 2 months [probed]** ⇒ shown as an
   indeterminate "checking data" phase, never as a hang. Missing data ⇒ **no auto-fetch (`--no-fetch`)**;
   offer "Build bars" (`qkt data build-bars`, ~1 s for 4 days, byte-identical output [probed]) /
   "Fetch" (`qkt fetch`) / "Run anyway" (`--allow-incomplete`, waived days recorded).
5. **`qkt backtest … --report-dir runs/<id>/engine`** — stdout/stderr tailed; engine logs every order/fill
   live [probed] ⇒ live fill counter and progressive chart markers.
6. **Post-process** — verify manifest sha256, derive round trips, metrics, monthly, integrity.
7. **Render**.

Progress: no engine progress signal exists [probed]. Single run = phase + elapsed + ETA from earlier runs
of the same shape (symbols × range × tier), stored in the index. Multi-run jobs (grid, walk-forward) get
determinate progress from finished child runs.

Cancel: SIGTERM to the process group; measured **63 ms exit, no partial run dir, no orphan JVM** [probed].
A newer save cancels an in-flight auto-run; results carry a sequence number and stale ones are dropped.
Restart recovery: `run.json` non-terminal states are marked `interrupted` on boot.

Error normalisation table (qkt prints raw Java stack traces for bad YAML / unknown symbol **[probed]**):
parse error, unknown indicator, missing data, incomplete data, bad config YAML, unknown risk key, missing
config, engine crash ⇒ `{kind, message, file?, line?}` shown in the pipeline and Problems list.

## 7. Results model

- **Trades = round trips**, derived from `trades.csv` (one row **per fill**; engine `tradeCount` counts
  fills — 81 fills = 40 round trips + 1 open **[probed]**). Pairing uses `strategyPositionQtyAfter` /
  `positionEffect` / `legId`; handles partial closes, scale in/out, reversals, hedged legs, open-at-end.
- **Reconciliation gate**: Σ fill `realized` must equal engine `global.realizedTotal` (exact on both
  probed runs). Mismatch ⇒ visible red integrity badge, never hidden.
- Metrics come from `result.json` (`global`, `perStrategy`: sharpe, sortino, calmar, PF, win rate, DD,
  daily P&L, …) plus derived (expectancy, avg hold, best/worst, long/short split, monthly grid).
  Unrealized P&L at end is shown separately from realized (383.40 vs 376.85 [probed]).
- In/out-of-sample: `qkt walkforward … --report-dir` (5 folds in 3.6 s, summary CSV/JSON + stitched
  out-of-sample equity [probed]) and `qkt experiment` (train/validation/test plan).
- Parameter grids: **`qkt sweep` has no `--report-dir`, and its `--json` stdout is mixed with ~3.7k engine
  log lines [probed]** ⇒ the studio runs each grid point as its own `qkt backtest --param` (Draft ≈1 s
  each, bounded parallelism) so every scenario has full bundles; a tolerant JSON extractor is kept for
  `sweep --json`. Sweep `selectionWarnings` (multiple-testing guard) are surfaced.
- Monte Carlo: engine's is fixed (1000 sims, seed 42, bootstrap, ≥30 trades). Studio implements
  shuffle / bootstrap / block-bootstrap / skip-trades on the round-trip list in a worker thread, seed stored
  in the manifest, fan chart + drawdown histogram + P(ruin). Re-run-based methods (randomised entry,
  parameter perturbation) are queued jobs (v1.1).

## 8. Charts

- **Lightweight Charts v5** (Apache-2.0, **attribution logo must remain**) for price; one chart per
  traded (symbol, timeframe), time-range-synced across timeframes with a re-entrancy guard **[probed: 15m↔1h]**.
  Trade boxes = series primitive (entry→exit rectangle, colour by P&L) **[probed: 40/40 drawn]**;
  entry/exit arrows via `createSeriesMarkers` **[probed: 80]**.
- Bars are read straight from the qkt bar store (`QKB1` v1 little-endian columnar, scale 8)
  **[probed: decoder matches engine counts exactly]**; other timeframes via `qkt data build-bars`;
  large ranges are LOD-aggregated by zoom on the server; no gap filling, UTC everywhere.
- Trade table (virtualised, server-side paging) ⇄ chart selection: side/outcome/date/duration filters
  drive markers and boxes. Any panel maximises to full view.
- ECharts for equity, drawdown, monthly heatmap, Monte Carlo fan, grid table.

## 9. Data and calendar correctness

- Three visual categories per day: **non-trading** (hatched), **expected break** (faint; engine tolerates one
  empty interior hour), **hole** (red, hours listed).
- **qkt's calendar is not holiday-aware [probed]**: 2026-01-19 (MLK) flagged incomplete
  (empty hours 20–22), 2026-04-03 (Good Friday) flagged missing. Provider gaps therefore need a
  **waive** action; waived days persist in `run.json` and stay visible.
- The tick store is sparse in practice (e.g. XAUUSD months missing between 2024-12 and 2026-01)
  [probed] ⇒ coverage UX is a first-class feature, not an error path.
- `--to` is **exclusive** [probed] ⇒ all window arithmetic in the studio uses `[from, to)`.
- Integrity badge per run: (a) studio bar count == engine `inputSummary.streamCandles` for the window
  (exact [probed]); (b) fills inside their bar's [low, high] (81/81 [probed], tolerance for spread);
  (c) P&L reconciliation; (d) manifest checksums.

## 10. Packaging (one container)

```
FROM ghcr.io/elitekaycy/qkt:<pinned>      (engine + jlink JRE, /opt/qkt)   [probed: :dev = 0.53.0, 205 MB]
+ node 22, studio build, non-root user with configurable UID/GID
ENV QKT_DATA_HOME=/data  HOME=/tmp/home
ENTRYPOINT studio-server            docker run -p 8080:8080 -v ~/.qkt:/qkt -v $PWD:/workspace …
```

Image tag = qkt version. Same trades/results under qkt 0.49.0 and 0.53.0 with schema
`qkt-backtest-result-v1` unchanged **[probed]**; studio still checks `schemaVersion` and refuses unknown
majors. UID: container runs as `--user $(id -u):$(id -g)` [probed] to avoid unwritable bind mounts.
First run ships a sample workspace (strategy + config); no data ⇒ guided "build bars / fetch" step.

## 11. Security (single-user default)

Path-jailed fs API (resolve + realpath prefix check, no symlink escape); optional bearer token; WebSocket
origin check; secrets in config (`api_key`, `${VAR}` expansions) redacted in `source/` snapshots and never
sent to the browser; each run child gets `ulimit`/cgroup memory cap, wall-clock timeout, no shell.
The terminal is a real shell **only when a token is set or bound to localhost**; otherwise a restricted
qkt-only terminal. Multi-tenant hosting is out of scope for v1.

## 12. Non-goals (v1) and optional upstream asks

Non-goals: accounts/multi-tenant, live trading, tick-level charts, plugin indicators, cloud storage.
Optional upstream asks (never blockers): `--progress ndjson`, a flag to skip the tick coverage scan,
`qkt sweep --report-dir`, JSON diagnostics from `qkt parse`, holiday-aware calendar.

## 13. Edge-case register

| # | Edge case | Fix | Evidence |
|---|---|---|---|
| E1 | Missing explicit `--config` silently uses defaults | studio checks existence, blocks run | probed |
| E2 | Unknown top-level config key silently accepted | JSON Schema warning | probed |
| E3 | Bad YAML / unknown symbol → Java stack trace | normalise to `{kind,message}` | probed |
| E4 | Unknown alias → 0-trade run, no error | alias lint + zero-trade warning | probed |
| E5 | Unknown indicator reported at 1:1 | relocate by identifier search | probed |
| E6 | Parser reports one error | show first; no false completeness | probed |
| E7 | Bars ignore config `data_root` | set `QKT_DATA_HOME`; warn on mismatch | probed |
| E8 | Coverage check silent 7–9 s | indeterminate "checking data" phase | probed |
| E9 | Holidays flagged as holes | waive workflow persisted in run.json | probed |
| E10 | Sparse tick store | coverage map first-class | probed |
| E11 | `--to` exclusive | `[from,to)` everywhere | probed |
| E12 | `tradeCount` = fills | round-trip derivation + label | probed |
| E13 | Unrealized vs realized totals | show separately | probed |
| E14 | `sweep` no report-dir, JSON mixed with logs | studio-owned grid + tolerant extractor | probed |
| E15 | Draft vs Full fidelity | tier badge, in run hash, "verify Full" | probed (identical on market-order) |
| E16 | Cancel leaves debris | process-group SIGTERM; no partial dir | probed |
| E17 | Foreign qkt JVMs on host (other harness) | only manage PIDs we spawned | observed |
| E18 | Stale result after newer run | sequence number, drop stale | design |
| E19 | New data after fetch, same run hash | data fingerprint in hash | design |
| E20 | Server restart mid-run | boot-time `interrupted` sweep | design |
| E21 | Two identical runs at once | join in-flight run | design |
| E22 | Fill→round-trip pairing edge cases | reconciliation gate + fixtures | design + probed (simple) |
| E23 | Multi-million-row trades / bars | server paging, LOD, virtual table | design |
| E24 | Secrets in config snapshots | redact on snapshot, never to browser | design |
| E25 | Path traversal / symlinks in fs API | realpath jail + tests | design |
| E26 | Bind-mount UID mismatch | `--user`, entrypoint permission check with fix hint | probed (uid run) |
| E27 | Docker Desktop unreliable inotify | polling fs watch fallback | design |
| E28 | Version drift engine vs store | image tag = qkt version; schemaVersion gate | probed |
| E29 | LSP crash | supervised restart, editor falls back to `qkt parse` | design |
| E30 | Two tabs saving one file | mtime/etag optimistic concurrency | design |
| E31 | Bundle size (Monaco all-languages) | slim imports (7 MB workers removed) | probed |
| E32 | MC with <30 trades | disabled with explanation | design |

Unverified before build (**[assumed]**): bid/ask/mid side of stored bars vs fill prices; `qkt fetch`
behaviour offline; behaviour of Draft vs Full on stop/TP strategies; Docker Desktop file-watch behaviour;
holiday handling in non-XAUUSD calendars. Each has a test or explicit UI disclosure in the plan.

## Appendix A — probe evidence (all in this session, qkt 0.49.0 local / 0.53.0 docker)

| Probe | Result |
|---|---|
| Cold `qkt parse` | 0.49 s; `--version` 0.12 s |
| Full tick backtest XAUUSD 15m | 1 month 13–31 s (7 s of it coverage); 3 months coverage alone 13 s |
| Draft `--bars` | 1 month 1.1 s; year 2024 2.45 s; identical results to Full on Oct/Nov 2024 |
| Bar decode (Node) | `QKB1` v1, exact count match with engine `liveCandles` (2021) once `--to` exclusive |
| Fills vs bars | 81/81 inside bar; Σ realized == `realizedTotal` (376.85, diff 0) |
| LSP | init 360 ms; diag 1–29 ms; hover 8 ms; completion 30 ms/254 items; burst 30 edits 26 ms; ≈92 MB |
| Semantic errors | unknown indicator → `parse` @1:1; unknown alias → nothing, run yields 0 trades |
| Container | `ghcr.io/elitekaycy/qkt:dev` 0.53.0; needs `QKT_DATA_HOME`; 1.7 s Draft month; identical to 0.49 |
| Cancel | SIGTERM pgroup → exit 143 in 63 ms; no partial dir |
| build-bars | 4 days 15m in ~1.1 s; byte-identical to existing store |
| node:sqlite | works on Node 22.22 (experimental warning) |
| Sweep | 6 scenarios 1.9 s; no `--report-dir`; JSON mixed with logs |
| Walk-forward | 5 folds 3.6 s; summary + stitched OOS equity + per-fold bundles |
| UI spike (headless Chrome) | dockview 4 panels; Shiki-highlighted Monaco + squiggle; 2 synced LWC charts (15m/1h), 40 boxes, 80 markers; ECharts; xterm; layout resize |
