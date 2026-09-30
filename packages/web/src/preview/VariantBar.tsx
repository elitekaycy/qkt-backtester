import { useEffect, useState } from "react";
import { api, ApiError, type PartStats } from "../api/client.js";
import { useAgent, variantSide } from "../state/agent.js";
import { useDiffView } from "../state/diffView.js";
import { fmtMoney } from "../util/format.js";

type Parts = { first: PartStats; test: PartStats | null };
type Side = { run: { status: string; error?: { message: string } } | null | "gone"; parts: Parts | "none" | null };
const EMPTY: Side = { run: null, parts: null };

/** Above the chart while a variant's run is shown: what changed, how it compares, and Adopt / Discard / Back.
 *  A variant's run (and its base's run) can still be going when this bar first appears. Each side's run status is read
 *  with its parts: "running…" and polled while it runs; its net once done; "failed: <reason>" (or cancelled / gone)
 *  when it ended without results — and then the polling stops. */
async function loadSide(id: string): Promise<Side> {
  const run = await api.run(id).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? ("gone" as const) : null));
  // a finished run the server has no trades for answers 404 here: that is a final "no trades", not "still loading"
  const parts = run && run !== "gone" && run.status === "done" ? await api.runParts(id).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? ("none" as const) : null)) : null;
  return { run: run && run !== "gone" ? { status: run.status, error: run.error ? { message: run.error.message } : undefined } : run, parts };
}
const netOf = (p: Side["parts"]) => (p === "none" ? "none" : p ? p.first.net + (p.test?.net ?? 0) : null);

export function VariantBar() {
  const showing = useAgent((s) => s.showing), variants = useAgent((s) => s.variants), split = useAgent((s) => s.split);
  const diffOn = useDiffView((s) => s.diffOf !== null && s.diffOf === showing?.id);
  const [sides, setSides] = useState<{ v: Side; b: Side }>({ v: EMPTY, b: EMPTY });
  useEffect(() => {
    setSides({ v: EMPTY, b: EMPTY });
    if (!showing?.runId) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      void Promise.all([loadSide(showing.runId!), showing.baseRunId ? loadSide(showing.baseRunId) : Promise.resolve(null)]).then(([v, b]) => {
        if (stopped) return;
        setSides({ v, b: b ?? EMPTY });
        const done = variantSide(v.run, netOf(v.parts), fmtMoney).final && (!b || variantSide(b.run, netOf(b.parts), fmtMoney).final);
        if (!done) timer = setTimeout(() => { if (!stopped) load(); }, 2000);
      });
    };
    load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [showing?.runId, showing?.baseRunId, split?.text]);
  if (!showing) return null;
  const siblings = variants.filter((x) => x.base === showing.base).slice(0, 6);
  const side = (x: Side, hasRun: boolean) => (!hasRun ? "not run yet" : variantSide(x.run, netOf(x.parts), fmtMoney).text);
  const nums = { v: sides.v.parts === "none" ? null : sides.v.parts, b: sides.b.parts === "none" ? null : sides.b.parts };
  return (
    <div className="banner info variant-bar" role="status">
      <b>Variant: {showing.label}</b>
      <span className="num">net {side(sides.v, !!showing.runId)} vs {side(sides.b, !!showing.baseRunId)}</span>
      {nums.v?.test && nums.b?.test && <span className="num muted">(test part {fmtMoney(nums.v.test.net)} vs {fmtMoney(nums.b.test.net)} · {split?.text})</span>}
      {siblings.length > 1 && (
        <select className="select sm" aria-label="Other variants" value={showing.id} onChange={(e) => { const v = siblings.find((x) => x.id === e.target.value); if (v) void useAgent.getState().show(v); }}>
          {siblings.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      )}
      <span className="grow" />
      <button className="btn sm auto-toggle" aria-pressed={diffOn} title={diffOn ? "Back to the editor" : "Show what the variant changes, in the editor"}
        onClick={() => void useDiffView.getState().toggle(showing)}>Diff</button>
      <button className="btn sm primary" onClick={() => void useAgent.getState().adopt(showing.id)}>Adopt</button>
      <button className="btn sm" onClick={() => void useAgent.getState().discard(showing.id)}>Discard</button>
      <button className="btn sm ghost" onClick={() => void useAgent.getState().back()}>Back to original</button>
    </div>
  );
}
