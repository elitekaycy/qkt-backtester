import { flattenProblems, useStore } from "../state/store.js";
import { revealAt } from "../editor/EditorPane.js";
import { CircleAlert, CircleCheck, CircleX, Info, TriangleAlert } from "../ui/icons.js";

export function ProblemsTab() {
  const problems = useStore((s) => s.problems);
  const list = flattenProblems(problems);
  const icon = (sev: string) => sev === "error" ? <CircleX size={15} color="var(--danger)" /> : sev === "warning" ? <TriangleAlert size={15} color="var(--warn)" /> : <Info size={15} color="var(--info)" />;
  return (
    <div className="dock-scroll">
      {list.length === 0 && <div className="empty"><CircleCheck className="ico-big" style={{ color: "var(--ok)" }} /><b>No problems</b>Checked live by qkt lsp as you type, by qkt parse after a pause, and against the config schema.</div>}
      {list.map((p, i) => (
        <div key={i} className="list-row" role="button" tabIndex={0} style={{ alignItems: "flex-start", padding: "var(--s2) var(--s4)", borderRadius: 0, borderBottom: "1px solid var(--line)" }}
          onClick={() => revealAt(p.path, p.line, p.col)} onKeyDown={(e) => { if (e.key === "Enter") revealAt(p.path, p.line, p.col); }}>
          <span style={{ paddingTop: 2 }}>{icon(p.severity)}</span>
          <div style={{ minWidth: 0, flex: 1 }}><div style={{ color: "var(--ink)" }}>{p.message}</div><div className="muted mono" style={{ fontSize: "var(--fs-xs)" }}>{p.path}:{p.line}:{p.col} · {p.source}</div></div>
        </div>
      ))}
      <span hidden><CircleAlert /></span>
    </div>
  );
}
