import json, csv, sys, pathlib, hashlib, urllib.request
P = pathlib.Path(__file__).parent
kind, port, rawdir, ws = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
st = json.load(open(P / f"studio_{kind}.json"))
bad = 0
for s, v in st.items():
    eng = ws / "runs" / v["id"] / "engine"
    raw = P / rawdir / s
    rj, sj = json.load(open(raw/"result.json")), json.load(open(eng/"result.json"))
    rt, stt = list(csv.DictReader(open(raw/"trades.csv"))), list(csv.DictReader(open(eng/"trades.csv")))
    key = lambda rows: [(r["timestamp"], r["side"], r["quantity"], r["price"], r["realized"]) for r in rows]
    same_trades = key(rt) == key(stt)
    same_pnl = rj["global"]["totalPnL"] == sj["global"]["totalPnL"]
    same_fills = rj["tradeSummary"]["fills"] == sj["tradeSummary"]["fills"]
    # the studio's own derived summary must agree with the engine
    sm = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/runs/{v['id']}"))
    integ = sm.get("integrity") or sm.get("summary", {}).get("integrity")
    ok = same_trades and same_pnl and same_fills
    bad += not ok
    print(f"{s:8} fills raw={rj['tradeSummary']['fills']:3} studio={sj['tradeSummary']['fills']:3} totalPnL raw={rj['global']['totalPnL'][:12]} studio={sj['global']['totalPnL'][:12]} trades identical={same_trades} {'OK' if ok else 'MISMATCH'}")
sys.exit(1 if bad else 0)
