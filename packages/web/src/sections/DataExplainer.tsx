import { CircleAlert, CircleCheck, CircleX } from "../ui/icons.js";

/** Plain-language definition of "complete", matching the scanner's rules (server data-scan.ts). Shown from the Data header and in the symbol dialog. */
export function DataExplainer() {
  return (
    <div className="explainer">
      <p>The scan looks at every calendar day between a series' first and last file and gives each day one status:</p>
      <dl>
        <dt><i className="swatch ok" />ok</dt><dd>The market was open and the store has data for the day.</dd>
        <dt><i className="swatch closed" />closed</dt><dd>The market was shut, so nothing is expected: an <b>empty bar file</b> (qkt writes one for a closed day), <b>weekends</b> for Mon–Fri markets, <b>Dec 25 and Jan 1</b>, a weekday that <b>most other symbols also lack</b> (a market holiday), and US exchange holidays for series that visibly follow them (futures such as CL, HG).</dd>
        <dt><i className="swatch thin" />thin</dt><dd>Open, but with under half a normal day's bars (early close, outage). Usable and flagged, not a gap.</dd>
        <dt><i className="swatch missing" />missing</dt><dd>The market should have been open and the store has nothing (or an unreadable or truncated file). This is a real gap.</dd>
      </dl>
      <ul>
        <li><CircleCheck size={13} color="var(--ok)" /><span><b>Complete</b> = no missing day. <b>Nearly complete</b> = missing days are at most 2% of the span. <b>Incomplete</b> = more than that.</span></li>
        <li><CircleAlert size={13} color="var(--warn)" /><span><b>Calendar years:</b> a year the data merely starts or stops in (for example data from June) is <b>partial</b>, not incomplete. Only missing days inside the data count.</span></li>
        <li><CircleAlert size={13} color="var(--info)" /><span><b>24/7 markets</b> (crypto: they trade Saturdays) treat any empty or absent day as a hole. Mon–Fri markets treat weekends as closed. A year in which a 24/7 series shows no weekend trading is judged as a weekday schedule.</span></li>
        <li><CircleX size={13} color="var(--danger)" /><span>A window is <b>runnable</b> only if it contains no missing day for every symbol the strategy reads. qkt itself also checks every session hour of a day at run time (the Coverage step of a run), which this day-level scan cannot see.</span></li>
      </ul>
    </div>
  );
}
