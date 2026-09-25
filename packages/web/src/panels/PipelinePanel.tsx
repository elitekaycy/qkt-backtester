import { useState } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { api, type Job } from "../api/client.js";
import type { StepRecord } from "../api/types.js";
import { CONFIG_TEMPLATE } from "../editor/monaco.js";
import { useStore } from "../state/store.js";
import { fmtDur } from "../util/format.js";
import { revealAt } from "./EditorPanel.js";

const LABEL: Record<string, string> = { project: "Project", config: "Config", parse: "Parse", coverage: "Data check", backtest: "Backtest", postprocess: "Post-process", render: "Render" };
const ICON: Record<string, string> = { pending: "○", ok: "✓", warn: "!", failed: "✕", skipped: "–" };

function StepRow({ s }: { s: StepRecord }) {
  const color = s.status === "ok" ? "var(--ok)" : s.status === "failed" ? "var(--bad)" : s.status === "warn" ? "var(--warn)" : "var(--ink-3)";
  return (
    <div className={`step ${s.status}`}>
      <span className="ico" style={{ color }}>{s.status === "running" ? <span className="spin" /> : ICON[s.status]}</span>
      <span style={{ fontWeight: s.status === "running" ? 600 : 400 }}>{LABEL[s.id] ?? s.id}</span>
      <span className="ink2" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.message ?? (s.status === "running" ? (s.id === "coverage" ? "Checking data coverage. qkt prints nothing until this finishes (a few seconds per month for ticks)." : "running…") : "")}</span>
      <span className="muted num nowrap">{s.ms !== undefined ? fmtDur(s.ms) : ""}</span>
      {s.command && <div className="cmd" title="The exact command. Paste it in a terminal to reproduce.">$ {s.command}</div>}
    </div>
  );
}

export function PipelinePanel() {
  const { run, progress, logs, running } = useStore();
  const store = useStore.getState;
  const strategy = useStore((s) => s.strategyPath());
  const file = useStore((s) => s.openFiles.find((f) => f.path === strategy));
  const cfg = useStore((s) => s.cfg);
  const [job, setJob] = useState<Job | null>(null);
  const err = run?.error;

  async function buildBars() {
    const streams = file ? parseStrategyInfo(file.content).streams : [];
    const fromHint = run?.buildBarsHint ? /build-bars (\S+) --tf (\S+)/.exec(run.buildBarsHint) : null;
    const targets = fromHint ? [{ symbol: fromHint[1]!, tf: fromHint[2]! }] : [...new Map(streams.map((s) => [`${s.symbol}:${s.tf}`, { symbol: s.symbol, tf: s.tf }])).values()];
    if (!targets.length) { store().toast("error", "Cannot tell which symbol to build. Open the strategy first."); return; }
    for (const t of targets) {
      try {
        const { jobId } = await api.buildBars({ ...t, from: run?.from ?? cfg.from, to: run?.to ?? cfg.to });
        for (;;) {
          const j = await api.job(jobId);
          setJob(j);
          if (j.status !== "running") {
            if (j.status === "done") store().toast("ok", `Built ${t.symbol} ${t.tf} bars`);
            else { store().toast("error", `Build failed: ${j.error?.message ?? "see log"}`); return; }
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) { store().toast("error", (e as Error).message); return; }
    }
    void store().startRun();
  }

  const steps = run?.steps ?? (["project", "config", "parse", "coverage", "backtest", "postprocess", "render"] as const).map((id) => ({ id, status: "pending" as const }));
  const phase = steps.find((s) => s.status === "running")?.id;
  const holes = run?.holes ?? [];

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Run pipeline</span>
        {run && <span className={`badge ${run.tier}`}>{run.tier === "draft" ? "Draft · bars" : "Full · ticks"}</span>}
        {run && <span className="muted mono" title={run.id}>{run.id.slice(-22)}</span>}
        <span className="grow" />
        {running && progress && <span className="ink2 nowrap">{progress.fills} fills · {fmtDur(progress.elapsedMs)}</span>}
      </div>
      {running && <div className={`bar${phase === "coverage" || !progress ? " indet" : ""}`}><i style={{ width: phase === "backtest" && progress?.etaMs ? `${Math.min(97, (progress.elapsedMs / (progress.elapsedMs + progress.etaMs)) * 100)}%` : undefined }} /></div>}
      <div className="panel-scroll">
        {!run && <div className="empty"><b>Nothing has run yet.</b><br />Press <b>Run</b> (Ctrl+Enter). Each step below shows its status, timing and the exact command.</div>}
        {run && steps.map((s) => <StepRow key={s.id} s={s} />)}

        {err && err.kind !== "cancelled" && (
          <div className="banner bad" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div><b>{err.kind.replace(/_/g, " ")}</b>: {err.message}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {err.file && err.line && <button className="btn sm" onClick={() => revealAt(err.file!, err.line!, err.col ?? 1)}>Show {err.file}:{err.line}</button>}
              {err.kind === "missing_config" && <button className="btn sm primary" onClick={() => void store().createEntry("qkt.config.yaml", "file", CONFIG_TEMPLATE)}>Create qkt.config.yaml</button>}
              {(err.kind === "missing_data" || err.kind === "incomplete_data") && (
                <>
                  <button className="btn sm primary" onClick={() => void buildBars()} title="Runs qkt data build-bars from the tick store into the bar store">Build bars</button>
                  <button className="btn sm" onClick={() => void store().startRun({ allowIncomplete: true })} title="Passes --allow-incomplete. The waived days stay recorded on the run.">Run anyway (waive holes)</button>
                </>
              )}
            </div>
            {holes.length > 0 && (
              <details open={holes.length <= 8}>
                <summary>{holes.length} day(s) qkt considers incomplete</summary>
                <div className="pre" style={{ marginTop: 4 }}>{holes.map((h) => `${h.day}  ${h.status}${h.emptyHours.length ? `  (empty hours ${h.emptyHours.join(",")})` : ""}`).join("\n")}</div>
                <div className="muted" style={{ marginTop: 4 }}>Holidays such as US market holidays and Good Friday are often listed here because qkt's calendar is not holiday-aware. If the provider genuinely has no data for them, waive them.</div>
              </details>
            )}
          </div>
        )}
        {job && <details><summary className="ink2" style={{ padding: "4px 10px" }}>build log · {job.status}</summary><div className="pre" style={{ padding: "0 10px 6px" }}>{job.command}{"\n"}{job.log.join("\n")}</div></details>}

        {run && run.warnings.length > 0 && (
          <div className="banner warn" style={{ flexDirection: "column", alignItems: "stretch" }}>
            {run.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}
        {logs.length > 0 && <details><summary className="ink2" style={{ padding: "4px 10px" }}>{logs.length} engine message(s)</summary><div className="pre" style={{ padding: "0 10px 8px" }}>{logs.join("\n")}</div></details>}
      </div>
    </div>
  );
}
