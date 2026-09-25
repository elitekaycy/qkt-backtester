import { flattenProblems, useStore } from "../state/store.js";
import { revealAt } from "./EditorPanel.js";

const SEV: Record<string, [string, string]> = { error: ["✕", "var(--bad)"], warning: ["!", "var(--warn)"], info: ["i", "var(--info)"] };

export function ProblemsPanel() {
  const problems = useStore((s) => s.problems);
  const list = flattenProblems(problems);
  const errors = list.filter((p) => p.severity === "error").length;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Problems</span>
        <span className={`badge ${errors ? "bad" : "ok"}`}>{errors} error{errors === 1 ? "" : "s"}</span>
        <span className="badge">{list.length - errors} other</span>
      </div>
      <div className="panel-scroll">
        {list.length === 0 && <div className="empty">No problems. Diagnostics come from <b>qkt lsp</b> as you type, <b>qkt parse</b> after a short pause, and the config checker.</div>}
        <table className="grid">
          <tbody>
            {list.map((p, i) => {
              const [g, c] = SEV[p.severity] ?? SEV.error!;
              return (
                <tr key={i} className="click" onClick={() => revealAt(p.path, p.line, p.col)}>
                  <td style={{ color: c, width: 18 }}>{g}</td>
                  <td style={{ whiteSpace: "normal" }}>{p.message}</td>
                  <td className="muted mono nowrap">{p.path}:{p.line}:{p.col}</td>
                  <td className="muted nowrap">{p.source}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
