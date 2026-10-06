import { useMemo, useRef, useState } from "react";
import { rangeDays } from "@qkt-studio/core/ranges";
import { barBases } from "@qkt-studio/core/strategy";
import type { ModeReadiness, Readiness } from "../api/types.js";
import { useStore } from "../state/store.js";
import { addDays } from "../util/format.js";
import { ChevronRight, CircleAlert, CircleCheck, CircleX, CloudDownload, Hammer } from "../ui/icons.js";
import { BuildForm, FetchForm, FixCommand } from "./dataParts.js";
import { kindShort, kindTitle, rootKeyFor, shownTier, showKind, tierRule } from "../util/derivatives.js";

const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** A day range with an exclusive end, as the inclusive dates it covers. */
const fmtRange = (r: { from: string; to: string }) => `${fmtDay(r.from)} → ${fmtDay(addDays(r.to, -1))}`;
const years = (r: { from: string; to: string }) => { const d = rangeDays(r); return d >= 365 ? `${(d / 365.25).toFixed(1)} years` : `${d} days`; };

type Fix = { kind: "build" | "fetch"; symbol: string; tf: string } | null;

/**
 * The first thing the Data section answers: can the strategy in the editor run on the data here, over which dates, and
 * if not, what exactly to do. Follows the top bar's Bars/Ticks choice; the other mode is one line below it.
 */
export function ReadinessCard() {
  const activePath = useStore((s) => s.activePath), readiness = useStore((s) => s.readiness), scan = useStore((s) => s.scan);
  const cfg = useStore((s) => s.cfg), setCfg = useStore((s) => s.setCfg), openSymbol = useStore((s) => s.openSymbol), openRoot = useStore((s) => s.openRoot);
  const [fix, setFix] = useState<Fix>(null);
  const fixAnchor = useRef<HTMLElement | null>(null);
  const r = readiness.find((x) => x.strategy === activePath);
  // the tier the run will use: an option strategy runs on ticks and a continuous future on bars, whatever was saved
  const onBars = (r ? shownTier(cfg.tier, r.streams) : cfg.tier) !== "full";

  // which bar folder each stream is read from (qkt aggregates a coarser stream from a finer built one)
  const bases = useMemo(() => {
    if (!r || !scan) return new Map<string, string | null>();
    const bySym = new Map(scan.symbols.map((s) => [s.symbol, s]));
    return barBases(r.streams, (broker, symbol) => bySym.get(symbol)?.bars.filter((b) => b.broker === broker && b.files > 0 && !b.qktReads).map((b) => b.tf) ?? []);
  }, [r, scan]);

  if (!activePath?.endsWith(".qkt")) return <OtherStrategies open heading="Open a strategy to see what it can run on" />;
  if (!r) return <div className="ready-card"><span className="spin" /> Checking {activePath.split("/").pop()} against the data…</div>;

  const m: ModeReadiness = onBars ? r.bars : r.ticks, other: ModeReadiness = onBars ? r.ticks : r.bars;
  // continuous futures have no ticks and option chains no bars: say so here, and offer the other tier, instead of a refused run
  const tierRules = tierRule(r.streams), tierBad = onBars ? tierRules.draft : tierRules.full, otherRefused = onBars ? tierRules.full : tierRules.draft;
  const win = { from: cfg.from, to: cfg.to };
  const fits = !!win.from && !!win.to && m.ranges.some((x) => x.from <= win.from && x.to >= win.to);
  const isLongest = !!m.longest && m.longest.from === win.from && m.longest.to === win.to;
  const blockedBy = (label: string) => m.blocked.find((b) => b.stream === label);
  const openFix = (e: React.MouseEvent<HTMLElement>, f: Fix) => { fixAnchor.current = e.currentTarget; setFix(f); };
  const symRep = (symbol: string) => scan?.symbols.find((x) => x.symbol === symbol);
  const hasTicks = (symbol: string) => !!symRep(symbol)?.ticks;
  /** A folder holding this stream's bars under a name qkt does not read (1440m for 1d): the fix is a rename. */
  const unread = (st: { broker: string; symbol: string; tf: string }) => symRep(st.symbol)?.bars.find((x) => x.broker === st.broker && x.files > 0 && x.qktReads === st.tf);

  return (
    <>
      <section className={`ready-card ${m.runnable ? "ok" : "bad"}`} aria-label={`What ${activePath.split("/").pop()} can run on`}>
        <div className="rc-head">
          <b className="rc-name" title={activePath}>{activePath.split("/").pop()}</b>
          <span className="muted">on {onBars ? "bars" : "ticks"}</span>
        </div>
        {m.runnable && m.longest ? (
          <>
            <div className="rc-verdict"><CircleCheck size={16} color="var(--ok)" aria-hidden="true" />
              <span>Ready on {onBars ? "bars" : "ticks"}{m.ranges.length > 1 ? <span className="muted"> · {m.ranges.length} complete stretches</span> : null}</span></div>
            <div className="rc-note">{m.ranges.length > 1 ? "Longest" : "Complete"}: <b className="num">{fmtRange(m.longest)}</b> <span className="muted">· {years(m.longest)}</span></div>
            <div className="rc-window">
              {fits ? <span className="rc-fit"><CircleCheck size={13} color="var(--ok)" aria-hidden="true" />Your window {fmtRange(win)} is complete</span>
                : <span className="rc-fit warn"><CircleAlert size={13} color="var(--warn)" aria-hidden="true" />{win.from && win.to ? <>Your window {fmtRange(win)} is not fully covered</> : "No window set"}</span>}
              {!isLongest && <button className="btn sm" onClick={() => setCfg({ from: m.longest!.from, to: m.longest!.to })}>Use the {m.ranges.length > 1 ? "longest" : "complete"} stretch</button>}
            </div>
          </>
        ) : (
          <div className="rc-verdict"><CircleX size={16} color="var(--danger)" aria-hidden="true" />
            <span>{m.blocked.length ? `Can't run on ${onBars ? "bars" : "ticks"} yet` : `No stretch where every symbol it reads is complete on ${onBars ? "bars" : "ticks"}`}</span></div>
        )}

        {tierBad && (
          <div className="rc-tier" role="status">
            <CircleAlert size={13} color="var(--warn)" aria-hidden="true" />
            <span className="ink2">{tierBad}</span>
            {!tierRules[onBars ? "full" : "draft"] && <button className="btn sm" onClick={() => setCfg({ tier: onBars ? "full" : "draft" })}>Use {onBars ? "ticks" : "bars"}</button>}
          </div>
        )}
        {r.needsAllowIncomplete && <div className="rc-note muted">Continuous streams are checked contract by contract here: qkt's own coverage check cannot see them, so the run passes <span className="mono">--allow-incomplete</span>.</div>}

        <ul className="rc-streams" aria-label="Streams it reads">
          {r.streams.map((s) => {
            const label = `${s.broker}:${s.symbol} ${s.tf}`, b = blockedBy(label);
            const kind = r.kinds?.[s.alias], rootKey = showKind(kind) ? rootKeyFor(s, scan?.derivatives) : null;
            const base = onBars ? bases.get(`${s.broker}:${s.symbol}`) : null;
            return (
              <li key={label} className={b ? "bad" : ""}>
                <button className="rc-stream" onClick={() => (rootKey ? openRoot(rootKey) : openSymbol(s.symbol))} aria-label={`${s.symbol} ${s.tf}: ${b ? b.reason : "ready"}. Open ${rootKey ?? s.symbol} data`}>
                  {b ? <CircleX size={13} color="var(--danger)" aria-hidden="true" /> : <CircleCheck size={13} color="var(--ok)" aria-hidden="true" />}
                  <b>{s.symbol}</b><span className="ink2">{s.tf}</span>
                  {showKind(kind) && <span className="badge rc-kind" title={kindTitle(kind)}>{kindShort(kind)}</span>}
                  {base && base !== s.tf && <span className="muted" title={`No ${s.tf} folder is built: qkt aggregates ${s.tf} from the ${base} bars, and so does the chart`}>from {base}</span>}
                  <span className="grow" /><ChevronRight size={13} className="muted" aria-hidden="true" />
                </button>
                {b && (
                  <div className="rc-fix">
                    {!unread(s) && <span className="ink2">{b.reason}</span>}
                    {b.members?.length ? <span className="muted">used by {b.members.join(", ")}</span> : null}
                    {b.command && <FixCommand command={b.command} />}
                    {!b.command && unread(s) ? <span className="rc-cmd">qkt looks for a folder named <span className="mono">{unread(s)!.qktReads}</span>. Rename <span className="mono">bars/{s.broker}/{s.symbol}/{unread(s)!.tf}</span> to <span className="mono">{unread(s)!.qktReads}</span> in the data folder, then rescan.</span>
                      : !b.command && b.fix === "build-bars" && hasTicks(s.symbol) && <button className="btn sm" onClick={(e) => openFix(e, { kind: "build", symbol: s.symbol, tf: s.tf })}><Hammer size={13} />Build {s.tf} bars</button>}
                    {!b.command && b.fix === "fetch" && <button className="btn sm" onClick={(e) => openFix(e, { kind: "fetch", symbol: s.symbol, tf: s.tf })}><CloudDownload size={13} />Fetch {s.symbol}</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {r.members && r.members.length > 0 && (
          <div className="rc-members">
            <span className="muted">Members:</span>
            {r.members.map((x) => { const ok = onBars ? x.bars : x.ticks; return (
              <span key={x.alias} className={`badge ${ok ? "ok" : "bad"}`} title={!x.exists ? `${x.rel ?? x.alias} is missing` : ok ? `${x.alias} can run on its own` : `${x.alias} cannot run on its own on ${onBars ? "bars" : "ticks"}`}>
                {ok ? <CircleCheck size={11} aria-hidden="true" /> : <CircleX size={11} aria-hidden="true" />}{x.alias}</span>); })}
          </div>
        )}

        <div className="rc-other">
          <span className="muted">On {onBars ? "ticks" : "bars"}:</span>{" "}
          {otherRefused ? <span className="ink2">{otherRefused}</span>
            : other.runnable && other.longest ? <span className="ink2">runs {fmtRange(other.longest)}</span>
            : <span className="ink2">{other.blocked[0] ? `${other.blocked[0].stream.split(" ")[0]!.split(":").pop()}: ${other.blocked[0].reason}${other.blocked.length > 1 ? ` (+${other.blocked.length - 1} more)` : ""}` : "no complete stretch"}</span>}
          {!otherRefused && <button className="btn ghost sm" onClick={() => setCfg({ tier: onBars ? "full" : "draft" })}>Switch to {onBars ? "ticks" : "bars"}</button>}
        </div>
      </section>
      <BuildForm open={fix?.kind === "build"} onClose={() => setFix(null)} anchor={fixAnchor} symbol={fix?.symbol} tf={fix?.tf} />
      <FetchForm open={fix?.kind === "fetch"} onClose={() => setFix(null)} anchor={fixAnchor} symbol={fix?.symbol} tf={fix?.tf} />
      <OtherStrategies />
    </>
  );
}

/** Every other strategy in the workspace with what it can run on: collapsed, since the open one is what matters. */
function OtherStrategies({ open: open0 = false, heading }: { open?: boolean; heading?: string }) {
  const readiness = useStore((s) => s.readiness), activePath = useStore((s) => s.activePath), cfg = useStore((s) => s.cfg), setCfg = useStore((s) => s.setCfg);
  const [open, setOpen] = useState(open0);
  const others = readiness.filter((x) => x.strategy !== activePath);
  if (!others.length) return heading ? <div className="ready-card muted">{heading}.</div> : null;
  const pick = (x: Readiness) => {
    const m = shownTier(cfg.tier, x.streams) === "full" ? x.ticks : x.bars;
    void useStore.getState().openFile(x.strategy);
    if (m.longest) setCfg({ from: m.longest.from, to: m.longest.to });
  };
  return (
    <div className="rc-others">
      {heading && <div className="muted rc-note" style={{ marginBottom: 4 }}>{heading}:</div>}
      <button className="btn ghost sm rc-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : undefined }} aria-hidden="true" />{heading ? "Strategies" : "Other strategies"} <span className="muted">{others.length}</span></button>
      {open && (
        <ul aria-label="Strategies and what they can run on">
          {others.map((x) => (
            <li key={x.strategy}>
              <button className="rc-stream" onClick={() => pick(x)} title="Open it and use its longest complete window">
                <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.strategy.replace(/^strategies\//, "")}</span>
                {(["bars", "ticks"] as const).map((k) => <span key={k} className={`badge ${x[k].runnable ? "ok" : "bad"}`} aria-label={`${k}: ${x[k].runnable ? "runs" : "cannot run"}`}>
                  {x[k].runnable ? <CircleCheck size={11} aria-hidden="true" /> : <CircleX size={11} aria-hidden="true" />}{k === "bars" ? "Bars" : "Ticks"}</span>)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
