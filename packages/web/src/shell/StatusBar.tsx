import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { CircleAlert, CircleCheck, Database } from "../ui/icons.js";
import { attentionOf } from "../util/dataStatus.js";

export function StatusBar() {
  const ui = useUi();
  const settings = useStore((s) => s.settings), scan = useStore((s) => s.scan), run = useStore((s) => s.run), results = useStore((s) => s.results);
  const t = scan?.totals;
  const problem = scan ? scan.symbols.filter((x) => attentionOf(x) !== null).length : 0;
  return (
    <footer className="statusbar">
      <button className="item" onClick={() => ui.showSection("data")} title={settings?.dataRoot}>
        <Database size={12} />{settings ? <span className="mono" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{settings.dataRoot}</span> : "data…"}
        {t && (problem ? <span className="row" style={{ gap: 3, color: "var(--warn)" }}><CircleAlert size={12} />{problem} need attention</span> : <span className="row" style={{ gap: 3, color: "var(--ok)" }}><CircleCheck size={12} />{t.complete}/{t.symbols} complete</span>)}
      </button>
      {run && <span className="item"><span className={`dot ${run.status === "done" ? "ok" : run.status === "failed" ? "bad" : "run"}`} />{run.status}</span>}
      {results && <span className="item hide-md">qkt {results.meta.qktVersion}</span>}
      <span className="item push">All times UTC</span>
    </footer>
  );
}
