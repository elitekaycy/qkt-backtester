import { useState } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { api, type Job } from "../api/client.js";
import type { StepRecord } from "../api/types.js";
import { revealAt } from "../editor/EditorPane.js";
import { CONFIG_TEMPLATE } from "../editor/monaco.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { addDays, fmtDur } from "../util/format.js";
import { Circle, CircleCheck, CircleDashed, CircleX, Copy, Hammer, OctagonX, Play, TriangleAlert } from "../ui/icons.js";

const LABEL: Record<string, string> = { project: "Project", config: "Config", parse: "Parse", coverage: "Data check", backtest: "Backtest", postprocess: "Post-process", render: "Render" };
const ORDER = ["project", "config", "parse", "coverage", "backtest", "postprocess", "render"] as const;

function StatusIcon({ s }: { s: StepRecord["status"] }) {
  if (s === "running") return <span className="spin" aria-label="running" />;
  if (s === "ok") return <CircleCheck size={16} color="var(--ok)" aria-label="done" />;
  if (s === "warn") return <TriangleAlert size={16} color="var(--warn)" aria-label="warning" />;
  if (s === "failed") return <CircleX size={16} color="var(--danger)" aria-label="failed" />;
  if (s === "skipped") return <Circle size={16} color="var(--ink-4)" aria-label="skipped" />;
  return <CircleDashed size={16} color="var(--ink-4)" aria-label="pending" />;
}

function Step({ s }: { s: StepRecord }) {
  return (
    <div className={`step ${s.status}`}>
      <span className="ico"><StatusIcon s={s.status} /></span>
      <span className="name" style={{ fontWeight: s.status === "running" ? 650 : 500 }}>{LABEL[s.id] ?? s.id}</span>
      <span className="msg">{s.message ?? (s.status === "running" ? (s.id === "coverage" ? "Checking data coverage. qkt prints nothing until this finishes." : "running…") : "")}</span>
      <span className="muted num nowrap">{s.ms !== undefined ? fmtDur(s.ms) : ""}</span>
      {s.command && (
        <div className="cmd">
          <span style={{ flex: 1 }} title="The exact command. Paste it in a terminal to reproduce.">$ {s.command}</span>
          <button className="btn ghost icon sm" aria-label="Copy command" onClick={() => void navigator.clipboard?.writeText(s.command!)}><Copy size={12} /></button>
        </div>
      )}
    </div>
  );
}

export function PipelineTab() {
  const run = useStore((s) => s.run), progress = useStore((s) => s.progress), logs = useStore((s) => s.logs), running = useStore((s) => s.running);
  const strategy = useStore((s) => s.strategyPath()), file = useStore((s) => s.openFiles.find((f) => f.path === s.strategyPath()));
  const cfg = useStore((s) => s.cfg), scan = useStore((s) => s.scan);
  const store = useStore.getState;
  const ui = useUi();
  const [job, setJob] = useState<Job | null>(null);
  const err = run?.error;

  async function buildBars() {
    const streams = file ? parseStrategyInfo(file.content).streams : [];
    const hint = run?.buildBarsHint ? /build-bars (\S+) --tf (\S+)/.exec(run.buildBarsHint) : null;
    const targets = hint ? [{ symbol: hint[1]!, tf: hint[2]! }] : [...new Map(streams.map((s) => [`${s.symbol}:${s.tf}`, { symbol: s.symbol, tf: s.tf }])).values()];
    if (!targets.length) { store().toast("error", "Cannot tell which symbol to build. Open the strategy first."); return; }
    for (const t of targets) {
      const ticks = scan?.symbols.find((s) => s.symbol === t.symbol)?.ticks;
      try {
        const { jobId } = await api.buildBars({ ...t, from: ticks?.first ?? run?.from ?? cfg.from, to: ticks?.last ? addDays(ticks.last, 1) : run?.to ?? cfg.to });
        store().trackJob(jobId, `Build ${t.symbol} ${t.tf} bars`);
        for (;;) { const j = await api.job(jobId); setJob(j); if (j.status !== "running") { if (j.status !== "done") return; break; } await new Promise((r) => setTimeout(r, 500)); }
      } catch (e) { store().toast("error", (e as Error).message); return; }
    }
    void store().startRun();
  }

  const steps = run?.steps ?? ORDER.map((id) => ({ id, status: "pending" as const }));
  const phase = steps.find((s) => s.status === "running")?.id;
  const holes = run?.holes ?? [];

  return (
    <div className="dock-body">
      <div className="row" style={{ padding: "var(--s2) var(--s4)", borderBottom: "1px solid var(--line)", flex: "none" }}>
        {run ? <>
          <span className={`badge ${run.tier === "full" ? "accent" : ""}`}>{run.tier === "full" ? "Ran on ticks" : "Ran on bars"}</span>
          <span className="muted mono" title={run.id} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{run.id.slice(-24)}</span>
          {run.options && Object.keys(run.options).length > 0 && <span className="badge" title={JSON.stringify(run.options)}>{Object.keys(run.options).length} option{Object.keys(run.options).length > 1 ? "s" : ""}</span>}
        </> : <span className="muted">Nothing has run yet</span>}
        <span className="grow" />
        {running && progress && <span className="ink2 num nowrap">{progress.fills} fills · {fmtDur(progress.elapsedMs)}</span>}
        {running ? <button className="btn danger sm" onClick={() => void store().killAll()}><OctagonX size={14} />Stop</button>
          : <button className="btn sm" disabled={!strategy} onClick={() => void store().startRun()}><Play size={13} fill="currentColor" />Run</button>}
      </div>
      {running && <div className={`progress${phase === "coverage" || !progress ? " indet" : ""}`}><i style={{ width: phase === "backtest" && progress?.etaMs ? `${Math.min(97, (progress.elapsedMs / (progress.elapsedMs + progress.etaMs)) * 100)}%` : undefined }} /></div>}
      <div className="dock-scroll">
        {!run && <div className="empty"><b>Ready to run.</b>Press <span className="kbd">Ctrl</span> <span className="kbd">Enter</span>. Each step will show its status, timing and the exact command.</div>}
        {run && steps.map((s) => <Step key={s.id} s={s} />)}

        {err && err.kind !== "cancelled" && (
          <div className="banner bad" style={{ flexDirection: "column", margin: "var(--s3) var(--s4)" }}>
            <div><b>{err.kind.replace(/_/g, " ")}</b>: {err.message}</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {err.file && err.line && <button className="btn sm" onClick={() => revealAt(err.file!, err.line!, err.col ?? 1)}>Show {err.file}:{err.line}</button>}
              {err.kind === "missing_config" && <button className="btn sm primary" onClick={() => void store().createEntry("qkt.config.yaml", "file", CONFIG_TEMPLATE)}>Create qkt.config.yaml</button>}
              {(err.kind === "missing_data" || err.kind === "incomplete_data") && (
                <>
                  <button className="btn sm primary" onClick={() => void buildBars()}><Hammer size={14} />Build bars</button>
                  <button className="btn sm" onClick={() => void store().startRun({ allowIncomplete: true })}>Run anyway (waive holes)</button>
                  <button className="btn sm ghost" onClick={() => ui.set({ section: "data" })}>Open Data</button>
                </>
              )}
            </div>
            {holes.length > 0 && (
              <details open={holes.length <= 8}>
                <summary>{holes.length} day(s) qkt considers incomplete</summary>
                <div className="pre mono" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{holes.map((h) => `${h.day}  ${h.status}${h.emptyHours.length ? `  (empty hours ${h.emptyHours.join(",")})` : ""}`).join("\n")}</div>
                <div className="muted" style={{ marginTop: 4 }}>Holidays such as US market holidays and Good Friday are often listed here because qkt's calendar is not holiday-aware. If the provider has no data for them, waive them.</div>
              </details>
            )}
          </div>
        )}
        {job && <details style={{ padding: "0 var(--s4)" }}><summary className="ink2">build log · {job.status}</summary><div className="pre mono muted" style={{ whiteSpace: "pre-wrap" }}>{job.command}{"\n"}{job.log.join("\n")}</div></details>}
        {run && run.warnings.length > 0 && <div className="banner warn" style={{ flexDirection: "column", margin: "var(--s3) var(--s4)" }}>{run.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
        {logs.length > 0 && <details style={{ padding: "0 var(--s4) var(--s3)" }}><summary className="ink2">{logs.length} engine message(s)</summary><div className="pre mono muted" style={{ whiteSpace: "pre-wrap" }}>{logs.join("\n")}</div></details>}
      </div>
    </div>
  );
}
