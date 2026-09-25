import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor/editor/editor.api.js";
import { api } from "../api/client.js";
import { LspClient, toMarkers } from "../editor/lsp.js";
import { languageFor, setupMonaco, themeFor, type Monaco } from "../editor/monaco.js";
import { useStore } from "../state/store.js";

export const REVEAL_EVENT = "qkt:reveal";
export const revealAt = (path: string, line: number, col: number) => window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { path, line, col } }));

export function EditorPanel() {
  const host = useRef<HTMLDivElement>(null);
  const S = useRef<{ m: Monaco; ed: editor.IStandaloneCodeEditor; models: Map<string, editor.ITextModel>; views: Map<string, editor.ICodeEditorViewState | null>; lsp: LspClient; suppress: boolean } | null>(null);
  const timers = useRef<{ lsp?: ReturnType<typeof setTimeout>; check?: ReturnType<typeof setTimeout>; seq: number }>({ seq: 0 });
  const [lspStatus, setLspStatus] = useState<"connecting" | "ready" | "down">("connecting");
  const [booted, setBooted] = useState(false);

  const info = useStore((s) => s.info);
  const openFiles = useStore((s) => s.openFiles);
  const activePath = useStore((s) => s.activePath);
  const theme = useStore((s) => s.theme);
  const store = useStore;
  const active = openFiles.find((f) => f.path === activePath) ?? null;

  // one-time boot
  useEffect(() => {
    if (!info || !host.current) return;
    let disposed = false;
    void setupMonaco().then((m) => {
      if (disposed || !host.current) return;
      const ed = m.editor.create(host.current, {
        model: null, theme: themeFor(store.getState().theme), automaticLayout: true, minimap: { enabled: false }, fontSize: 13, tabSize: 4,
        scrollBeyondLastLine: false, renderWhitespace: "selection", fixedOverflowWidgets: true, padding: { top: 6 },
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", lineNumbersMinChars: 3,
      });
      const lsp = new LspClient(m, info.workspace, (uri, diags) => {
        const path = uri.startsWith(`file://${info.workspace}/`) ? uri.slice(`file://${info.workspace}/`.length) : null;
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
      setBooted(true);
      (host.current as HTMLDivElement & { __dispose?: () => void }).__dispose = () => { provider.dispose(); lsp.dispose(); ed.dispose(); for (const mm of S.current?.models.values() ?? []) mm.dispose(); };
    });
    return () => { disposed = true; (host.current as (HTMLDivElement & { __dispose?: () => void }) | null)?.__dispose?.(); S.current = null; };
  }, [info]);

  // theme
  useEffect(() => { S.current?.m.editor.setTheme(themeFor(theme)); }, [theme, booted]);

  // keep models in sync with the store's open files
  useEffect(() => {
    const s = S.current;
    if (!s || !booted || !info) return;
    const want = new Set(openFiles.map((f) => f.path));
    for (const f of openFiles) {
      let model = s.models.get(f.path);
      if (!model) {
        model = s.m.editor.createModel(f.content, languageFor(f.path), s.m.Uri.parse(`file://${info.workspace}/${f.path}`));
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
      } else if (model.getValue() !== f.content) {
        s.suppress = true; model.setValue(f.content); s.suppress = false; // reload from disk
      }
    }
    for (const [p, model] of s.models) if (!want.has(p)) { if (p.endsWith(".qkt")) s.lsp.close(p); model.dispose(); s.models.delete(p); s.views.delete(p); store.getState().setDiagnostics(p, "check", []); store.getState().setDiagnostics(p, "lsp", []); }
  }, [openFiles, booted, info]);

  // show the active model, remembering scroll/cursor per file
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const s = S.current;
    if (!s || !booted) return;
    if (shown.current && shown.current !== activePath) s.views.set(shown.current, s.ed.saveViewState());
    const model = activePath ? s.models.get(activePath) : null;
    if (model && s.ed.getModel() !== model) { s.ed.setModel(model); const v = s.views.get(activePath!); if (v) s.ed.restoreViewState(v); s.ed.focus(); }
    if (!model) s.ed.setModel(null);
    shown.current = activePath;
  }, [activePath, openFiles.length, booted]);

  // click in Problems -> jump
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
        if (seq !== timers.current.seq) return; // a newer edit superseded this answer
        const s = S.current;
        const model = s?.models.get(path);
        if (s && model) s.m.editor.setModelMarkers(model, "qkt-check", toMarkers(s.m, diagnostics));
        store.getState().setDiagnostics(path, kind === "config" ? "config" : "check", diagnostics);
      } catch { /* checker busy or offline: keep the last markers */ }
    }, 600);
  }

  return (
    <div className="panel">
      <div className="tabs" role="tablist">
        {openFiles.map((f) => (
          <div key={f.path} role="tab" aria-selected={f.path === activePath} className={`tab${f.path === activePath ? " active" : ""}`} onClick={() => store.getState().setActive(f.path)} title={f.path}>
            <span>{f.path.split("/").pop()}</span>
            {f.conflict ? <span className="badge bad">conflict</span> : f.content !== f.saved ? <span className="dot" title="unsaved changes" /> : null}
            <span className="x" onClick={(e) => { e.stopPropagation(); if (f.content === f.saved || window.confirm(`Discard unsaved changes to ${f.path}?`)) store.getState().closeFile(f.path); }}>✕</span>
          </div>
        ))}
      </div>
      {active?.conflict && (
        <div className="banner bad">
          <span><b>{active.path}</b> changed on disk since you opened it.</span>
          <button className="btn sm" onClick={() => void store.getState().reloadFromDisk(active.path)}>Reload from disk</button>
          <button className="btn sm danger" onClick={() => void store.getState().overwriteOnDisk(active.path)}>Overwrite</button>
        </div>
      )}
      {!active && booted && <div className="empty"><b>No file open.</b><br />Open a file from the explorer, or create a strategy with the + button.</div>}
      <div ref={host} className="monaco-host" style={{ display: active ? "block" : "none" }} />
      <div className="statusbar" style={{ height: 22, flex: "none" }}>
        <span title="qkt language server">LSP: {lspStatus === "ready" ? "connected" : lspStatus === "connecting" ? "connecting…" : "reconnecting…"}</span>
        <span>{active ? `${active.path}${active.content !== active.saved ? "  ● unsaved" : ""}` : ""}</span>
        <span style={{ marginLeft: "auto" }}><span className="kbd">Ctrl</span>+<span className="kbd">S</span> save · <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> run</span>
      </div>
    </div>
  );
}
