// The variant diff in the editor area: the base file's CURRENT text (left / removed) against the variant's source (right /
// added), read-only, in Monaco's own diff editor with the editor's theme and qkt highlighting. It owns its diff editor and
// both of its models; the base file's own model (the one Adopt edits as one undo step) is never touched or disposed here.
import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor/editor/editor.api.js";
import { api } from "../api/client.js";
import { useAgent, type VariantInfo } from "../state/agent.js";
import { useDiffView } from "../state/diffView.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { Columns2, Rows2, X } from "../ui/icons.js";
import { languageFor, setupMonaco, themeFor, type Monaco } from "./monaco.js";
import { baseChanged, countLines, diffEditorOptions, diffLayout, diffTitle, toggledMode } from "./variantDiff.js";
import "./variantDiff.css";

type Source = { source: string; baseHash: string } | "gone" | null;
const toastError = (e: unknown) => useStore.getState().toast("error", (e as Error).message);

export function VariantDiff({ variant }: { variant: VariantInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const R = useRef<{ m: Monaco; ed: editor.IStandaloneDiffEditor; orig: editor.ITextModel; mod: editor.ITextModel } | null>(null);
  const [booted, setBooted] = useState(false);
  const [src, setSrc] = useState<Source>(null);
  const [disk, setDisk] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [lines, setLines] = useState<{ added: number; removed: number } | null>(null);
  // the open buffer (a string, or undefined when the tab is closed): a scalar selector, never a fresh object per call
  const buffer = useStore((s) => s.openFiles.find((f) => f.path === variant.base)?.content);
  const theme = useStore((s) => s.theme), fontSize = useUi((s) => s.fontSize), mode = useDiffView((s) => s.mode);
  const current = buffer ?? disk;

  // the variant's text and the hash of the text it was made from
  useEffect(() => {
    let live = true;
    setSrc(null);
    void api.variant(variant.id).then(
      (v) => { if (live) setSrc(v.source === null ? "gone" : { source: v.source, baseHash: v.baseHash }); },
      () => { if (live) setSrc("gone"); },
    );
    return () => { live = false; };
  }, [variant.id]);

  // the base file from disk, only when its tab is not open (an open tab's buffer is the current text)
  useEffect(() => {
    if (buffer !== undefined) return;
    let live = true;
    void api.readFile(variant.base).then((r) => { if (live) setDisk(r.content); }, () => undefined);
    return () => { live = false; };
  }, [variant.base, buffer === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  // the diff editor and its own two models, created once and disposed with the component
  useEffect(() => {
    let disposed = false;
    void setupMonaco().then((m) => {
      if (disposed || !host.current) return;
      const lang = languageFor(variant.base);
      const orig = m.editor.createModel("", lang), mod = m.editor.createModel("", lang);
      const ed = m.editor.createDiffEditor(host.current, {
        theme: themeFor(useStore.getState().theme), automaticLayout: true, readOnly: true, originalEditable: false, domReadOnly: true,
        minimap: { enabled: false }, fontSize: useUi.getState().fontSize, lineHeight: Math.round(useUi.getState().fontSize * 1.65),
        fontFamily: "'JetBrains Mono Variable', ui-monospace, Menlo, Consolas, monospace", fontLigatures: true, lineNumbersMinChars: 3,
        scrollBeyondLastLine: false, renderOverviewRuler: true, overviewRulerBorder: false, renderIndicators: true, ignoreTrimWhitespace: false,
        renderMarginRevertIcon: false, padding: { top: 8, bottom: 8 }, fixedOverflowWidgets: true,
        ariaLabel: `Changes the variant ${variant.label} makes to ${variant.base}`,
        ...diffEditorOptions(useDiffView.getState().mode, host.current.clientWidth),
      });
      ed.setModel({ original: orig, modified: mod });
      ed.onDidUpdateDiff(() => setLines(countLines(ed.getLineChanges())));
      R.current = { m, ed, orig, mod };
      (window as unknown as { __qktDiff?: editor.IStandaloneDiffEditor }).__qktDiff = ed; // handle for automated tests
      setBooted(true);
    });
    return () => {
      disposed = true;
      const r = R.current;
      R.current = null;
      if (!r) return;
      const w = window as unknown as { __qktDiff?: editor.IStandaloneDiffEditor };
      if (w.__qktDiff === r.ed) delete w.__qktDiff;
      r.ed.dispose(); r.orig.dispose(); r.mod.dispose(); // the diff editor does not dispose models it did not create
    };
  }, [variant.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep both sides current: the base as the user edits it, the variant once loaded
  useEffect(() => {
    const r = R.current;
    if (!r) return;
    if (current !== null && current !== undefined && r.orig.getValue() !== current) r.orig.setValue(current);
    const text = src && src !== "gone" ? src.source : "";
    if (r.mod.getValue() !== text) r.mod.setValue(text);
  }, [booted, current, src]);

  useEffect(() => { R.current?.m.editor.setTheme(themeFor(theme)); }, [theme, booted]);
  useEffect(() => { R.current?.ed.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.65) }); }, [fontSize, booted]);
  useEffect(() => { R.current?.ed.updateOptions(diffEditorOptions(mode, width)); }, [mode, width, booted]);

  // the pane's width decides "auto" (and the toggle's label), so the header always names the layout on screen
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const layout = diffLayout(mode, width);
  const changed = src && src !== "gone" ? baseChanged(src.baseHash, current) : false;
  const name = variant.base.split("/").pop();
  return (
    <div className="variant-diff">
      <div className="variant-diff-head" role="toolbar" aria-label="Variant diff">
        <b className="variant-diff-title" title={`${variant.base} ← ${variant.label}`}>{diffTitle(variant.base, variant.label)}</b>
        {lines && (lines.added > 0 || lines.removed > 0) && (
          <span className="variant-diff-count mono" aria-label={`${lines.added} lines added, ${lines.removed} removed`}>
            <span className="add">+{lines.added}</span> <span className="del">−{lines.removed}</span>
          </span>
        )}
        {lines && lines.added === 0 && lines.removed === 0 && src && src !== "gone" && <span className="muted">no changes</span>}
        <span className="grow" />
        <button className="btn sm ghost" aria-label={layout === "split" ? "Show the diff inline" : "Show the diff side by side"}
          title={layout === "split" ? "Inline" : "Side by side"} onClick={() => useDiffView.getState().setMode(toggledMode(mode, width))}>
          {layout === "split" ? <Rows2 size={14} /> : <Columns2 size={14} />}{layout === "split" ? "Inline" : "Side by side"}
        </button>
        <button className="btn sm primary" disabled={src === "gone"} onClick={() => void useAgent.getState().adopt(variant.id).catch(toastError)}>Adopt</button>
        <button className="btn sm" onClick={() => void useAgent.getState().discard(variant.id).catch(toastError)}>Discard</button>
        <button className="btn sm ghost" aria-label="Close the diff" title="Back to the editor" onClick={() => useDiffView.getState().close()}><X size={14} />Close</button>
      </div>
      {changed && <div className="variant-diff-note" role="status">{name} changed since this variant was made; the diff is against your current text.</div>}
      {src === "gone" && <div className="variant-diff-note" role="status">The variant's file is gone; there is nothing to compare.</div>}
      <div ref={host} className="monaco-host variant-diff-host" />
    </div>
  );
}
