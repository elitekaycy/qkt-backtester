# Parity checks: the studio against raw qkt

Proves, per symbol, that what the studio runs and shows is what qkt produced, on your own data. Needs `qkt` on PATH and a
data store with the symbols (edit the symbol lists at the top of each script).

1. `python3 raw.py`: runs one fixed EMA strategy per CFD symbol with raw `qkt backtest --bars` and records `raw/`.
2. Start a studio on a workspace holding those strategies (`ema_<SYMBOL>.qkt`) and `cfg.yaml` as `qkt.config.yaml`, then
   `python3 studio.py <port> cfd` runs the same strategies through the API.
3. `python3 compare.py cfd <port> raw <workspace>`: fills, total P&L and every trade row must be identical.
4. `python3 recompute.py [raw-dir]`: recomputes each round trip from prices and the contract size without trusting qkt's
   `realized`; total P&L differs from the realized sum only by the open position's mark.
5. `STUDIO_PORT=<port> python3 strict.py`: runs raw qkt in strict mode (no `--allow-incomplete`) over the longest window the
   studio calls complete for each strategy; qkt must accept every one at 100% coverage.

Futures: the same with `studio.py <port> fut` (strategies `fut_<ROOT>.qkt`, the futures config) and `compare.py fut`.
