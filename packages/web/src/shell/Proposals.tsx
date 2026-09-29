import { useRef, useState } from "react";
import { api } from "../api/client.js";
import { decideApplyProposalAction, useAgent } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";

/** Changes a tool proposed (a strategy edit, a config or instrument change, a data job): review the diff, Apply or Reject. */
export function ProposalsButton() {
  const open = useAgent((s) => s.proposals.filter((p) => p.status === "open"));
  const [show, setShow] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!open.length) return null;
  const act = async (id: string, apply: boolean, path?: string) => {
    try {
      if (apply) {
        await api.applyProposal(id);
        if (path) {
          await useStore.getState().refreshTree("");
          const action = decideApplyProposalAction(useStore.getState().openFiles.find((f) => f.path === path));
          if (action === "reload") {
            // the tab is clean: it takes the new text as its saved state (no conflict banner)
            await useStore.getState().reloadFromDisk(path);
          } else if (action === "conflict") {
            // the tab has unsaved edits: never discard them silently — flag the same conflict state the
            // file-watch path uses, so the existing banner (Reload from disk / Overwrite) handles it
            useStore.setState((s) => ({ openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, conflict: true } : f)) }));
            useStore.getState().toast("info", `Applied to ${path} — your unsaved edits are kept; the editor shows the file changed on disk.`);
          }
        }
      }
      else await api.rejectProposal(id);
    } catch (e) { useStore.getState().toast("error", (e as Error).message); }
    await useAgent.getState().refresh();
  };
  return (
    <>
      <button ref={btn} className="btn sm" aria-haspopup="dialog" aria-expanded={show} onClick={() => setShow(!show)}>Proposals ({open.length})</button>
      <Popover open={show} onClose={() => setShow(false)} anchor={btn} align="end" width={520} label="Proposed changes">
        <div className="settings-sec">
          {open.map((p) => (
            <div key={p.id} className="proposal">
              <div className="row" style={{ gap: 6 }}><b className="grow">{p.title}</b>
                <button className="btn sm primary" onClick={() => void act(p.id, true, p.path)}>{p.kind === "job" ? "Start" : "Apply"}</button>
                <button className="btn sm ghost" onClick={() => void act(p.id, false)}>Reject</button>
              </div>
              {p.diff && <pre className="diff mono">{p.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}</pre>}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
