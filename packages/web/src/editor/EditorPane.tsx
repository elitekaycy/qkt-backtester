import { PaneControls } from "../ui/PaneControls.js";
import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor/editor/editor.api.js";
import { api } from "../api/client.js";
import { LspClient, toMarkers } from "./lsp.js";
import { enableVim, languageFor, setupMonaco, themeFor, type Monaco } from "./monaco.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { newStrategy } from "../sections/FilesSection.js";
import { FileCode2, FileCog, FileText, Plus, X } from "../ui/icons.js";

export const REVEAL_EVENT = "qkt:reveal";
export const revealAt = (path: string, line: number, col: number) => window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { path, line, col } }));

const TabIcon = ({ path }: { path: string }) => path.endsWith(".qkt") ? <FileCode2 size={15} className="ficon qkt" /> : /\.ya?ml$/.test(path) ? <FileCog size={15} className="ficon yaml" /> : <FileText size={15} className="ficon dir" />;

export function EditorPane() {
  const host = useRef<HTMLDivElement>(null);
  const vimStatus = useRef<HTMLSpanElement>(null);
  const S = useRef<{ m: Monaco; ed: editor.IStandaloneCodeEditor; models: Map<string, editor.ITextModel>; views: Map<string, editor.ICodeEditorViewState | null>; lsp: LspClient; suppress: boolean } | null>(null);
  const vimOff = useRef<(() => void) | null>(null);
  const timers = useRef<{ lsp?: ReturnType<typeof setTimeout>; check?: ReturnType<typeof setTimeout>; seq: number }>({ seq: 0 });
  const [lspStatus, setLspStatus] = useState<"connecting" | "ready" | "down">("connecting");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [booted, setBooted] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const info = useStore((s) => s.info), openFiles = useStore((s) => s.openFiles), activePath = useStore((s) => s.activePath), theme = useStore((s) => s.theme);
  const vim = useUi((s) => s.vim), fontSize = useUi((s) => s.fontSize);
  const store = useStore;
  const active = openFiles.find((f) => f.path === activePath) ?? null;

  useEffect(() => {
    if (!info || !host.current) return;
    let disposed = false;
    void setupMonaco().then((m) => {
      if (disposed || !host.current) return;
      const ed = m.editor.create(host.current, {
        model: null, theme: themeFor(store.getState().theme), automaticLayout: true, minimap: { enabled: false }, fontSize: useUi.getState().fontSize, tabSize: 4,
        scrollBeyondLastLine: false, renderWhitespace: "selection", fixedOverflowWidgets: true, padding: { top: 12, bottom: 12 }, lineHeight: 0,
        fontFamily: "'JetBrains Mono Variable', ui-monospace, Menlo, Consolas, monospace", fontLigatures: true, lineNumbersMinChars: 3, smoothScrolling: true,
        cursorSmoothCaretAnimation: "on", roundedSelection: true, guides: { indentation: true, bracketPairs: false }, overviewRulerBorder: false, renderLineHighlight: "line",
      });
      const lsp = new LspClient(m, info.workspace, (uri, diags) => {
        const prefix = `file://${info.workspace}/`;
        const path = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
        if (!path) return;
        const model = S.current?.models.get(path);
        if (model) m.editor.setModelMarkers(model, "qkt-lsp", toMarkers(m, diags));
        store.getState().setDiagnostics(path, "lsp", diags);
      });
      lsp.onStatus = setLspStatus;
      const provider = lsp.register();
      lsp.connect();
      S.current = { m, ed, models: new Map(), views: new Map(), lsp, suppress: false };
      (window as unknown as { __qktEditor?: editor.IStandaloneCodeEditor }).__qktEditor = ed; // handle for automated tests
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => { const p = store.getState().activePath; if (p) void store.getState().saveFile(p); });
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => void store.getState().startRun());
      // Monaco owns these chords while the editor has focus; forward them to the app so shortcuts work everywhere.
      const K = m.KeyCode, C = m.KeyMod.CtrlCmd, ui = () => useUi.getState();
      ed.addCommand(C | K.KeyK, () => ui().set({ palette: !ui().palette }));
      ed.addCommand(C | K.KeyJ, () => ui().set({ journalOpen: !ui().journalOpen }));
      ed.addCommand(C | K.KeyB, () => ui().set({ section: ui().section ? null : "files" }));
      ed.addCommand(C | K.Comma, () => ui().set({ runSettings: !ui().runSettings }));
      ed.addCommand(C | K.Period, () => void store.getState().killAll());
      ed.addCommand(C | K.Backquote, () => ui().set({ dockOpen: !ui().dockOpen }));
      ([K.Digit1, K.Digit2, K.Digit3] as const).forEach((k, i) => ed.addCommand(C | k, () => ui().set({ section: (["files", "data", "runs"] as const)[i]! })));
      // Esc with a completion popup open: in vim mode it closes the popup AND leaves insert mode in the same press (one Esc is all a
      // vim user should ever need); without vim it only closes the popup, as in any Monaco editor.
      host.current?.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        const popup = host.current?.querySelector(".suggest-widget.visible, .parameter-hints-widget.visible"); // not the hover: its element always exists
        if (!popup) return;
        ed.trigger("keyboard", "hideSuggestWidget", null); ed.trigger("keyboard", "closeParameterHints", null);
        if (!useUi.getState().vim) { e.stopPropagation(); e.preventDefault(); }
      }, true);
      ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }));
      setBooted(true);
      (host.current as HTMLDivElement & { __dispose?: () => void }).__dispose = () => { vimOff.current?.(); provider.dispose(); lsp.dispose(); ed.dispose(); for (const mm of S.current?.models.values() ?? []) mm.dispose(); };
    });
    return () => { disposed = true; (host.current as (HTMLDivElement & { __dispose?: () => void }) | null)?.__dispose?.(); S.current = null; };
  }, [info]);

  useEffect(() => { S.current?.m.editor.setTheme(themeFor(theme)); }, [theme, booted]);
  useEffect(() => { S.current?.ed.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.65) }); }, [fontSize, booted]);

  // vim mode: loaded on demand, torn down when switched off. monaco-vim binds to the editor's CURRENT model, so it is
  // (re)attached whenever the model changes (tab switch, first file after boot); attaching it before a model exists left
  // insert mode "on" but typing going nowhere.
  const vimGen = useRef(0);
  const syncVim = () => {
    const s = S.current;
    if (!s || !vimStatus.current) return;
    const gen = ++vimGen.current;
    vimOff.current?.(); vimOff.current = null;
    if (!useUi.getState().vim || !s.ed.getModel()) { vimStatus.current.textContent = ""; return; }
    void enableVim(s.ed, vimStatus.current, {
      save: () => { const p = store.getState().activePath; return p ? store.getState().saveFile(p) : false; },
      saveAll: () => store.getState().saveAllDirty(),
      close: (force) => { const st = store.getState(), p = st.activePath, f = st.openFiles.find((x) => x.path === p); if (!p || !f) return; if (!force && f.content !== f.saved) { st.toast("error", `${p} has unsaved changes. :w to save, or :q! to discard them.`); return; } st.closeFile(p); },
      run: () => void store.getState().startRun(),
      say: (m) => store.getState().toast("info", m),
    }).then((off) => { if (gen !== vimGen.current) off(); else vimOff.current = off; });
  };
  useEffect(() => { if (booted) syncVim(); }, [vim, booted]);

  useEffect(() => {
    const s = S.current;
    if (!s || !booted || !info) return;
    // Read the LATEST store state, not the render's closure: keystrokes land between a render and its effect, and
    // pushing a stale copy back into the model (setValue) erased typing and the undo history.
    const latest = store.getState().openFiles;
    const want = new Set(latest.map((f) => f.path));
    for (const f of latest) {
      let model = s.models.get(f.path);
      if (!model) {
        const uri = s.m.Uri.parse(`file://${info.workspace}/${f.path}`);
        // a model for this URI can outlive an editor instance that was torn down mid-boot (fast unmount/remount): reuse it, never create twice
        model = s.m.editor.getModel(uri) ?? s.m.editor.createModel(f.content, languageFor(f.path), uri);
        if (model.getValue() !== f.content) model.setValue(f.content);
        s.models.set(f.path, model);
        if (f.path.endsWith(".qkt")) s.lsp.open(f.path, f.content);
        const path = f.path;
        model.onDidChangeContent(() => {
          if (s.suppress) return;
          const text = model!.getValue();
          store.getState().setContent(path, text);
          if (path.endsWith(".qkt")) { clearTimeout(timers.current.lsp); timers.current.lsp = setTimeout(() => s.lsp.change(path, text), 150); }
          scheduleCheck(path, text);
        });
        scheduleCheck(f.path, f.content);
      } else if (model.getValue() !== f.content) { s.suppress = true; model.setValue(f.content); s.suppress = false; }
    }
    for (const [p, model] of s.models) if (!want.has(p)) { if (p.endsWith(".qkt")) s.lsp.close(p); model.dispose(); s.models.delete(p); s.views.delete(p); store.getState().setDiagnostics(p, "check", []); store.getState().setDiagnostics(p, "lsp", []); }
  }, [openFiles, booted, info]);

  const shown = useRef<string | null>(null);
  useEffect(() => {
    const s = S.current;
    if (!s || !booted) return;
    if (shown.current && shown.current !== activePath) s.views.set(shown.current, s.ed.saveViewState());
    const model = activePath ? s.models.get(activePath) : null;
    const swapped = !!model && s.ed.getModel() !== model;
    if (model && swapped) { s.ed.setModel(model); const v = s.views.get(activePath!); if (v) s.ed.restoreViewState(v); s.ed.focus(); }
    if (!model) s.ed.setModel(null);
    shown.current = activePath;
    if (swapped && useUi.getState().vim) syncVim();
  }, [activePath, openFiles.length, booted]);

  useEffect(() => {
    const h = (e: Event) => {
      const { path, line, col } = (e as CustomEvent).detail as { path: string; line: number; col: number };
      void store.getState().openFile(path).then(() => setTimeout(() => { const s = S.current; if (!s) return; s.ed.revealLineInCenter(line); s.ed.setPosition({ lineNumber: line, column: col }); s.ed.focus(); }, 60));
    };
    window.addEventListener(REVEAL_EVENT, h);
    return () => window.removeEventListener(REVEAL_EVENT, h);
  }, []);

  function scheduleCheck(path: string, text: string) {
    const kind = path.endsWith(".qkt") ? "qkt" : path === "qkt.config.yaml" ? "config" : null;
    if (!kind) return;
    clearTimeout(timers.current.check);
    const seq = ++timers.current.seq;
    timers.current.check = setTimeout(async () => {
      try {
        const { diagnostics } = await api.check(kind, text);
        if (seq !== timers.current.seq) return;
        const s = S.current, model = s?.models.get(path);
        if (s && model) s.m.editor.setModelMarkers(model, "qkt-check", toMarkers(s.m, diagnostics));
        store.getState().setDiagnostics(path, kind === "config" ? "config" : "check", diagnostics);
      } catch { /* checker busy or offline: keep the last markers */ }
    }, 600);
  }

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const move = (j: number) => { const f = openFiles[(j + openFiles.length) % openFiles.length]; if (f) { store.getState().setActive(f.path); (e.currentTarget.parentElement?.children[(j + openFiles.length) % openFiles.length] as HTMLElement | undefined)?.focus(); } };
    if (e.key === "ArrowRight") { e.preventDefault(); move(i + 1); } else if (e.key === "ArrowLeft") { e.preventDefault(); move(i - 1); }
  };

  return (
    <>
      <div className="tabs-row">
      <div className="tabs" role="tablist" aria-label="Open files">
        {openFiles.map((f, i) => (
          <div key={f.path} role="tab" tabIndex={f.path === activePath ? 0 : -1} aria-selected={f.path === activePath} className={`tab${dragOver === f.path ? " dragover" : ""}`} title={f.path} draggable
            onClick={() => store.getState().setActive(f.path)} onKeyDown={(e) => onTabKey(e, i)}
            onAuxClick={(e) => { if (e.button === 1) store.getState().closeFile(f.path); }}
            onDragStart={(e) => { e.dataTransfer.setData("text/plain", f.path); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(f.path); }} onDragLeave={() => setDragOver(null)}
            onDrop={(e) => { e.preventDefault(); setDragOver(null); store.getState().reorderFiles(e.dataTransfer.getData("text/plain"), f.path); }}>
            <TabIcon path={f.path} /><span>{f.path.split("/").pop()}</span>
            {f.conflict ? <span className="badge bad">conflict</span> : f.content !== f.saved ? <span className="unsaved" title="Unsaved changes" /> : null}
            <button className="x" tabIndex={-1} aria-label={`Close ${f.path}`} onClick={(e) => { e.stopPropagation(); if (f.content === f.saved || window.confirm(`Discard unsaved changes to ${f.path}?`)) store.getState().closeFile(f.path); }}><X size={13} /></button>
          </div>
        ))}
      </div>
      <PaneControls pane="editor" />
      </div>
      {active?.conflict && (
        <div className="banner bad" style={{ margin: "var(--s2)", alignItems: "center" }}>
          <span className="grow"><b>{active.path}</b> changed on disk since you opened it.</span>
          <button className="btn sm" onClick={() => void store.getState().reloadFromDisk(active.path)}>Reload from disk</button>
          <button className="btn sm danger" onClick={() => void store.getState().overwriteOnDisk(active.path)}>Overwrite</button>
        </div>
      )}
      {!active && booted && (
        <div className="empty" style={{ flex: 1, justifyContent: "center" }}><FileCode2 className="ico-big" /><b>No file open</b>Pick one from Files, or start a new strategy.
          <button className="btn primary" onClick={() => newStrategy()}><Plus size={15} />New strategy</button></div>
      )}
      <div ref={host} id="editor" className="monaco-host" style={{ display: active ? "block" : "none" }} />
      <div className="editor-status" role="status">
        <span className="vim-status" ref={vimStatus} aria-label="Vim mode" />
        <span>{active ? `Ln ${cursor.line}, Col ${cursor.col}` : ""}</span>
        <span>{active ? (active.path.endsWith(".qkt") ? "qkt" : "YAML") : ""}</span>
        <span className="row" style={{ gap: 6 }}><span className={`dot ${lspStatus === "ready" ? "ok" : "warn"}`} />LSP {lspStatus === "ready" ? "connected" : lspStatus === "connecting" ? "connecting…" : "reconnecting…"}</span>
        <span style={{ marginLeft: "auto" }}><span className="kbd">Ctrl</span> <span className="kbd">S</span> save · <span className="kbd">Ctrl</span> <span className="kbd">Enter</span> run</span>
      </div>
    </>
  );
}
