import { useEffect, useRef, useState } from "react";
import { ApiError, getToken, setToken } from "../api/client.js";
import { DockBar, DockBody } from "../dock/Dock.js";
import { EditorPane } from "../editor/EditorPane.js";
import { Journal } from "../journal/Journal.js";
import { PreviewPane } from "../preview/PreviewPane.js";
import { DataSection } from "../sections/DataSection.js";
import { FilesSection } from "../sections/FilesSection.js";
import { RunsSection } from "../sections/RunsSection.js";
import { useStore } from "../state/store.js";
import { clamp, useUi } from "../state/ui.js";
import { PaneControls } from "../ui/PaneControls.js";
import { Splitter } from "../ui/Splitter.js";
import { ChevronLeft } from "../ui/icons.js";
import { CommandPalette, Shortcuts } from "./CommandPalette.js";
import { Rail } from "./Rail.js";
import { StatusBar } from "./StatusBar.js";
import { TopBar } from "./TopBar.js";

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} onClick={() => useStore.getState().dismissToast(t.id)}>{t.text}</div>)}</div>;
}

function TokenGate({ children }: { children: React.ReactNode }) {
  const info = useStore((s) => s.info);
  const [need, setNeed] = useState(false);
  const [val, setVal] = useState("");
  useEffect(() => { void useStore.getState().init().catch((e) => { if (e instanceof ApiError && e.status === 401) setNeed(true); else useStore.getState().toast("error", (e as Error).message); }); }, []);
  if (need) return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <form className="card pad" style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={(e) => { e.preventDefault(); setToken(val); location.reload(); }}>
        <b style={{ fontSize: "var(--fs-lg)" }}>Access token required</b>
        <span className="muted">This studio was started with STUDIO_TOKEN.{getToken() ? " The saved token was rejected." : ""}</span>
        <input className="input" type="password" autoFocus value={val} onChange={(e) => setVal(e.target.value)} placeholder="token" aria-label="Access token" />
        <button className="btn primary" type="submit">Continue</button>
      </form>
    </div>
  );
  return info ? <>{children}</> : <div className="empty" style={{ height: "100%", justifyContent: "center" }}><span className="spin" />Connecting to the studio…</div>;
}

// The chart pane is owned by another workstream; it may or may not still take these props, so pass them loosely.
const ChartPane = PreviewPane as unknown as React.ComponentType<{ maxed: boolean; onMax(): void }>;

const MIN_SIDE = 160, MIN_CHART = 200, MIN_EDITOR = 160, MIN_DOCK = 96, STRIP = 40;

function Shell() {
  const ui = useUi();
  const running = useStore((s) => s.running), run = useStore((s) => s.run);
  const mainRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1200, h: 700, bodyW: 1600 });
  const maxed = ui.maxed;

  useEffect(() => {
    const el = mainRef.current, body = bodyRef.current;
    if (!el || !body) return;
    let raf = 0;
    // measured outside the observer callback: no "ResizeObserver loop" errors when a resize changes what is being observed
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setBox({ w: el.clientWidth, h: el.clientHeight, bodyW: body.clientWidth })); });
    ro.observe(el); ro.observe(body);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // the output panel opens by itself when a run starts or fails, so the steps are never hidden
  useEffect(() => { if (running) useUi.getState().set({ dockOpen: true, dockTab: "pipeline" }); }, [running]);
  useEffect(() => { if (run?.status === "failed") useUi.getState().set({ dockOpen: true, dockTab: "pipeline" }); }, [run?.status]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || !!t.closest?.(".monaco-editor, .xterm"));
      const u = useUi.getState(), s = useStore.getState();
      // Esc leaves full screen, unless something more specific (a dialog, the palette, vim, a text field) wants it
      // Esc never takes you out of the editor: in a full-screen editor it only puts the cursor back in it (vim users press it constantly)
      if (e.key === "Escape" && u.maxed === "editor" && !typing && !e.defaultPrevented && !u.palette && !u.runSettings && !u.shortcuts && !u.journalOpen && !document.querySelector(".modal, .popover")) {
        (window as unknown as { __qktEditor?: { focus(): void } }).__qktEditor?.focus(); return;
      }
      if (e.key === "Escape" && u.maxed && u.maxed !== "editor" && !typing && !e.defaultPrevented && !u.palette && !u.runSettings && !u.shortcuts && !u.journalOpen && !document.querySelector(".modal, .popover")) { e.preventDefault(); u.restore(); return; }
      // undo/redo follow the editor even when focus is on a button or the chart, as in any editor app
      if (mod && !typing && ["z", "y", "Z"].includes(e.key)) {
        const ed = (window as unknown as { __qktEditor?: { focus(): void; trigger(s: string, id: string, a: unknown): void } }).__qktEditor;
        if (ed) { e.preventDefault(); ed.focus(); ed.trigger("keyboard", e.key === "z" && !e.shiftKey ? "undo" : "redo", null); return; }
      }
      if (mod && e.key === "k") { e.preventDefault(); u.set({ palette: !u.palette }); }
      else if (mod && e.key === "j") { e.preventDefault(); u.set({ journalOpen: !u.journalOpen }); }
      else if (mod && e.key === "b") { e.preventDefault(); u.toggleCollapse("sidebar"); }
      else if (mod && e.key === ",") { e.preventDefault(); u.set({ runSettings: !u.runSettings }); }
      else if (mod && e.key === ".") { e.preventDefault(); void s.killAll(); }
      else if (mod && e.key === "`") { e.preventDefault(); u.toggleCollapse("dock"); }
      else if (mod && ["1", "2", "3"].includes(e.key)) { e.preventDefault(); u.set({ section: (["files", "data", "runs"] as const)[Number(e.key) - 1]! }); }
      else if (mod && e.key === "Enter" && !e.defaultPrevented) { e.preventDefault(); if (!s.running) void s.startRun(); }
      else if (e.key === "?" && !typing && !mod) { e.preventDefault(); u.set({ shortcuts: true }); }
    };
    const leave = (e: BeforeUnloadEvent) => { if (useStore.getState().openFiles.some((f) => f.content !== f.saved)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", leave);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("beforeunload", leave); };
  }, []);

  const row = ui.layout === "row";
  const sideOpen = !!ui.section;
  // limits are generous: a pane may take nearly everything, leaving a small minimum for the others (or collapse to a strip)
  const sideMax = Math.max(MIN_SIDE, box.bodyW - 56 - 240);
  const sideW = clamp(ui.sidebarW, MIN_SIDE, sideMax);
  const chartStrip = ui.collapsed.chart, editorStrip = ui.collapsed.editor;
  const chartMax = row ? Math.max(MIN_CHART, box.w - MIN_EDITOR - 24) : Math.max(MIN_CHART, box.h - MIN_EDITOR - 24);
  const chartSize = clamp(ui.previewW || 560, MIN_CHART, chartMax);
  const dockMax = Math.max(MIN_DOCK, box.h - 48 - MIN_EDITOR);
  const dockH = clamp(ui.dockH, MIN_DOCK, dockMax);

  const hide = (on: boolean): React.CSSProperties | undefined => (on ? { display: "none" } : undefined);
  const showSide = sideOpen && (!maxed || maxed === "sidebar");
  const showMain = maxed !== "sidebar";
  const showEditor = !maxed || maxed === "editor" || maxed === "dock";
  const showChart = !maxed || maxed === "chart";
  const editorCol = !maxed || maxed === "editor" || maxed === "dock";
  const dockMaxed = maxed === "dock";
  const editorMaxed = maxed === "editor";

  return (
    <div className="app" data-maxed={maxed ?? undefined}>
      <a className="skip-link" href="#editor">Skip to the editor</a>
      <div className="body" ref={bodyRef}>
        <Rail />
        {showSide && (
          <>
            <aside className={`sidebar${maxed === "sidebar" ? " maxed" : ""}`} style={maxed === "sidebar" ? { flex: 1, width: "auto" } : { width: sideW }} aria-label={ui.section ?? "sidebar"}>
              <span className="side-controls"><PaneControls pane="sidebar" /></span>
              {ui.section === "files" ? <FilesSection /> : ui.section === "data" ? <DataSection /> : <RunsSection />}
            </aside>
            {maxed !== "sidebar" && (
              <div style={{ width: 0, position: "relative", flex: "none" }}>
                <div className="side-split">
                  <Splitter dir="v" label="Resize sidebar" value={sideW} min={MIN_SIDE} max={sideMax} onChange={(v) => ui.set({ sidebarW: v })} onReset={() => ui.resetPane("sidebar")} />
                </div>
              </div>
            )}
          </>
        )}
        <main className="app-main" ref={mainRef} style={hide(!showMain)}>
          <TopBar />
          <div className="workbench" data-layout={ui.layout}>
            <div className="editor-col" style={hide(!editorCol || (!!maxed && maxed !== "editor" && maxed !== "dock"))}>
              <section className="pane grow" aria-label="Editor" style={{ ...(hide(dockMaxed) ?? {}), ...(editorStrip && !editorMaxed ? { flex: "none", height: STRIP } : {}) }}><EditorPane /></section>
              {ui.dockOpen ? (
                <>
                  {!maxed && !editorStrip && <Splitter dir="h" label="Resize output panel" invert value={dockH} min={MIN_DOCK} max={dockMax} onChange={(v) => ui.set({ dockH: v })} onReset={() => ui.resetPane("dock")} />}
                  {!maxed && editorStrip && <div style={{ height: "var(--gap)", flex: "none" }} />}
                  <section className="pane" aria-label="Output" style={hide(editorMaxed) ?? (dockMaxed || editorStrip ? { flex: 1 } : { height: dockH, flex: "none" })}>
                    <DockBar /><DockBody />
                  </section>
                </>
              ) : <section className="pane dock-collapsed" aria-label="Output" style={hide(editorMaxed)}><DockBar /></section>}
            </div>
            {showChart && !chartStrip && !maxed && <Splitter dir={row ? "v" : "h"} label="Resize chart" invert value={chartSize} min={MIN_CHART} max={chartMax} onChange={(v) => ui.set({ previewW: v })} onReset={() => ui.resetPane("chart")} />}
            {showChart && chartStrip && !maxed && (
              <button className={`chart-strip ${row ? "v" : "h"}`} aria-label="Expand chart" onClick={() => ui.toggleCollapse("chart")}><ChevronLeft size={14} /><span>Chart</span></button>
            )}
            <div className={`pv-wrap${maxed === "chart" ? " maxed" : ""}`}
              style={!showChart || (chartStrip && maxed !== "chart") ? { display: "none" } : maxed === "chart" ? undefined : row ? { width: chartSize, flex: "none", display: "flex" } : { height: chartSize, flex: "none", display: "flex" }}>
              <ChartPane maxed={maxed === "chart"} onMax={() => ui.toggleMax("chart")} />
            </div>
          </div>
          {ui.journalOpen && <Journal containerWidth={box.w} />}
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <Shortcuts />
      <Toasts />
    </div>
  );
}

export function App() { return <TokenGate><Shell /></TokenGate>; }
