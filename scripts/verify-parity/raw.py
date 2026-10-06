import json, subprocess, sys, os, pathlib
P = pathlib.Path(__file__).parent
CFD = ["XAUUSD","XAGUSD","EURUSD","GBPUSD","AUDUSD","NZDUSD","USDJPY","USDCAD","USDCHF","BTCUSD"]
TPL = """STRATEGY ema_{s} VERSION 1

SYMBOLS
    x = BACKTEST:{s} EVERY 1h

RULES
    WHEN ema(x.close, 10) CROSSES ABOVE ema(x.close, 30) AND POSITION.x = 0
    THEN BUY x SIZING 0.1

    WHEN ema(x.close, 10) CROSSES BELOW ema(x.close, 30) AND POSITION.x > 0
    THEN CLOSE x
"""
FROM, TO = "2024-01-02", "2024-04-01"
out = {}
for s in CFD:
    f = P / f"ema_{s}.qkt"; f.write_text(TPL.format(s=s))
    d = P / "raw" / s; d.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["qkt","backtest",str(f),"--config",str(P/"cfg.yaml"),"--starting-balance","100000","--bars","--no-fetch","--from",FROM,"--to",TO,"--report-dir",str(d)],capture_output=True,text=True)
    rj = d/"result.json"
    if not rj.exists():
        out[s] = {"error": (r.stderr or r.stdout).strip().splitlines()[-1][:200]}; continue
    j = json.load(open(rj)); g = j["global"]
    out[s] = {"trades": j["tradeSummary"].get("fills") or j["tradeSummary"].get("fillCount"), "totalPnL": g.get("totalPnL"), "commission": g.get("commissionPaid"), "ts": list(j["tradeSummary"].keys())[:6]}
json.dump(out, open(P/"raw.json","w"), indent=1)
for k,v in out.items(): print(k, v)
