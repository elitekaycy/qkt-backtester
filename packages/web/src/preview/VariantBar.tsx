import { useEffect, useState } from "react";
import { api, type PartStats } from "../api/client.js";
import { useAgent } from "../state/agent.js";
import { fmtMoney } from "../util/format.js";

type Parts = { first: PartStats; test: PartStats | null };

/** Above the chart while a variant's run is shown: what changed, how it compares, and Adopt / Discard / Back.
 *  A variant's run (and its base's run) can still be going when this bar first appears: `runParts` 404s until
 *  the run has trades, so a failed or missing fetch means "still running", not "zero" — shown as such, and
 *  polled until it resolves. */
export function VariantBar() {
  const showing = useAgent((s) => s.showing), variants = useAgent((s) => s.variants), split = useAgent((s) => s.split);
  const [nums, setNums] = useState<{ v: Parts | null; b: Parts | null }>({ v: null, b: null });
  useEffect(() => {
    setNums({ v: null, b: null });
    if (!showing?.runId) return;
    let stopped = false;
    const load = () => {
      void Promise.all([
        api.runParts(showing.runId!).catch(() => null),
        showing.baseRunId ? api.runParts(showing.baseRunId).catch(() => null) : Promise.resolve(null),
      ]).then(([v, b]) => {
        if (stopped) return;
        setNums({ v, b });
        // one or both sides are not done yet: try again shortly rather than showing a final-looking blank/zero
        if (!v || (showing.baseRunId && !b)) setTimeout(() => { if (!stopped) load(); }, 2000);
      });
    };
    load();
    return () => { stopped = true; };
  }, [showing?.runId, showing?.baseRunId, split?.text]);
  if (!showing) return null;
  const siblings = variants.filter((x) => x.base === showing.base).slice(0, 6);
  const net = (p: Parts | null) => (p ? p.first.net + (p.test?.net ?? 0) : null);
  const side = (p: Parts | null, hasRun: boolean) => (!hasRun ? "not run yet" : p ? fmtMoney(net(p) ?? 0) : "running…");
  return (
    <div className="banner info variant-bar" role="status">
      <b>Variant: {showing.label}</b>
      <span className="num">net {side(nums.v, !!showing.runId)} vs {side(nums.b, !!showing.baseRunId)}</span>
      {nums.v?.test && nums.b?.test && <span className="num muted">(test part {fmtMoney(nums.v.test.net)} vs {fmtMoney(nums.b.test.net)} · {split?.text})</span>}
      {siblings.length > 1 && (
        <select className="select sm" aria-label="Other variants" value={showing.id} onChange={(e) => { const v = siblings.find((x) => x.id === e.target.value); if (v) void useAgent.getState().show(v); }}>
          {siblings.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      )}
      <span className="grow" />
      <button className="btn sm primary" onClick={() => void useAgent.getState().adopt(showing.id)}>Adopt</button>
      <button className="btn sm" onClick={() => void useAgent.getState().discard(showing.id)}>Discard</button>
      <button className="btn sm ghost" onClick={() => void useAgent.getState().back()}>Back to original</button>
    </div>
  );
}
