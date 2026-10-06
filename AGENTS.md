# qkt-backtester: agent guide

A browser workspace (editor, run pipeline, charts, trades, metrics, Monte Carlo, grid, walk-forward) for qkt, in one
container. **Rule one: never modify `../qkt`.** Consume only its CLI, `qkt lsp` and the files it writes. Read `README.md`
first, then `docs/specs/2026-09-25-qkt-backtester-design.md` (design, probe evidence, edge-case register).

## Layout

- `packages/core`: pure, browser-safe logic (bars decoder, round-trip pairing, result/integrity, run identity, output
  parsers, lint, Monte Carlo, trade queries). Tested against real qkt output in `test/fixtures`. The web app imports
  only the subpaths `@qkt-studio/core/{lint,strategy,tripquery,montecarlo}` (the root entry pulls in `node:fs`).
- `packages/server`: Fastify. `runner.ts` is the pipeline; `postprocess.ts` writes `runs/<id>/derived`; routes in
  `run-routes|bars-routes|check-routes|fs-routes`, jobs (grid/walk-forward/data) in `jobs.ts`, bridges in
  `lsp-bridge.ts` and `terminal.ts`.
- `packages/web`: React + zustand + Monaco (vim via monaco-vim)/Shiki + Lightweight Charts + ECharts. State in `src/state/store.ts` (data/runs) and `src/state/ui.ts` (layout, persisted). Design tokens in `src/theme.css`; sections in `src/sections`, journal in `src/journal`.
- `docker/`, `tools/demo-data.mjs` (synthetic DEMOUSD), `scripts/e2e.mjs`, `probes/` (throwaway
  evidence from the design phase; not part of the build).

## Commands

```bash
pnpm -r build && pnpm -r test          # server tests run the REAL qkt binary against ~/.qkt/data (skipped if absent)
node scripts/e2e.mjs                   # needs a running studio (default :8099) with WORKSPACE=./workspace (a new empty folder is seeded with config, instruments and samples)
pnpm docker:build
```

## Facts about qkt that shaped the code (all probed; do not "simplify" them away)

- `--to` is **exclusive**. The bar store ignores config `data_root`; set `QKT_DATA_HOME`. A missing explicit `--config`
  silently uses defaults, so the studio checks it exists.
- **The studio keeps no DSL knowledge of its own.** On startup the server runs `qkt dsl vocabulary --json` (schema
  `qkt-vocabulary-v1`: keywords by category, indicators, functions, constants, stream/meta fields, pseudo-symbol members)
  and `qkt editor grammar --format textmate`, refuses to start on a qkt that lacks them (0.54+), and serves them at
  `GET /api/qkt/vocabulary` and `GET /api/qkt/grammar` (ETag, `no-cache`). The web app loads both before Monaco exists:
  lint and completions read the vocabulary, Shiki highlights with the grammar. Tests use the capture in
  `packages/core/test/fixtures/qkt-vocabulary.json`; regenerate it with `qkt dsl vocabulary --json > that file` after a
  qkt release. Server tests take the binary from `QKT_BIN` (default `qkt` on PATH).
- `qkt parse` and `qkt lsp` report every compile error at its real position (unknown indicator, unknown or undeclared
  stream alias, unknown field, wrong arity, `BRACKET requires ...`), and an undeclared stream alias anywhere in a rule
  **is a compile error** (`unknown_alias`). Two things are still the studio's: a missing `IMPORT` is reported at 1:1 with
  only the file's path (`locateImport` points at the IMPORT line), and "expected X, got 'TOKEN'" lands on the next
  line's first token (`anchorParseError` moves it to the end of the unfinished line). qkt stops at its first error; the
  studio's alias lint reports every undeclared alias. Comments are `--`, `#` and `/* */`; durations are `\d+[smhd]`.
- `trades.csv` is one row per **fill**; `tradeCount` counts fills. Pair round trips from the signed strategy position.
- Bar day files: an **empty file** means closed day, **no file** means not built. Format `QKB1` v1, little-endian, scale 8.
- `qkt sweep` has no `--report-dir` and interleaves logs with `--json`; grids are one `qkt backtest` per point instead.
- `qkt` prints nothing during the ~9 s tick coverage check, and its calendar is not holiday-aware. Draft (`--bars`) differs
  from Full for stop/target strategies (measured ~7-10%).
- Engine log lines carry live fills (`order filled ...`); dashes come out as `?` under a container locale.
- **Portfolio runs**: a `PORTFOLIO` file's `trades.csv` uses the engine strategy id `<portfolio>:<alias>` (e.g. `book:trend`)
  in the `strategy` column; `result.json.perStrategy` is keyed the same way, plus `bookAnalytics`/`bookRisk` when present.
  Per-strategy equity files on disk are `equity_<urlencoded id>.csv` (e.g. `equity_book%3Atrend.csv`). `postprocess.ts`
  writes `derived/{strategies,equity-by-strategy,book}.json` only when a run has more than one strategy; a single-strategy
  run never gets them, and every UI branch on `meta.strategies.length > 1` (or a 404 on those routes), never on run
  metadata alone. Readiness for a portfolio file must resolve its `IMPORT`s (`server/src/portfolio.ts`) to get the
  union of streams; the portfolio file's own `SYMBOLS` block is not enough.
- **Futures and options** (probed on qkt 0.55.0; `server/src/derivatives-{scan,readiness}.ts`). The DSL is one language
  (`alias = VENUE:SYMBOL EVERY tf`), but **qkt does not enforce which fields a kind has**: `fx.dte` on a CFD parses and runs
  with zero trades, so `kind-gate.ts` refuses it in the editor check and as a failed parse step. A continuous stream
  (`CME:ES@front`)'s own coverage check is meaningless (it looks for `bars/<V>/<ROOT>@front` and reports 0/N days, in bars
  and ticks runs alike) and the run only starts with `--allow-incomplete`, so the studio checks every contract the roll
  schedule follows itself (`Readiness.needsAllowIncomplete`). A root without `roll:` fails with "has no roll policy"; trading
  a continuous stream needs `adjust: panama`. A series starts at its first measured roll. An option contract is read from the
  stored chain, never from bars (a bars run looks for `bars/<V>/<CONTRACT>` and reports 0/N): Full runs print "chain coverage"
  and refuse a missing day with the exact `qkt fetch ... --chains` line; no `chains:` fails with "declares no chain series".
  A perpetual's funding rates must leave no gap over a day (`--funding off` runs without). Contract bars read as `.bin` in a
  bars run, so a `.csv` store is not "built". The scan reads directory listings only, so a store with hundreds of contract
  folders scans in seconds; the plain symbol list leaves contracts under their root. A per-run data view (`data-view.ts`) must
  link `contracts/ funding/ marks/ open_interest/ tape/ liquidations/ depth/ chains/` as well as bars, or a run on a
  per-symbol source cannot see its catalog.

## Futures and options (all probed on qkt 0.55.0; the spec is `docs/specs/2026-10-06-futures-options-design.md`)

- **Continuous streams** (`CME:ES@front`): qkt's `--bars` coverage check looks for a folder named `ES@front` and reports `0/N days`,
  so every such run needs `--allow-incomplete`; the runner adds it itself (`derivatives-run.ts`) and the run's coverage record is
  flagged `continuous: true` so nothing reports it as short. Contract bars are what Data readiness verifies. Continuous runs are
  **Draft only** (Full says `no market data for CME:ES@front`); option contracts, `OPTIONS:` chains and `CHAIN:` analytics are
  **Full only** (`--bars` asks for bars that cannot exist). The runner refuses the wrong tier before queueing.
- `qkt` prints `qkt: chain coverage <SYM> 2/2 days (trade chain)` for options (not `bar coverage ... trading days`); `classifyLine`
  reads it as `source: "chain"`, `tf: "trade" | "book"`.
- **Cost accounting**: `result.json` `global`/`perStrategy` carry `rollCostsPaid` and `fundingPaid` **only on runs that have them**.
  `realizedTotal` = sum of the fills' `realized` **minus** roll costs and funding, so the reconcile check adds them back; the bridge
  is `preCostPnL = totalPnL + commissionPaid + swapPaid + rollCostsPaid + fundingPaid` (verified: it returns the zero-cost P&L).
- **Venue closes** are fills in `trades.csv` whose `brokerOrderId` is `expiry:<contract>:<strategy>` or
  `liquidation:<contract>:<strategy>:<ms>` (empty `orderType`); `venueExitOf` reads them into `RoundTrip.venueExit`, and `exit` stays
  `signal`. A `ROLL_FAILED` close is matched on a `roll_failed:` prefix that has **not** been observed. `contractSize` in
  `trades.csv` is the root multiplier, and `realized` already includes it: never recompute P&L.
- **Rolls are not fills.** A roll closes and reopens inside qkt with no `trades.csv` row, so the signed strategy position, and
  therefore the trip, spans the roll; `rolls.csv` and `contracts.csv` say which contracts (`attachContracts`).
- **A root entry without `perpetual:`** is read as a plain symbol: no funding, no root fees. Margin is optional: without it no order
  is refused for margin and nothing is liquidated; with it qkt refuses and liquidates (`liquidations.csv`).
- qkt's defaults silently block futures orders (`max_order_notional` 250000, `max_order_qty`, `max_daily_loss` 1000); the seeded
  config for a store that holds futures raises them. The workspace `instruments.yaml` **wins entirely** over the data root's, so the
  scaffold copies the data root's `futures:`/`options:` entries verbatim (quotes matter: unquoted `atUtc: 00:00` is a number in YAML 1.1).
- Per-symbol data views (`data-view.ts`) link `contracts/`, `funding/`, `chains/`... from the default source: qkt reads one root.
- Derived outputs for these runs: `derived/derivatives.json` (sections present only when their file had rows; `meta.derivatives`
  lists them), `summary.costs`, `meta.streams[].kind`, `trip.venueExit/contract/exitContract/rolls`; a CFD run gets none of them.

## Conventions and traps

- Comments are sparse and explain **why**; keep that. TypeScript strict, ESM. Windows are `[from, to)`, times UTC.
- Anything user-supplied that becomes a path goes through `resolveInJail`; identifiers must not be dots-only.
- Never signal a process you did not spawn; use process groups (`proc.ts`). In shells here `cat` is aliased (use `command cat`)
  and `pkill -f` can match its own command line; track PIDs.
- `pnpm` is v12: approved build scripts live in `pnpm-workspace.yaml` under `allowBuilds`.
- After changing `packages/core`, run `pnpm --filter @qkt-studio/core build` (server and web resolve its `dist`).
