import { useRef, useState } from "react";
import { ChevronDown as Down, ChevronLeft, ChevronRight, ChevronUp as Up, Columns2, Crosshair, Eye, GripVertical, LayoutGrid, Layers, Plus, Rows2, SkipBack, Maximize, X } from "lucide-react";
import type { ChartLayout, ChartTab } from "../state/chartPrefs.js";
import { Popover } from "../ui/Popover.js";
import { Tip } from "../ui/Tip.js";
import { keyOf, type Stream } from "./streams.js";

interface Props {
  streams: Stream[]; hidden: string[]; layout: ChartLayout; follow: boolean; tab: ChartTab; activeKey: string | null;
  addable: Stream[]; extra: Stream[]; count: number; total: number; index: number; truncated: boolean;
  onToggle(k: string): void; onMove(k: string, toIndex: number): void; onLayout(l: ChartLayout): void; onFollow(v: boolean): void; onTab(t: ChartTab): void;
  onActive(k: string): void; onAdd(s: Stream): void; onRemoveExtra(k: string): void; onPrev(): void; onNext(): void; onFirst(): void; onFit(): void;
}

const LAYOUTS: Array<{ id: ChartLayout; label: string; icon: typeof Rows2 }> = [
  { id: "stack", label: "Stacked", icon: Rows2 }, { id: "grid", label: "Two across", icon: LayoutGrid }, { id: "tabs", label: "One at a time", icon: Layers },
];

/** Everything about which charts are shown and how the view moves, in one row above the charts. */
export function ChartToolbar(p: Props) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const shownCount = p.streams.length - p.hidden.filter((h) => p.streams.some((s) => keyOf(s) === h)).length;
  const isChart = p.tab === "chart";

  return (
    <div className="chart-toolbar" role="toolbar" aria-label="Chart controls">
      <div className="seg sm" role="group" aria-label="Show">
        <button aria-pressed={isChart} onClick={() => p.onTab("chart")}>Chart</button>
        <button aria-pressed={!isChart} onClick={() => p.onTab("trades")}>Trades <span className="num muted">{p.count.toLocaleString()}</span></button>
      </div>
      {isChart && (
        <>
          <button ref={btn} className="btn sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Eye size={14} />Charts <span className="num muted">{shownCount}/{p.streams.length}</span><Down size={13} />
          </button>
          <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label="Charts to show" width={300}>
            <div className="chart-menu">
              <div className="hint">Layout</div>
              <div className="seg sm" role="group" aria-label="Chart layout" style={{ marginBottom: 10 }}>
                {LAYOUTS.map(({ id, label, icon: Icon }) => <button key={id} aria-pressed={p.layout === id} onClick={() => p.onLayout(id)}><Icon size={14} />{label}</button>)}
              </div>
              <div className="hint">Tick to show or hide. Drag the handle, or use the arrows, to reorder.</div>
              <ul>
                {p.streams.map((s, i) => {
                  const k = keyOf(s), on = !p.hidden.includes(k), isExtra = p.extra.some((x) => keyOf(x) === k);
                  return (
                    <li key={k} className={`${drag === k ? "dragging" : ""}${over === i && drag && drag !== k ? " over" : ""}`} draggable
                      onDragStart={(e) => { setDrag(k); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); }}
                      onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragEnd={() => { setDrag(null); setOver(null); }}
                      onDrop={(e) => { e.preventDefault(); if (drag) p.onMove(drag, i); setDrag(null); setOver(null); }}>
                      <span className="grip" aria-hidden="true"><GripVertical size={14} /></span>
                      <label className="grow"><input type="checkbox" checked={on} onChange={() => p.onToggle(k)} /><b>{s.symbol}</b> <span className="ink2">{s.tf}</span> <span className="muted">{s.broker}</span></label>
                      <button className="btn ghost icon sm" aria-label={`Move ${s.symbol} ${s.tf} up`} disabled={i === 0} onClick={() => p.onMove(k, i - 1)}><Up size={13} /></button>
                      <button className="btn ghost icon sm" aria-label={`Move ${s.symbol} ${s.tf} down`} disabled={i === p.streams.length - 1} onClick={() => p.onMove(k, i + 1)}><Down size={13} /></button>
                      {isExtra && <button className="btn ghost icon sm" aria-label={`Remove ${s.symbol} ${s.tf}`} onClick={() => p.onRemoveExtra(k)}><X size={13} /></button>}
                    </li>
                  );
                })}
              </ul>
              {p.addable.length > 0 && (
                <>
                  <div className="hint" style={{ marginTop: 8 }}>Add another timeframe of these symbols</div>
                  <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                    {p.addable.map((s) => <button key={keyOf(s)} className="btn sm" onClick={() => p.onAdd(s)}><Plus size={12} />{s.symbol} {s.tf}</button>)}
                  </div>
                </>
              )}
              {p.hidden.length > 0 && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => p.hidden.forEach((h) => p.onToggle(h))}><Eye size={13} />Show all</button>}
            </div>
          </Popover>
          {p.layout === "tabs" && (
            <div className="seg sm chart-tabs" role="tablist" aria-label="Charts">
              {p.streams.filter((s) => !p.hidden.includes(keyOf(s))).map((s) => <button key={keyOf(s)} role="tab" aria-selected={p.activeKey === keyOf(s)} aria-pressed={p.activeKey === keyOf(s)} onClick={() => p.onActive(keyOf(s))}>{s.symbol} {s.tf}</button>)}
            </div>
          )}
          <div className="row" role="group" aria-label="View" style={{ gap: 2 }}>
            <Tip label="Zoom to the first trades of the run" side="bottom"><button className="btn ghost icon sm" aria-label="Zoom to the first trades" onClick={p.onFirst}><SkipBack size={15} /></button></Tip>
            <Tip label="Fit the whole run in view" side="bottom"><button className="btn ghost icon sm" aria-label="Fit the whole run" onClick={p.onFit}><Maximize size={15} /></button></Tip>
            <Tip label={p.follow ? "Following: selecting a trade moves the chart to it (click to stop)" : "Follow the selected trade: move the chart to it"} side="bottom"><button className="btn ghost icon sm" aria-label="Follow the selected trade" aria-pressed={p.follow} onClick={() => p.onFollow(!p.follow)}><Crosshair size={15} /></button></Tip>
          </div>
        </>
      )}
      <span className="grow" />
      <div className="stepper" role="group" aria-label="Step through trades">
        <Tip label="Previous trade" kbd="←" side="bottom"><button className="btn ghost icon sm" aria-label="Previous trade" disabled={p.count === 0 || p.index === 0} onClick={p.onPrev}><ChevronLeft size={16} /></button></Tip>
        <span className="num step-count" aria-live="polite">{p.index >= 0 ? `Trade ${(p.index + 1).toLocaleString()} of ${p.count.toLocaleString()}` : `${p.count.toLocaleString()} trade${p.count === 1 ? "" : "s"}`}{p.truncated ? "+" : ""}</span>
        <Tip label={p.index >= 0 ? "Go to the next trade" : "Start at the first trade"} kbd="→" side="bottom"><button className="btn ghost icon sm" aria-label={p.index >= 0 ? "Next trade" : "Start at the first trade"} disabled={p.count === 0 || p.index === p.count - 1} onClick={p.onNext}><ChevronRight size={16} /></button></Tip>
      </div>
    </div>
  );
}
