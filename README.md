# qkt backtester

A browser workspace for [qkt](../qkt): write strategies and config, run backtests, and study the results, all from **one
Docker container** with **plain files as the only source of truth**. It never modifies qkt. It only uses qkt's CLI,
`qkt lsp`, and the files qkt writes.

```
┌ Explorer · Editor · Console ──────┬ Charts (one per timeframe, synced) ─┬ Results · Robustness · History ──┐
│ qkt.config.yaml, *.qkt            │ candles + trade boxes + entry/exit  │ Sharpe, PF, drawdown, monthly P&L│
│ live diagnostics (qkt lsp)        │ Trades table (filters drive charts) │ Monte Carlo · grid · walk-forward│
│ run pipeline · problems · terminal│ every region collapses / expands    │ integrity checks · run compare   │
└───────────────────────────────────┴─────────────────────────────────────┴──────────────────────────────────┘
```

## Quick start

```bash
mkdir workspace                     # your strategies live here (owned by you, so files stay yours)
docker compose up --build           # http://localhost:8080
```

or without compose:

```bash
docker build -f docker/Dockerfile -t qkt-backtester .
docker run --rm -p 127.0.0.1:8080:8080 \
  -v "$PWD/workspace:/workspace" -v "$HOME/.qkt/data:/data" qkt-backtester
```

- **First run needs nothing.** An empty `/workspace` is seeded with a sample project (`qkt.config.yaml` and two demo
  strategies). An *empty* `/data` gets a small **synthetic** dataset (`DEMOUSD`, a seeded random walk, clearly not market
  data) whose bars are built by qkt itself. A data store that already has files is never touched.
- **Your data:** mount your qkt data store at `/data` (default `~/.qkt/data`). It is read for candles and ticks; "Build bars"
  writes into it, so mount it read-only only if it is already complete.
- **Files stay yours.** The container drops to the owner of the mounted `/workspace`. If Docker created the folder as root
  you'll get a note; create it yourself first (`mkdir workspace`).
- **Exposing it beyond localhost:** set `STUDIO_TOKEN=<secret>`. That requires a token for the API and enables the full-shell
  terminal. Without a token on a non-loopback bind the terminal is restricted to `qkt` commands. There are no user accounts;
  this is a single-user or small-team tool, one container per workspace.
- **Pin the engine:** `--build-arg QKT_IMAGE=ghcr.io/elitekaycy/qkt@sha256:<digest>` (default `ghcr.io/elitekaycy/qkt:latest`).

## Using it

1. **Write** a `.qkt` file. Highlighting comes from qkt's own TextMate grammar. Diagnostics appear as you type (`qkt lsp`),
   plus a `qkt parse` check after a short pause. `qkt.config.yaml` is edited in the same editor and checked against a schema.
2. **Run** with `Ctrl+Enter` (or ▶ Run). The **Run pipeline** panel shows every step with its status, timing and the exact
   command (paste it in a terminal to reproduce): project, config, parse, data check, backtest, post-process, render.
3. **Study** the result: candles for every traded timeframe with entry→exit boxes, arrows and hold times; a filterable,
   server-paged trades table (filters also filter the charts, and clicking a trade zooms the chart onto it); KPIs, equity,
   drawdown, monthly P&L; integrity checks; run history and side-by-side compare.
4. **Stress** it: **Monte Carlo** (bootstrap, shuffle, block, skip; seeded and reproducible), **parameter grid** (each point
   is a full run with its own charts), **walk-forward** (in-sample vs out-of-sample).

### Draft vs Full

| | qkt flags | Speed (measured) | Use |
|---|---|---|---|
| **Draft** | `--bars` | ~1 s per month, ~2.5 s per year | iterate |
| **Full** | tick replay | 13–31 s per month (+ a silent ~7 s coverage check) | verify |

With market orders they gave **identical** trades, P&L and drawdown. With **stops, targets or brackets they differ**:
on the bundled bracket demo Draft −106.88 vs Full −95.95. The studio warns in the run bar and pipeline when a Draft run uses
intrabar orders, and the tier is stamped on every run, chart and metric. Use **Verify with Full** before trusting a number.

### Data and calendars

- Windows are `[from, to)`. qkt's `--to` is **exclusive**, and so is everything here. All times are UTC.
- The studio never auto-fetches (`--no-fetch`). Missing data stops the run at **Data check** with qkt's own remedy:
  **Build bars** (from your tick store), or **Run anyway** (waive the holes; they stay recorded on the run).
- qkt's calendar is **not holiday-aware**: days like US holidays and Good Friday are flagged incomplete even though the
  market was thin or shut. The waive flow exists for that. Each chart has a coverage strip: closed (hatched), thin (amber),
  missing (red).
- The bar store ignores the config's `data_root`; the studio always sets `QKT_DATA_HOME`, and warns if they differ.

## What is on disk

```
/workspace
  qkt.config.yaml            yours
  strategies/*.qkt           yours
  .qkt-studio/               derived, deletable: run index (SQLite), job records
  runs/<YYYYMMDDTHHMMSSZ>_<strategy>_<hash8>/
    run.json                 status, steps, params, engine version, waived days, timings
    source/                  strategy + config snapshot (secrets redacted)
    engine/                  qkt's own bundle, untouched: result.json, trades.csv, equity_*.csv, manifest.json, report.html
    derived/                 round trips, summary, monthly, equity, integrity, meta
    robustness/              Monte Carlo results (seed included)
    logs/                    stdout.log, stderr.log, events.ndjson
```

The run id ends in a hash of the strategy, config, params, window, tier, engine version and the data files it reads.
Re-running identical inputs is an instant cache hit; changing any of them (including fetching new data) is a new run.
A "trade" is a **round trip**; qkt's own `tradeCount` counts *fills*, and both are shown. Round trips are reconciled to
the engine's realised P&L on every run.

## Integrity checks (every run)

| Check | Meaning |
|---|---|
| Trades reconcile with engine P&L | Σ round-trip P&L equals qkt's `realizedTotal` |
| Chart bars match engine candles | the bars drawn are the bars qkt evaluated (exact count for the window) |
| Every fill lies inside its bar | catches misplaced data; amber (expected) in Draft for stop/target fills |
| Engine artifact checksums | every file in qkt's `manifest.json` still matches its sha256 |

## Known limits

- Single-user / small-team. No accounts. One qkt version per image.
- The LSP and `qkt parse` report **one error at a time**; unknown indicators are reported by qkt at `1:1` and relocated
  by the studio. An unknown stream alias is silently accepted by qkt (it just never trades), so the studio blocks it.
- Terminal resize is not propagated to the shell (a pty without a native module). Sweeps use one run per grid point (max 200).
- Tables page from memory up to 2,000,000 fills; beyond that the run is refused with a clear message.
- `qkt fetch` needs network and broker access and was not exercised offline. Docker Desktop file-watching is not used at
  all: edits go through the API and an on-disk change is detected by a save conflict, not live.
- Not verified: non-XAUUSD calendars, Windows hosts.

## Develop

```bash
pnpm install
pnpm -r build && pnpm -r test                 # core, server (uses the real qkt binary + your ~/.qkt/data) and web
QKT_BIN=qkt WORKSPACE=./probes/ws QKT_DATA_HOME=~/.qkt/data pnpm --filter @qkt-studio/server dev
pnpm --filter @qkt-studio/web dev             # http://localhost:5173, proxies /api and /ws to :8080
node scripts/e2e.mjs                          # browser e2e (system Chrome) against a running studio
BASE=http://127.0.0.1:8090 node scripts/e2e-demo.mjs   # same for a fresh Docker install
```

`packages/core` is pure and fixture-tested against real qkt output (`test/fixtures`). Design, probe evidence and the edge-case
register: [`docs/specs/2026-09-25-qkt-backtester-design.md`](docs/specs/2026-09-25-qkt-backtester-design.md).
