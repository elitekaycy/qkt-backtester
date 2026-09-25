import { useCallback, useEffect, useRef, useState } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ChartsPanel } from "../panels/ChartsPanel.js";
import { EditorPanel } from "../panels/EditorPanel.js";
import { FileTree } from "../panels/FileTree.js";
import { MetricsPanel } from "../panels/MetricsPanel.js";
import { PipelinePanel } from "../panels/PipelinePanel.js";
import { ProblemsPanel } from "../panels/ProblemsPanel.js";
import { RobustnessPanel } from "../panels/RobustnessPanel.js";
import { RunBar } from "../panels/RunBar.js";
import { RunsPanel } from "../panels/RunsPanel.js";
import { TerminalPanel } from "../panels/TerminalPanel.js";
import { TradesPanel } from "../panels/TradesPanel.js";
import { useStore } from "../state/store.js";
import { ApiError, getToken, setToken } from "../api/client.js";

const components = {
  explorer: FileTree, editor: EditorPanel, pipeline: PipelinePanel, problems: ProblemsPanel, terminal: TerminalPanel,
  charts: ChartsPanel, trades: TradesPanel, results: MetricsPanel, robustness: RobustnessPanel, runs: RunsPanel,
};
const LAYOUT_KEY = "qkt-studio-layout-v2";
const PANEL_IDS = Object.keys(components);

/** Regions the top bar can collapse. Each lists the panels whose groups it hides. */
const REGIONS: Array<{ id: string; label: string; panels: string[] }> = [
  { id: "files", label: "Files", panels: ["explorer"] },
  { id: "editor", label: "Editor", panels: ["editor"] },
  { id: "console", label: "Console", panels: ["pipeline"] },
  { id: "charts", label: "Charts", panels: ["charts"] },
  { id: "trades", label: "Trades", panels: ["trades"] },
  { id: "results", label: "Results", panels: ["results"] },
];

function buildDefault(api: DockviewApi): void {
  const explorer = api.addPanel({ id: "explorer", component: "explorer", title: "Explorer", initialWidth: 210 });
  const editor = api.addPanel({ id: "editor", component: "editor", title: "Editor", position: { referencePanel: explorer, direction: "right" }, initialWidth: 520 });
  const pipeline = api.addPanel({ id: "pipeline", component: "pipeline", title: "Run pipeline", position: { referencePanel: editor, direction: "below" }, initialHeight: 250 });
  api.addPanel({ id: "problems", component: "problems", title: "Problems", position: { referencePanel: pipeline, direction: "within" } });
  api.addPanel({ id: "terminal", component: "terminal", title: "Terminal", position: { referencePanel: pipeline, direction: "within" } });
  pipeline.api.setActive();
  const charts = api.addPanel({ id: "charts", component: "charts", title: "Charts", position: { referencePanel: editor, direction: "right" } });
  api.addPanel({ id: "trades", component: "trades", title: "Trades", position: { referencePanel: charts, direction: "below" }, initialHeight: 250 });
  const results = api.addPanel({ id: "results", component: "results", title: "Results", position: { referencePanel: charts, direction: "right" }, initialWidth: 430 });
  api.addPanel({ id: "robustness", component: "robustness", title: "Robustness", position: { referencePanel: results, direction: "within" } });
  api.addPanel({ id: "runs", component: "runs", title: "Run history", position: { referencePanel: results, direction: "within" } });
  results.api.setActive();
  applySizes(api);
}

/** Sizes are applied after the grid has laid out; dockview ignores `initialWidth` when panels are added in a chain. */
function applySizes(api: DockviewApi): void {
  const total = api.width || window.innerWidth;
  const left = 210, editorW = Math.round(Math.min(560, Math.max(380, total * 0.27))), right = Math.round(Math.min(460, Math.max(360, total * 0.25)));
  const set = () => {
    api.getPanel("explorer")?.group.api.setSize({ width: left });
    api.getPanel("editor")?.group.api.setSize({ width: editorW });
    api.getPanel("results")?.group.api.setSize({ width: right });
    api.getPanel("pipeline")?.group.api.setSize({ height: 250 });
    api.getPanel("trades")?.group.api.setSize({ height: Math.round((api.height || window.innerHeight) * 0.3) });
  };
  requestAnimationFrame(() => { set(); setTimeout(set, 120); });
}

function HeaderActions({ containerApi, activePanel, group }: IDockviewHeaderActionsProps) {
  const [max, setMax] = useState(false);
  useEffect(() => { const d = containerApi.onDidMaximizedGroupChange(() => setMax(group.api.isMaximized())); return () => d.dispose(); }, [containerApi, group]);
  if (!activePanel) return null;
  return (
    <button className="btn ghost sm" style={{ margin: "3px 4px" }} title={max ? "Restore layout" : "Expand this panel to fill the window"}
      onClick={() => (group.api.isMaximized() ? containerApi.exitMaximizedGroup() : containerApi.maximizeGroup(activePanel))}>{max ? "⤡" : "⤢"}</button>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} onClick={() => useStore.getState().dismissToast(t.id)}>{t.text}</div>)}</div>;
}

function TokenGate({ children }: { children: React.ReactNode }) {
  const info = useStore((s) => s.info);
  const [needToken, setNeed] = useState(false);
  const [val, setVal] = useState("");
  useEffect(() => {
    void useStore.getState().init().catch((e) => { if (e instanceof ApiError && e.status === 401) setNeed(true); else useStore.getState().toast("error", (e as Error).message); });
  }, []);
  if (needToken) return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <form className="panel" style={{ height: "auto", padding: 20, border: "1px solid var(--border)", borderRadius: 6, width: 360, gap: 10 }}
        onSubmit={(e) => { e.preventDefault(); setToken(val); location.reload(); }}>
        <b>Access token required</b><span className="muted">This studio was started with STUDIO_TOKEN.{getToken() ? " The saved token was rejected." : ""}</span>
        <input className="input" style={{ height: 30 }} type="password" autoFocus value={val} onChange={(e) => setVal(e.target.value)} placeholder="token" />
        <button className="btn primary" type="submit">Continue</button>
      </form>
    </div>
  );
  return info ? <>{children}</> : <div className="empty">Connecting to the studio…</div>;
}

export function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const theme = useStore((s) => s.theme);

  const onReady = useCallback((e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    let restored = false;
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) {
        e.api.fromJSON(JSON.parse(saved));
        restored = PANEL_IDS.every((id) => e.api.getPanel(id));
        if (!restored) e.api.clear();
      }
    } catch { e.api.clear(); }
    if (!restored) buildDefault(e.api);
    e.api.onDidLayoutChange(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())); } catch { /* storage blocked */ } });
    (window as unknown as { __dock: DockviewApi }).__dock = e.api;
  }, []);

  const toggle = (id: string) => {
    const api = apiRef.current;
    const region = REGIONS.find((r) => r.id === id);
    if (!api || !region) return;
    const next = !hidden[id];
    for (const pid of region.panels) api.getPanel(pid)?.group.api.setVisible(!next);
    setHidden((h) => ({ ...h, [id]: next }));
  };
  const reset = () => { const api = apiRef.current; if (!api) return; try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ } api.clear(); buildDefault(api); setHidden({}); };

  return (
    <TokenGate>
      <div className="app">
        <RunBar toggles={[...REGIONS.map((r) => ({ id: r.id, label: r.label, on: !hidden[r.id], toggle: () => toggle(r.id) })), { id: "reset", label: "Reset", on: false, toggle: reset }]} />
        <div className="workspace">
          <DockviewReact className="dockview-theme-qkt" components={components as never} onReady={onReady} rightHeaderActionsComponent={HeaderActions} disableFloatingGroups />
        </div>
        <StatusBar />
      </div>
      <Toasts />
      <span hidden data-theme-indicator={theme} />
    </TokenGate>
  );
}

function StatusBar() {
  const { info, run, results } = useStore();
  return (
    <div className="statusbar">
      <span>{info?.workspace}</span>
      <span title="Bars are read from QKT_DATA_HOME">data: {info?.dataRoot}</span>
      {run && <span>run {run.id.slice(-22)} · {run.status}</span>}
      {results && <span>qkt {results.meta.qktVersion} · {results.meta.tier} · {results.meta.from} → {results.meta.to}</span>}
      <span style={{ marginLeft: "auto" }}>All times UTC · window is [from, to)</span>
    </div>
  );
}
