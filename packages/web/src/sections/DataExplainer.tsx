import { CircleAlert, CircleCheck, CircleX } from "../ui/icons.js";

/** Plain-language definition of "complete", matching the scanner's rules (server data-scan.ts, which follows qkt). Shown from the Data header and in the symbol dialog. */
export function DataExplainer() {
  return (
    <div className="explainer">
      <p>The scan applies <b>qkt's own rule</b>, so a window it calls complete is one qkt agrees to run. Each symbol follows qkt's trading calendar: <b>crypto</b> (BTC…, ETH…, …USDT) every day; <b>SPX, NDX, DJI, RUT</b> the NYSE week less NYSE holidays; <b>everything else</b> the fx week, Sunday 22:00 to Friday 22:00 UTC, with no holidays. Every calendar day between a series' first and last file gets one status:</p>
      <dl>
        <dt><i className="swatch ok" />ok</dt><dd>The store has data for the day.</dd>
        <dt><i className="swatch closed" />closed</dt><dd>Nothing is expected: not a trading day in the symbol's calendar (Saturdays for fx), or an <b>empty bar file</b>, which is how qkt marks a day without trading.</dd>
        <dt><i className="swatch thin" />thin</dt><dd>A trading day with under half a normal day's bars (early close, outage). Usable and flagged, not a gap.</dd>
        <dt><i className="swatch missing" />missing</dt><dd>A trading day with no file, an unreadable or truncated file, or a tick file qkt would reject: no ticks in it, or session hours left empty (a feed with one row per day). qkt refuses a window that contains one.</dd>
      </dl>
      <ul>
        <li><CircleCheck size={13} color="var(--ok)" /><span><b>Complete</b> = no missing day. <b>Nearly complete</b> = missing days are at most 2% of the span. <b>Incomplete</b> = more than that.</span></li>
        <li><CircleAlert size={13} color="var(--warn)" /><span><b>Calendar years:</b> a year the data merely starts or stops in (for example data from June) is <b>partial</b>, not incomplete. Only missing days inside the data count.</span></li>
        <li><CircleAlert size={13} color="var(--info)" /><span><b>Holidays:</b> the fx calendar has none, so a day the source recorded nothing (Good Friday on metals, an outage) is missing, exactly as qkt reports it. If you know the day really had no data, <b>Accept as no data</b> in the symbol's calendar writes the empty day file qkt uses for a closed day; accepted days are listed there and can be undone. One stricter rule than qkt: an empty file on a <b>crypto</b> day stays missing until accepted, because crypto never closes and an empty day there is usually a failed download.</span></li>
        <li><CircleX size={13} color="var(--danger)" /><span>A window is <b>runnable</b> only if it contains no missing day for every symbol the strategy reads. On ticks qkt also checks every session hour of a day at run time (the Coverage step of a run), which this day-level scan cannot see.</span></li>
      </ul>
    </div>
  );
}
