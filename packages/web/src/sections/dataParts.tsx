import { useEffect, useState } from "react";
import type { Completeness, YearRow } from "../api/types.js";
import { api } from "../api/client.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";
import { addDays } from "../util/format.js";
import { tfMs } from "@qkt-studio/core/strategy";
import { yearChip } from "../util/datawindow.js";
import { CircleAlert, CircleCheck, CircleX, CloudDownload, Copy, Hammer } from "../ui/icons.js";
import { fetchLabel, fetchRequestFrom } from "../util/derivatives.js";

/** Pieces shared by the Data section, its readiness card and the symbol dialog. */

export const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
export const LABEL: Record<Completeness | "ticks-only", string> = { complete: "Complete", mostly: "Nearly complete", incomplete: "Incomplete", empty: "Empty", "ticks-only": "Ticks only" };
export const StatusIcon = ({ s, size = 14 }: { s: Completeness | "ticks-only"; size?: number }) =>
  s === "complete" ? <CircleCheck size={size} color="var(--ok)" aria-hidden="true" /> : s === "mostly" ? <CircleAlert size={size} color="var(--warn)" aria-hidden="true" />
    : s === "incomplete" ? <CircleX size={size} color="var(--danger)" aria-hidden="true" /> : <CircleAlert size={size} color="var(--ink-3)" aria-hidden="true" />;

/** One small cell per calendar year, toned by missing days: the shape of a symbol's history at a glance. The full chips
 *  with their numbers are in the symbol dialog. */
export function MiniYears({ years, first, last }: { years: YearRow[]; first: string | null; last: string | null }) {
  if (!years.length) return null;
  const chips = years.map((y) => yearChip(y, first, last));
  const bad = chips.filter((c) => c.tone === "bad" || c.tone === "warn").map((c) => c.year);
  return (
    <span className="miniyears" role="img" aria-label={`${years[0]!.year} to ${years.at(-1)!.year}${bad.length ? `, gaps in ${bad.join(", ")}` : ", no missing days"}`}>
      {chips.map((c) => <i key={c.year} className={`t-${c.tone}${c.partial ? " partial" : ""}`} title={c.title} />)}
    </span>
  );
}

/** Build bars from ticks. `symbol`/`tf` prefill it (a readiness fix names both); the range defaults to all the ticks. */
export function BuildForm({ open, onClose, anchor, symbol, tf: tf0 }: { open: boolean; onClose(): void; anchor: React.RefObject<HTMLElement | null>; symbol?: string; tf?: string }) {
  const scan = useStore((s) => s.scan), trackJob = useStore((s) => s.trackJob);
  const syms = (scan?.symbols ?? []).filter((s) => s.ticks);
  const [sym, setSym] = useState(symbol ?? "");
  const [tf, setTf] = useState(tf0 ?? "15m");
  useEffect(() => { if (open) { setSym(symbol ?? ""); setTf(tf0 ?? "15m"); setFrom(""); setTo(""); } }, [open, symbol, tf0]);
  const cur = syms.find((s) => s.symbol === (sym || symbol || syms[0]?.symbol));
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const f = from || cur?.ticks?.first || "", t = to || (cur?.ticks?.last ? addDays(cur.ticks.last, 1) : "");
  const tfs = TFS.includes(tf) ? TFS : [tf, ...TFS];
  // qkt reads the COARSEST built folder whose timeframe divides the strategy's (a 4h strategy on 30m bars when 30m is
  // the coarsest that divides 4h), whether or not that folder covers the window. A new, coarser folder therefore takes
  // over from the finer ones for every such strategy, with only the range built into it.
  const built = (cur?.bars ?? []).filter((b) => b.files > 0 && !b.qktReads).map((b) => b.tf);
  const ms = tfMs(tf);
  const finer = ms ? built.filter((b) => b !== tf && (tfMs(b) ?? 0) > 0 && ms % tfMs(b)! === 0).sort((a, b) => tfMs(b)! - tfMs(a)!) : [];
  const shadows = !built.includes(tf) && finer.length > 0;
  const go = async () => {
    if (!cur) return;
    try { const { jobId } = await api.buildBars({ symbol: cur.symbol, tf, from: f, to: t }); trackJob(jobId, `Build ${cur.symbol} ${tf} bars`); onClose(); }
    catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={320} label="Build bars">
      <div className="settings-sec">
        <h4>Build bars from ticks</h4>
        {syms.length === 0 ? <div className="hint">No symbol has tick files. Fetch ticks first, or point the data source at a folder that has <span className="mono">symbols/</span>.</div>
          : symbol && !cur ? <div className="hint">{symbol} has no tick files to build bars from. Fetch its ticks first.</div> : (
          <>
            <div className="field"><label htmlFor="bb-sym">Symbol</label><select id="bb-sym" className="select" value={cur?.symbol ?? ""} onChange={(e) => { setSym(e.target.value); setFrom(""); setTo(""); }}>{syms.map((s) => <option key={s.symbol}>{s.symbol}</option>)}</select></div>
            <div className="field"><label htmlFor="bb-tf">Timeframe</label><select id="bb-tf" className="select" value={tf} onChange={(e) => setTf(e.target.value)}>{tfs.map((x) => <option key={x}>{x}</option>)}</select></div>
            <div className="grid-2">
              <div className="field"><label htmlFor="bb-f">From</label><input id="bb-f" className="input" type="date" value={f} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="field"><label htmlFor="bb-t">To</label><input id="bb-t" className="input" type="date" value={t} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            {shadows && (
              <div className="banner warn" role="alert"><CircleAlert size={14} /><span>
                Probably not needed: qkt already makes {tf} candles from the {finer[0]} bars. Building a {tf} folder makes qkt read it
                instead of {finer[0]} for every strategy whose timeframe {tf} divides, and it only holds the days you build here, so
                windows outside them would stop running. To extend the data, build {finer.join(", ")} for the new days instead.
              </span></div>
            )}
            <div className="hint">
              Runs <span className="mono">qkt data build-bars</span> into <span className="mono">bars/BACKTEST/{cur?.symbol ?? "SYMBOL"}/{tf}/</span>, the folder qkt reads.
              It never overwrites: a day that already has a file is skipped, so this only fills days that have none. A day whose tick file
              holds no ticks gets no bars and stays missing. Stop interrupts it and removes any half-written file.
            </div>
            <button className="btn primary" onClick={() => void go()} disabled={!f || !t}><Hammer size={15} />Build {tf} bars</button>
          </>
        )}
      </div>
    </Popover>
  );
}

/** Fetch from a broker (`qkt fetch`). `symbol`/`tf` prefill it. */
export function FetchForm({ open, onClose, anchor, symbol, tf }: { open: boolean; onClose(): void; anchor: React.RefObject<HTMLElement | null>; symbol?: string; tf?: string }) {
  const trackJob = useStore((s) => s.trackJob);
  const [f, setF] = useState({ broker: "EXNESS", symbol: symbol ?? "", tf: tf ?? "1m", from: "", to: "" });
  useEffect(() => { if (open) setF((x) => ({ ...x, symbol: symbol ?? x.symbol, tf: tf ?? x.tf })); }, [open, symbol, tf]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const go = async () => {
    try { const { jobId } = await api.fetchData(f); trackJob(jobId, `Fetch ${f.broker}:${f.symbol}`); onClose(); }
    catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={320} label="Fetch data">
      <div className="settings-sec">
        <h4>Fetch from a broker</h4>
        <div className="grid-2">
          <div className="field"><label htmlFor="ft-b">Broker</label><input id="ft-b" className="input" value={f.broker} onChange={(e) => set("broker", e.target.value)} /></div>
          <div className="field"><label htmlFor="ft-s">Symbol</label><input id="ft-s" className="input" placeholder="XAUUSD" value={f.symbol} onChange={(e) => set("symbol", e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="ft-tf">Timeframe</label><select id="ft-tf" className="select" value={f.tf} onChange={(e) => set("tf", e.target.value)}>{(TFS.includes(f.tf) ? TFS : [f.tf, ...TFS]).map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="grid-2">
          <div className="field"><label htmlFor="ft-f">From</label><input id="ft-f" className="input" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></div>
          <div className="field"><label htmlFor="ft-t">To</label><input id="ft-t" className="input" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></div>
        </div>
        <div className="hint">Runs <span className="mono">qkt fetch</span>, which needs network access and credentials for that broker. Nothing is downloaded during a backtest.</div>
        <button className="btn primary" disabled={!f.symbol || !f.from || !f.to} onClick={() => void go()}><CloudDownload size={15} />Fetch</button>
      </div>
    </Popover>
  );
}

/**
 * The exact `qkt fetch ...` a blocked futures/options stream needs. Copy always; Run only when the command has no placeholder left, and
 * only on a click: a fetch uses the network, so the studio never starts one on its own.
 */
export function FixCommand({ command }: { command: string }) {
  const runFetch = useStore((s) => s.runFetch), jobs = useStore((s) => s.jobs);
  const req = fetchRequestFrom(command);
  const label = req ? fetchLabel(req) : "";
  const running = !!req && jobs.some((j) => j.status === "running" && j.label === label);
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return (
    <span className="fixcmd">
      <code className="mono fixcmd-text" title={command}>{command}</code>
      <span className="fixcmd-btns">
        <button className="btn ghost sm" onClick={copy} aria-label={`Copy: ${command}`}><Copy size={12} />{copied ? "Copied" : "Copy"}</button>
        {req ? <button className="btn sm" disabled={running} onClick={() => void runFetch(req)} title={`${label}. Uses the network; progress shows under Jobs.`}>
          {running ? <span className="spin" /> : <CloudDownload size={13} />}{running ? "Running…" : "Run it"}</button>
          : <span className="muted" title="Fill in the dates it asks for, then run it in a terminal">edit dates first</span>}
      </span>
    </span>
  );
}
