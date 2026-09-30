# qkt DSL cheat sheet (read this first; `dsl_reference(topic)` has the full pages)

A strategy file:
```qkt
STRATEGY name VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m
    gold4h = BACKTEST:XAUUSD EVERY 4h
    fx = BACKTEST:NZDUSD EVERY 4h

PARAM fast = 9
PARAM slow = 21

RULES
    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, slow)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1
        BRACKET { STOP_LOSS BY 1.0 PCT, TAKE_PROFIT BY 2.0 PCT }

    WHEN ema(gold.close, fast) CROSSES BELOW ema(gold.close, slow)
     AND POSITION.gold > 0
    THEN CLOSE gold
```

- Streams: `alias = BROKER:SYMBOL EVERY <tf>` (`1m 5m 15m 30m 1h 4h 1d`). Fields: `alias.open .high .low .close .volume`; lookback `gold.close[1]` = previous bar.
- A rule: `WHEN <condition>` then lines starting `AND` / `OR`, then `THEN <action>` (actions separated by `;`). Rules are separated by a blank line.
- Compare: `> >= < <= = !=`, `a CROSSES ABOVE b`, `a CROSSES BELOW b` (true only on the crossing bar), `x IN [1, 2, 3]`, `NOT (...)`.
- Indicators: `sma(v, N) ema(v, N) wma(v, N) rsi(v, N) atr(alias, N) macd(v, F, S, sig) zscore(v, N) percentile_rank(v, N) correlation(a, b, N) vwap(alias, N)`; `v` is a series like `gold.close`.
- Position: `POSITION.gold` (net qty: >0 long, <0 short, 0 flat), `POSITION.gold.entry_price`, `POSITION.gold.pnl`, `POSITION.gold.holding_duration` (seconds).
- Time (UTC): `NOW.hour_utc` 0-23, `NOW.weekday` 0-6 (Monday = 0), `NOW.month`, `NOW.day`, `NOW.date_utc` (days since 1970-01-01), `SESSION_WINDOW(h1, m1, h2, m2)`, `CALENDAR_WINDOW(month1, day1, month2, day2)`.
- Actions: `BUY alias SIZING ...`, `SELL alias SIZING ...`, `CLOSE alias`.
- Sizing: `SIZING 0.1` (lots), `SIZING 0.5 PCT RISK` (a stop-out loses 0.5 % of equity; needs a STOP_LOSS), `SIZING 5 PCT OF EQUITY`.
- Bracket (after BUY/SELL): `BRACKET { STOP_LOSS BY 12, TAKE_PROFIT BY 24 }` - BY is a distance in the symbol's own price units (12 = $12 on gold, but 12.0 on a pair near 0.6: use 0.0012 there); `BY 1.0 PCT` = percent of the entry price (works on any symbol); `AT <expr>` = an absolute price, e.g. `STOP_LOSS AT gold.close - atr(gold, 14) * 2`.

Skip a date / weekday / hours / season (add to the rule's conditions):
```qkt
STRATEGY skip_days VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m

RULES
    WHEN gold.close > ema(gold.close, 50)
     AND POSITION.gold = 0
     AND NOT (NOW.date_utc IN [20679])
     AND NOT (NOW.weekday IN [4])
     AND NOT (NOW.hour_utc IN [21, 22])
    THEN BUY gold SIZING 0.1
```

Common mistakes: comparing two different symbols' prices (gold ~4000 vs a pair ~0.6 never cross); a BY distance sized for gold on a pair (lands below zero); `POSITION.x = 0` guard missing (orders stack).
