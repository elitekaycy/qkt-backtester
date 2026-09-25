import { useStore } from "../state/store.js";
import { CONFIG_TEMPLATE, QKT_TEMPLATE } from "../editor/monaco.js";
import type { TreeEntry } from "../api/client.js";

const icon = (e: TreeEntry) => (e.type === "dir" ? "" : e.name.endsWith(".qkt") ? "◆" : e.name.endsWith(".yaml") || e.name.endsWith(".yml") ? "≡" : "·");

function Node({ e, depth }: { e: TreeEntry; depth: number }) {
  const { tree, expanded, activePath } = useStore();
  const store = useStore.getState;
  const open = expanded[e.path];
  const kids = tree[e.path] ?? [];
  const isRuns = e.path === "runs" || e.path.startsWith("runs/");
  return (
    <>
      <div
        className={`tree-row${activePath === e.path ? " active" : ""}`} style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (e.type === "dir" ? void store().toggleDir(e.path) : void store().openFile(e.path))}
        title={e.path}
      >
        <span className="twist">{e.type === "dir" ? (open ? "▾" : "▸") : icon(e)}</span>
        <span className={isRuns ? "muted" : ""}>{e.name}</span>
        {!isRuns && (
          <span className="actions" onClick={(ev) => ev.stopPropagation()}>
            {e.type === "dir" && <button className="btn ghost sm" title="New strategy here" onClick={() => newStrategy(e.path)}>+</button>}
            <button className="btn ghost sm" title="Rename" onClick={() => { const n = window.prompt("Rename to", e.path); if (n && n !== e.path) void store().renameEntry(e.path, n); }}>✎</button>
            <button className="btn ghost sm" title="Delete" onClick={() => { if (window.confirm(`Delete ${e.path}?`)) void store().removeEntry(e.path); }}>✕</button>
          </span>
        )}
      </div>
      {e.type === "dir" && open && kids.map((k) => <Node key={k.path} e={k} depth={depth + 1} />)}
    </>
  );
}

function newStrategy(dir = "strategies") {
  const raw = window.prompt("New strategy name", "my_strategy");
  if (!raw) return;
  const name = raw.replace(/\.qkt$/i, "").replace(/[^\w.-]+/g, "_");
  void useStore.getState().createEntry(`${dir}/${name}.qkt`, "file", QKT_TEMPLATE(name));
}

export function FileTree() {
  const root = useStore((s) => s.tree[""]) ?? [];
  const info = useStore((s) => s.info);
  const store = useStore.getState;
  const hasConfig = root.some((e) => e.name === "qkt.config.yaml");
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Explorer</span>
        <span className="grow" />
        <button className="btn ghost sm" title="New strategy" onClick={() => newStrategy()}>+ Strategy</button>
        <button className="btn ghost sm" title="Refresh" onClick={() => { void store().refreshTree(""); for (const p of Object.keys(store().expanded)) if (store().expanded[p] && p) void store().refreshTree(p); }}>↻</button>
      </div>
      <div className="panel-scroll tree">
        {!hasConfig && info && (
          <div className="banner warn">
            <span>No <b>qkt.config.yaml</b>.</span>
            <button className="btn sm" onClick={() => void store().createEntry("qkt.config.yaml", "file", CONFIG_TEMPLATE)}>Create</button>
          </div>
        )}
        {root.map((e) => <Node key={e.path} e={e} depth={0} />)}
        {root.length === 0 && <div className="empty">This workspace is empty. Create a <b>strategy</b> to begin.</div>}
      </div>
      {info && <div className="statusbar" style={{ height: 22, flex: "none" }} title={info.workspace}>{info.workspace}</div>}
    </div>
  );
}
