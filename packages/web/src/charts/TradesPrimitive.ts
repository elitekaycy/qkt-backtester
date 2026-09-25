import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time, UTCTimestamp } from "lightweight-charts";
import type { RoundTrip } from "../api/types.js";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface TradeColors { gain: string; loss: string; ink: string }

/** Snap a millisecond timestamp to the start of its bar (bars are UTC-aligned), as LWC seconds. */
export const barTime = (ms: number, tfMs: number): UTCTimestamp => (Math.floor(ms / tfMs) * tfMs / 1000) as UTCTimestamp;

/**
 * Series primitive: one rectangle per trade from entry (time, price) to exit (time, price). Wins and losses use the
 * validated diverging pair; open trades run to the right edge with a dashed border; the selected trade is outlined
 * in ink. Off-screen trades are skipped so 20k trades stay cheap.
 */
export class TradesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private requestUpdate: (() => void) | null = null;
  private trips: RoundTrip[] = [];
  private selectedId: number | null = null;
  private tfMs = 60_000;
  private colors: TradeColors = { gain: "#3987e5", loss: "#e66767", ink: "#ffffff" };
  /** Number of rectangles painted in the last frame (asserted by the e2e tests). */
  drawn = 0;

  private view: IPrimitivePaneView = {
    zOrder: () => "bottom",
    renderer: () => ({
      draw: (target: DrawTarget) => this.paint(target),
    }),
  };

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<"Candlestick">;
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = null; }
  updateAllViews(): void { /* geometry is recomputed inside paint() */ }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view]; }

  set(trips: RoundTrip[], tfMs: number, selectedId: number | null, colors: TradeColors): void {
    this.trips = trips; this.tfMs = tfMs; this.selectedId = selectedId; this.colors = colors;
    this.requestUpdate?.();
  }

  private paint(target: DrawTarget): void {
    const chart = this.chart, series = this.series;
    if (!chart || !series) return;
    let drawn = 0;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context, hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
      const ts = chart.timeScale();
      const width = scope.bitmapSize.width;
      for (const t of this.trips) {
        const x1 = ts.timeToCoordinate(barTime(t.entryTs, this.tfMs));
        const xe = t.exitTs === null ? null : ts.timeToCoordinate(barTime(t.exitTs, this.tfMs));
        const y1 = series.priceToCoordinate(t.entryPx);
        const y2 = t.exitPx === null ? y1 : series.priceToCoordinate(t.exitPx);
        if (x1 === null || y1 === null || y2 === null) continue;
        const px1 = x1 * hr;
        const px2 = t.open || xe === null ? width : xe * hr;
        if (px2 < 0 || px1 > width) continue;
        const win = t.pnl > 0, loss = t.pnl < 0;
        const base = win ? this.colors.gain : loss ? this.colors.loss : this.colors.ink;
        const top = Math.min(y1, y2) * vr, h = Math.max(Math.abs(y2 - y1) * vr, 2 * vr);
        const w = Math.max(px2 - px1, 3 * hr);
        ctx.globalAlpha = t.open ? 0.12 : 0.22; ctx.fillStyle = base; ctx.fillRect(px1, top, w, h);
        ctx.globalAlpha = 0.85; ctx.strokeStyle = base; ctx.lineWidth = Math.max(1, hr);
        if (t.open) ctx.setLineDash([4 * hr, 3 * hr]); else ctx.setLineDash([]);
        ctx.strokeRect(px1 + 0.5, top + 0.5, w, h);
        // entry -> exit diagonal shows direction of the price move the trade captured
        if (!t.open && w > 6 * hr) { ctx.beginPath(); ctx.moveTo(px1, y1 * vr); ctx.lineTo(px1 + w, y2 * vr); ctx.setLineDash([]); ctx.stroke(); }
        if (t.id === this.selectedId) {
          ctx.globalAlpha = 1; ctx.strokeStyle = this.colors.ink; ctx.lineWidth = 2 * hr; ctx.setLineDash([]);
          ctx.strokeRect(px1, top - 1, w, h + 2);
        }
        drawn++;
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    });
    this.drawn = drawn;
    (this.chart as unknown as { __tradesDrawn?: number }).__tradesDrawn = drawn;
  }
}
