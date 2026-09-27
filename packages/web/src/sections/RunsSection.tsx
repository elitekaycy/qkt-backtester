import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useStore } from "../state/store.js";
import { useUi } from "../state/ui.js";
import { Modal } from "../ui/Modal.js";
import { navigateList } from "../util/listNav.js";
import { Popover } from "../ui/Popover.js";
import { Tip } from "../ui/Tip.js";
import { DASH, fmtMoney, fmtRatio, fmtTs } from "../util/format.js";
import { ChevronDown, DiskIcon, GitCompare, Layers, RefreshCw, Trash2 } from "../ui/icons.js";

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

type Plan = { title: string; body: string; ids: string[]; bytes: number } | null;

export function RunsSection() {
  const runs = useStore((s) => s.runs), runId = useStore((s) => s.runId), compare = useStore((s) => s.compare);
  const store = useStore.getState;
  const ui = useUi();
  const [usage, setUsage] = useState<{ total: number; perRun: Record<string, number> } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [menu, setMenu] = useState(false);
  const [plan, setPlan] = useState<Plan>(null);
  const [busy, setBusy] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  const refreshUsage = () => { void api.runsUsage().then(setUsage).catch(() => setUsage(null)); };
  useEffect(() => { void store().refreshRuns(); refreshUsage(); }, []);
  useEffect(() => { refreshUsage(); }, [runs.length]);
  useEffect(() => { setSel((s) => new Set([...s].filter((id) => runs.some((r) => r.id === id)))); }, [runs]);

  const size = (ids: string[]) => ids.reduce((n, id) => n + (usage?.perRun[id] ?? 0), 0);
  const askDelete = (title: string, ids: string[]) => { if (ids.length) setPlan({ title, body: `${ids.length} run${ids.length > 1 ? "s" : ""}`, ids, bytes: size(ids) }); };

  const older = (days: number) => runs.filter((r) => Date.now() - Date.parse(r.created_at) > days * 86_400_000).map((r) => r.id);
  const beyondLast = (n: number) => runs.slice(n).map((r) => r.id); // runs are newest first

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    try {
      // the server deletes the folder, the index row and any cached data, and cancels a run that is still going
      const r = await api.pruneRuns({ ids: plan.ids });
      const gone = new Set(r.deleted);
      const cur = store().runId;
      if (cur && gone.has(cur)) useStore.setState({ runId: null, run: null, results: null, resultsStale: false, selectedTrip: null, progress: null, logs: [], running: false });
      useStore.setState((s) => ({ compare: s.compare.filter((id) => !gone.has(id)) }));
      await store().refreshRuns(); refreshUsage();
      setSel(new Set());
      store().toast("info", `Deleted ${r.deleted.length} run${r.deleted.length === 1 ? "" : "s"}, freed ${fmtBytes(r.freedBytes)}`);
    } catch (e) { store().toast("error", (e as Error).message); }
    finally { setBusy(false); setPlan(null); }
  }

  const listRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const rowsTabStop = runs.some((r) => r.id === focusId) ? focusId : runs.find((r) => r.id === runId)?.id ?? runs[0]?.id;
  const onListKey = (ev: React.KeyboardEvent, i: number) => {
    if (ev.target !== ev.currentTarget) return;
    const act = navigateList(runs.length, i, ev.key);
    if (act) {
      ev.preventDefault();
      if (act.focus !== undefined) listRef.current?.querySelectorAll<HTMLElement>("[role='option']")[act.focus]?.focus();
      if (act.activate) selecting ? toggle(runs[i]!.id) : void store().selectRun(runs[i]!.id);
      return;
    }
    if (ev.key === "Delete" && !selecting) { ev.preventDefault(); askDelete(`Delete ${runs[i]!.strategy.replace(/^strategies\//, "").replace(/\.qkt$/, "")}`, [runs[i]!.id]); }
    else if (ev.key === " " && selecting) { ev.preventDefault(); toggle(runs[i]!.id); }
  };
  const selected = useMemo(() => [...sel], [sel]);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      <div className="side-head">
        <h2>Runs</h2>
        {compare.length >= 2 && <button className="btn sm" onClick={() => ui.openJournal("compare")}><GitCompare size={14} />Compare {compare.length}</button>}
        <Tip label="Refresh" side="bottom"><button className="btn ghost icon sm" aria-label="Refresh runs" onClick={() => { void store().refreshRuns(); refreshUsage(); }}><RefreshCw size={14} /></button></Tip>
      </div>

      <div className="runs-tools">
        <span className="disk" title="Disk used by the runs folder"><DiskIcon size={13} />{usage ? <b className="num">{fmtBytes(usage.total)}</b> : DASH}<span className="muted"> · {runs.length} run{runs.length === 1 ? "" : "s"}</span></span>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost" aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSel(new Set()); }}>{selecting ? "Done" : "Select"}</button>
        <button ref={menuBtn} className="btn sm" aria-haspopup="menu" aria-expanded={menu} disabled={!runs.length} onClick={() => setMenu(!menu)}>Clear<ChevronDown size={13} /></button>
        <Popover open={menu} onClose={() => setMenu(false)} anchor={menuBtn} align="end" width={250} label="Clear runs">
          <div className="menu" role="menu">
            {[7, 30].map((d) => <button key={d} role="menuitem" className="menu-item" disabled={!older(d).length} onClick={() => { setMenu(false); askDelete(`Delete runs older than ${d} days`, older(d)); }}>Older than {d} days<span className="muted">{older(d).length}</span></button>)}
            <button role="menuitem" className="menu-item" disabled={runs.length <= 10} onClick={() => { setMenu(false); askDelete("Keep the newest 10 runs", beyondLast(10)); }}>Keep the last 10<span className="muted">{Math.max(0, runs.length - 10)}</span></button>
            <button role="menuitem" className="menu-item" disabled={!runs.filter((r) => r.status !== "done").length} onClick={() => { setMenu(false); askDelete("Delete failed and cancelled runs", runs.filter((r) => r.status !== "done").map((r) => r.id)); }}>Failed and cancelled<span className="muted">{runs.filter((r) => r.status !== "done").length}</span></button>
            <div className="menu-sep" />
            <button role="menuitem" className="menu-item danger" onClick={() => { setMenu(false); askDelete("Delete all runs", runs.map((r) => r.id)); }}>Delete all runs<span className="muted">{runs.length}</span></button>
          </div>
        </Popover>
      </div>
      {selecting && (
        <div className="runs-bulk">
          <button className="btn sm ghost" onClick={() => setSel(new Set(sel.size === runs.length ? [] : runs.map((r) => r.id)))}>{sel.size === runs.length ? "None" : "All"}</button>
          <span className="muted grow">{sel.size} selected{sel.size ? ` · ${fmtBytes(size(selected))}` : ""}</span>
          <button className="btn sm danger" disabled={!sel.size} onClick={() => askDelete("Delete the selected runs", selected)}><Trash2 size={13} />Delete</button>
        </div>
      )}

      <div className="side-scroll">
        {runs.length === 0 && <div className="empty"><b>No runs yet.</b>Press Run (Ctrl+Enter). Every run is kept here with its charts and trades.</div>}
        {/* role="list", not "listbox": each row carries a checkbox and a delete button, and listbox's "option" role
            (like tablist's "tab") cannot have real focusable descendants. */}
        <div role="list" aria-label="Runs" ref={listRef}>
          {runs.map((r) => {
            const name = r.strategy.replace(/^strategies\//, "").replace(/\.qkt$/, "");
            const dot = r.status === "done" ? "ok" : r.status === "failed" ? "bad" : r.status === "cancelled" || r.status === "interrupted" ? "warn" : "run";
            return (
              <div key={r.id} role="listitem" aria-label={name} aria-current={r.id === runId || undefined} tabIndex={r.id === rowsTabStop ? 0 : -1} className="list-row" style={{ alignItems: "flex-start", padding: "var(--s2)" }}
                onFocus={(e) => { if (e.target === e.currentTarget) setFocusId(r.id); }}
                onClick={() => (selecting ? toggle(r.id) : void store().selectRun(r.id))} onKeyDown={(e) => onListKey(e, runs.indexOf(r))}>
                {selecting
                  ? <input type="checkbox" aria-label={`Select ${name} for deletion`} checked={sel.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} style={{ marginTop: 4 }} />
                  : <input type="checkbox" aria-label={`Compare ${name}`} disabled={r.status !== "done"} checked={compare.includes(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => store().toggleCompare(r.id)} style={{ marginTop: 4 }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 6 }}><span className={`dot ${dot}`} title={r.status} /><b style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</b><span className={`badge ${r.tier === "full" ? "accent" : ""}`}>{r.tier === "full" ? "Ticks" : "Bars"}</span>{r.kind === "portfolio" && <span className="badge" title={`Portfolio of ${r.members} strategies`}><Layers size={11} />{r.members}</span>}</div>
                  <div className="muted mono" style={{ fontSize: "var(--fs-xs)" }}>{r.from_d} → {r.to_d}</div>
                  <div className="row" style={{ gap: "var(--s3)", fontSize: "var(--fs-xs)" }}>
                    <span className={(r.total_pnl ?? 0) >= 0 ? "gain num" : "loss num"}>{r.total_pnl === null ? DASH : fmtMoney(r.total_pnl)}</span>
                    <span className="muted num">Sharpe {r.sharpe === null ? DASH : fmtRatio(r.sharpe)}</span>
                    <span className="muted num">{r.trades ?? DASH} trades</span>
                  </div>
                  <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{fmtTs(Date.parse(r.created_at))} UTC{usage?.perRun[r.id] !== undefined ? ` · ${fmtBytes(usage.perRun[r.id]!)}` : ""}</div>
                </div>
                {!selecting && (
                  <Tip label="Delete run and its files" side="left">
                    <button className="btn ghost icon sm" aria-label={`Delete run ${name}`} onClick={(e) => { e.stopPropagation(); askDelete(`Delete ${name}`, [r.id]); }}><Trash2 size={13} /></button>
                  </Tip>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Modal open={plan !== null} onClose={() => { if (!busy) setPlan(null); }} title={plan?.title ?? "Delete"} width={420}
        footer={<><button className="btn" disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button className="btn danger" data-autofocus disabled={busy} onClick={() => void confirm()}><Trash2 size={14} />{busy ? "Deleting…" : "Delete"}</button></>}>
        <p style={{ margin: 0 }}>This permanently deletes <b>{plan?.body}</b> and every file they wrote (trades, charts data, logs){plan?.bytes ? <>, freeing about <b>{fmtBytes(plan.bytes)}</b></> : null}. A run that is still going is stopped first. This cannot be undone.</p>
      </Modal>
    </>
  );
}
