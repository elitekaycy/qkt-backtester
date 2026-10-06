import csv, json, sys, pathlib
P = pathlib.Path(__file__).parent
CS = {"XAUUSD":100,"XAGUSD":5000,"EURUSD":100000,"GBPUSD":100000,"AUDUSD":100000,"NZDUSD":100000,"USDJPY":100000,"USDCAD":100000,"USDCHF":100000,"BTCUSD":1}
root = pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else P/"raw"
bad = 0
for s, cs in CS.items():
    rows = list(csv.DictReader(open(root/s/"trades.csv")))
    pos = 0.0; avg = 0.0; native = 0.0; acct = 0.0; maxdiff = 0.0
    for r in rows:
        q = float(r["quantity"]); px = float(r["price"]); side = 1 if r["side"]=="BUY" else -1
        if pos*side >= 0:           # opening or adding
            avg = (avg*abs(pos)+px*q)/(abs(pos)+q); pos += side*q
        else:                       # closing
            closeq = min(q, abs(pos)); pnl = (px-avg)*(1 if pos>0 else -1)*closeq*cs
            maxdiff = max(maxdiff, abs(pnl-float(r["nativeRealized"]))); native += pnl; pos += side*closeq
        acct += float(r["accountRealized"])
    tot = float(json.load(open(root/s/"result.json"))["global"]["totalPnL"])
    ok = maxdiff < 0.01 and abs(acct-tot) < 0.5
    bad += not ok
    print(f"{s:7} fills={len(rows):3} indepNative={native:11.2f} sumAccountRealized={acct:11.2f} totalPnL={tot:11.2f} maxPerTripDiff={maxdiff:.4f} {'OK' if ok else 'MISMATCH'}")
sys.exit(1 if bad else 0)
