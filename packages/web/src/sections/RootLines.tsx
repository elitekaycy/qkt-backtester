import { useMemo } from "react";
import { parseStrategyInfo } from "@qkt-studio/core/strategy";
import { useStore } from "../state/store.js";
import { CircleAlert, CircleCheck, CircleX } from "../ui/icons.js";
import { futureRootLine, optionRootLine, readsRoot, type RootLine } from "../util/derivatives.js";
import { RootDialog } from "./RootDialog.js";

const Status = ({ s }: { s: RootLine["status"] }) => s === "ok" ? <CircleCheck size={14} color="var(--ok)" aria-hidden="true" /> : s === "warn" ? <CircleAlert size={14} color="var(--warn)" aria-hidden="true" /> : <CircleX size={14} color="var(--danger)" aria-hidden="true" />;

function Line({ line, used, kind }: { line: RootLine; used: boolean; kind: string }) {
  return (
    <div role="listitem">
      <button className={`symline${line.attention ? " attn" : ""}`} aria-haspopup="dialog" data-root={line.key}
        aria-label={`${line.title}: ${kind}${line.attention ? `, ${line.attention}` : ""}${used ? ", used by the open strategy" : ""}. Open details`}
        onClick={() => useStore.getState().openRoot(line.key)}>
        <span className="sl-top">
          <Status s={line.status} />
          <b>{line.title}</b>
          <span className="badge" title={kind === "futures" ? "A futures root: its contracts, rolls and perpetual" : "An options root: its catalog and stored chains"}>{kind}</span>
          {used && <span className="badge accent" title="The open strategy reads this root">used</span>}
        </span>
        <span className="sl-bottom"><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{line.facts.join(" · ")}</span></span>
        {line.attention && <span className={`sl-why ${line.status === "bad" ? "bad" : "warn"}`}>{line.attention.replace(/`/g, "").replace(/:\s*(qkt fetch .*)$/, "")}</span>}
      </button>
    </div>
  );
}

/**
 * Futures and options roots the data source holds, shown under the symbols in the same form. A CFD-only source has no
 * `derivatives` in its scan, so nothing at all is rendered for it.
 */
export function RootLines() {
  const d = useStore((s) => s.scan?.derivatives), readiness = useStore((s) => s.readiness), activePath = useStore((s) => s.activePath), openFiles = useStore((s) => s.openFiles);
  const streams = useMemo(() => {
    const r = readiness.find((x) => x.strategy === activePath);
    if (r) return r.streams;
    const f = openFiles.find((x) => x.path === activePath);
    return f && activePath?.endsWith(".qkt") ? parseStrategyInfo(f.content).streams : [];
  }, [readiness, activePath, openFiles]);
  if (!d || (!d.futures.length && !d.options.length)) return null;
  return (
    <>
      {d.futures.length > 0 && (
        <div className="side-group">
          <h3>Futures <span className="muted num">{d.futures.length}</span></h3>
          <div role="list" aria-label="Futures roots">
            {d.futures.map((r) => <Line key={r.key} line={futureRootLine(r)} kind="futures" used={streams.some((s) => readsRoot(s, r))} />)}
          </div>
        </div>
      )}
      {d.options.length > 0 && (
        <div className="side-group">
          <h3>Options <span className="muted num">{d.options.length}</span></h3>
          <div role="list" aria-label="Options roots">
            {d.options.map((r) => <Line key={r.key} line={optionRootLine(r)} kind="options" used={streams.some((s) => readsRoot(s, r))} />)}
          </div>
        </div>
      )}
      <RootDialog />
    </>
  );
}
