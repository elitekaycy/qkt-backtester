import { useEffect, useState } from "react";
import { api, type NoDataEntry } from "../api/client.js";
import { useStore } from "../state/store.js";
import { addDays } from "../util/format.js";
import { Check, Undo2, X } from "../ui/icons.js";

/**
 * "Accept as no data" for one bar series: the user decides a gap is real (the source recorded nothing that day) and a
 * backtest may run through it. The server writes the empty day file qkt itself uses for a day without trading and records
 * the day, so it is listed here and can be undone. Works on the missing days inside the selected range, never the whole
 * history at once, so a stretch of genuinely missing data is not waved through by accident.
 */
export function NoDataPanel({ symbol, broker, tf, from, to, missing, onChanged }: { symbol: string; broker: string; tf: string; from: string; to: string; missing: number; onChanged(): void }) {
  const toast = useStore((s) => s.toast);
  const [entries, setEntries] = useState<NoDataEntry[]>([]);
  const [pending, setPending] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = entries.filter((e) => e.symbol === symbol && e.broker === broker && e.tf === tf);
  const reload = () => api.noData().then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  useEffect(() => { void reload(); setPending(null); }, [symbol, broker, tf]);
  useEffect(() => setPending(null), [from, to]);

  const kind = `${broker}:${tf}`;
  const collect = async () => {
    try {
      const d = await api.symbolDays(symbol, kind);
      const days: string[] = [];
      for (let i = 0; i < d.days.length; i++) { const day = addDays(d.first, i); if (d.days[i] === "m" && (!from || day >= from) && (!to || day < to)) days.push(day); }
      if (!days.length) toast("info", "No missing days in the selected range.");
      else setPending(days);
    } catch (e) { toast("error", (e as Error).message); }
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await reload(); onChanged(); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const accept = () => run(async () => {
    const r = await api.acceptNoData({ broker, symbol, tf, days: pending! });
    setPending(null);
    toast("ok", `${r.accepted.length} day${r.accepted.length === 1 ? "" : "s"} accepted as no data${r.skipped.length ? `; ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join("; ")})` : ""}.`);
  });
  const undo = (days: string[]) => run(() => api.undoNoData({ broker, symbol, tf, days }));

  if (!pending && missing === 0 && mine.length === 0) return null;
  return (
    <div className="sd-nodata">
      {pending ? (
        <div className="banner warn" role="alert">
          <span className="grow">
            Accept <b>{pending.length}</b> missing {tf} day{pending.length === 1 ? "" : "s"} as having no data? Backtests will run through {pending.length === 1 ? "it" : "them"} with no bars, as qkt does for a closed day.
            Only do this when the source really recorded nothing (an outage, a holiday); a failed download should be fetched again instead.
            <span className="mono muted" style={{ display: "block", marginTop: 4 }}>{pending.slice(0, 12).join(", ")}{pending.length > 12 ? `, … (${pending.length - 12} more)` : ""}</span>
          </span>
          <button className="btn sm primary" disabled={busy || pending.length > 366} title={pending.length > 366 ? "At most 366 days at once: select a shorter range" : undefined} onClick={() => void accept()}><Check size={13} />Accept</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => setPending(null)}><X size={13} />Cancel</button>
        </div>
      ) : missing > 0 && (
        <button className="btn sm" disabled={busy} onClick={() => void collect()} title="Mark the missing days in the selected range (or the whole series) as days the source has no data for">
          <Check size={13} />Accept missing days {from || to ? "in the selected range " : ""}as no data…
        </button>
      )}
      {mine.length > 0 && (
        <div className="hint">
          <b>{mine.length}</b> day{mine.length === 1 ? "" : "s"} accepted as no data:{" "}
          {mine.slice(0, 20).map((e) => <button key={e.day} className="chip" disabled={busy} title={`Accepted ${e.at.slice(0, 16).replace("T", " ")} UTC. Click to undo.`} onClick={() => void undo([e.day])}>{e.day} <Undo2 size={11} /></button>)}
          {mine.length > 20 && <span className="muted"> … {mine.length - 20} more</span>}
          {" "}<button className="link" disabled={busy} onClick={() => void undo(mine.map((e) => e.day))}>Undo all</button>
        </div>
      )}
    </div>
  );
}
