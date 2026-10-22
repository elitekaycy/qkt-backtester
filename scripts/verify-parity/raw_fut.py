"""Raw `qkt backtest` baselines for futures and a perpetual (continuous @front, daily bars; a Binance perpetual, hourly).
Edit RUNS for the roots you hold. Needs the futures config (risk caps) at ~/.qkt/qkt-futures.config.yaml or CONFIG."""
import os, pathlib, subprocess
P = pathlib.Path(__file__).parent.resolve()
CONFIG = os.environ.get("QKT_FUTURES_CONFIG", os.path.expanduser("~/.qkt/qkt-futures.config.yaml"))
TPL = """STRATEGY ema_{s} VERSION 1

SYMBOLS
    x = {v}:{s}{suffix} EVERY {tf}

RULES
    WHEN ema(x.close, 10) CROSSES ABOVE ema(x.close, 30) AND POSITION.x = 0
    THEN BUY x SIZING {q}

    WHEN ema(x.close, 10) CROSSES BELOW ema(x.close, 30) AND POSITION.x > 0
    THEN CLOSE x
"""
RUNS = [("CME", s, "@front", "1d", 1, "2019-01-02", "2021-01-04") for s in ["ES", "NQ", "CL", "GC", "JY", "NG"]]
RUNS += [("BINANCE_UM", "BTCUSDT", "", "1h", 0.1, "2024-01-01", "2024-03-01")]
for v, s, suf, tf, q, fr, to in RUNS:
    f = P / f"fut_{s}.qkt"; f.write_text(TPL.format(v=v, s=s, suffix=suf, tf=tf, q=q))
    d = P / "raw_fut" / s; d.mkdir(parents=True, exist_ok=True)
    subprocess.run(["qkt", "backtest", str(f), "--config", CONFIG, "--bars", "--no-fetch", "--allow-incomplete", "--from", fr, "--to", to, "--report-dir", str(d)], capture_output=True, text=True)
