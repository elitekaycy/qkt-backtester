# qkt-backtester — design spec

Status: BUILT and verified (see §14). Approved to build by the owner's `/goal` directive (2026-09-25). Every technical claim below is
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
- **What the LSP misses [probed] and our fixes** (as of qkt 0.49; see §18 for what qkt 0.54 changed):
  1. Unknown indicator: only `qkt parse` reports it, at `file:1:1` ⇒ run `qkt parse` on 600 ms idle and
     relocate the error by finding the offending identifier in the source. *Superseded: qkt 0.54 positions it.*
  2. **Unknown stream alias produces a silent 0-trade run** ⇒ studio-side lint against declared
     `SYMBOLS` aliases, plus a "0 trades" result warning. *Superseded: qkt 0.54 makes it a compile error.*
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
| E4 | Unknown alias → 0-trade run, no error (qkt ≤ 0.53) | qkt 0.54 reports it as a compile error at its position; the studio's lint still lists every one | probed, re-probed 2026-09-30 |
| E5 | Unknown indicator reported at 1:1 (qkt ≤ 0.53) | qkt 0.54 positions it; relocation removed. Only a missing IMPORT stays at 1:1 (`locateImport`) | probed, re-probed 2026-09-30 |
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

## 14. Implementation status and verification (added after the build)

Suites: core 143 tests, server 76 (real qkt + real data), web 9; browser e2e 35 checks (local, XAUUSD) and 23 checks
(fresh Docker install with the synthetic demo). All green at the time of writing.

### Edge-case register: what verifies each row

| # | Status | Verified by |
|---|---|---|
| E1 missing config | done | runner test (never spawns qkt), lint tests |
| E2 unknown top-level key | done | lint + `/api/check` tests |
| E3 stack traces | done | outputs tests on real captures, runner bad-YAML test |
| E4 unknown alias | done (qkt's error + lint) | lint, runner, `/api/check` tests, e2e |
| E5 unknown indicator at 1:1 | gone in qkt 0.54 | runner and `/api/check` tests assert qkt's position; `locateImport` test for the IMPORT case |
| E6 one error at a time | limit, documented | not fixable without touching qkt |
| E7 `data_root` vs `QKT_DATA_HOME` | done | container run finds bars; mismatch warning tested |
| E8 silent coverage phase | done (UI text), no automated UI test | screenshot review |
| E9 holidays / waive | server + UI done; the waive **button** has no automated UI test | `allowIncomplete` exercised by cancel/grid tests |
| E10 sparse store | done | coverage API tests, coverage strip e2e |
| E11 exclusive `--to` | done | bars tests (2021 bars), e2e |
| E12 fills vs trades | done | roundtrips + results tests, e2e |
| E13 realised vs unrealised | done | results tests |
| E14 sweep | done as studio-owned grid; `extractJsonDocs` exists for `sweep --json` but the server does not call it | api grid test, demo e2e |
| E15 Draft vs Full | done and **measured**: identical for market orders, ~7-10% apart with brackets | runner fidelity test, demo e2e |
| E16 cancel | done | runner tests (63 ms class, no debris, no orphan) |
| E17 foreign JVMs | done by design (only own process groups are signalled) | observed during the session |
| E18 stale results | done in the client (run-id guards on SSE and result loads); `seq` is recorded | no dedicated test |
| E19 data fingerprint in the hash | done | core hash tests; no end-to-end "new data changes the id" test |
| E20 restart recovery | done | runner test |
| E21 concurrent identical submits | done | runner + api tests |
| E22 fill pairing | done | real long-only and long/short/bracket fixtures reconcile to <1e-12 |
| E23 huge outputs | done | 1M-trade query test, server paging, LOD, 2M-fill refusal |
| E24 secrets | snapshots redacted (tested); the editor necessarily shows the user's own config to that authenticated user | redact tests |
| E25 traversal | done, and the tests **found a real hole** (a `..` identifier) that is now closed | fs, api tests |
| E26 UID mismatch | done: the container drops to the workspace owner | docker run with host-owned mounts |
| E27 file watching | **not implemented**: on-disk changes surface as a save conflict (etag), the tree refreshes on demand | documented deviation |
| E28 version drift | done: schema gate, image reports its qkt version | results tests |
| E29 LSP crash | bridge closes and the client reconnects with backoff and re-opens documents; no crash-injection test | code review only |
| E30 two tabs | done server-side (etag 412) and in the UI (conflict banner); no e2e | fs tests |
| E31 bundle size | done (one 301 kB worker; main bundle 5.7 MB, 1.5 MB gzipped) | build output |
| E32 Monte Carlo < 30 trades | done | core, api tests, UI disabled state |

### Found while building (not in the original register)

Dot-only identifiers (`..`) escaped the bar directory; a refused terminal command exited 0; event snapshots aliased the live
run object; `@fastify/static` served a stale file list after a rebuild; dockview ignored `initialWidth`, leaving the chart
100 px wide; Lightweight Charts' default minimum bar spacing hid most of a month; pnpm 12 needs `allowBuilds`; qkt refuses a
symbol without an instrument spec (the demo ships one); container root-owned bind mounts; a Draft-only fill-outside-bar
failure needed a "soft" level; walk-forward needed a window-length hint; qkt's dash character becomes `?` in a container locale.

### Open items (verified as far as possible, not further)

- Bar side (bid/ask/mid) vs fills: consistent on every run tested in both tiers (81/81 fills inside bars, Full and Draft),
  so no tolerance was needed on those; the 2 bps Full tolerance remains as a precaution.
- `qkt fetch` offline behaviour, Docker Desktop, Windows, non-XAUUSD calendars: not exercised.
- Optional upstream asks (§12) remain optional; nothing in qkt was changed.

## 15. UI redesign addendum (2026-09-25)

Rail + sidebar + editor/preview + dock layout with persisted, resizable panes; journal slide-over driven by
`/api/runs/:id/analytics` and the shared trip filter (adds exit type, R, weekday, hour, day). Runs default to bars
(`tier: draft`). Data section = `data-scan.ts` (per symbol/tf/year completeness, 2% tolerance, usable windows,
readiness per strategy); the data root is mutable at runtime within an allowed-roots policy. Kill = `/api/kill`
(cancel with purge, stop jobs, remove partial bar files). Verified by `scripts/e2e.mjs` (theme, vim, Stop leaves no run
dir, journal filter narrows trades, labelled icon buttons). Bug found by that e2e: Modal re-ran its focus effect on every
parent render and returned focus to the opener, so palette typing went into the editor; fixed (effect keyed on `open`).

## 16. Workspace files, data semantics, sources (2026-09-25, second pass)

- **Probed:** `qkt backtest` ignores config `starting_balance` (always 10000 unless `--starting-balance`); instruments are looked up in `--instruments` (default `<dataRoot>/instruments.yaml`) then a built-in table of FX majors, XAU, XAG only; `${VAR:-default}` substitution reads the process environment (no `.env` support in qkt), so the studio injects the workspace `.env` into every child it spawns (runs, jobs, LSP, terminal).
- **Completeness** (`data-scan.ts`): per-day ok/closed/thin/missing with 24/7 detection (Saturday share, per year), fixed holidays, cross-symbol holiday inference (>=3 symbols, >=80% without data), US-holiday learning per series (neighbour years count). On the real store this turned daily CL/HG from 1882/2110 false missing days into 5/6 real ones (2012-10-29 Sandy closure, 2018-12-05), moved 2 symbols to complete, and exposed 57 empty Saturdays of an older BTC feed as weekday-schedule years rather than gaps. Tests: `test/calendar.test.ts`.
- **Per-symbol source/window:** `symbolPrefs`/`sources` in `.qkt-studio/settings.json`; a run with overridden symbols reads a folder of symlinks (`.qkt-studio/views/<hash>`), windows are enforced with a 400 naming the symbol.
- **Terminal (restricted):** ls/cd/cat/head/tail/tree/pwd/echo/help builtins jailed to the workspace (`term-builtins.ts`); `clear`/Ctrl+L client side.
- **Housekeeping:** `GET /api/runs-usage`, `POST /api/runs/prune`; DELETE removes the run folder, index row and caches.
- **Diagnostics:** qkt reports "expected X, got 'TOKEN'" at the token that failed, usually the first token of the next line; `anchorParseError` moves the marker to the end of the unfinished line above (still true of qkt 0.54, re-probed 2026-09-30).

## 17. Portfolio support (2026-09-27)

- **Probed:** `qkt backtest book.qkt` on a real `PORTFOLIO` file writes one `trades.csv` with `strategy` = `<portfolio>:<alias>`,
  per-strategy `equity_<urlencoded id>.csv`, and `result.json.perStrategy` + `bookAnalytics` (contribution/risk/drawdown
  attribution, return correlation) + `bookRisk` (book volatility, gross/net exposure). The studio already ran a portfolio
  end to end before this work (union streams, reconciled trips); this pass makes the UI and derived data portfolio-aware.
- **Core:** `analyze()` gained `byStrategy`/`dailyByStrategy`/`monthlyByStrategy` (empty for one strategy); `TripQuery`
  gained `strategies?: string[]` (any-of) alongside the exact `strategy`; `parseStrategyInfo` reads `IMPORT ... HOLD` and
  a new `portfolio.ts` gives `strategyBreakdown()`/`bookInfo()` from a `QktResult`.
- **Server:** `portfolio.ts` resolves `IMPORT`s transitively inside the workspace jail (`resolveStrategy`, `listPortfolios`,
  cached by mtime); readiness for a portfolio unions its children's streams and names which child blocks a stream.
  `postprocess.ts` writes `derived/{strategies,equity-by-strategy,book}.json` only when `perStrategy` has more than one
  key. `/api/runs` rows carry `kind`/`members`, derived lazily from `derived/meta.json` (no index migration). `/api/portfolios`
  lists every portfolio and which portfolios use each strategy file.
- **Web:** Files sidebar expands a portfolio to its members; a "New portfolio" template; `RUN`/`IMPORT '` completions.
  Chart entry markers, the trades list and the journal trades table gain a strategy colour/badge (`util/strategyColor.ts`,
  a hash so it's stable) ONLY when a chart or list actually holds more than one strategy — a single-strategy run's
  layout is byte-for-byte unchanged. A chart-toolbar strategy legend toggles the shared `filters.strategies`, so hiding
  a strategy there hides it in the trades list and the journal too. Journal gains a "Strategies" nav item (shown only
  for >1 strategy): a contribution table sourced from `derived/strategies.json` (the book's own numbers, deliberately
  NOT the active drill filter, so a row's numbers do not change when you click it to filter the rest of the journal),
  an equity chart per strategy plus the book total, and a book-risk card.
- **Verified:** the whole existing regression set (`pnpm -r test`, `scripts/e2e.mjs`, shell-layout/editor/files-runs-terminal,
  lsp, vim-ex) still passes; a scripted browser check of a single-strategy run after this change shows no strategy
  legend, no Strategy column, and the same 8 journal nav items as before.

## 18. The language comes from the qkt that runs (2026-09-30)

- **Probed** on qkt 0.54.0: `qkt dsl vocabulary --json` prints one `qkt-vocabulary-v1` document (153 keywords in 14
  categories, 61 indicators with arity/signature/doc, 18 functions, 8 constants, 11 stream fields, 6 meta fields,
  `candle`/`tick`, the members of every pseudo-symbol, 4 shorthands); `qkt editor grammar --format textmate` prints the
  TextMate grammar (`scopeName: source.qkt`). `qkt parse` and `qkt lsp` position every compile error
  (`Unknown indicator: emax` at the identifier, `Unknown stream alias: gld` at the alias, `Unknown stream field for
  gold: nope`, `Indicator ema expects 2 args, got 3`, `SIZING RISK ... requires` at the sizing, `BRACKET requires` at
  BRACKET, `Unknown reference: BOGUS`); an undeclared alias is a compile error. Still at 1:1: a missing IMPORT (message
  is the bare absolute path). Still on the next line's token: "expected X, got 'TOKEN'".
- **Design:** the server reads both documents once at startup (`qkt-lang.ts`), refuses an older qkt with a message that
  names the command, and serves them at `/api/qkt/vocabulary` and `/api/qkt/grammar` (strong ETag, `no-cache`, 304 on
  revalidation: the URL does not change when the image's qkt does). The web app fetches both in `setupMonaco()` before
  any editor exists; the vocabulary feeds completions (actions, POSITION members, stream and meta fields) and the
  lint (fields; the price-scale averages for the cross-scale warning are the indicators whose doc says "moving
  average" of a `value`), the grammar feeds Shiki. The hand-kept lists (`STREAM_FIELDS`, `ACTIONS`,
  `POSITION_MEMBERS`, the MA-name regex, the bundled `qkt.tmLanguage.json`, `w` as a duration unit) and the 1:1
  `relocate` logic are gone. A test scans the studio's own snippets and context rules for uppercase names and refuses
  any the vocabulary lacks.
- **Verification:** `packages/server/test/qkt-lang.test.ts` (both endpoints against the real binary, schema, key
  order, categories, members, ETag/304, the old-binary refusal), `packages/core/test/vocabulary.test.ts` and the
  lint/completions tests on `packages/core/test/fixtures/qkt-vocabulary.json` (a capture; regenerate after a qkt
  release). The Docker image still pins the qkt by digest in `docker/Dockerfile` (`QKT_IMAGE`); it must be a 0.54+
  build for the studio to start.
