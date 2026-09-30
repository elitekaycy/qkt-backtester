import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { RoundTrip } from "../api/types.js";
import { tradeSpan } from "./barAnchor.js";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface TradeColors { gain: string; loss: string; ink: string; surface: string }

/** Where a trade sits on screen, in CSS pixels of the pane. */
export interface TradeGeo { trip: RoundTrip; x1: number; y1: number; x2: number; y2: number; left: number; right: number; top: number; bottom: number; slY?: number; tpY?: number }

/** More than this many trades in view: boxes lose their fill. More than DENSE2: only hairline boxes. */
const DENSE = 40, DENSE2 = 240;

const PRICE = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 10 ? n.toFixed(3) : n.toFixed(5));

/**
 * Series primitive that draws trades so they can be followed one at a time.
 *  - Every trade is a small box from entry (time, price) to exit (time, price): never wider than the trade itself.
 *  - Entry marker: triangle (up = long, down = short). Exit marker: diamond = target, cross = stop, circle = signal.
 *  - Crowded views drop the fills, then the markers, so a zoomed-out chart stays readable.
 *  - The SELECTED (or hovered) trade gets full detail: risk and reward zones, entry / stop / target lines with labels.
 * Only trades inside the visible time range are touched, so 20,000 trades stay cheap.
 * A trade is placed on the displayed bars that hold its entry and exit (`tradeSpan`), so it lands right on merged bars
 * and across gaps, and is clipped to the loaded data; only an open trade runs on to the data's end.
 */
export class TradesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private requestUpdate: (() => void) | null = null;
  private trips: RoundTrip[] = [];
  private maxHold = 0;
  private selectedId: number | null = null;
  private hoverId: number | null = null;
  private tfMs = 60_000;
  private dataEnd: number | null = null;
  /** The series' bar times (LWC seconds, ascending), set with the bars (`setBars`). */
  private times: readonly number[] = [];
  private colors: TradeColors = { gain: "#3987e5", loss: "#e66767", ink: "#ffffff", surface: "#1b1c20" };
  private geo: TradeGeo[] = [];
  private mode: 0 | 1 | 2 = 0;
  private paneW = 0;
  /** Set only on a portfolio run: colours the entry marker by strategy instead of the neutral ink, so several strategies on one chart stay distinguishable. */
  private strategyColor: ((strategy: string) => string) | null = null;
  /** Number of trades painted in the last frame (asserted by the e2e tests). */
  drawn = 0;

  private bottom: IPrimitivePaneView = { zOrder: () => "bottom", renderer: () => ({ draw: (t: DrawTarget) => this.paintBoxes(t) }) };
  private top: IPrimitivePaneView = { zOrder: () => "top", renderer: () => ({ draw: (t: DrawTarget) => this.paintMarkers(t) }) };

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<"Candlestick">;
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = null; }
  paneViews(): readonly IPrimitivePaneView[] { return [this.bottom, this.top]; }

  /** Recompute screen geometry for the trades in view. LWC calls this before every render. */
  updateAllViews(): void {
    const chart = this.chart, series = this.series;
    this.geo = [];
    if (!chart || !series || !this.trips.length) return;
    const ts = chart.timeScale();
    const vr = ts.getVisibleRange();
    if (!vr) return;
    const fromMs = (vr.from as number) * 1000 - this.tfMs, toMs = (vr.to as number) * 1000 + this.tfMs;
    const w = ts.width();
    this.paneW = w;
    // first trade that could still be in view: entries are sorted, holds are bounded by maxHold
    let lo = 0, hi = this.trips.length;
    const need = fromMs - this.maxHold;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.trips[m]!.entryTs < need) lo = m + 1; else hi = m; }
    for (let i = lo; i < this.trips.length; i++) {
      const t = this.trips[i]!;
      if (t.entryTs > toMs) break;
      if ((t.exitTs ?? Number.POSITIVE_INFINITY) < fromMs) continue;
      const span = tradeSpan(this.times, this.tfMs, t, this.dataEnd);
      if (!span) continue;
      const x1 = ts.timeToCoordinate(span.entry), x2 = ts.timeToCoordinate(span.exit);
      const y1 = series.priceToCoordinate(t.entryPx);
      const y2 = t.exitPx === null ? y1 : series.priceToCoordinate(t.exitPx);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const left = Math.min(x1, x2), right = Math.max(x1, x2, x1 + 4);
      const pad = 2;
      const g: TradeGeo = { trip: t, x1, y1, x2, y2, left, right, top: Math.min(y1, y2) - pad, bottom: Math.max(y1, y2) + pad };
      if (t.sl !== undefined) g.slY = series.priceToCoordinate(t.sl) ?? undefined;
      if (t.tp !== undefined) g.tpY = series.priceToCoordinate(t.tp) ?? undefined;
      this.geo.push(g);
    }
    this.mode = this.geo.length > DENSE2 ? 2 : this.geo.length > DENSE ? 1 : 0;
  }

  set(trips: RoundTrip[], tfMs: number, selectedId: number | null, colors: TradeColors, dataEndMs: number | null = null, strategyColor: ((strategy: string) => string) | null = null): void {
    this.trips = trips; this.tfMs = tfMs; this.selectedId = selectedId; this.colors = colors; this.dataEnd = dataEndMs; this.strategyColor = strategyColor;
    this.maxHold = trips.reduce((m, t) => Math.max(m, t.holdMs ?? ((dataEndMs ?? t.entryTs) - t.entryTs)), 0);
    this.requestUpdate?.();
  }
  /** The bar times the series now shows (LWC seconds, ascending): what trades are anchored on. */
  setBars(times: readonly number[]): void { this.times = times; this.requestUpdate?.(); }
  setHover(id: number | null): void { if (id !== this.hoverId) { this.hoverId = id; this.requestUpdate?.(); } }

  /** Screen position of a trade that is currently in view (CSS px), for anchoring cards. */
  geometry(id: number): TradeGeo | null { return this.geo.find((g) => g.trip.id === id) ?? null; }

  /** The trade under a point (CSS px in the pane): markers first (10px reach), then box interiors (smallest wins). */
  tripAt(x: number, y: number): RoundTrip | null {
    let best: TradeGeo | null = null, bestD = 10;
    for (const g of this.geo) {
      const d1 = Math.hypot(x - g.x1, y - (g.trip.side === "long" ? g.y1 + 10 : g.y1 - 10));
      const d2 = g.trip.open ? Infinity : Math.hypot(x - g.x2, y - g.y2);
      const d = Math.min(d1, d2);
      if (d < bestD) { best = g; bestD = d; }
    }
    if (best) return best.trip;
    let area = Infinity;
    for (const g of this.geo) {
      if (x >= g.left - 3 && x <= g.right + 3 && y >= g.top - 3 && y <= g.bottom + 3) {
        const a = (g.right - g.left + 6) * (g.bottom - g.top + 6);
        if (a < area) { area = a; best = g; }
      }
    }
    return best?.trip ?? null;
  }

  private base(t: RoundTrip): string { return t.pnl > 0 ? this.colors.gain : t.pnl < 0 ? this.colors.loss : this.colors.ink; }

  private paintBoxes(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      let drawn = 0;
      for (const g of this.geo) {
        const id = g.trip.id;
        if (id === this.selectedId) continue; // painted with detail on the top layer
        const base = this.base(g.trip), hot = id === this.hoverId;
        const w = Math.max(g.right - g.left, 3), h = Math.max(g.bottom - g.top, 4);
        if (this.mode === 0 || hot) { ctx.globalAlpha = hot ? 0.24 : g.trip.open ? 0.08 : 0.14; ctx.fillStyle = base; ctx.fillRect(g.left, g.top, w, h); }
        ctx.globalAlpha = hot ? 1 : this.mode === 2 ? 0.4 : this.mode === 1 ? 0.6 : 0.8;
        ctx.strokeStyle = base; ctx.lineWidth = hot ? 2 : 1;
        ctx.setLineDash(g.trip.open ? [4, 3] : []);
        ctx.strokeRect(g.left + 0.5, g.top + 0.5, w, h);
        if (this.mode === 0 && !g.trip.open && w > 8) { ctx.globalAlpha = 0.5; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke(); }
        drawn++;
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      this.drawn = drawn + (this.geo.some((g) => g.trip.id === this.selectedId) ? 1 : 0);
      (this.chart as unknown as { __tradesDrawn?: number } | null) && ((this.chart as unknown as { __tradesDrawn?: number }).__tradesDrawn = this.drawn);
    });
  }

  private entryMarker(ctx: CanvasRenderingContext2D, g: TradeGeo, size: number): void {
    const long = g.trip.side === "long", cy = long ? g.y1 + size + 3 : g.y1 - size - 3;
    ctx.beginPath();
    if (long) { ctx.moveTo(g.x1, cy - size); ctx.lineTo(g.x1 - size, cy + size * 0.7); ctx.lineTo(g.x1 + size, cy + size * 0.7); }
    else { ctx.moveTo(g.x1, cy + size); ctx.lineTo(g.x1 - size, cy - size * 0.7); ctx.lineTo(g.x1 + size, cy - size * 0.7); }
    ctx.closePath();
    ctx.fillStyle = this.strategyColor ? this.strategyColor(g.trip.strategy) : this.colors.ink; ctx.strokeStyle = this.colors.surface; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fill();
  }

  private exitMarker(ctx: CanvasRenderingContext2D, g: TradeGeo, r: number): void {
    const t = g.trip;
    if (t.open || t.exitPx === null) return;
    const x = g.x2, y = g.y2;
    ctx.fillStyle = this.base(t); ctx.strokeStyle = this.colors.surface; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (t.exit === "target") { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y); ctx.closePath(); ctx.stroke(); ctx.fill(); }
    else if (t.exit === "stop") { ctx.rect(x - r, y - r, 2 * r, 2 * r); ctx.stroke(); ctx.fill(); ctx.strokeStyle = this.colors.surface; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - r * 0.55, y - r * 0.55); ctx.lineTo(x + r * 0.55, y + r * 0.55); ctx.moveTo(x + r * 0.55, y - r * 0.55); ctx.lineTo(x - r * 0.55, y + r * 0.55); ctx.stroke(); }
    else { ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.fill(); }
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, w: number): void {
    ctx.font = "600 10.5px 'Inter Variable', system-ui, sans-serif";
    const tw = ctx.measureText(text).width + 8;
    const lx = Math.max(2, Math.min(x, w - tw - 2));
    ctx.globalAlpha = 0.94; ctx.fillStyle = this.colors.surface; ctx.fillRect(lx, y - 8, tw, 16);
    ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(lx + 0.5, y - 7.5, tw - 1, 15);
    ctx.fillStyle = this.colors.ink; ctx.textBaseline = "middle"; ctx.fillText(text, lx + 4, y + 0.5);
  }

  private detail(ctx: CanvasRenderingContext2D, g: TradeGeo): void {
    const t = g.trip, c = this.colors, w = this.paneW;
    const xr = Math.max(g.right, g.x1 + 60);
    const zone = (yTo: number | undefined, col: string) => {
      if (yTo === undefined) return;
      ctx.globalAlpha = 0.1; ctx.fillStyle = col; ctx.fillRect(g.x1, Math.min(g.y1, yTo), xr - g.x1, Math.abs(yTo - g.y1) || 1); ctx.globalAlpha = 1;
    };
    zone(g.slY, c.loss); zone(g.tpY, c.gain);
    const base = this.base(t);
    ctx.globalAlpha = 0.2; ctx.fillStyle = base; ctx.fillRect(g.left, g.top, Math.max(g.right - g.left, 3), Math.max(g.bottom - g.top, 4));
    ctx.globalAlpha = 1; ctx.strokeStyle = c.ink; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.strokeRect(g.left, g.top, Math.max(g.right - g.left, 3), Math.max(g.bottom - g.top, 4));
    const line = (y: number, col: string, dash: number[]) => { ctx.strokeStyle = col; ctx.lineWidth = 1.25; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(g.x1, y); ctx.lineTo(xr, y); ctx.stroke(); ctx.setLineDash([]); };
    line(g.y1, c.ink, []);
    if (g.slY !== undefined) line(g.slY, c.loss, [5, 3]);
    if (g.tpY !== undefined) line(g.tpY, c.gain, [5, 3]);
    const lx = xr + 6;
    // labels at nearly the same height would sit on top of each other: the exit label absorbs the stop/target it coincides with
    const exitNear = (y?: number) => y !== undefined && !t.open && Math.abs(y - g.y2) < 16;
    this.label(ctx, `Entry ${PRICE(t.entryPx)}`, lx, g.y1, c.ink, w);
    if (g.slY !== undefined && t.sl !== undefined && !exitNear(g.slY)) this.label(ctx, `SL ${PRICE(t.sl)}${t.risk ? " (−1R)" : ""}`, lx, g.slY, c.loss, w);
    if (g.tpY !== undefined && t.tp !== undefined && !exitNear(g.tpY)) this.label(ctx, `TP ${PRICE(t.tp)}${t.risk && t.risk > 0 ? ` (+${(Math.abs(t.tp - t.entryPx) / Math.abs(t.entryPx - (t.sl ?? t.entryPx)) || 0).toFixed(1)}R)` : ""}`, lx, g.tpY, c.gain, w);
    if (!t.open && t.exitPx !== null) {
      const hit = exitNear(g.slY) && t.exit === "stop" ? "SL" : exitNear(g.tpY) && t.exit === "target" ? "TP" : null;
      this.label(ctx, `${hit ? `${hit} hit` : "Exit"} ${PRICE(t.exitPx)}${hit ? "" : ` · ${t.exit}`}`, lx, g.y2, base, w);
    }
  }

  private paintMarkers(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      if (this.mode < 2) {
        const s = this.mode === 0 ? 5 : 3.5, r = this.mode === 0 ? 4 : 2.5;
        for (const g of this.geo) {
          if (g.trip.id === this.selectedId) continue;
          this.entryMarker(ctx, g, s); this.exitMarker(ctx, g, r);
        }
      }
      const sel = this.geo.find((g) => g.trip.id === this.selectedId);
      if (sel) { this.detail(ctx, sel); this.entryMarker(ctx, sel, 7); this.exitMarker(ctx, sel, 6); }
      const hov = this.hoverId !== null && this.hoverId !== this.selectedId ? this.geo.find((g) => g.trip.id === this.hoverId) : null;
      if (hov && this.mode > 0) { this.entryMarker(ctx, hov, 6); this.exitMarker(ctx, hov, 5); }
      ctx.restore();
    });
  }
}
