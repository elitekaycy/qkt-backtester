import { lazy, Suspense, useEffect, useState } from "react";
import { flattenProblems, useStore } from "../state/store.js";
import { useUi, type DockTab } from "../state/ui.js";
import { useChat } from "../chat/state.js";
import { ListChecks, MessageSquare, SquareTerminal, TriangleAlert } from "../ui/icons.js";
import { PaneControls } from "../ui/PaneControls.js";
import { PipelineTab } from "./PipelineTab.js";
import { ProblemsTab } from "./ProblemsTab.js";
const TerminalTab = lazy(() => import("./TerminalTab.js").then((m) => ({ default: m.TerminalTab })));
const ChatTab = lazy(() => import("../chat/ChatTab.js").then((m) => ({ default: m.ChatTab })));

export function DockBar() {
  const ui = useUi();
  const problems = useStore((s) => s.problems), run = useStore((s) => s.run), running = useStore((s) => s.running);
  const chatBusy = useChat((s) => s.busy);
  const list = flattenProblems(problems);
  const errors = list.filter((p) => p.severity === "error").length;
  const tabs: Array<{ id: DockTab; label: string; icon: React.ReactNode; badge?: React.ReactNode }> = [
    { id: "pipeline", label: "Pipeline", icon: <ListChecks size={15} />, badge: running ? <span className="dot run" /> : run?.status === "failed" ? <span className="dot bad" /> : run?.status === "done" ? <span className="dot ok" /> : null },
    { id: "problems", label: "Problems", icon: <TriangleAlert size={15} />, badge: list.length ? <span className={`badge ${errors ? "bad" : "warn"}`}>{list.length}</span> : null },
    { id: "terminal", label: "Terminal", icon: <SquareTerminal size={15} /> },
    { id: "chat", label: "Chat", icon: <MessageSquare size={15} />, badge: chatBusy ? <span className="dot run" /> : null },
  ];
  return (
    <div className="dock-bar">
      <div role="tablist" aria-label="Output" style={{ display: "contents" }}>
        {tabs.map((t) => (
          <button key={t.id} role="tab" id={`dock-tab-${t.id}`} aria-controls={`dock-panel-${t.id}`} className="dock-tab" aria-selected={ui.dockOpen && ui.dockTab === t.id} onClick={() => ui.showDock(t.id)}>{t.icon}{t.label}{t.badge}</button>
        ))}
      </div>
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
      {tab === "pipeline" && <div role="tabpanel" id="dock-panel-pipeline" aria-labelledby="dock-tab-pipeline" style={{ display: "contents" }}><PipelineTab /></div>}
      {tab === "problems" && <div role="tabpanel" id="dock-panel-problems" aria-labelledby="dock-tab-problems" style={{ display: "contents" }}><ProblemsTab /></div>}
      {tab === "chat" && <div role="tabpanel" id="dock-panel-chat" aria-labelledby="dock-tab-chat" className="dock-chat"><Suspense fallback={<div className="empty"><span className="spin" />Loading the chat…</div>}><ChatTab /></Suspense></div>}
      {seen && <div role="tabpanel" id="dock-panel-terminal" aria-labelledby="dock-tab-terminal" className="dock-term" style={{ display: tab === "terminal" ? "flex" : "none" }}><Suspense fallback={null}><TerminalTab /></Suspense></div>}
    </>
  );
}
