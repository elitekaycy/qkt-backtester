#!/usr/bin/env python3
"""
Independent check of everything the studio derives from a qkt run.

Runs a strategy through a running studio, downloads qkt's own raw output (trades.csv, result.json, equity_global.csv) through
the API, recomputes every derived number here from scratch (round trips, exit reasons, summary stats, daily/monthly/weekday/hour
buckets, R, streaks, equity drawdown) and compares with what the studio serves. Any difference fails. Standard library only.

  scripts/accuracy-check.py BASE STRATEGY FROM TO [draft|full] [OPTIONS_JSON] [REPEAT]

REPEAT > 1 also forces that many identical runs and checks every artifact is byte-identical (determinism).
PARAMS='{"fast":"7"}' overrides strategy PARAMs. CLI_REPLAY=<qkt data home> (studio on this machine only) re-runs the exact
command the studio recorded with the plain qkt CLI and requires the same trades, equity and totals: the studio passes qkt
exactly what it says, and changes nothing qkt computes.
"""
import csv, datetime as dt, hashlib, io, json, sys, time, urllib.parse, urllib.request
from collections import defaultdict

BASE = sys.argv[1].rstrip("/")
STRATEGY, FROM, TO = sys.argv[2], sys.argv[3], sys.argv[4]
TIER = sys.argv[5] if len(sys.argv) > 5 else "draft"
OPTIONS = json.loads(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] else None
REPEAT = int(sys.argv[7]) if len(sys.argv) > 7 else 1
TOKEN = __import__("os").environ.get("STUDIO_TOKEN")
PARAMS = json.loads(__import__("os").environ.get("PARAMS") or "null")
CLI_REPLAY = __import__("os").environ.get("CLI_REPLAY")

STOP_FAMILY = {"Stop", "StopLimit", "TrailingStop", "ArmedTrailingStop", "SteppedStop", "TimeTighteningStop", "TrailingStopLimit"}
TARGET_FAMILY = {"Limit", "IfTouched"}

def http(path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method="POST" if body is not None else "GET",
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    with urllib.request.urlopen(req, timeout=900) as r:
        data = r.read()
        return data if raw else json.loads(data or b"null")

def run(force):
    body = {"strategy": STRATEGY, "from": FROM, "to": TO, "tier": TIER, "force": force}
    if OPTIONS: body["options"] = OPTIONS
    if PARAMS: body["params"] = PARAMS
    rid = http("/api/runs", body)["runId"]
    for _ in range(3600):
        r = http(f"/api/runs/{rid}")
        if r["status"] in ("done", "failed", "cancelled", "interrupted"): break
        time.sleep(0.25)
    if r["status"] != "done": sys.exit(f"run {rid} ended {r['status']}: {r.get('error')}")
    return rid

art = lambda rid, p: http(f"/api/runs/{rid}/artifact?path={urllib.parse.quote(p)}", raw=True)
f = lambda x: 0.0 if x in (None, "") else float(x)
of = lambda x: None if x in (None, "") else float(x)
utc = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc)

def reference_trips(rows):
    """A round trip opens when the strategy's position leaves flat and closes when it returns to flat or flips side."""
    open_by, trips = {}, []
    def new(r, side, qty):
        t = dict(strategy=r["strategy"], symbol=r["symbol"], side=side, entryTs=int(r["timestamp"]), exitTs=None, pnl=0.0, fills=0, maxQty=abs(qty),
                 eQty=0.0, eNot=0.0, xQty=0.0, xNot=0.0, sl=of(r["stopLossPrice"]), tp=of(r["takeProfitPrice"]), risk=of(r.get("riskUsd")), open=True, closeType="")
        trips.append(t); return t
    for r in rows:
        key = (r["strategy"], r["symbol"]); b, a = f(r["strategyPositionQtyBefore"]), f(r["strategyPositionQtyAfter"])
        if b == 0 and a == 0: continue
        t = open_by.get(key); flip = b != 0 and a != 0 and (b > 0) != (a > 0)
        if b == 0: t = new(r, "long" if a > 0 else "short", a); open_by[key] = t
        elif t is None: t = new(r, "long" if b > 0 else "short", b); open_by[key] = t
        t["fills"] += 1; t["pnl"] += f(r["realized"])
        if b == 0 or (not flip and abs(a) > abs(b)):
            add = abs(a) - abs(b); t["eQty"] += add; t["eNot"] += add * f(r["price"]); t["maxQty"] = max(t["maxQty"], abs(a))
            if of(r["stopLossPrice"]) is not None: t["sl"] = of(r["stopLossPrice"])
            if of(r["takeProfitPrice"]) is not None: t["tp"] = of(r["takeProfitPrice"])
            if of(r.get("riskUsd")) is not None: t["risk"] = ((t["risk"] or 0) + of(r["riskUsd"])) if b != 0 else of(r["riskUsd"])
        else:
            closed = abs(b) if flip else abs(b) - abs(a); t["xQty"] += closed; t["xNot"] += closed * f(r["price"])
            if a == 0 or flip:
                t["open"] = False; t["exitTs"] = int(r["timestamp"]); t["closeType"] = r.get("orderType", ""); del open_by[key]
                if flip:
                    n = new(r, "long" if a > 0 else "short", a); n["fills"] = 1; n["eQty"] = abs(a); n["eNot"] = abs(a) * f(r["price"]); open_by[key] = n
    for t in trips:
        t["entryPx"] = t["eNot"] / t["eQty"] if t["eQty"] else None
        t["exitPx"] = (t["xNot"] / t["xQty"]) if (t["xQty"] and not t["open"]) else None
        t["holdMs"] = (t["exitTs"] - t["entryTs"]) if t["exitTs"] is not None else None
        ct = t["closeType"]
        t["exit"] = "open" if t["open"] else ("stop" if ct in STOP_FAMILY else "target" if ct in TARGET_FAMILY else "signal")
        t["r"] = (t["pnl"] / t["risk"]) if (not t["open"] and t["risk"]) else None
    return trips

problems = []
def same(a, b, tol=1e-6):
    if a is None or b is None: return a is None and b is None
    if isinstance(a, (int, float)) and isinstance(b, (int, float)): return abs(a - b) <= tol * max(1.0, abs(a), abs(b))
    return a == b
def check(label, got, want, tol=1e-6):
    if not same(got, want, tol): problems.append(f"{label}: studio={got!r} reference={want!r}")

def verify(rid):
    rows = list(csv.DictReader(io.StringIO(art(rid, "engine/trades.csv").decode())))
    res = json.loads(art(rid, "engine/result.json")); g = res["global"]
    R = reference_trips(rows); closed = [t for t in R if not t["open"]]
    trips = json.loads(art(rid, "derived/roundtrips.json")); s = http(f"/api/runs/{rid}/derived/summary"); a = http(f"/api/runs/{rid}/analytics")
    check("trade count", len(trips), len(R))
    for i, (x, y) in enumerate(zip(trips, R)):
        for k, rk in (("strategy", "strategy"), ("symbol", "symbol"), ("side", "side"), ("entryTs", "entryTs"), ("exitTs", "exitTs"), ("entryPx", "entryPx"), ("exitPx", "exitPx"),
                      ("qty", "maxQty"), ("pnl", "pnl"), ("fills", "fills"), ("holdMs", "holdMs"), ("open", "open"), ("sl", "sl"), ("tp", "tp"), ("risk", "risk"), ("exit", "exit"), ("r", "r")):
            check(f"trade #{i + 1} {k}", x.get(k), y[rk])
    wins = [t for t in closed if t["pnl"] > 0]; losses = [t for t in closed if t["pnl"] < 0]
    gw, gl = sum(t["pnl"] for t in wins), sum(t["pnl"] for t in losses)
    streak = mx = 0
    for t in sorted(closed, key=lambda t: t["exitTs"]): streak = streak + 1 if t["pnl"] < 0 else 0; mx = max(mx, streak)
    for k, v in (("realized", f(g["realizedTotal"])), ("totalPnl", f(g["totalPnL"])), ("unrealized", f(g["unrealizedTotal"])), ("fills", g["tradeCount"]), ("trades", len(closed)),
                 ("openTrades", len(R) - len(closed)), ("wins", len(wins)), ("losses", len(losses)), ("winRate", len(wins) / len(closed) if closed else 0),
                 ("profitFactor", gw / -gl if gl < 0 else None), ("expectancy", sum(t["pnl"] for t in closed) / len(closed) if closed else 0),
                 ("largestWin", max([0] + [t["pnl"] for t in closed])), ("largestLoss", min([0] + [t["pnl"] for t in closed])), ("maxConsecutiveLosses", mx),
                 ("sharpe", f(g["sharpeRatio"])), ("maxDrawdown", f(g["maxDrawdown"]))):
        check(f"summary.{k}", s.get(k), v)
    check("round trips reconcile with the engine's realised P&L", sum(t["pnl"] for t in R), f(g["realizedTotal"]))
    daily, monthly, wd, hr, ex = defaultdict(float), defaultdict(float), [0.0] * 7, [0.0] * 24, defaultdict(int)
    for t in closed:
        x, e = utc(t["exitTs"]), utc(t["entryTs"])
        daily[x.strftime("%Y-%m-%d")] += t["pnl"]; monthly[x.strftime("%Y-%m")] += t["pnl"]; wd[(e.weekday() + 1) % 7] += t["pnl"]; hr[e.hour] += t["pnl"]; ex[t["exit"]] += 1
    rd = lambda d: {k: round(v, 6) for k, v in d.items()}
    check("daily P&L", rd({d["day"]: d["pnl"] for d in a["daily"]}), rd(daily))
    check("monthly P&L", rd({m["month"]: m["pnl"] for m in a["monthly"]}), rd(monthly))
    check("weekday P&L", [round(b["pnl"], 6) for b in a["weekday"]], [round(v, 6) for v in wd])
    check("hour P&L", [round(b["pnl"], 6) for b in a["hour"]], [round(v, 6) for v in hr])
    check("exit reasons", {e["reason"]: e["trades"] for e in a["exit"]}, dict(ex))
    check("longest losing streak", a["maxLossStreak"], mx)
    eq = http(f"/api/runs/{rid}/derived/equity")
    raw = [float(r[1]) for r in csv.reader(io.StringIO(art(rid, "engine/equity_global.csv").decode())) if r and r[0].isdigit()]
    if raw:
        peak, mdd = -1e300, 0.0
        for v in raw: peak = max(peak, v); mdd = min(mdd, (v - peak) / peak if peak > 0 else 0)
        check("equity first", eq["equity"][0], raw[0]); check("equity last", eq["equity"][-1], raw[-1]); check("equity max drawdown", min(eq["drawdown"]), mdd, 1e-9)
    # each drill-down bar lists exactly the trades it counts
    for name, h, lo, hi in (("P&L", a["pnlHistogram"], "minPnl", "maxPnl"), ("R", a.get("rHistogram"), "minR", "maxR")):
        if not h: continue
        for i, c in enumerate(h["counts"]):
            top = h["edges"][i + 1]
            if i < len(h["counts"]) - 1: top = __import__("math").nextafter(top, -__import__("math").inf)
            got = http(f"/api/runs/{rid}/analytics?{lo}={h['edges'][i]!r}&{hi}={top!r}")["closed"]
            check(f"{name} bar {i} lists what it counts", got, c)
    for b in a["hold"]:
        q = f"minHold={b['minMs']}" + (f"&maxHold={b['maxMs']}" if b["maxMs"] is not None and b["maxMs"] < 1e15 else "")
        check(f"hold bucket {b['label']} lists what it counts", http(f"/api/runs/{rid}/analytics?{q}")["closed"], b["trades"])
    # orders qkt rejected: the studio's summary counts exactly the rows qkt wrote, grouped without losing any
    try: rej = list(csv.DictReader(io.StringIO(art(rid, "engine/rejections.csv").decode())))
    except Exception: rej = []
    meta = http(f"/api/runs/{rid}/derived/meta"); rs = meta.get("rejections") or {"count": 0, "reasons": []}
    check("rejections: count", rs["count"], len(rej))
    check("rejections: reasons add up", sum(x["count"] for x in rs["reasons"]), len(rej))
    check("rejections: every example is a reason qkt wrote", all(x["example"] in {r["reason"] for r in rej} for x in rs["reasons"]), True)
    runj = http(f"/api/runs/{rid}")
    if len(R) == 0 and rej: check("no-trade run names the rejections", any("rejected" in w for w in runj["warnings"]), True)
    if len(R) == 0 and not rej: check("no-trade run says the conditions never held", any("never held" in w for w in runj["warnings"]), True)
    return len(R)

def fingerprint(rid):
    out = {}
    for p in ("engine/trades.csv", "engine/equity_global.csv", "derived/roundtrips.json", "derived/summary.json", "derived/monthly.json", "derived/equity.json", "derived/integrity.json"):
        out[p] = hashlib.sha256(art(rid, p)).hexdigest()
    return out

def replay(rid):
    """Run the recorded qkt command again with the CLI alone, into a scratch folder, and compare what qkt wrote."""
    import os, shlex, subprocess, tempfile
    runj = http(f"/api/runs/{rid}")
    cmd = next((st.get("command") for st in runj["steps"] if (st.get("command") or "").startswith("qkt backtest")), None)
    if not cmd: problems.append("replay: no recorded qkt backtest command"); return
    args = shlex.split(cmd)
    out = tempfile.mkdtemp(prefix="qkt-replay-")
    args[args.index("--report-dir") + 1] = out
    p = subprocess.run(args, env={**os.environ, "QKT_DATA_HOME": CLI_REPLAY}, capture_output=True, text=True, timeout=1800)
    if p.returncode != 0: problems.append(f"replay: qkt exited {p.returncode}: {p.stderr[-400:]}"); return
    for f in ("trades.csv", "equity_global.csv"):
        mine = open(os.path.join(out, f), "rb").read()
        if hashlib.sha256(mine).hexdigest() != hashlib.sha256(art(rid, f"engine/{f}")).hexdigest(): problems.append(f"replay: {f} differs from the plain qkt CLI")
    a, b = json.load(open(os.path.join(out, "result.json")))["global"], json.loads(art(rid, "engine/result.json"))["global"]
    for k in ("realizedTotal", "unrealizedTotal", "totalPnL", "tradeCount", "maxDrawdown", "sharpeRatio", "winRate", "profitFactor", "commissionPaid", "swapPaid"):
        if a.get(k) != b.get(k): problems.append(f"replay: result.global.{k} studio={b.get(k)!r} cli={a.get(k)!r}")
    print(f"cli replay: {' '.join(args[:2])} ... reproduces trades, equity and totals" if not any(x.startswith("replay") for x in problems) else "cli replay: DIFFERS")

rid = run(force=False)
n = verify(rid)
if CLI_REPLAY: replay(rid)
print(f"{STRATEGY} {FROM}..{TO} {TIER}: {n} trades compared with an independent implementation")
if REPEAT > 1:
    base = fingerprint(rid)
    for i in range(REPEAT - 1):
        other = fingerprint(run(force=True))
        for k in base:
            if base[k] != other[k]: problems.append(f"not deterministic: {k} differs on forced re-run {i + 2}")
    print(f"determinism: {REPEAT} runs, {len(base)} artifacts compared")
if problems:
    print("\n".join(problems[:200])); print(f"ACCURACY FAIL: {len(problems)} difference(s)"); sys.exit(1)
print("ACCURACY OK")
