# Futures and options in the studio

Status: design, 2026-10-06. Engine facts are probed against qkt 0.55.0 and its `docs/instruments/`,
`docs/how-to/backtest-data.md` and `docs/reference/cli-commands.md`. The studio still only consumes qkt's CLI, `qkt lsp`,
`qkt dsl vocabulary` and the files qkt writes; nothing in `../qkt` changes.

## Principle

**One DSL, one set of studio screens, CFDs still the default.** A CFD strategy is untouched by any of this. Futures and
options are extra *kinds* of instrument that the studio recognises from the strategy and the data, so nobody picks a mode.

## What qkt does (probed)

- The DSL is the same for every instrument: `alias = VENUE:SYMBOL EVERY tf`. Kinds differ only by what the symbol names:
  `BINANCE_UM:BTCUSDT_241227` (listed contract), `CME:ES@front` / `@next` (continuous), a root's perpetual, an option
  contract, `OPTIONS:DERIBIT.BTC_USDC` (a chain, read by `OPEN x = OPTIONS ON ...`), `CHAIN:DERIBIT.BTC_USDC.atm_iv.30d`
  (a read-only analytic series).
- Fields exist per kind. `contract`, `dte`, `days_to_roll` are futures; `mark`, `index`, `open_interest`, `buy_volume`,
  `sell_volume`, `*_liq_volume`, `bid_depth`, `ask_depth`, `book_imbalance` are listed contracts and perpetuals (not `@front`);
  `iv`, `delta`, `gamma`, `vega`, `theta` are option contracts.
- **qkt does not enforce this.** `fx = BACKTEST:XAUUSD` then `fx.dte > 1` parses (`ok`) and backtests with zero trades and no
  error, because an undefined field never fires. This is the same trap as an unknown alias, so the studio catches it
  (lint + run gate), and never relaxes the DSL.
- Data layout (under `QKT_DATA_HOME`): `contracts/<V>/<ROOT>.json` (catalog), `<ROOT>.rolls.json` (measured rolls),
  `<ROOT>.options.json`; `bars/<V>/<CONTRACT>/<tf>/`; `funding/<V>/<NAME>.csv`; `marks/`, `open_interest/`, `tape/`,
  `liquidations/`, `depth/`; option chains per root. `instruments.yaml` gains `futures:` and `options:` next to
  `instruments:`; `qkt.config.yaml` gains `type: gateway` accounts and needs larger risk caps for futures notional.
- A futures run writes extra files only when they have rows: `rolls.csv`, `contracts.csv`, `settlements.csv`,
  `margin_daily.csv`, `liquidations.csv`, `structures.csv`; `financing.csv` gets a `funding` row; the gross-to-net bridge gains
  `rollCostsPaid` and `fundingPaid`. `trades.csv` stays one row per fill; exit reasons add `EXPIRY`, `ROLL_FAILED`, `LIQUIDATION`.
- Verified on real data: `CME:ES@front EVERY 1d` 2019-2021 (13 trades, 2 rolls, margin days) and a Binance perpetual with
  stored funding (funding paid in `financing.csv`).

## Studio gaps this fixes

| Gap (today) | Fix |
|---|---|
| `@front` streams are not parsed, so readiness reports no streams and nothing blocks | stream parser reads `@front/@next`, `OPTIONS:`, `CHAIN:`, `HUB:` and tags each stream with a kind |
| every contract is its own "symbol" (92 ES rows) | scan groups contracts under their root, with expiries and rolls |
| readiness only knows bars/ticks per symbol | readiness asks each kind's own question (catalog, rolls, every contract's bars across the window, funding, marks, open interest, chains) and names the `qkt fetch` that fixes it |
| `instruments.yaml` scaffold is CFD-only | scaffold futures/options roots found in the store; unknown terms are marked GUESSED like CFD specs |
| editor lets CFD streams read derivatives fields | lint error `field_not_for_kind`, run blocked like an unknown alias |
| reports show only trades/equity | Derivatives panel: contracts and rolls, margin vs equity, settlements, liquidations, funding, structures; trade card shows the contract |
| round trips assume lots x contract size | pairing and P&L use the multiplier and the contract behind each fill |

## Instrument kinds

`cfd | future | continuous | perpetual | option | chain | analytic | hub`. Known from syntax alone: `@front|@next` is
continuous, broker `OPTIONS` is a chain, `CHAIN` an analytic, `HUB` a hub, brokers that are MT5 profiles or `BACKTEST` are
CFDs. Needing the store: a listed contract (`<root>_<expiry>` or a name in a catalog), a root's perpetual, an option contract.
The server resolves those from the catalog and `instruments.yaml`; the browser receives the result (`/api/instruments`) and
passes it to lint.

## Slices

1. core: stream parser, kinds, field-by-kind table, `instruments.yaml` parser (all three sections), tests on real strings.
2. server data: derivatives scan, readiness per kind with fixes, grouped symbols, fetch jobs for catalog/rolls/funding/marks.
3. server run: config seeding for futures, run options, post-process of the new CSVs, round trips with multiplier.
4. web: data section (roots), readiness chips, derivatives results panel, trade card, lint markers.
5. docs, README, qkt 0.55.0 pin, e2e on a real futures run, release.
