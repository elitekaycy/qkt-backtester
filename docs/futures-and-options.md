# Futures and options

CFDs are the default and nothing below changes them. Futures, perpetuals and options use the same editor, the same Run
button and the same Journal. The studio recognises what a stream is from its symbol and from your data, so there is no
mode to switch.

## One language

qkt has one DSL for every instrument: `alias = VENUE:SYMBOL EVERY timeframe`. What the symbol names decides the kind.

| You write | Kind |
|---|---|
| `BACKTEST:XAUUSD`, `EXNESS:EURUSD` | CFD |
| `CME:ESZ24`, `BINANCE_UM:BTCUSDT_241227` | listed futures contract |
| `CME:ES@front`, `@next` | continuous futures (rolls on schedule) |
| `BINANCE_UM:BTCUSDT` (a root's `perpetual:`) | perpetual (pays funding) |
| `DERIBIT:BTC_USDC_26SEP26_84000_C` | option contract |
| `OPTIONS:DERIBIT.BTC_USDC` | an options chain, read by `OPEN x = OPTIONS ON ...` |
| `CHAIN:DERIBIT.BTC_USDC.atm_iv.30d` | read-only chain analytic |

Some fields exist only on some kinds:

- `contract`, `dte`, `days_to_roll`: futures (`days_to_roll` is continuous only).
- `mark`, `index`, `open_interest`, `buy_volume`, `sell_volume`, the `*_liq_volume` fields, `bid_depth`, `ask_depth`,
  `book_imbalance`: listed contracts and perpetuals, not `@front`.
- `iv`, `delta`, `gamma`, `vega`, `theta`: option contracts.

**qkt does not enforce this.** `fx.dte` on a CFD parses and backtests with zero trades and no error, because an undefined
field never fires. The studio does enforce it: the editor marks it, completions after `alias.` list only the fields that kind
has, and the run is refused with the line and column.

## Data

The data source is read like it is for CFDs; nothing is picked by hand.

| Store folder | What it holds |
|---|---|
| `contracts/<VENUE>/<ROOT>.json` | the contract catalog: every expiry with its delivery price |
| `contracts/<VENUE>/<ROOT>.rolls.json` | measured rolls, for `@front` / `@next` |
| `bars/<VENUE>/<CONTRACT>/<tf>/` | bars of one contract |
| `funding/<VENUE>/<NAME>.csv` | perpetual funding rates |
| `marks/`, `open_interest/`, `tape/`, `liquidations/`, `depth/` | optional series a strategy can read |
| `chains/<VENUE>/<ROOT>/{trade,book}/` | option chain snapshots |
| `instruments.yaml` | `futures:` and `options:` terms next to `instruments:` |

The Data section lists futures and options roots beside symbols, with catalog size, expiry range, rolls, perpetual series and
chain coverage. Each contract is a folder under its root, not a symbol of its own.

Readiness asks each kind its own question, and a block always names the command that fixes it, with Copy and Run buttons. Run
starts it only when you click it:

- **Listed future or perpetual:** bars of that contract at the strategy's timeframe; funding with no gap over a day when it
  trades a perpetual (`--funding off` skips this); marks, open interest, trade tape or depth when the strategy reads them.
- **Continuous (`@front`, `@next`):** the root declared under `futures:` with a `roll:` policy (`adjust: panama` to trade it),
  the catalog, the rolls file, and bars of every contract the window uses, checked along the roll schedule.
- **Options:** the root under `options:` with `chains: trade` or `book`, the catalog, and chain days up to each expiry.

## instruments.yaml

`instruments:` is unchanged. Two more sections hold what futures and options need:

```yaml
futures:
  - root: CME:ES
    currency: USD
    multiplier: 50
    tickSize: 0.25
    volumeStep: 1
    volumeMin: 1
    calendar: cme_globex
    exchangeFeePerContract: 2.23
    margin: { initial: 25713, maintenance: 23375, basis: per_contract }
    roll: { daysBeforeExpiry: 7, atUtc: "00:00", adjust: panama }

options:
  - root: DERIBIT:BTC_USDC
    contractSize: 1
    chains: trade
    takerFeeRate: 0.0003
```

A new workspace is seeded with an entry for each root the data source holds. Terms the studio cannot know are marked
`GUESSED` the way CFD specs are, and margin is never invented: without a `margin:` block qkt applies no margin check and never
liquidates. A store that holds futures also gets raised `risk:` caps in `qkt.config.yaml` (`max_order_notional`,
`max_order_qty`, `max_daily_loss`); qkt's defaults are sized for small CFD accounts and silently block futures orders.

## Running

- **Draft or Full.** Continuous futures run on bars (Draft) only. Option contracts, `OPTIONS:` chains and `CHAIN:` analytics
  run Full only. Listed contracts and perpetuals run Draft; Full needs a tick store. The tier control explains this before you
  hit the refusal.
- **Exchange simulator.** Futures and options fill on qkt's own exchange simulator whatever the broker model says: market
  orders at the executable price plus slippage, fees from the root on every fill, rolls booked as roll costs.
- **Coverage on `@front`.** qkt's own bar-coverage check cannot see a continuous stream (it reports 0 of N days), so the studio
  does the per-contract check itself and passes `--allow-incomplete` for these runs. The run's coverage line says so.
- **Funding.** A perpetual with stored rates is charged funding. The run bar has a Funding switch; off passes `--funding off`.

## Reading the results

The Journal adds a **Futures & options** view, only for runs that have it:

- contracts traded and every roll, with the cost of each;
- margin used against equity per day, with margin calls flagged;
- settlements at expiry, and liquidations with the equity and maintenance that triggered them;
- funding and financing;
- option structures with their legs, outcome (closed, unwound, settled), credit and premium P&L.

The Overview shows the cost bridge when it applies: `pre-cost P&L = total P&L + commission + swap + roll costs + funding`.
Trades show the contract behind them and a venue-close badge (`EXPIRY`, `LIQUIDATION`, `ROLL_FAILED`); search with
`exit:expiry` or `contract:ESH19`. A trade that spans a roll is one round trip; its roll legs are in the Futures & options
view.

## Limits

- No chart for continuous, chain or analytic streams: they have no single price series. The chart says so instead of failing.
- Option structure legs pair per leg in the trades list; `structures.csv` is the structure-level view.
- Fetch jobs (`qkt fetch ...`) are the only network the studio ever uses, and only when you start them.
