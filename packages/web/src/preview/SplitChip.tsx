import { useRef, useState } from "react";
import { api } from "../api/client.js";
import { useAgent } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";

const PRESETS: Array<{ label: string; split: Record<string, unknown> }> = [
  { label: "No split", split: { none: true } },
  { label: "Test = last 25 %", split: { test_pct: 25 } },
  { label: "Test = last 30 %", split: { test_pct: 30 } },
  { label: "Test = last 1 month", split: { test_last: "1 months" } },
  { label: "Test = last 3 months", split: { test_last: "3 months" } },
];

/** The user's split of every window into a first part and a test part: shown, and changed here or from the tools. */
export function SplitChip() {
  const split = useAgent((s) => s.split);
  const [open, setOpen] = useState(false), [from, setFrom] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const set = async (x: Record<string, unknown>) => {
    try { await api.setSplit(x); await useAgent.getState().refresh(); setOpen(false); } catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  return (
    <>
      <button ref={btn} className="chip" title="How each window is divided into a first part and a test part" onClick={() => setOpen(!open)}>Split: {split?.text ?? "…"}</button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={260} label="Split">
        <div className="settings-sec">
          {PRESETS.map((p) => <button key={p.label} className="btn sm ghost" style={{ justifyContent: "flex-start" }} onClick={() => void set(p.split)}>{p.label}</button>)}
          <div className="row" style={{ gap: 6 }}>
            <input className="input" type="date" aria-label="Test part starts on" value={from} onChange={(e) => setFrom(e.target.value)} />
            <button className="btn sm" disabled={!from} onClick={() => void set({ test_from: from })}>Set</button>
          </div>
        </div>
      </Popover>
    </>
  );
}
