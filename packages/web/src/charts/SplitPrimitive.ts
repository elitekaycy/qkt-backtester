import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/**
 * Where the split's cut lands on a series' bars, given the bars' UTC-second times (ascending, as `series.data()`
 * returns them) and the cut in ms:
 *  - cut before the first bar: `"start"` (shade the whole pane from the left edge, x = 0).
 *  - cut exactly on a bar, or in a gap (e.g. a weekend): the first bar at or after the cut.
 *  - cut after the last bar: `null` (nothing to shade — the test part isn't in view).
 * `timeToCoordinate` returns null for a time that isn't an existing bar (which a raw cut almost always is not:
 * weekends, non-trading hours), so shading must always anchor on an actual bar time, never the raw cut directly.
 */
export function splitAnchor(times: readonly number[], cutMs: number): { time: UTCTimestamp } | "start" | null {
  if (times.length === 0) return null;
  const cutSec = cutMs / 1000;
  if (cutSec < times[0]!) return "start";
  if (cutSec > times[times.length - 1]!) return null;
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < cutSec) lo = mid + 1; else hi = mid;
  }
  return { time: times[lo] as UTCTimestamp };
}

class SplitRenderer implements IPrimitivePaneRenderer {
  constructor(private x: number | null) {}
  draw(target: DrawTarget): void {
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio }) => {
      if (this.x === null) return;
      const x = Math.round(this.x * horizontalPixelRatio);
      context.fillStyle = "rgba(128, 128, 128, 0.08)";
      context.fillRect(x, 0, bitmapSize.width - x, bitmapSize.height);
      context.fillStyle = "rgba(128, 128, 128, 0.55)";
      context.fillRect(x, 0, Math.max(1, Math.round(horizontalPixelRatio)), bitmapSize.height);
    });
  }
}

class SplitView implements IPrimitivePaneView {
  x: number | null = null;
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return new SplitRenderer(this.x); }
}

/** Shades the test part of the split on a price chart: from the cut to the right edge. Recomputes its screen x on
 *  every redraw (scroll/zoom/resize all call `updateAllViews` before painting), so it never shows a stale position. */
export class SplitPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private request: (() => void) | null = null;
  private cut: number | null = null;
  private view = new SplitView();

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series;
    this.request = p.requestUpdate;
  }
  detached(): void { this.chart = null; this.series = null; this.request = null; }

  /** `ms`: the split's cut, in epoch milliseconds (or null: no split / no cut in this window). */
  setCut(ms: number | null): void { this.cut = ms; this.request?.(); }

  paneViews(): readonly IPrimitivePaneView[] { return [this.view]; }

  updateAllViews(): void {
    const chart = this.chart, series = this.series;
    if (this.cut === null || !chart || !series) { this.view.x = null; return; }
    const times = series.data().map((d) => d.time as number);
    const anchor = splitAnchor(times, this.cut);
    this.view.x = anchor === null ? null : anchor === "start" ? 0 : chart.timeScale().timeToCoordinate(anchor.time);
  }
}
