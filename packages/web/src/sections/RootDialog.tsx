import { useMemo, useState } from "react";
import type { FutureTerms, OptionTerms } from "@qkt-studio/core/instruments";
import type { ContractReport, FutureRootReport, OptionRootReport, SeriesReport } from "../api/types.js";
import { useStore } from "../state/store.js";
import { Modal } from "../ui/Modal.js";
import { CircleAlert, CircleCheck, FileCog, TriangleAlert } from "../ui/icons.js";
import { closedDaysFor, commandsIn, differenceNote, readsRoot, termsFor } from "../util/derivatives.js";
import { fmtNum } from "../util/format.js";
import { FixCommand } from "./dataParts.js";
import { Heatmap } from "./SymbolDialog.js";

const noop = () => undefined;
const NO_SEL = { from: "", to: "" };
const range = (a: string | null | undefined, b: string | null | undefined) => (a ? `${a} → ${b ?? ""}` : "none stored");

/** `label  value` rows: the terms and series of a root, read-only. */
function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return <dl className="rd-facts">{rows.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>)}</dl>;
}

const seriesRow = (s: SeriesReport | null | undefined): React.ReactNode => (s ? <>{range(s.first, s.last)} <span className="muted">· {s.files.toLocaleString()} file{s.files === 1 ? "" : "s"}</span></> : <span className="muted">none stored</span>);

/** Contracts newest first, each with the timeframes built for it; a click opens the day-by-day calendar of one of them. */
function Contracts({ root }: { root: FutureRootReport }) {
  const [open, setOpen] = useState<string | null>(null), [tf, setTf] = useState<string | null>(null), [all, setAll] = useState(false);
  const closed = useMemo(() => closedDaysFor(root.root, root.terms?.calendar), [root.root, root.terms?.calendar]);
  const list = useMemo(() => [...root.contracts].sort((a, b) => (b.expiry ?? "").localeCompare(a.expiry ?? "")), [root.contracts]);
  const shown = all ? list : list.slice(0, 24);
  const pick = (c: ContractReport) => { const next = open === c.symbol ? null : c.symbol; setOpen(next); setTf(next ? c.bars.find((b) => b.files > 0)?.tf ?? null : null); };
  return (
    <section className="sd-sec">
      <h3>Contracts <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· newest first, bars built per timeframe</span></h3>
      <div className="tbl-scroll"><table className="tbl sd-tbl">
        <thead><tr><th>Contract</th><th>Expiry</th><th>Bars</th><th className="r">Delivery price</th></tr></thead>
        <tbody>
          {shown.map((c) => {
            const built = c.bars.filter((b) => b.files > 0), sel = open === c.symbol;
            return (
              <FragmentRow key={c.symbol} sel={sel} onPick={() => pick(c)} c={c} built={built}>
                {sel && tf && (
                  <tr><td colSpan={4} className="rd-cal">
                    <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                      <div className="seg sm" role="group" aria-label={`${c.symbol} timeframe`}>{built.map((b) => <button key={b.tf} aria-pressed={tf === b.tf} onClick={() => setTf(b.tf)}>{b.tf}</button>)}</div>
                      <span className="muted num">{range(built.find((b) => b.tf === tf)?.first, built.find((b) => b.tf === tf)?.last)}</span>
                    </div>
                    <div className="legend" aria-hidden="true"><span><i className="hc s-o" />ok</span><span><i className="hc s-c" />closed</span><span><i className="hc s-t" />thin</span><span><i className="hc s-m" />missing</span></div>
                    <Heatmap symbol={c.symbol} kind={`${root.venue}:${tf}`} onPick={noop} sel={NO_SEL} remap={closed} />
                  </td></tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table></div>
      {list.length > shown.length && <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setAll(true)}>Show all {list.length}</button>}
    </section>
  );
}

function FragmentRow({ c, built, sel, onPick, children }: { c: ContractReport; built: ContractReport["bars"]; sel: boolean; onPick(): void; children: React.ReactNode }) {
  return (
    <>
      <tr className="click" aria-selected={sel} tabIndex={0} onClick={built.length ? onPick : undefined} onKeyDown={(e) => { if (e.key === "Enter" && built.length) onPick(); }}>
        <td><b>{c.symbol}</b></td>
        <td className="num">{c.expiry ?? "?"}</td>
        <td>{built.length ? <span className="sl-tfs">{built.map((b) => <span key={b.tf} title={`${b.tf}: ${range(b.first, b.last)}, ${b.files} files`}>{b.tf}</span>)}</span> : <span className="muted">no bars</span>}</td>
        <td className="r num">{c.deliveryPrice ?? <span className="muted">not yet</span>}</td>
      </tr>
      {children}
    </>
  );
}

function Notes({ notes }: { notes: string[] }) {
  return <>{notes.map((n, i) => (
    <div key={i} className="banner warn" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div className="row"><CircleAlert size={14} color="var(--warn)" /><span>{n.replace(/`qkt fetch [^`]+`/g, "").replace(/\s+:\s*$/, "").replace(/:\s*\.?$/, "").trim()}</span></div>
      {commandsIn(n).map((c) => <FixCommand key={c} command={c} />)}
    </div>
  ))}</>;
}

function FutureBody({ root }: { root: FutureRootReport }) {
  const { terms, source, differs } = termsFor(useStore((s) => s.instruments), root.key);
  const t = terms as FutureTerms | null;
  return (
    <>
      <Notes notes={root.notes} />
      <section className="sd-sec">
        <h3>What is stored</h3>
        <Facts rows={[
          ["Catalog", root.catalog ? <>{root.catalog.contracts} contracts · expiries {range(root.catalog.first, root.catalog.last)} <span className="muted">· {root.catalog.delivered} delivered</span></> : <span className="muted">none: qkt fetch {root.key} --catalog</span>],
          ["Rolls", root.rolls ? <>{root.rolls.count} measured{root.rolls.policy ? <span className="muted"> · policy {root.rolls.policy}</span> : null} · {range(root.rolls.first, root.rolls.last)}</> : <span className="muted">not measured (a continuous stream needs them)</span>],
          ...(root.perpetual ? [
            ["Perpetual", <b key="n">{root.perpetual.name}</b>] as [string, React.ReactNode],
            ["Funding", seriesRow(root.perpetual.funding)] as [string, React.ReactNode],
            ["Open interest", seriesRow(root.perpetual.openInterest)] as [string, React.ReactNode],
            ...root.perpetual.marks.map((m) => [`Marks ${m.tf}`, seriesRow(m)] as [string, React.ReactNode]),
          ] : []),
        ]} />
      </section>
      <section className="sd-sec">
        <TermsHead source={source} differs={differs} />
        {t ? (
          <Facts rows={[
            ["Multiplier", t.multiplier], ["Tick size", t.tickSize], ["Lot step / min", t.volumeStep !== undefined ? `${t.volumeStep} / ${t.volumeMin ?? "?"}` : undefined], ["Currency", t.currency], ["Calendar", t.calendar],
            ["Taker fee", t.takerFeeRate !== undefined ? `${fmtNum(t.takerFeeRate * 100, 4)}% of notional` : undefined],
            ["Exchange fee", t.exchangeFeePerContract !== undefined ? `${t.exchangeFeePerContract} per contract per fill` : undefined],
            ["Margin", t.margin ? `initial ${t.margin.initial ?? "?"} · maintenance ${t.margin.maintenance ?? "?"} · ${t.margin.basis ?? ""}` : undefined],
            ["Roll", t.roll ? `${t.roll.daysBeforeExpiry ?? "?"} days before expiry at ${t.roll.atUtc ?? "?"} UTC · ${t.roll.adjust ?? ""}` : undefined],
            ["Expiry guard", t.expiryGuardHours !== undefined ? `${t.expiryGuardHours} h` : undefined],
          ]} />
        ) : <div className="muted">This root has no <span className="mono">futures:</span> entry.</div>}
        <OpenInstruments />
      </section>
      {root.contracts.length > 0 && <Contracts root={root} />}
    </>
  );
}

function OptionBody({ root }: { root: OptionRootReport }) {
  const { terms, source, differs } = termsFor(useStore((s) => s.instruments), root.key);
  const t = terms as OptionTerms | null;
  return (
    <>
      <Notes notes={root.notes} />
      <section className="sd-sec">
        <h3>What is stored</h3>
        <Facts rows={[
          ["Catalog", root.catalog ? <>{root.catalog.contracts} contracts · {range(root.catalog.first, root.catalog.last)}</> : <span className="muted">none: qkt fetch {root.key} --catalog</span>],
          ["Trade chains", seriesRow(root.chains.trade)], ["Book chains", seriesRow(root.chains.book)],
        ]} />
      </section>
      <section className="sd-sec">
        <TermsHead source={source} differs={differs} />
        {t ? (
          <Facts rows={[
            ["Contract size", t.contractSize], ["Tick size", t.tickSize], ["Lot step / min", t.volumeStep !== undefined ? `${t.volumeStep} / ${t.volumeMin ?? "?"}` : undefined], ["Currency", t.currency],
            ["Underlying index", t.underlyingIndex], ["Chains traded", t.chains], ["Max quote age", t.maxQuoteAgeMinutes !== undefined ? `${t.maxQuoteAgeMinutes} min` : undefined],
            ["Taker fee", t.takerFeeRate !== undefined ? `${fmtNum(t.takerFeeRate * 100, 4)}% of the index` : undefined],
          ]} />
        ) : <div className="muted">This root has no <span className="mono">options:</span> entry.</div>}
        <OpenInstruments />
      </section>
    </>
  );
}

/** Which file the terms below come from (the one the next run uses) and, when the other file disagrees, where. */
function TermsHead({ source, differs }: { source: "workspace" | "dataRoot" | "none"; differs: string[] }) {
  const from = source === "workspace" ? "the workspace's instruments.yaml" : source === "dataRoot" ? "the data source's instruments.yaml (the workspace has none)" : "no instruments.yaml";
  const note = differenceNote(source, differs);
  return (
    <>
      <h3>Terms <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· used by the next run, from {from}</span></h3>
      {note && <div className="banner warn" role="status"><CircleAlert size={14} color="var(--warn)" /><span>{note}</span></div>}
    </>
  );
}

/** The terms shown are the ones a run uses; this is where to change them. */
function OpenInstruments() {
  const openFile = useStore((s) => s.openFile), close = useStore((s) => s.openRoot);
  return <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => { void openFile("instruments.yaml", true); close(null); }}><FileCog size={13} />Open instruments.yaml</button>;
}

export function RootDialog() {
  const key = useStore((s) => s.rootDialog), close = useStore((s) => s.openRoot), scan = useStore((s) => s.scan), readiness = useStore((s) => s.readiness), openFile = useStore((s) => s.openFile);
  const fut = scan?.derivatives?.futures.find((r) => r.key === key), opt = scan?.derivatives?.options.find((r) => r.key === key);
  const root = fut ?? opt;
  const users = root ? readiness.filter((r) => r.streams.some((s) => readsRoot(s, { venue: root.venue, root: root.root, contracts: fut?.contracts, perpetual: fut?.perpetual }))) : [];
  return (
    <Modal open={!!root} onClose={() => close(null)} title={root ? `${root.key} · ${fut ? "futures" : "options"}` : "Root"} width={860} footer={<button className="btn" onClick={() => close(null)}>Close</button>}>
      {root && (
        <>
          <div className="sd-head">
            <span className="badge accent">{fut ? (fut.perpetual ? "futures + perpetual" : "futures") : "options"}</span>
            <span className="row" style={{ gap: 6 }}>{root.notes.length ? <CircleAlert size={14} color="var(--warn)" /> : <CircleCheck size={14} color="var(--ok)" />}<b>{root.notes.length ? "Needs attention" : "Ready"}</b></span>
          </div>
          {scan?.derivatives?.instruments.errors.length ? <div className="banner bad" role="alert"><TriangleAlert size={14} /><span>instruments.yaml: {scan.derivatives.instruments.errors[0]}</span></div> : null}
          {fut ? <FutureBody root={fut} /> : opt ? <OptionBody root={opt} /> : null}
          <section className="sd-sec">
            <h3>Strategies that read {root.root}</h3>
            {users.length === 0 ? <div className="muted">No strategy in the workspace reads it.</div> : users.map((r) => (
              <div key={r.strategy} className="sd-strat"><button className="link" onClick={() => { void openFile(r.strategy); close(null); }}>{r.strategy.replace(/^strategies\//, "")}</button></div>
            ))}
          </section>
        </>
      )}
    </Modal>
  );
}
