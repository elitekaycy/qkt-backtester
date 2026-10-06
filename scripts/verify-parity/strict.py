import json, subprocess, urllib.request, pathlib, time
P=pathlib.Path('.').resolve()
d=json.load(urllib.request.urlopen(f"http://127.0.0.1:{__import__('os').environ.get('STUDIO_PORT','8101')}/api/data/readiness", timeout=300))
res={}
for r in d['strategies']:
    s=r['strategy'].split('/')[-1][4:-4]; w=r['bars']['longest']
    t=time.time()
    p=subprocess.run(["qkt","backtest",str(P/f"ema_{s}.qkt"),"--config",str(P/"cfg.yaml"),"--starting-balance","100000","--bars","--no-fetch","--from",w['from'],"--to",w['to'],"--report-dir",str(P/"strict"/s)],capture_output=True,text=True)
    cov=[l for l in (p.stdout+p.stderr).splitlines() if 'coverage' in l]
    res[s]=(p.returncode,w,cov[:1],round(time.time()-t))
    print(s.ljust(7),"exit",p.returncode,w['from'],"->",w['to'],cov[:1],f"{res[s][3]}s",flush=True)
