import { useMemo } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { useStore } from "../state/store.js";
import { addDays, daysBetween, fmtDur } from "../util/format.js";

const PRESETS: Array<[string, number]> = [["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365]];

export function RunBar({ toggles }: { toggles: Array<{ id: string; label: string; on: boolean; toggle: () => void }> }) {
  const { cfg, running, run, progress, results, theme } = useStore();
  const strategy = useStore((s) => s.strategyPath());
  const file = useStore((s) => s.openFiles.find((f) => f.path === strategy));
  const store = useStore.getState;
  const params = useMemo(() => (file ? parseStrategyInfo(file.content).params : []), [file?.content]);
  const values = (strategy && cfg.paramsByStrategy[strategy]) || {};
  const span = cfg.from && cfg.to ? daysBetween(cfg.from, cfg.to) : 0;
  const bad = !strategy || !cfg.from || !cfg.to || span <= 0;
  const tierOfResults = results?.meta.tier;

  return (
    <div className="topbar">
      <span className="brand">qkt backtester</span>
      <span className="sep" />
      <span title={strategy ?? ""} className="nowrap" style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis" }}>{strategy ?? "no strategy"}</span>
      <div className="seg" role="group" aria-label="Fidelity">
        <button aria-pressed={cfg.tier === "draft"} onClick={() => store().setCfg({ tier: "draft" })} title="Draft: uses built bars (--bars). Seconds per run; bar-approximated intrabar fills.">Draft</button>
        <button aria-pressed={cfg.tier === "full"} onClick={() => store().setCfg({ tier: "full" })} title="Full: replays ticks. Slower (tens of seconds per month) and the reference result.">Full</button>
      </div>
      <label className="field">from <input type="date" value={cfg.from} onChange={(e) => store().setCfg({ from: e.target.value })} /></label>
      <label className="field" title="Exclusive upper bound, like qkt --to">to <input type="date" value={cfg.to} onChange={(e) => store().setCfg({ to: e.target.value })} /></label>
      <div className="seg" role="group" aria-label="Range presets">
        {PRESETS.map(([l, d]) => <button key={l} aria-pressed={span === d} onClick={() => cfg.to && store().setCfg({ from: addDays(cfg.to, -d) })} title={`${d} days ending at 'to'`}>{l}</button>)}
      </div>
      {params.length > 0 && strategy && (
        <details style={{ position: "relative" }}>
          <summary className="btn sm" style={{ listStyle: "none" }}>Params ({params.length})</summary>
          <div style={{ position: "absolute", top: 28, left: 0, zIndex: 40, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 10, minWidth: 220, boxShadow: "0 6px 20px rgba(0,0,0,.3)" }}>
            {params.map((p) => (
              <label key={p.name} className="field" style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="mono">{p.name}</span>
                <input className="narrow" value={values[p.name] ?? ""} placeholder={p.default} onChange={(e) => store().setParam(strategy, p.name, e.target.value)} />
              </label>
            ))}
            <div className="muted" style={{ fontSize: 11 }}>Blank uses the value written in the file.</div>
          </div>
        </details>
      )}
      <span className="sep" />
      {running
        ? <button className="btn danger" onClick={() => void store().cancelRun()}>Cancel</button>
        : <button className="btn primary" disabled={bad} onClick={() => void store().startRun()} title="Ctrl+Enter">▶ Run</button>}
      {!running && tierOfResults === "draft" && results && (
        <button className="btn" onClick={() => void store().startRun({ tier: "full" })} title="Re-run the same window on ticks">Verify with Full</button>
      )}
      <label className="check" title="Re-run a Draft backtest whenever you save"><input type="checkbox" checked={cfg.autoRun} onChange={(e) => store().setCfg({ autoRun: e.target.checked })} />auto-run on save</label>
      {running && <span className="ink2 nowrap">{progress ? `${progress.phase} · ${fmtDur(progress.elapsedMs)}${progress.etaMs ? ` · ~${fmtDur(progress.etaMs)} left` : ""}` : "starting…"}</span>}
      {!running && run && <span className={`badge ${run.status === "done" ? "ok" : run.status === "failed" ? "bad" : ""}`}>{run.status}</span>}
      <span style={{ flex: 1 }} />
      <div className="seg subtle" role="group" aria-label="Panels">
        {toggles.map((t) => <button key={t.id} aria-pressed={t.on} onClick={t.toggle} title={`Show or hide ${t.label}`}>{t.label}</button>)}
      </div>
      <button className="btn ghost sm" onClick={() => store().setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">{theme === "dark" ? "☾" : "☀"}</button>
    </div>
  );
}
