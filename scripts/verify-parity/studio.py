import json, sys, time, urllib.request, pathlib
P = pathlib.Path(__file__).parent
def call(port, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=None if body is None else json.dumps(body).encode(), headers={"content-type":"application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=600) as r: return json.load(r)
def run(port, strategy, frm, to, tier="draft", options=None):
    body = {"strategy": strategy, "from": frm, "to": to, "tier": tier, "force": True}
    if options: body["options"] = options
    r = call(port, "/api/runs", body)
    rid = r["runId"]
    for _ in range(600):
        g = call(port, f"/api/runs/{rid}")
        if g.get("status") in ("done","failed","cancelled","error"): return g
        time.sleep(1)
    return g
if __name__ == "__main__":
    port = int(sys.argv[1]); kind = sys.argv[2]
    out = {}
    if kind == "cfd":
        for s in ["XAUUSD","XAGUSD","EURUSD","GBPUSD","AUDUSD","NZDUSD","USDJPY","USDCAD","USDCHF","BTCUSD"]:
            g = run(port, f"strategies/ema_{s}.qkt", "2024-01-02", "2024-04-01")
            out[s] = {"status": g.get("status"), "error": (g.get("error") or {}).get("message") if isinstance(g.get("error"), dict) else g.get("error"), "id": g.get("id")}
    else:
        for s, fr, to in [("ES","2019-01-02","2021-01-04"),("NQ","2019-01-02","2021-01-04"),("CL","2019-01-02","2021-01-04"),("GC","2019-01-02","2021-01-04"),("JY","2019-01-02","2021-01-04"),("NG","2019-01-02","2021-01-04"),("BTCUSDT","2024-01-01","2024-03-01")]:
            g = run(port, f"strategies/fut_{s}.qkt", fr, to)
            out[s] = {"status": g.get("status"), "error": (g.get("error") or {}).get("message") if isinstance(g.get("error"), dict) else g.get("error"), "id": g.get("id")}
    json.dump(out, open(P / f"studio_{kind}.json", "w"), indent=1)
    for k, v in out.items(): print(k, v)
