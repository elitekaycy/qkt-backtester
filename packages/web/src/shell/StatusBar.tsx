import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { CircleAlert, CircleCheck, Database } from "../ui/icons.js";

export function StatusBar() {
  const ui = useUi();
  const settings = useStore((s) => s.settings), scan = useStore((s) => s.scan), run = useStore((s) => s.run), results = useStore((s) => s.results), cfg = useStore((s) => s.cfg);
  const t = scan?.totals;
  const problem = t ? t.incomplete + t.ticksOnly : 0;
  return (
    <footer className="statusbar">
      <button className="item" onClick={() => ui.set({ section: "data" })} title={settings?.dataRoot}>
        <Database size={12} />{settings ? <span className="mono" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{settings.dataRoot}</span> : "data…"}
        {t && (problem ? <span className="row" style={{ gap: 3, color: "var(--warn)" }}><CircleAlert size={12} />{problem} need attention</span> : <span className="row" style={{ gap: 3, color: "var(--ok)" }}><CircleCheck size={12} />{t.complete}/{t.symbols} complete</span>)}
      </button>
      <span className="item">{cfg.tier === "draft" ? "Running on bars" : "Running on ticks"}</span>
      {run && <span className="item"><span className={`dot ${run.status === "done" ? "ok" : run.status === "failed" ? "bad" : "run"}`} />{run.status}</span>}
      {results && <span className="item hide-md">qkt {results.meta.qktVersion}</span>}
      <span className="item push">All times UTC · windows are [from, to)</span>
    </footer>
  );
}
