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
- `packages/web`: React + dockview + Monaco/Shiki + Lightweight Charts + ECharts. State in `src/state/store.ts`.
- `docker/`, `sample-workspace/`, `tools/demo-data.mjs` (synthetic DEMOUSD), `scripts/e2e*.mjs`, `probes/` (throwaway
  evidence from the design phase; not part of the build).

## Commands

```bash
pnpm -r build && pnpm -r test          # server tests run the REAL qkt binary against ~/.qkt/data (skipped if absent)
node scripts/e2e.mjs                   # needs a running studio (default :8099) with WORKSPACE=<copy of probes/ws>
BASE=http://127.0.0.1:8090 node scripts/e2e-demo.mjs   # against a fresh container
pnpm docker:build
```

## Facts about qkt that shaped the code (all probed; do not "simplify" them away)

- `--to` is **exclusive**. The bar store ignores config `data_root`; set `QKT_DATA_HOME`. A missing explicit `--config`
  silently uses defaults, so the studio checks it exists. An unknown stream alias runs with **zero trades and no error**.
- `trades.csv` is one row per **fill**; `tradeCount` counts fills. Pair round trips from the signed strategy position.
- Bar day files: an **empty file** means closed day, **no file** means not built. Format `QKB1` v1, little-endian, scale 8.
- `qkt sweep` has no `--report-dir` and interleaves logs with `--json`; grids are one `qkt backtest` per point instead.
- `qkt` prints nothing during the ~9 s tick coverage check, and its calendar is not holiday-aware. Draft (`--bars`) differs
  from Full for stop/target strategies (measured ~7-10%).
- Engine log lines carry live fills (`order filled ...`); dashes come out as `?` under a container locale.

## Conventions and traps

- Comments are sparse and explain **why**; keep that. TypeScript strict, ESM. Windows are `[from, to)`, times UTC.
- Anything user-supplied that becomes a path goes through `resolveInJail`; identifiers must not be dots-only.
- Never signal a process you did not spawn; use process groups (`proc.ts`). In shells here `cat` is aliased (use `command cat`)
  and `pkill -f` can match its own command line; track PIDs.
- `pnpm` is v12: approved build scripts live in `pnpm-workspace.yaml` under `allowBuilds`.
- After changing `packages/core`, run `pnpm --filter @qkt-studio/core build` (server and web resolve its `dist`).
