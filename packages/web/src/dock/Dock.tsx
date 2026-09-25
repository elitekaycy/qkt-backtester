import { useEffect, useState } from "react";
import { flattenProblems, useStore } from "../state/store.js";
import { useUi, type DockTab } from "../state/ui.js";
import { ListChecks, SquareTerminal, TriangleAlert } from "../ui/icons.js";
import { PaneControls } from "../ui/PaneControls.js";
import { PipelineTab } from "./PipelineTab.js";
import { ProblemsTab } from "./ProblemsTab.js";
import { TerminalTab } from "./TerminalTab.js";

export function DockBar() {
  const ui = useUi();
  const problems = useStore((s) => s.problems), run = useStore((s) => s.run), running = useStore((s) => s.running);
  const list = flattenProblems(problems);
  const errors = list.filter((p) => p.severity === "error").length;
  const tabs: Array<{ id: DockTab; label: string; icon: React.ReactNode; badge?: React.ReactNode }> = [
    { id: "pipeline", label: "Pipeline", icon: <ListChecks size={15} />, badge: running ? <span className="dot run" /> : run?.status === "failed" ? <span className="dot bad" /> : run?.status === "done" ? <span className="dot ok" /> : null },
    { id: "problems", label: "Problems", icon: <TriangleAlert size={15} />, badge: list.length ? <span className={`badge ${errors ? "bad" : "warn"}`}>{list.length}</span> : null },
    { id: "terminal", label: "Terminal", icon: <SquareTerminal size={15} /> },
  ];
  return (
    <div className="dock-bar" role="tablist" aria-label="Output">
      {tabs.map((t) => (
        <button key={t.id} role="tab" className="dock-tab" aria-selected={ui.dockOpen && ui.dockTab === t.id} onClick={() => ui.set({ dockOpen: true, dockTab: t.id })}>{t.icon}{t.label}{t.badge}</button>
      ))}
      <span style={{ flex: 1 }} />
      <PaneControls pane="dock" />
    </div>
  );
}

export function DockBody() {
  const tab = useUi((s) => s.dockTab);
  // the terminal keeps its session (and scrollback) while you look at another tab: mounted after the first visit, hidden otherwise
  const [seen, setSeen] = useState(tab === "terminal");
  useEffect(() => { if (tab === "terminal") setSeen(true); }, [tab]);
  return (
    <>
      {tab === "pipeline" && <PipelineTab />}
      {tab === "problems" && <ProblemsTab />}
      {seen && <div className="dock-term" style={{ display: tab === "terminal" ? "flex" : "none" }}><TerminalTab /></div>}
    </>
  );
}
