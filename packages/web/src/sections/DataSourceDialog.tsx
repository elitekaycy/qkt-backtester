import { useEffect, useState } from "react";
import { api, ApiError, type DirList } from "../api/client.js";
import { useStore } from "../state/store.js";
import { Modal } from "../ui/Modal.js";
import { ArrowUpRight, CircleCheck, Database, Folder, TriangleAlert } from "../ui/icons.js";

/** Choose the folder qkt reads market data from: type or paste a path, or browse. It is validated before it is used. */
export function DataSourceDialog({ open, onClose, mode = "default" }: { open: boolean; onClose(): void; /** `add` picks an EXTRA source folder symbols can be pointed at, instead of changing the default one. */ mode?: "default" | "add" }) {
  const settings = useStore((s) => s.settings), setDataRoot = useStore((s) => s.setDataRoot), addSource = useStore((s) => s.addSource), removeSource = useStore((s) => s.removeSource);
  const adding = mode === "add";
  const [path, setPath] = useState("");
  const [list, setList] = useState<DirList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const browse = async (p?: string) => {
    try { const l = await api.dirs(p); setList(l); setPath(l.path); setErr(null); }
    catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); }
  };
  useEffect(() => { if (open) { setWarn([]); setErr(null); void browse(settings?.dataRoot); } }, [open]);

  const apply = async (p: string | null) => {
    setBusy(true); setErr(null);
    try { const w = adding && p ? await addSource(p) : await setDataRoot(p); setWarn(w); if (!w.length) onClose(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={adding ? "Add a source folder" : "Data source"} width={620}
      footer={<>
        {!adding && settings?.fromSettings && <button className="btn ghost" style={{ marginRight: "auto" }} onClick={() => void apply(null)} disabled={busy}>Use default ({settings.defaultDataRoot})</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !path} onClick={() => void apply(path)}>{busy ? "Scanning…" : adding ? "Add this folder" : "Use this folder"}</button>
      </>}>
      <p className="ink2" style={{ margin: 0, lineHeight: 1.55 }}>
        {adding ? "An additional data folder. Any symbol can then be pointed at it from its own dialog (Data → click a symbol); everything else keeps using the default source. " : "The folder qkt reads market data from. Every symbol uses it unless you point that symbol elsewhere. "} It should contain <span className="mono">symbols/</span> (tick files, one CSV per day) and/or <span className="mono">bars/</span> (candles built with <span className="mono">qkt data build-bars</span>). After you choose it the studio scans it and shows exactly what is complete.
      </p>
      {!adding && settings && settings.sources.length > 0 && (
        <div className="field"><label>Extra sources</label>
          {settings.sources.map((x) => <div key={x} className="row"><Folder size={14} className="ficon dir" /><span className="mono grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{x}</span>
            <button className="btn ghost sm" aria-label={`Remove source ${x}`} onClick={() => void removeSource(x)}>Remove</button></div>)}
          <div className="hint">Symbols pointed at a removed source go back to the default one.</div></div>
      )}
      <div className="field">
        <label htmlFor="ds-path">Folder path on the server</label>
        <input id="ds-path" className="input mono" data-autofocus value={path} placeholder="/data" spellCheck={false}
          onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void browse(path); }} />
        <div className="hint">In Docker this is a path inside the container: mount your data first (<span className="mono">-v /your/data:/data</span>) and choose <span className="mono">/data</span>.</div>
      </div>
      {settings && !settings.canChangeAnywhere && <div className="banner info"><TriangleAlert size={15} /><span>This server is reachable without a token, so only <span className="mono">{settings.openRoots.join(", ")}</span> can be chosen. Start it with <span className="mono">STUDIO_TOKEN</span> to allow any folder.</span></div>}
      {err && <div className="banner bad"><TriangleAlert size={15} /><span>{err}</span></div>}
      {warn.map((w, i) => <div key={i} className="banner warn"><TriangleAlert size={15} /><span>{w}</span></div>)}
      {list && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "var(--s2) var(--s3)", borderBottom: "1px solid var(--line)" }}>
            <button className="btn ghost sm" disabled={!list.parent} onClick={() => list.parent && void browse(list.parent)}><ArrowUpRight size={14} style={{ transform: "rotate(-135deg)" }} />Up</button>
            <span className="mono ink2 grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{list.path}</span>
            {list.store ? <span className="badge ok"><CircleCheck size={12} />qkt data store</span> : <span className="badge">not a store</span>}
          </div>
          <div style={{ maxHeight: 220, overflow: "auto", padding: "var(--s1)" }} role="listbox" aria-label="Folders">
            {list.dirs.length === 0 && <div className="empty">No sub-folders</div>}
            {list.dirs.map((d) => (
              <div key={d.name} role="option" tabIndex={0} aria-selected={false} className="list-row" onClick={() => void browse(`${list.path.replace(/\/$/, "")}/${d.name}`)}
                onKeyDown={(e) => { if (e.key === "Enter") void browse(`${list.path.replace(/\/$/, "")}/${d.name}`); }}>
                {d.store ? <Database size={16} color="var(--accent-ink)" /> : <Folder size={16} className="ficon dir" />}
                <span className="grow">{d.name}</span>{d.store && <span className="badge accent">data store</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
