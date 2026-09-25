import { useEffect, useMemo, useRef, useState } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { api, type Job } from "../api/client.js";
import type { McMethod, McResult } from "../api/types.js";
import { baseOption, EChart, tok } from "../charts/EChart.js";
import { useStore } from "../state/store.js";
import { DASH, daysBetween, fmtMoney, fmtNum, fmtPct, fmtRatio } from "../util/format.js";

type Tab = "mc" | "grid" | "wf";

async function poll(id: string, onUpdate: (j: Job) => void, alive: () => boolean): Promise<Job | null> {
  for (;;) {
    if (!alive()) return null;
    const j = await api.job(id);
    onUpdate(j);
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 600));
  }
}

/** One text box per PARAM of the active strategy: "5,9,13" sweeps it, blank leaves the file's value. */
function useAxes() {
  const strategy = useStore((s) => s.strategyPath());
  const file = useStore((s) => s.openFiles.find((f) => f.path === strategy));
  const params = useMemo(() => (file ? parseStrategyInfo(file.content).params : []), [file?.content]);
  const [axes, setAxes] = useState<Record<string, string>>({});
  const parsed = Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, v.split(",").map((x) => x.trim()).filter(Boolean)]).filter(([, v]) => (v as string[]).length > 0)) as Record<string, string[]>;
  const combos = Object.values(parsed).reduce((a, v) => a * v.length, Object.keys(parsed).length ? 1 : 0);
  return { strategy, params, axes, setAxes, parsed, combos };
}

function AxesEditor({ ax }: { ax: ReturnType<typeof useAxes> }) {
  if (!ax.params.length) return <div className="empty">The active strategy has no <b>PARAM</b> declarations to sweep. Add e.g. <span className="mono">PARAM fast = 9</span> and use <span className="mono">fast</span> in a rule.</div>;
  return (
    <div className="form-row">
      {ax.params.map((p) => (
        <label key={p.name} className="field"><span className="mono">{p.name}</span>
          <input className="input" style={{ width: 120 }} placeholder={`${p.default} (fixed)`} value={ax.axes[p.name] ?? ""} onChange={(e) => ax.setAxes({ ...ax.axes, [p.name]: e.target.value })} title="Comma-separated values, e.g. 5,9,13" /></label>
      ))}
      <span className="muted">{ax.combos ? `${ax.combos} combination${ax.combos === 1 ? "" : "s"}` : "enter values to sweep"}</span>
    </div>
  );
}

// ---- Monte Carlo ---------------------------------------------------------------------------------------------
function MonteCarlo() {
  const { results } = useStore();
  const [method, setMethod] = useState<McMethod>("bootstrap");
  const [sims, setSims] = useState(1000);
  const [seed, setSeed] = useState(42);
  const [blockLen, setBlockLen] = useState(0);
  const [skipPct, setSkipPct] = useState(10);
  const [ruin, setRuin] = useState(50);
  const [res, setRes] = useState<McResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRes(null); setErr(null); }, [results?.runId]);
  if (!results) return <div className="empty">Run a backtest first. Monte Carlo resamples its closed trades.</div>;
  const n = results.summary.trades;

  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api.runMonteCarlo(results.runId, { method, sims, seed, blockLen: blockLen || undefined, skipPct: skipPct / 100, ruinDrawdown: ruin / 100 })); }
    catch (e) { setErr((e as Error).message); setRes(null); }
    finally { setBusy(false); }
  };
  const help: Record<McMethod, string> = {
    shuffle: "Reorders the same trades. Final P&L never changes; drawdown does. Tests sequencing luck.",
    bootstrap: "Draws trades with replacement. Tests how variable the totals are. Assumes independent trades.",
    block: "Draws runs of consecutive trades. Keeps streaks and clustering that plain bootstrap destroys.",
    skip: "Randomly drops trades. Tests missed fills and execution failures.",
  };
  return (
    <>
      <div className="form-row">
        <label className="field">method <select className="input" value={method} onChange={(e) => setMethod(e.target.value as McMethod)}>
          <option value="bootstrap">Bootstrap</option><option value="shuffle">Shuffle order</option><option value="block">Block bootstrap</option><option value="skip">Skip trades</option></select></label>
        <label className="field">paths <input className="input narrow" type="number" min={10} max={100000} value={sims} onChange={(e) => setSims(Number(e.target.value))} /></label>
        <label className="field">seed <input className="input narrow" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></label>
        {method === "block" && <label className="field">block <input className="input narrow" type="number" min={0} placeholder="auto" value={blockLen || ""} onChange={(e) => setBlockLen(Number(e.target.value))} /></label>}
        {method === "skip" && <label className="field">skip % <input className="input narrow" type="number" min={0} max={100} value={skipPct} onChange={(e) => setSkipPct(Number(e.target.value))} /></label>}
        <label className="field" title="A path counts as ruined when its drawdown reaches this level">ruin at DD <input className="input narrow" type="number" min={1} max={100} value={ruin} onChange={(e) => setRuin(Number(e.target.value))} />%</label>
        <button className="btn primary" disabled={busy || n < 30} onClick={() => void run()}>{busy ? "Running…" : "Run Monte Carlo"}</button>
        <span className="muted">{n} closed trades · same seed reproduces the result</span>
      </div>
      <div className="muted" style={{ padding: "0 10px 6px" }}>{help[method]}</div>
      {n < 30 && <div className="banner warn">Monte Carlo needs at least 30 closed trades. This run has {n}. Use a longer window.</div>}
      {err && <div className="banner bad">{err}</div>}
      {res && <McView r={res} />}
    </>
  );
}

function McView({ r }: { r: McResult }) {
  const q = (a: { p5: number; p50: number; p95: number }, f: (v: number) => string) => `${f(a.p5)}  ·  ${f(a.p50)}  ·  ${f(a.p95)}`;
  const obsBucket = (() => { const e = r.drawdownHistogram.edges; for (let i = 0; i < e.length - 1; i++) if (r.observed.maxDrawdown <= e[i + 1]!) return i; return e.length - 2; })();
  return (
    <>
      <div className="kpis">
        <div className="kpi"><div className="l">Final equity 5·50·95%</div><div className="v" style={{ fontSize: 13 }}>{q(r.finalEquity, (v) => fmtNum(v, 0))}</div><div className="s">actual {fmtNum(r.observed.finalEquity, 0)}</div></div>
        <div className="kpi"><div className="l">Max DD 5·50·95%</div><div className="v loss" style={{ fontSize: 13 }}>{q(r.maxDrawdown, (v) => fmtPct(v, 1))}</div><div className="s">actual {fmtPct(r.observed.maxDrawdown, 1)}</div></div>
        <div className="kpi"><div className="l">P(final &lt; start)</div><div className="v">{fmtPct(r.probNegative, 1)}</div></div>
        <div className="kpi"><div className="l">P(ruin: DD ≥ {fmtPct(r.ruinDrawdown, 0)})</div><div className="v">{fmtPct(r.probRuin, 1)}</div></div>
      </div>
      <div className="section">
        <h4>Equity paths ({r.sims.toLocaleString()} × {r.trades} trades, {r.method}, seed {r.seed})</h4>
        <EChart height={210} deps={[r]} testId="mc-fan" build={() => {
          const c = tok("--series-1"), i = r.fanIndex, f = r.fan;
          const diff = (a: number[], b: number[]) => a.map((v, k) => v - b[k]!);
          return baseOption({
            xAxis: { ...baseOption().xAxis as object, type: "category", data: i, name: "trades", nameLocation: "middle", nameGap: 20, axisLabel: { color: tok("--ink-3"), fontSize: 11, interval: Math.max(0, Math.floor(i.length / 6)) } },
            tooltip: { ...baseOption().tooltip as object, formatter: (p: Array<{ dataIndex: number }>) => { const k = p[0]!.dataIndex; return `after ${i[k]} trades<br/>5%: ${fmtNum(f.p5[k]!, 0)}<br/>25%: ${fmtNum(f.p25[k]!, 0)}<br/><b>median: ${fmtNum(f.p50[k]!, 0)}</b><br/>75%: ${fmtNum(f.p75[k]!, 0)}<br/>95%: ${fmtNum(f.p95[k]!, 0)}`; } },
            series: [
              { type: "line", stack: "o", data: f.p5, symbol: "none", lineStyle: { opacity: 0 }, silent: true },
              { type: "line", stack: "o", data: diff(f.p95, f.p5), symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: c, opacity: 0.13 }, silent: true },
              { type: "line", stack: "i", data: f.p25, symbol: "none", lineStyle: { opacity: 0 }, silent: true },
              { type: "line", stack: "i", data: diff(f.p75, f.p25), symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: c, opacity: 0.25 }, silent: true },
              { type: "line", data: f.p50, symbol: "none", lineStyle: { width: 2, color: c }, markLine: { silent: true, symbol: "none", lineStyle: { color: tok("--ink-2"), type: "dashed" }, label: { color: tok("--ink-2"), formatter: "actual final", position: "insideEndTop" }, data: [{ yAxis: r.observed.finalEquity }] } },
            ],
          });
        }} />
        <div className="legend"><span><i style={{ background: tok("--series-1") }} />median</span><span className="muted">bands: 25–75% and 5–95% of paths · dashed: the real backtest's final equity</span></div>
      </div>
      <div className="section">
        <h4>Max drawdown distribution</h4>
        <EChart height={150} deps={[r]} testId="mc-hist" build={() => baseOption({
          xAxis: { ...baseOption().xAxis as object, type: "category", data: r.drawdownHistogram.counts.map((_, k) => `${(r.drawdownHistogram.edges[k]! * 100).toFixed(0)}%`), axisLabel: { color: tok("--ink-3"), fontSize: 11, interval: 3 } },
          yAxis: { ...baseOption().yAxis as object, scale: false },
          series: [{ type: "bar", data: r.drawdownHistogram.counts.map((v, k) => ({ value: v, itemStyle: { color: k === obsBucket ? tok("--ink-2") : tok("--series-1"), borderRadius: [3, 3, 0, 0] } })), barCategoryGap: "12%" }],
          tooltip: { ...baseOption().tooltip as object, trigger: "axis", formatter: (p: Array<{ dataIndex: number; value: number }>) => `${(r.drawdownHistogram.edges[p[0]!.dataIndex]! * 100).toFixed(1)}–${(r.drawdownHistogram.edges[p[0]!.dataIndex + 1]! * 100).toFixed(1)}%: ${p[0]!.value} paths` },
        })} />
        <div className="legend"><span className="muted">Darker bar: the bucket holding the real backtest's drawdown ({fmtPct(r.observed.maxDrawdown, 1)}).</span></div>
      </div>
    </>
  );
}

// ---- Parameter grid ------------------------------------------------------------------------------------------
function Grid() {
  const { cfg, results } = useStore();
  const ax = useAxes();
  const [rank, setRank] = useState("sharpe");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const running = job?.status === "running";

  const start = async () => {
    setErr(null);
    try {
      const { jobId } = await api.grid({ strategy: ax.strategy, from: cfg.from, to: cfg.to, tier: cfg.tier, params: ax.parsed, rank });
      await poll(jobId, setJob, () => alive.current);
      void useStore.getState().refreshRuns();
    } catch (e) { setErr((e as Error).message); }
  };
  const rows = (job?.result?.rows ?? []) as Array<{ params: Record<string, string>; runId?: string; status: string; summary?: Record<string, number> }>;
  const cols = ["sharpe", "calmar", "profitFactor", "totalPnL", "winRate"] as const;
  return (
    <>
      <AxesEditor ax={ax} />
      <div className="form-row">
        <label className="field">rank by <select className="input" value={rank} onChange={(e) => setRank(e.target.value)}>{cols.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <span className="muted">{cfg.tier === "draft" ? "Draft" : "Full"} · {cfg.from} → {cfg.to} · every point is a full run with its own charts and trades</span>
        <span className="grow" style={{ flex: 1 }} />
        {running ? <button className="btn danger" onClick={() => job && void api.cancelJob(job.id)}>Cancel</button>
          : <button className="btn primary" disabled={!ax.strategy || ax.combos === 0 || ax.combos > 200} onClick={() => void start()}>Run grid ({ax.combos})</button>}
      </div>
      {err && <div className="banner bad">{err}</div>}
      {job?.progress && <div className="bar"><i style={{ width: `${(job.progress.done / job.progress.total) * 100}%` }} /></div>}
      {job && <div className="muted" style={{ padding: "4px 10px" }}>{job.status}{job.progress ? ` · ${job.progress.done}/${job.progress.total}` : ""}</div>}
      {(job?.result?.warnings as string[] | undefined)?.map((w, i) => <div key={i} className="banner warn">⚠ {w}</div>)}
      {rows.length > 0 && (
        <table className="grid">
          <thead><tr><th>#</th><th>Parameters</th>{cols.map((c) => <th key={c} className="num" style={c === rank ? { color: "var(--accent)" } : undefined}>{c}{c === rank ? " ▼" : ""}</th>)}<th className="num">trades</th><th className="num">max DD</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`click${results?.runId === r.runId ? " sel" : ""}`} onClick={() => r.runId && r.status === "done" && void useStore.getState().selectRun(r.runId)} title={r.status === "done" ? "Open this run's charts and trades" : r.status}>
                <td className="muted">{i + 1}</td>
                <td className="mono">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                {cols.map((c) => <td key={c} className="num">{r.summary ? (c === "totalPnL" ? fmtMoney(r.summary[c]) : c === "winRate" ? fmtPct(r.summary[c], 1) : fmtRatio(r.summary[c])) : DASH}</td>)}
                <td className="num">{r.summary?.trades ?? DASH}</td>
                <td className="num">{r.summary ? fmtPct(r.summary.maxDrawdown, 1) : DASH}</td>
                <td className="muted">{r.status === "done" ? "" : r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---- Walk-forward: in-sample vs out-of-sample --------------------------------------------------------------------
function WalkForward() {
  const { cfg } = useStore();
  const ax = useAxes();
  const [train, setTrain] = useState(45), [test, setTest] = useState(15), [step, setStep] = useState(15);
  const [rank, setRank] = useState("sharpe");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const running = job?.status === "running";
  const span = cfg.from && cfg.to ? daysBetween(cfg.from, cfg.to) : 0;
  const tooShort = span < train + test;
  const start = async () => {
    setErr(null); setJob(null);
    try {
      const { jobId } = await api.walkForward({ strategy: ax.strategy, from: cfg.from, to: cfg.to, tier: cfg.tier, params: ax.parsed, train: `${train}d`, test: `${test}d`, step: `${step}d`, rank });
      await poll(jobId, setJob, () => alive.current);
    } catch (e) { setErr((e as Error).message); }
  };
  const res = job?.status === "done" ? job.result : null;
  const folds = (res?.folds ?? []) as Array<{ foldIndex: number; trainRange: { from: string; to: string }; testRange: { from: string; to: string }; winnerLabel: string; trainScore: string; testTotalPnL: string; testMaxDrawdown: string }>;
  const oos = res?.oosEquity as { ts: number[]; equity: number[] } | undefined;
  return (
    <>
      <AxesEditor ax={ax} />
      <div className="form-row">
        <label className="field">train <input className="input narrow" type="number" min={1} value={train} onChange={(e) => setTrain(Number(e.target.value))} />d</label>
        <label className="field">test <input className="input narrow" type="number" min={1} value={test} onChange={(e) => setTest(Number(e.target.value))} />d</label>
        <label className="field">step <input className="input narrow" type="number" min={1} value={step} onChange={(e) => setStep(Number(e.target.value))} />d</label>
        <label className="field">rank <select className="input" value={rank} onChange={(e) => setRank(e.target.value)}>{["sharpe", "calmar", "profitFactor", "totalPnL", "winRate"].map((c) => <option key={c}>{c}</option>)}</select></label>
        <span style={{ flex: 1 }} />
        {running ? <button className="btn danger" onClick={() => job && void api.cancelJob(job.id)}>Cancel</button>
          : <button className="btn primary" disabled={!ax.strategy || ax.combos === 0 || tooShort} onClick={() => void start()}>Run walk-forward</button>}
      </div>
      {tooShort && <div className="banner warn">The run window is {span} days but one fold needs train + test = {train + test} days. Widen from/to in the top bar or shorten train/test.</div>}
      <div className="muted" style={{ padding: "0 10px 6px" }}>Each fold picks the best parameters on its training window, then is scored once on the unseen test window that follows.</div>
      {err && <div className="banner bad">{err}</div>}
      {job && !res && <div className="muted" style={{ padding: "4px 10px" }}>{job.status}{job.error ? `: ${job.error.message}` : ""}</div>}
      {res && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="l">Mean in-sample score</div><div className="v">{fmtRatio(Number(res.meanTrainScore))}</div><div className="s">{rank}, training windows</div></div>
            <div className="kpi"><div className="l">Mean out-of-sample score</div><div className="v">{fmtRatio(Number(res.meanTestScore))}</div><div className="s">{rank}, unseen test windows</div></div>
            <div className="kpi"><div className="l">Out-of-sample net</div><div className="v">{fmtMoney(folds.reduce((a, f) => a + Number(f.testTotalPnL), 0))}</div><div className="s">{folds.length} folds</div></div>
          </div>
          {oos && (
            <div className="section"><h4>Stitched out-of-sample equity</h4>
              <EChart height={160} deps={[job?.id]} testId="wf-equity" build={() => baseOption({ xAxis: { ...baseOption().xAxis as object, type: "time" }, series: [{ type: "line", showSymbol: false, lineStyle: { width: 2, color: tok("--series-1") }, data: oos.ts.map((t, i) => [t, oos.equity[i]]) }], tooltip: { ...baseOption().tooltip as object, valueFormatter: (v: number) => fmtNum(v) } })} /></div>
          )}
          <table className="grid">
            <thead><tr><th>Fold</th><th>Train</th><th>Test</th><th>Winner</th><th className="num">In-sample</th><th className="num">Test P&L</th><th className="num">Test DD</th></tr></thead>
            <tbody>{folds.map((f) => (
              <tr key={f.foldIndex}><td>{f.foldIndex}</td><td className="mono">{f.trainRange.from.slice(0, 10)} → {f.trainRange.to.slice(0, 10)}</td><td className="mono">{f.testRange.from.slice(0, 10)} → {f.testRange.to.slice(0, 10)}</td>
                <td className="mono">{f.winnerLabel}</td><td className="num">{fmtRatio(Number(f.trainScore))}</td><td className={`num ${Number(f.testTotalPnL) >= 0 ? "gain" : "loss"}`}>{Number(f.testTotalPnL) >= 0 ? "▲" : "▼"} {fmtMoney(Number(f.testTotalPnL))}</td><td className="num">{fmtPct(Number(f.testMaxDrawdown), 1)}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
    </>
  );
}

export function RobustnessPanel() {
  const [tab, setTab] = useState<Tab>("mc");
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Robustness</span>
        <div className="seg" role="tablist">
          {([["mc", "Monte Carlo"], ["grid", "Grid"], ["wf", "Walk-forward"]] as Array<[Tab, string]>).map(([k, l]) => <button key={k} role="tab" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </div>
      <div className="panel-scroll">{tab === "mc" ? <MonteCarlo /> : tab === "grid" ? <Grid /> : <WalkForward />}</div>
    </div>
  );
}
