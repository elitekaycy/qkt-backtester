// packages/web/src/chat/cards.tsx
import { useEffect, useState } from "react";
import { api, type PartStats } from "../api/client.js";
import { actOnProposal, DiffView } from "../shell/Proposals.js";
import { useAgent, variantSide, type VariantInfo } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { fmtMoney, polarity } from "../util/format.js";
import { overfitFlags, parseResult } from "./results.js";

type Parts = { cut: string | null; first: PartStats; test: PartStats | null };
interface RunNums { runId?: string; status?: string; error?: string; net?: number | null; trades?: number | null }

const Money = ({ n }: { n: number | null | undefined }) => <span className={polarity(n)}>{fmtMoney(n)}</span>;
/** A run's net as the variant bar words it: the number once done ("no trades" without any), else failed / cancelled / running. */
function NetCell({ x }: { x: RunNums | null | undefined }) {
  if (!x?.status) return <>–</>;
  if (x.status === "done" && typeof x.net === "number") return <Money n={x.net} />;
  const t = variantSide({ status: x.status, error: x.error ? { message: x.error } : undefined }, "none", fmtMoney).text;
  return <span className={x.status === "failed" ? "loss" : "muted"}>{t}</span>;
}
const toastError = (e: unknown) => useStore.getState().toast("error", (e as Error).message);

/** Test-part numbers for a set of runs, recomputed whenever the split changes (the split only regroups trades). */
function useParts(runIds: Array<string | undefined>): Array<Parts | null> {
  const split = useAgent((s) => s.split?.text);
  const key = runIds.join(",");
  const [parts, setParts] = useState<Array<Parts | null>>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(runIds.map((id) => (id ? api.runParts(id).catch(() => null) : Promise.resolve(null)))).then((p) => { if (live) setParts(p); });
    return () => { live = false; };
  }, [key, split]); // eslint-disable-line react-hooks/exhaustive-deps
  return parts;
}

/** Adopt / Discard / Show for one variant; `compact` (a row of the comparison table) keeps the buttons short and quiet. */
function VariantButtons({ v, compact = false }: { v: VariantInfo | undefined; compact?: boolean }) {
  const showing = useAgent((s) => s.showing);
  if (!v) return <span className="muted">discarded</span>;
  return (
    <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
      <button className={`btn sm${compact ? "" : " primary"}`} onClick={() => void useAgent.getState().adopt(v.id).catch(toastError)}>Adopt</button>
      <button className={`btn sm${compact ? " ghost" : ""}`} onClick={() => void useAgent.getState().discard(v.id).catch(toastError)}>Discard</button>
      {showing?.id === v.id
        ? compact && <span className="muted">on the chart</span>
        : <button className="btn sm ghost" title="Show on the chart" onClick={() => void useAgent.getState().show(v)}>{compact ? "Show" : "Show on the chart"}</button>}
    </span>
  );
}

function VariantCard({ r }: { r: { variantId: string; label: string; variant?: RunNums | null; base?: RunNums | null } }) {
  const v = useAgent((s) => s.variants.find((x) => x.id === r.variantId)), split = useAgent((s) => s.split);
  const [pv, pb] = useParts([r.variant?.runId, r.base?.runId]);
  return (
    <div className="chat-card">
      <div className="row"><b className="grow">Variant: {r.label}</b><VariantButtons v={v} /></div>
      <table className="chat-table num">
        <thead><tr><th /><th>Variant</th><th>Original</th></tr></thead>
        <tbody>
          <tr><td>Net</td><td><NetCell x={r.variant} /></td><td><NetCell x={r.base} /></td></tr>
          <tr><td>Trades</td><td>{r.variant?.trades ?? "–"}</td><td>{r.base?.trades ?? "–"}</td></tr>
          {pv?.test && <tr><td>Test part ({split?.text})</td><td><Money n={pv.test.net} /></td><td><Money n={pb?.test?.net} /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function VariantTable({ r }: { r: { base?: RunNums | null; variants: Array<RunNums & { variantId: string; label: string }> } }) {
  const all = useAgent((s) => s.variants), split = useAgent((s) => s.split);
  const parts = useParts([r.base?.runId, ...r.variants.map((x) => x.runId)]);
  return (
    <div className="chat-card">
      <table className="chat-table num">
        <thead><tr><th /><th>Net</th><th>Trades</th><th>Test part{split?.text ? ` (${split.text})` : ""}</th><th /></tr></thead>
        <tbody>
          <tr><td>Original</td><td><NetCell x={r.base} /></td><td>{r.base?.trades ?? "–"}</td><td><Money n={parts[0]?.test?.net} /></td><td /></tr>
          {r.variants.map((x, i) => (
            <tr key={x.variantId}><td>{x.label}</td><td><NetCell x={x} /></td><td>{x.trades ?? "–"}</td><td><Money n={parts[i + 1]?.test?.net} /></td>
              <td><VariantButtons compact v={all.find((v) => v.id === x.variantId)} /></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "applying" exists since phase 1's fix wave (set before the first await of apply; a restart turns it back into "open")
const PROPOSAL_STATUS: Record<string, string> = { applying: "applying…", applied: "applied", rejected: "rejected", stale: "out of date" };
function ProposalCard({ id }: { id: string }) {
  const p = useAgent((s) => s.proposals.find((x) => x.id === id));
  if (!p) return <div className="chat-card muted">This proposal is no longer listed.</div>;
  return (
    <div className="chat-card">
      <div className="row" style={{ gap: 6 }}>
        <b className="grow">{p.title}</b>
        {p.status === "open"
          ? <><button className="btn sm primary" onClick={() => void actOnProposal(p.id, true, p.path)}>{p.kind === "job" ? "Start" : "Apply"}</button>
              <button className="btn sm ghost" onClick={() => void actOnProposal(p.id, false)}>Reject</button></>
          : <span className={`badge ${p.status === "applied" ? "ok" : p.status === "stale" ? "warn" : ""}`}>{PROPOSAL_STATUS[p.status] ?? p.status}</span>}
      </div>
      {p.status === "stale" && <p className="muted chat-card-note">The file changed since this was proposed; ask again on the current text.</p>}
      {p.diff && <DiffView diff={p.diff} />}
    </div>
  );
}

type SweepRow = { params: Record<string, string>; runId?: string; first: number | null; test: number | null };
/**
 * A sweep's rows with both parts, for the user, with the over-fit flag (spec 6). job_status gave the model first-part rows
 * only, but that is a convention, not a guarantee (each row carries a runId the model can open with get_run/trades), so
 * this card never says the test part was hidden from the model.
 */
function SweepCard({ jobId }: { jobId: string }) {
  const split = useAgent((s) => s.split?.text);
  const [status, setStatus] = useState("running");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [rows, setRows] = useState<SweepRow[]>([]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const j = await api.job(jobId).catch(() => null);
      if (!live) return;
      if (!j) { setStatus("gone"); return; }
      setStatus(j.status); setProgress(j.progress ?? null);
      if (j.status === "running") { timer = setTimeout(() => void tick(), 2000); return; }
      const out: SweepRow[] = [];
      for (const r of ((j.result as { rows?: Array<{ params: Record<string, string>; runId?: string }> } | undefined)?.rows ?? []).slice(0, 30)) {
        const p = r.runId ? await api.runParts(r.runId).catch(() => null) : null;
        out.push({ params: r.params, runId: r.runId, first: p?.first.net ?? null, test: p?.test?.net ?? null });
      }
      if (live) setRows(out);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [jobId, split]);
  const flags = overfitFlags(rows);
  const head = status === "running" ? `running…${progress ? ` ${progress.done}/${progress.total}` : ""}` : status === "done" ? `${rows.length} rows` : status === "gone" ? "the job is no longer listed" : status;
  return (
    <div className="chat-card">
      <div className="row"><b>Sweep</b><span className="muted">{head}</span></div>
      {rows.length > 0 && (
        <table className="chat-table num">
          <thead><tr><th>Params</th><th>First part</th><th>Test part{split ? ` (${split})` : ""}</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className={flags[i] ? "flag" : ""}>
              <td>{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" ")}</td><td><Money n={r.first} /></td><td><Money n={r.test} /></td>
              <td className="chat-row-end">{flags[i] && <span className="badge warn">likely over-fitted</span>}{r.runId && <button className="btn sm ghost" onClick={() => void useStore.getState().selectRun(r.runId!)}>Open</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {rows.length > 0 && rows.every((r) => r.test === null) && <p className="muted chat-card-note">No test part: set a split to see how each row does on data it was not picked on.</p>}
      {flags.some(Boolean) && <p className="muted chat-card-note">Flagged rows beat the median on the first part but fall below it on the test part.</p>}
    </div>
  );
}

/** What a tool's result shows beside its step: the variant with Adopt, a comparison, a proposal's diff, a sweep, a run link. */
export function ToolCard({ name, text }: { name: string; text: string }) {
  const r = parseResult(text);
  if (!r) return null;
  if (name === "try_change" && typeof r.variantId === "string") return <VariantCard r={r as Parameters<typeof VariantCard>[0]["r"]} />;
  if (name === "try_variants" && Array.isArray(r.variants)) return <VariantTable r={r as Parameters<typeof VariantTable>[0]["r"]} />;
  if (typeof r.proposalId === "string") return <ProposalCard id={r.proposalId} />;
  if (name === "sweep" && typeof r.jobId === "string") return <SweepCard jobId={r.jobId} />;
  if (typeof r.runId === "string") return <div className="row"><button className="btn sm" onClick={() => void useStore.getState().selectRun(r.runId as string)}>Open on the chart</button><span className="muted mono chat-run-id">{r.runId}</span></div>;
  return null;
}
