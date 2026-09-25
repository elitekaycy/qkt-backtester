import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { api, type Coverage, type RunMeta } from "../api/client.js";
import type { RoundTrip } from "../api/types.js";
import { barTime, TradesPrimitive } from "../charts/TradesPrimitive.js";
import { useStore } from "../state/store.js";
import { fmtPrice, fmtTs } from "../util/format.js";

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const MAX_MARKER_TRIPS = 1500;
type Stream = { broker: string; symbol: string; tf: string };
const keyOf = (s: Stream) => `${s.broker}:${s.symbol}:${s.tf}`;

interface Registry { charts: Map<string, IChartApi>; lock: boolean }

function CoverageStrip({ stream, from, to, registry, id }: { stream: Stream; from: number; to: number; registry: Registry; id: string }) {
  const [cov, setCov] = useState<Coverage | null>(null);
  const [view, setView] = useState<{ l: number; w: number } | null>(null);
  useEffect(() => {
    let live = true;
    api.coverage({ ...stream, from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) }).then((c) => live && setCov(c)).catch(() => live && setCov(null));
    return () => { live = false; };
  }, [stream.broker, stream.symbol, stream.tf, from, to]);
  useEffect(() => {
    const chart = registry.charts.get(id);
    if (!chart) return;
    const upd = () => {
      const r = chart.timeScale().getVisibleRange();
      if (!r) return;
      const span = to - from;
      const l = Math.max(0, ((r.from as number) * 1000 - from) / span), rr = Math.min(1, ((r.to as number) * 1000 - from) / span);
      setView({ l: l * 100, w: Math.max(0.5, (rr - l) * 100) });
    };
    upd();
    chart.timeScale().subscribeVisibleTimeRangeChange(upd);
    return () => chart.timeScale().unsubscribeVisibleTimeRangeChange(upd);
  }, [id, from, to, cov]);
  if (!cov) return <div className="covstrip" title="Day coverage of the bar store" />;
  const s = cov.summary;
  const tip = `Bar-store coverage ${cov.days[0]?.day} to ${cov.days[cov.days.length - 1]?.day}: ${s.ok} ok, ${s.thin} thin, ${s.closed} closed (no bars written), ${s.missing} missing`;
  return (
    <div className="covstrip" title={tip} onClick={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const t = from + ((e.clientX - rect.left) / rect.width) * (to - from);
      const chart = registry.charts.get(id);
      try { chart?.timeScale().setVisibleRange({ from: ((t - 2 * 86_400_000) / 1000) as UTCTimestamp, to: ((t + 2 * 86_400_000) / 1000) as UTCTimestamp }); } catch { /* outside data */ }
    }}>
      {cov.days.map((d) => <i key={d.day} className={d.status} title={`${d.day}: ${d.status === "closed" ? "closed (0 bars written)" : d.status === "missing" ? "MISSING: no day file" : d.status === "thin" ? `partial day (${d.bars} bars)` : `${d.bars} bars`}`} />)}
      {view && <span className="view" style={{ left: `${view.l}%`, width: `${view.w}%` }} />}
    </div>
  );
}

function PriceChart({ stream, win, runId, registry, maximized, onMax, onRemove }: { stream: Stream; win: { from: number; to: number }; runId: string; registry: Registry; maximized: boolean; onMax: () => void; onRemove?: () => void }) {
  const plot = useRef<HTMLDivElement>(null);
  const parts = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick">; prim: TradesPrimitive; markers: ISeriesMarkersPluginApi<Time>; tfMs: number } | null>(null);
  const id = keyOf(stream);
  const filters = useStore((s) => s.filters);
  const selected = useStore((s) => s.selectedTrip);
  const focus = useStore((s) => s.focus);
  const theme = useStore((s) => s.theme);
  const store = useStore;
  const [info, setInfo] = useState<{ count: number; source: number; missing: number; error?: string } | null>(null);
  const [hover, setHover] = useState<string>("");
  const [ov, setOv] = useState<{ rows: RoundTrip[]; total: number; truncated: boolean }>({ rows: [], total: 0, truncated: false });
  const [ready, setReady] = useState(0);

  useEffect(() => {
    if (!plot.current) return;
    const chart = createChart(plot.current, {
      autoSize: true, crosshair: { mode: CrosshairMode.Normal },
      layout: { background: { type: ColorType.Solid, color: cssVar("--surface") }, textColor: cssVar("--ink-2"), fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: cssVar("--grid") }, horzLines: { color: cssVar("--grid") } },
      rightPriceScale: { borderColor: cssVar("--axis") }, timeScale: { borderColor: cssVar("--axis"), timeVisible: true, secondsVisible: false, minBarSpacing: 0.01, rightOffset: 2 },
    });
    const up = cssVar("--candle-up"), dn = cssVar("--candle-dn");
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceLineVisible: false, lastValueVisible: true });
    const prim = new TradesPrimitive();
    series.attachPrimitive(prim);
    const markers = createSeriesMarkers(series, []);
    parts.current = { chart, series, prim, markers, tfMs: 0 };
    registry.charts.set(id, chart);
    (plot.current as HTMLDivElement & { __chart?: IChartApi; __prim?: TradesPrimitive }).__chart = chart;
    (plot.current as HTMLDivElement & { __prim?: TradesPrimitive }).__prim = prim;

    const onRange = (r: { from: Time; to: Time } | null) => {
      if (!r || registry.lock) return;
      registry.lock = true;
      try { for (const [k, c] of registry.charts) if (k !== id) c.timeScale().setVisibleRange({ from: r.from, to: r.to }); } catch { /* other chart has no data yet */ }
      registry.lock = false;
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(series) as { open: number; high: number; low: number; close: number } | undefined;
      setHover(d && p.time ? `${fmtTs((p.time as number) * 1000)}  O ${fmtPrice(d.open)}  H ${fmtPrice(d.high)}  L ${fmtPrice(d.low)}  C ${fmtPrice(d.close)}` : "");
    });
    setReady((n) => n + 1);
    return () => { chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange); registry.charts.delete(id); chart.remove(); parts.current = null; };
  }, [id]);

  // bars
  useEffect(() => {
    let live = true;
    const p = parts.current;
    if (!p) return;
    setInfo(null);
    api.bars({ ...stream, from: win.from, to: win.to, max: 20000 }).then(({ cols, sourceCount, missingDays }) => {
      if (!live || !parts.current) return;
      const data = new Array(cols.ts.length);
      for (let i = 0; i < cols.ts.length; i++) data[i] = { time: (cols.ts[i]! / 1000) as UTCTimestamp, open: cols.open[i], high: cols.high[i], low: cols.low[i], close: cols.close[i] };
      parts.current.series.setData(data);
      parts.current.tfMs = cols.tfMs;
      parts.current.chart.timeScale().fitContent();
      setInfo({ count: cols.ts.length, source: sourceCount, missing: missingDays });
      setReady((n) => n + 1);
    }).catch((e: Error) => live && setInfo({ count: 0, source: 0, missing: 0, error: e.message }));
    return () => { live = false; };
  }, [id, win.from, win.to, runId]);

  // overlay (server applies the shared filters)
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.overlay(runId, { ...filters, symbol: `${stream.broker}:${stream.symbol}` }, win.from, win.to)
        .then((o) => live && setOv({ rows: o.rows, total: o.total, truncated: o.truncated })).catch(() => live && setOv({ rows: [], total: 0, truncated: false }));
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [runId, JSON.stringify(filters), stream.broker, stream.symbol, win.from, win.to]);

  // paint trades + markers whenever anything they depend on changes
  useEffect(() => {
    const p = parts.current;
    if (!p || !p.tfMs) return;
    p.prim.set(ov.rows, p.tfMs, selected?.id ?? null, { gain: cssVar("--gain"), loss: cssVar("--loss"), ink: cssVar("--ink") });
    if (ov.rows.length <= MAX_MARKER_TRIPS) {
      const ink = cssVar("--ink-2"), gain = cssVar("--gain"), loss = cssVar("--loss");
      const m: SeriesMarker<Time>[] = [];
      for (const t of ov.rows) {
        m.push({ time: barTime(t.entryTs, p.tfMs), position: t.side === "long" ? "belowBar" : "aboveBar", shape: t.side === "long" ? "arrowUp" : "arrowDown", color: ink });
        if (t.exitTs !== null) m.push({ time: barTime(t.exitTs, p.tfMs), position: t.side === "long" ? "aboveBar" : "belowBar", shape: "circle", color: t.pnl >= 0 ? gain : loss });
      }
      m.sort((a, b) => (a.time as number) - (b.time as number));
      p.markers.setMarkers(m);
    } else p.markers.setMarkers([]);
  }, [ov, selected?.id, ready, theme]);

  useEffect(() => {
    const p = parts.current;
    if (!p || !focus) return;
    try { p.chart.timeScale().setVisibleRange({ from: (focus.from / 1000) as UTCTimestamp, to: (focus.to / 1000) as UTCTimestamp }); } catch { /* range outside loaded bars */ }
  }, [focus?.nonce]);

  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    p.chart.applyOptions({ layout: { background: { type: ColorType.Solid, color: cssVar("--surface") }, textColor: cssVar("--ink-2") }, grid: { vertLines: { color: cssVar("--grid") }, horzLines: { color: cssVar("--grid") } }, rightPriceScale: { borderColor: cssVar("--axis") }, timeScale: { borderColor: cssVar("--axis") } });
    const up = cssVar("--candle-up"), dn = cssVar("--candle-dn");
    p.series.applyOptions({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn });
  }, [theme]);

  return (
    <div className={`chart-cell${maximized ? " maximized" : ""}`} data-chart={id}>
      <div className="cap">
        <b>{stream.symbol}</b><span className="ink2">{stream.tf}</span><span className="muted">{stream.broker}</span>
        {info && !info.error && <span className="muted" title={info.source !== info.count ? `Aggregated from ${info.source} bars for display` : ""}>{info.count.toLocaleString()} bars{info.source !== info.count ? ` (of ${info.source.toLocaleString()})` : ""}</span>}
        {info?.error && <span className="badge bad" title={info.error}>no bars: {info.error}</span>}
        {info && info.missing > 0 && <span className="badge warn" title="Days in this window with no bar file. The chart shows no candles there.">{info.missing} day(s) not built</span>}
        <span className="badge" title={ov.truncated ? "Showing the first 20,000 matching trades" : ""}>{ov.total.toLocaleString()} trade{ov.total === 1 ? "" : "s"}{ov.truncated ? " (capped)" : ""}</span>
        <span className="mono muted" style={{ marginLeft: 4 }}>{hover}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onMax} title={maximized ? "Restore" : "Expand to the full panel"}>{maximized ? "⤡" : "⤢"}</button>
        {onRemove && <button className="btn ghost sm" onClick={onRemove} title="Remove this chart">✕</button>}
      </div>
      <div ref={plot} className="plot" />
      <CoverageStrip stream={stream} from={win.from} to={win.to} registry={registry} id={id} />
    </div>
  );
}

export function ChartsPanel() {
  const { results, resultsStale, run, running } = useStore();
  const [extra, setExtra] = useState<Stream[]>([]);
  const [maxed, setMaxed] = useState<string | null>(null);
  const [tfOptions, setTfOptions] = useState<Array<{ broker: string; symbol: string; tfs: string[] }>>([]);
  const registry = useRef<Registry>({ charts: new Map(), lock: false }).current;
  const meta: RunMeta | null = results?.meta ?? null;
  const streams = useMemo(() => {
    const seen = new Set<string>();
    return [...(meta?.streams ?? []), ...extra].filter((s) => { const k = keyOf(s); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [meta, extra]);

  useEffect(() => { setExtra([]); setMaxed(null); }, [results?.runId]);
  useEffect(() => {
    if (!meta) return;
    api.barsSymbols().then((r) => {
      const want = new Set(meta.streams.map((s) => `${s.broker}:${s.symbol}`));
      setTfOptions(r.symbols.filter((s) => want.has(`${s.broker}:${s.symbol}`)).map((s) => ({ broker: s.broker, symbol: s.symbol, tfs: s.timeframes })));
    }).catch(() => setTfOptions([]));
  }, [meta?.runId]);

  if (!results || !meta) {
    return (
      <div className="panel">
        <div className="panel-head"><span className="title">Charts</span></div>
        <div className="empty">
          {running ? <><b>Running…</b><br />Charts appear here when the run finishes.</>
            : run?.status === "failed" ? <><b>The last run failed.</b><br />See the Run pipeline panel for the step that stopped it.</>
            : <><b>No results yet.</b><br />Run a backtest to see every traded timeframe here with entries, exits, trade boxes and hold times.</>}
        </div>
      </div>
    );
  }

  const win = { from: Date.parse(meta.from + "T00:00:00Z"), to: Date.parse(meta.to + "T00:00:00Z") };
  const integ = results.integrity;
  const failed = integ.checks.filter((c) => c.ok === false);
  const addable = tfOptions.flatMap((o) => o.tfs.filter((tf) => !streams.some((s) => s.broker === o.broker && s.symbol === o.symbol && s.tf === tf)).map((tf) => ({ broker: o.broker, symbol: o.symbol, tf })));

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Charts</span>
        <span className={`badge ${meta.tier}`}>{meta.tier === "draft" ? "Draft · bars" : "Full · ticks"}</span>
        <span className={`badge ${failed.length ? "bad" : "ok"}`} title={integ.checks.map((c) => `${c.ok === null ? "–" : c.ok ? "✓" : "✕"} ${c.label}: ${c.detail}`).join("\n")}>
          {failed.length ? `✕ integrity: ${failed.map((c) => c.label).join(", ")}` : "✓ chart matches engine"}
        </span>
        <span className="muted">{meta.from} → {meta.to} (to exclusive) · UTC</span>
        <span className="grow" />
        {addable.length > 0 && (
          <select className="input" value="" onChange={(e) => { const s = addable[Number(e.target.value)]; if (s) setExtra((x) => [...x, s]); }} title="Show another timeframe from the bar store">
            <option value="">+ timeframe</option>
            {addable.map((s, i) => <option key={keyOf(s)} value={i}>{s.symbol} {s.tf}</option>)}
          </select>
        )}
      </div>
      <div className={resultsStale ? "dim" : ""} style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {streams.length === 0 && <div className="empty">This run evaluated no bar streams.</div>}
        {streams.map((s) => (
          <PriceChart key={keyOf(s)} stream={s} win={win} runId={results.runId} registry={registry}
            maximized={maxed === keyOf(s)} onMax={() => setMaxed(maxed === keyOf(s) ? null : keyOf(s))}
            onRemove={extra.some((x) => keyOf(x) === keyOf(s)) ? () => setExtra((x) => x.filter((y) => keyOf(y) !== keyOf(s))) : undefined} />
        ))}
      </div>
    </div>
  );
}
