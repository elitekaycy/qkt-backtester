import { useMemo } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { rangeDays } from "@qkt-studio/core/ranges";
import { api, type SettingsView } from "../api/client.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { addDays, daysBetween } from "../util/format.js";
import { insideRanges } from "../util/datawindow.js";
import { hasDerivativeStreams, kindContextFrom, shownTier, streamsPerpetual, tierRule } from "../util/derivatives.js";
import { CircleAlert, CircleCheck, Database, Hammer, Zap } from "../ui/icons.js";

const NO_PREFS: SettingsView["symbolPrefs"] = {};   // a stable fallback: a fresh {} per call makes the selector unequal every time
const PRESETS: Array<[string, number]> = [["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365]];
const EXEC = ["paper-fast", "mt5-basic", "mt5-realistic", "stress"] as const;

/** Every qkt option the studio exposes, in one form. Fields that only apply to tick runs say so instead of vanishing. */
export function RunSettings() {
  const ui = useUi();
  const cfg = useStore((s) => s.cfg), setCfg = useStore((s) => s.setCfg), setOption = useStore((s) => s.setOption), setParam = useStore((s) => s.setParam);
  const strategy = useStore((s) => s.strategyPath());
  const file = useStore((s) => s.openFiles.find((f) => f.path === s.strategyPath()));
  const readiness = useStore((s) => s.readiness), scan = useStore((s) => s.scan), trackJob = useStore((s) => s.trackJob);
  const params = useMemo(() => (file ? parseStrategyInfo(file.content).params : []), [file?.content]);
  // what the streams are decides which tier can run them, whether funding applies, and who fills the orders
  const instruments = useStore((s) => s.instruments);
  const rule = useMemo(() => tierRule(file ? parseStrategyInfo(file.content).streams : []), [file?.content]);
  const ctx = useMemo(() => kindContextFrom(instruments), [instruments]);
  const perp = useMemo(() => !!file && streamsPerpetual(file.content, ctx), [file?.content, ctx]);
  const deriv = useMemo(() => !!file && hasDerivativeStreams(file.content, ctx), [file?.content, ctx]);
  const values = (strategy && cfg.paramsByStrategy[strategy]) || {};
  const o = cfg.options;
  const ticks = shownTier(cfg.tier, file ? parseStrategyInfo(file.content).streams : []) === "full";
  const span = cfg.from && cfg.to ? daysBetween(cfg.from, cfg.to) : 0;
  const ready = readiness.find((r) => r.strategy === strategy);
  const mode = ticks ? ready?.ticks : ready?.bars;
  const submitError = useStore((s) => s.submitError);
  const prefs = useStore((s) => s.settings?.symbolPrefs ?? NO_PREFS);
  const limited = ready ? ready.streams.filter((x) => prefs[x.symbol]?.from || prefs[x.symbol]?.to).map((x) => x.symbol) : [];
  const outside = !!mode && mode.runnable && !!cfg.from && !!cfg.to && !insideRanges(cfg.from, cfg.to, mode.ranges);

  async function buildMissing() {
    if (!mode) return;
    for (const b of mode.blocked.filter((x) => x.fix === "build-bars")) {
      const [, sym] = b.stream.split(":"); const [symbol, tf] = (sym ?? "").split(" ");
      const t = scan?.symbols.find((s) => s.symbol === symbol)?.ticks;
      if (!symbol || !tf || !t?.first || !t.last) continue;
      try { const { jobId } = await api.buildBars({ symbol, tf, from: t.first, to: addDays(t.last, 1) }); trackJob(jobId, `Build ${symbol} ${tf} bars`); }
      catch (e) { useStore.getState().toast("error", (e as Error).message); }
    }
    ui.set({ runSettings: false }); ui.showSection("data");
  }

  return (
    <div style={{ width: 420 }}>
      <section className="settings-sec">
        <h4>Run on</h4>
        <div className="seg" role="group" aria-label="Data used to run" style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          <button aria-pressed={!ticks} disabled={!!rule.draft} title={rule.draft ?? undefined} onClick={() => setCfg({ tier: "draft" })}><Zap size={14} />Bars <span className="badge accent">default</span></button>
          <button aria-pressed={ticks} disabled={!!rule.full} title={rule.full ?? undefined} onClick={() => setCfg({ tier: "full" })}><Database size={14} />Ticks</button>
        </div>
        {(rule.draft || rule.full) && <div className="hint ink2" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>{rule.draft ?? rule.full}</div>}
        <div className="hint ink2" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>
          {ticks ? "Replays every tick from your tick store. Slow (tens of seconds per month), and the reference result. Needed for the MT5 simulator and realistic stop/target fills."
            : "Uses the candles built from your ticks. Seconds per month, identical to ticks for market orders. Stop and target fills are approximated from bars."}
        </div>
        {mode ? (
          mode.runnable ? (
            <div className="banner" style={{ alignItems: "center" }}>
              <CircleCheck size={16} color="var(--ok)" />
              <span className="grow">Complete for this strategy: <b className="num">{mode.longest!.from}</b> → <b className="num">{mode.longest!.to}</b> <span className="muted">({rangeDays(mode.longest!)}d)</span></span>
              <button className="btn sm" onClick={() => setCfg({ from: mode.longest!.from, to: mode.longest!.to })}>Use</button>
            </div>
          ) : (
            <div className="banner warn" style={{ flexDirection: "column" }}>
              <div className="row"><CircleAlert size={16} color="var(--warn)" /><b>Not runnable on {ticks ? "ticks" : "bars"} yet</b></div>
              {mode.blocked.map((b) => <div key={b.stream} className="ink2">{b.stream}: {b.reason}</div>)}
              <div className="row">
                {mode.blocked.some((b) => b.fix === "build-bars") && <button className="btn sm" onClick={() => void buildMissing()}><Hammer size={14} />Build missing bars</button>}
                <button className="btn sm ghost" onClick={() => { ui.set({ runSettings: false }); ui.showSection("data"); }}>Open Data</button>
              </div>
            </div>
          )
        ) : <div className="hint">Open a strategy and scan the data source to see which windows can run.</div>}
        {outside && (
          <div className="banner warn rs-msg" role="alert">
            <div className="row"><CircleAlert size={16} color="var(--warn)" /><b>This window is not fully inside data that is complete{limited.length ? ` and inside the range you set for ${limited.join(", ")}` : ""}.</b></div>
            <div className="ink2">The run may be refused or hit missing days. The end date is exclusive.</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => setCfg({ from: mode!.longest!.from, to: mode!.longest!.to })}>Use the longest complete window</button>
              <button className="btn sm ghost" onClick={() => { ui.set({ runSettings: false }); ui.showSection("data"); }}>Open Data</button>
            </div>
          </div>
        )}
        {submitError && (
          <div className="banner bad rs-msg" role="alert"><div className="row"><CircleAlert size={16} color="var(--danger)" /><b>The server refused the last run</b></div><div className="ink2">{submitError}</div></div>
        )}
      </section>

      <section className="settings-sec">
        <h4>Window <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· to is exclusive, UTC</span></h4>
        <div className="grid-2">
          <div className="field"><label htmlFor="rs-from">From</label><input id="rs-from" className="input" type="date" value={cfg.from} onChange={(e) => setCfg({ from: e.target.value })} /></div>
          <div className="field"><label htmlFor="rs-to">To</label><input id="rs-to" className="input" type="date" value={cfg.to} onChange={(e) => setCfg({ to: e.target.value })} /></div>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div className="seg sm" role="group" aria-label="Window presets">
            {PRESETS.map(([l, d]) => <button key={l} aria-pressed={span === d} onClick={() => cfg.to && setCfg({ from: addDays(cfg.to, -d) })}>{l}</button>)}
          </div>
          <span className="muted">{span > 0 ? `${span} days` : "choose a window"}</span>
        </div>
        {span <= 0 && cfg.from && cfg.to && <div className="err" style={{ color: "var(--loss-ink)", fontSize: "var(--fs-xs)" }}>“To” must be after “from”.</div>}
      </section>

      {params.length > 0 && strategy && (
        <section className="settings-sec">
          <h4>Parameters</h4>
          <div className="grid-2">
            {params.map((p) => (
              <div className="field" key={p.name}><label htmlFor={`rs-p-${p.name}`} className="mono">{p.name}</label>
                <input id={`rs-p-${p.name}`} className="input" value={values[p.name] ?? ""} placeholder={`${p.default} (file)`} onChange={(e) => setParam(strategy, p.name, e.target.value)} /></div>
            ))}
          </div>
          <div className="hint">Blank keeps the value written in the file. Sweeps over several values live in the Journal → Lab.</div>
        </section>
      )}

      <section className="settings-sec">
        <h4>Account</h4>
        <div className="grid-2">
          <div className="field"><label htmlFor="rs-bal">Starting balance</label>
            <input id="rs-bal" className="input" type="number" min={1} placeholder="config file" value={o.startingBalance ?? ""} onChange={(e) => setOption("startingBalance", e.target.value === "" ? undefined : Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="rs-pm">Position mode</label>
            <select id="rs-pm" className="select" value={o.positionMode ?? ""} onChange={(e) => setOption("positionMode", (e.target.value || undefined) as "hedging" | "netting" | undefined)}>
              <option value="">qkt default</option><option value="hedging">Hedging</option><option value="netting">Netting</option></select></div>
          <div className="field"><label htmlFor="rs-cur">Account currency</label>
            <input id="rs-cur" className="input" maxLength={3} placeholder="USD" value={o.accountCurrency ?? ""} onChange={(e) => setOption("accountCurrency", e.target.value.toUpperCase() || undefined)} /></div>
          <div className="field"><label htmlFor="rs-fx">Missing FX rate</label>
            <select id="rs-fx" className="select" value={o.fxMissingPolicy ?? ""} onChange={(e) => setOption("fxMissingPolicy", (e.target.value || undefined) as "warn" | "fail" | undefined)}>
              <option value="">qkt default (fail)</option><option value="warn">Warn and continue</option><option value="fail">Fail the run</option></select></div>
        </div>
        {perp && (
          <label className="switch" title="A perpetual pays or earns funding every few hours. Off backtests it without that cost.">
            <input type="checkbox" checked={o.funding !== "off"} onChange={(e) => setOption("funding", e.target.checked ? undefined : "off")} /><span className="track" /><span>Charge funding on perpetuals</span></label>
        )}
        {perp && o.funding === "off" && <div className="hint">Funding is off: the result leaves out what the perpetual's funding would have cost or paid. Stored rates are not needed.</div>}
        <div className="hint">Contract size, lot step, commission, swap and slippage points per symbol live in <button className="link" onClick={() => void useStore.getState().openFile("instruments.yaml")}>instruments.yaml</button>. Everything else is in <button className="link" onClick={() => void useStore.getState().openFile("qkt.config.yaml")}>qkt.config.yaml</button>.</div>
      </section>

      <section className="settings-sec">
        <h4>Execution {!ticks && <span className="badge">Ticks only</span>}</h4>
        <div className="grid-2" aria-disabled={!ticks}>
          <div className="field"><label htmlFor="rs-br">Broker model</label>
            <select id="rs-br" className="select" disabled={!ticks} value={o.broker ?? ""} onChange={(e) => setOption("broker", (e.target.value || undefined) as "paper" | "mt5-sim" | undefined)}>
              <option value="">qkt default</option><option value="paper">Paper (fills at mid)</option><option value="mt5-sim">MT5 simulator</option></select></div>
          <div className="field"><label htmlFor="rs-ex">Preset</label>
            <select id="rs-ex" className="select" disabled={!ticks} value={o.execution ?? ""} onChange={(e) => setOption("execution", (e.target.value || undefined) as never)}>
              <option value="">none</option>{EXEC.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div className="field"><label htmlFor="rs-sl">Slippage</label>
            <input id="rs-sl" className="input" disabled={!ticks} placeholder="zero · fixed-points:3" value={o.slippage ?? ""} onChange={(e) => setOption("slippage", e.target.value || undefined)} /></div>
          <div className="field"><label htmlFor="rs-seed">Seed</label>
            <input id="rs-seed" className="input" type="number" min={0} placeholder="random" value={o.seed ?? ""} onChange={(e) => setOption("seed", e.target.value === "" ? undefined : Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="rs-lat">Order latency</label>
            <input id="rs-lat" className="input" disabled={!ticks} placeholder="250ms" value={o.latency ?? ""} onChange={(e) => setOption("latency", e.target.value || undefined)} /></div>
          <div className="field"><label htmlFor="rs-slat">Stop latency</label>
            <input id="rs-slat" className="input" disabled={!ticks} placeholder="0" value={o.stopLatency ?? ""} onChange={(e) => setOption("stopLatency", e.target.value || undefined)} /></div>
          <div className="field"><label htmlFor="rs-tp">Take-profit fill</label>
            <select id="rs-tp" className="select" disabled={!ticks} value={o.tpFill ?? ""} onChange={(e) => setOption("tpFill", (e.target.value || undefined) as "print" | "level" | undefined)}>
              <option value="">qkt default (print)</option><option value="print">At the crossing print</option><option value="level">Exactly at the level</option></select></div>
          <div className="field"><label htmlFor="rs-rej">Reject every Nth order</label>
            <input id="rs-rej" className="input" type="number" min={1} disabled={!ticks} placeholder="never" value={o.rejectEvery ?? ""} onChange={(e) => setOption("rejectEvery", e.target.value === "" ? undefined : Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="rs-pf">Partial fills (0–1)</label>
            <input id="rs-pf" className="input" type="number" min={0.05} max={0.95} step={0.05} disabled={!ticks} placeholder="off" value={o.partialFill ?? ""} onChange={(e) => setOption("partialFill", e.target.value === "" ? undefined : Number(e.target.value))} /></div>
        </div>
        {deriv && <div className="hint">Futures and options fill on qkt's exchange simulator (executable price plus the run's slippage, the root's fees on every fill), so the broker model and preset above do not change their fills.</div>}
        {!ticks && <div className="hint">qkt refuses the MT5 simulator with bars (synthetic bar extremes do not preserve trigger prices). Switch to Ticks to use it.</div>}
      </section>

      <section className="settings-sec">
        <h4>Behaviour</h4>
        <label className="switch"><input type="checkbox" checked={cfg.autoRun} onChange={(e) => setCfg({ autoRun: e.target.checked })} /><span className="track" /><span>Re-run on bars whenever I save</span></label>
        <label className="switch"><input type="checkbox" checked={cfg.allowIncomplete} onChange={(e) => setCfg({ allowIncomplete: e.target.checked })} /><span className="track" /><span>Run anyway when data has holes (waive them)</span></label>
      </section>
    </div>
  );
}
