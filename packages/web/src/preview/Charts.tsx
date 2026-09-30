import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { X } from "lucide-react";
import { api, type Coverage, type RunMeta } from "../api/client.js";
import type { RoundTrip } from "../api/types.js";
import { SplitPrimitive } from "../charts/SplitPrimitive.js";
import { TradesPrimitive } from "../charts/TradesPrimitive.js";
import { useAgent } from "../state/agent.js";
import { ordered, useChartPrefs } from "../state/chartPrefs.js";
import { useStore } from "../state/store.js";
import { Maximize2, Minimize2 } from "../ui/icons.js";
import { Tip } from "../ui/Tip.js";
import { fmtDur, fmtR, fmtMoney, fmtPrice, fmtTs } from "../util/format.js";
import { strategyAlias, tfMs } from "@qkt-studio/core/strategy";
import { strategyColor } from "../util/strategyColor.js";
import { ChartToolbar } from "./ChartToolbar.js";
import { StrategyLegend } from "./StrategyLegend.js";
import { TradeStrip } from "./TradeStrip.js";
import { TradesTab } from "./TradesTab.js";
import { firstTradesRange, type Range } from "./initialView.js";
import { useRunTrips } from "./useRunTrips.js";
import { keyOf, type Stream } from "./streams.js";

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Shared between the charts of one run: for time sync and for the one-time initial view. */
interface Registry { charts: Map<string, IChartApi>; lock: boolean; runId: string | null; range: Range | null; tfMs: number }

const colors = () => ({ gain: cssVar("--gain"), loss: cssVar("--loss"), ink: cssVar("--ink"), surface: cssVar("--main") || cssVar("--surface") });
const safeRange = (chart: IChartApi, r: Range): boolean => {
  try { chart.timeScale().setVisibleRange({ from: (r.from / 1000) as UTCTimestamp, to: (r.to / 1000) as UTCTimestamp }); return true; } catch { return false; }
};

function CoverageStrip({ stream, from, to, registry, id }: { stream: Stream; from: number; to: number; registry: Registry; id: string }) {
  const [cov, setCov] = useState<Coverage | null>(null);
  const [view, setView] = useState<{ l: number; w: number } | null>(null);
  useEffect(() => {
    let live = true;
    api.coverage({ ...stream, from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) }).then((c) => live && setCov(c)).catch(() => live && setCov(null));
    return () => { live = false; };
  }, [stream.broker, stream.symbol, stream.tf, stream.base, from, to]);
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
    return () => { try { chart.timeScale().unsubscribeVisibleTimeRangeChange(upd); } catch { /* chart already removed */ } };
  }, [id, from, to, cov]);
  if (!cov) return <div className="covstrip" title="Day coverage of the bar store" />;
  const s = cov.summary;
  const tip = `Bar-store coverage ${cov.days[0]?.day} to ${cov.days[cov.days.length - 1]?.day}: ${s.ok} ok, ${s.thin} thin, ${s.closed} closed (no bars written), ${s.missing} missing. Click to jump.`;
  return (
    <div className="covstrip" title={tip} role="img" aria-label={tip} onClick={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0) return;
      const t = from + ((e.clientX - rect.left) / rect.width) * (to - from);
      const chart = registry.charts.get(id);
      if (chart) safeRange(chart, { from: t - 2 * 86_400_000, to: t + 2 * 86_400_000 });
    }}>
      {cov.days.map((d) => <i key={d.day} className={d.status} title={`${d.day}: ${d.status === "closed" ? "closed (0 bars written)" : d.status === "missing" ? "MISSING: no day file" : d.status === "thin" ? `partial day (${d.bars} bars)` : `${d.bars} bars`}`} />)}
      {view && <span className="view" style={{ left: `${view.l}%`, width: `${view.w}%` }} />}
    </div>
  );
}

interface PriceChartProps {
  stream: Stream; win: { from: number; to: number }; runId: string; registry: Registry; trips: RoundTrip[]; tripsReady: boolean;
  maximized: boolean; onMax(): void; onHide(): void; onSelect(t: RoundTrip): void;
}

export function PriceChart({ stream, win, runId, registry, trips, tripsReady, maximized, onMax, onHide, onSelect }: PriceChartProps) {
  const plot = useRef<HTMLDivElement>(null);
  const parts = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick">; prim: TradesPrimitive; splitPrim: SplitPrimitive; tfMs: number; first: number; last: number } | null>(null);
  const id = keyOf(stream);
  const selected = useStore((s) => s.selectedTrip);
  const focus = useStore((s) => s.focus);
  const theme = useStore((s) => s.theme);
  const split = useAgent((s) => s.split);
  const [info, setInfo] = useState<{ count: number; source: number; missing: number; error?: string } | null>(null);
  const [hover, setHover] = useState<string>("");
  const [tip, setTip] = useState<{ trip: RoundTrip; x: number; y: number } | null>(null);
  const [ready, setReady] = useState(0);
  const cb = useRef({ onSelect });
  cb.current = { onSelect };
  const sym = `${stream.broker}:${stream.symbol}`;
  const mine = useMemo(() => trips.filter((t) => t.symbol === sym || t.symbol === stream.symbol), [trips, sym, stream.symbol]);
  // colour entry markers by strategy only when this chart actually has more than one, so a plain strategy's chart never changes
  const stratColor = useMemo(() => (new Set(mine.map((t) => t.strategy)).size > 1 ? strategyColor : null), [mine]);

  useEffect(() => {
    if (!plot.current) return;
    const chart = createChart(plot.current, {
      autoSize: true, crosshair: { mode: CrosshairMode.Normal },
      layout: { background: { type: ColorType.Solid, color: cssVar("--main") }, textColor: cssVar("--ink-2"), fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: cssVar("--grid") }, horzLines: { color: cssVar("--grid") } },
      rightPriceScale: { borderColor: cssVar("--axis") }, timeScale: { borderColor: cssVar("--axis"), timeVisible: true, secondsVisible: false, minBarSpacing: 0.01, rightOffset: 2 },
    });
    const up = cssVar("--ck-up"), dn = cssVar("--ck-dn");
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceLineVisible: false, lastValueVisible: true });
    const prim = new TradesPrimitive();
    series.attachPrimitive(prim);
    const splitPrim = new SplitPrimitive();
    series.attachPrimitive(splitPrim);
    parts.current = { chart, series, prim, splitPrim, tfMs: 0, first: 0, last: 0 };
    registry.charts.set(id, chart);
    (plot.current as HTMLDivElement & { __chart?: IChartApi; __prim?: TradesPrimitive }).__chart = chart;
    (plot.current as HTMLDivElement & { __prim?: TradesPrimitive }).__prim = prim;

    const onRange = (r: { from: Time; to: Time } | null) => {
      if (!r || registry.lock) return;
      if (registry.runId !== null && registry.range !== null) registry.range = { from: (r.from as number) * 1000, to: (r.to as number) * 1000 };
      registry.lock = true;
      try { for (const [k, c] of registry.charts) if (k !== id) safeRange(c, { from: (r.from as number) * 1000, to: (r.to as number) * 1000 }); } finally { registry.lock = false; }
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(series) as { open: number; high: number; low: number; close: number } | undefined;
      setHover(d && p.time ? `${fmtTs((p.time as number) * 1000)}  O ${fmtPrice(d.open)}  H ${fmtPrice(d.high)}  L ${fmtPrice(d.low)}  C ${fmtPrice(d.close)}` : "");
      const t = p.point ? prim.tripAt(p.point.x, p.point.y) : null;
      prim.setHover(t?.id ?? null);
      setTip((cur) => (t && p.point ? { trip: t, x: p.point.x, y: p.point.y } : cur ? null : cur));
      if (plot.current) plot.current.style.cursor = t ? "pointer" : "";
    });
    chart.subscribeClick((p) => { const t = p.point ? prim.tripAt(p.point.x, p.point.y) : null; if (t) cb.current.onSelect(t); });
    setReady((n) => n + 1);
    return () => {
      try { chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange); } catch { /* removed */ }
      registry.charts.delete(id); parts.current = null;
      try { chart.remove(); } catch { /* already disposed by a fast double toggle */ }
    };
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
      parts.current.first = cols.ts[0] ?? win.from; parts.current.last = cols.ts[cols.ts.length - 1] ?? win.to;
      setInfo({ count: cols.ts.length, source: sourceCount, missing: missingDays });
      setReady((n) => n + 1);
    }).catch((e: Error) => live && setInfo({ count: 0, source: 0, missing: 0, error: e.message }));
    return () => { live = false; };
  }, [id, win.from, win.to, runId]);

  // the first view of a run: the first trades, readable, not the whole window squeezed in. Later charts copy it.
  useEffect(() => {
    const p = parts.current;
    if (!p || !p.tfMs || !info || info.error) return;
    if (registry.runId === runId && registry.range) { safeRange(p.chart, registry.range); return; }
    if (!tripsReady) return;
    const r = firstTradesRange(mine, p.tfMs, p.first, p.last);
    registry.runId = runId; registry.range = r; registry.tfMs = p.tfMs;
    if (!safeRange(p.chart, r)) { try { p.chart.timeScale().fitContent(); } catch { /* no data */ } }
  }, [info, tripsReady, runId, id]);

  // paint trades
  useEffect(() => {
    const p = parts.current;
    if (!p || !p.tfMs) return;
    p.prim.set(mine, p.tfMs, selected?.id ?? null, colors(), win.to - 1, stratColor);
  }, [mine, selected?.id, ready, theme, win.to, stratColor]);

  // the test part shading: where the split's cut falls in this run's trades, from the server (no re-run: same
  // rule the split chip and the parts stats use). Re-fetched whenever the run or the split setting changes.
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    if (!runId) { p.splitPrim.setCut(null); return; }
    void api.runParts(runId).then((r) => parts.current?.splitPrim.setCut(r.cut ? Date.parse(`${r.cut}T00:00:00Z`) : null))
      .catch(() => parts.current?.splitPrim.setCut(null));
  }, [runId, split?.text, ready]);

  useEffect(() => {
    const p = parts.current;
    if (!p || !focus || !p.tfMs) return;
    if (!safeRange(p.chart, { from: focus.from, to: focus.to })) { /* range outside loaded bars */ }
  }, [focus?.nonce]);

  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    p.chart.applyOptions({ layout: { background: { type: ColorType.Solid, color: cssVar("--main") }, textColor: cssVar("--ink-2") }, grid: { vertLines: { color: cssVar("--grid") }, horzLines: { color: cssVar("--grid") } }, rightPriceScale: { borderColor: cssVar("--axis") }, timeScale: { borderColor: cssVar("--axis") } });
    const up = cssVar("--ck-up"), dn = cssVar("--ck-dn");
    p.series.applyOptions({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn });
    p.prim.set(mine, p.tfMs || 60_000, selected?.id ?? null, colors(), win.to - 1, stratColor);
  }, [theme]);

  const t = tip?.trip;
  return (
    <div className={`chart-cell${maximized ? " maximized" : ""}`} data-chart={id}>
      <div className="cap">
        <b>{stream.symbol}</b><span className="ink2">{stream.tf}</span><span className="muted">{stream.broker}</span>
        {info && !info.error && <span className="muted" title={info.source !== info.count ? `Aggregated from ${info.source} bars for display` : ""}>{info.count.toLocaleString()} bars{info.source !== info.count ? ` (of ${info.source.toLocaleString()})` : ""}</span>}
        {info?.error && <span className="badge bad" title={info.error}>no bars: {info.error}</span>}
        {info && info.missing > 0 && <span className="badge warn" title="Days in this window with no bar file. The chart shows no candles there.">{info.missing} day(s) not built</span>}
        <span className="badge" title="Trades shown on this chart (after the filters)">{mine.length.toLocaleString()} trade{mine.length === 1 ? "" : "s"}</span>
        <span className="mono muted ohlc">{hover}</span>
        <span style={{ flex: 1 }} />
        <span className="cap-actions">
          <Tip label={maximized ? "Restore this chart" : "Expand this chart to the whole pane"} side="bottom"><button className="btn ghost icon sm" aria-label={maximized ? `Restore ${stream.symbol} ${stream.tf}` : `Expand ${stream.symbol} ${stream.tf}`} onClick={onMax}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button></Tip>
          <Tip label="Close this chart (reopen it from Charts)" side="bottom"><button className="btn ghost icon sm" aria-label={`Close ${stream.symbol} ${stream.tf} chart`} onClick={onHide}><X size={14} /></button></Tip>
        </span>
      </div>
      <div ref={plot} className="plot" />
      {t && tip && (
        <div className="trade-tip" role="tooltip" style={{ left: Math.min(tip.x + 14, (plot.current?.clientWidth ?? 600) - 210), top: Math.max(30, tip.y - 8) }}>
          <b>{t.side === "long" ? "▲ Long" : "▼ Short"} {t.symbol.split(":").pop()} · {t.qty} lots{stratColor && <span style={{ color: strategyColor(t.strategy) }}> · {strategyAlias(t.strategy)}</span>}</b>
          <span>{fmtTs(t.entryTs)} → {t.open ? "open" : fmtTs(t.exitTs)}</span>
          <span>{fmtPrice(t.entryPx)} → {t.exitPx === null ? "—" : fmtPrice(t.exitPx)} · {t.open ? "open" : t.exit}</span>
          <span className={t.pnl >= 0 ? "gain" : "loss"}>{fmtMoney(t.pnl)}{t.r !== undefined ? ` · ${fmtR(t.r)}` : ""} · held {fmtDur(t.holdMs)}</span>
          <span className="muted">{t.risk !== undefined ? `risk ${fmtMoney(t.risk).replace("+", "")}` : "no stop set"}{t.sl !== undefined ? ` · SL ${fmtPrice(t.sl)}` : ""}{t.tp !== undefined ? ` · TP ${fmtPrice(t.tp)}` : ""}</span>
          <em>click to inspect</em>
        </div>
      )}
      <CoverageStrip stream={stream} from={win.from} to={win.to} registry={registry} id={id} />
    </div>
  );
}

export function ChartsBody({ onOpenJournal }: { onOpenJournal(): void }) {
  const results = useStore((s) => s.results), resultsStale = useStore((s) => s.resultsStale), run = useStore((s) => s.run), running = useStore((s) => s.running);
  const selected = useStore((s) => s.selectedTrip), selectTrip = useStore((s) => s.selectTrip);
  const prefs = useChartPrefs();
  const [extra, setExtra] = useState<Stream[]>([]);
  const [maxed, setMaxed] = useState<string | null>(null);
  const [tfOptions, setTfOptions] = useState<Array<{ broker: string; symbol: string; tfs: string[] }>>([]);
  const registry = useRef<Registry>({ charts: new Map(), lock: false, runId: null, range: null, tfMs: 900_000 }).current;
  const meta: RunMeta | null = results?.meta ?? null;
  const win = useMemo(() => (meta ? { from: Date.parse(meta.from + "T00:00:00Z"), to: Date.parse(meta.to + "T00:00:00Z") } : null), [meta?.from, meta?.to]);
  const trips = useRunTrips(results?.runId, win);

  const all = useMemo(() => {
    const seen = new Set<string>();
    // an added chart of a run's symbol reads the run's bar base when that divides it, as qkt would aggregate it
    const baseOf = (s: Stream) => {
      const b = meta?.streams.find((m) => m.broker === s.broker && m.symbol === s.symbol)?.base;
      const t = tfMs(s.tf), bt = b ? tfMs(b) : null;
      return b && t && bt && t % bt === 0 ? b : undefined;
    };
    return [...(meta?.streams ?? []), ...extra.map((s) => ({ ...s, base: baseOf(s) }))].filter((s) => { const k = keyOf(s); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [meta, extra]);
  const sorted = useMemo(() => ordered(all, keyOf, prefs.order), [all, prefs.order]);
  const shown = useMemo(() => sorted.filter((s) => !prefs.hidden.includes(keyOf(s))), [sorted, prefs.hidden]);
  const active = prefs.layout === "tabs" ? (shown.find((s) => keyOf(s) === prefs.activeKey) ?? shown[0]) : null;
  const visible = prefs.layout === "tabs" ? (active ? [active] : []) : shown;

  useEffect(() => { setExtra([]); setMaxed(null); registry.runId = null; registry.range = null; }, [results?.runId]);
  useEffect(() => {
    if (!meta) return;
    api.barsSymbols().then((r) => {
      const want = new Set(meta.streams.map((s) => `${s.broker}:${s.symbol}`));
      setTfOptions(r.symbols.filter((s) => want.has(`${s.broker}:${s.symbol}`)).map((s) => ({ broker: s.broker, symbol: s.symbol, tfs: s.timeframes })));
    }).catch(() => setTfOptions([]));
  }, [meta?.runId]);

  const rows = trips.rows;
  // the charts show every symbol's trades on its own chart; the list honours the symbol filter too
  const symFilter = useStore((s) => s.filters.symbol);
  const listRows = useMemo(() => (symFilter ? rows.filter((t) => t.symbol === symFilter) : rows), [rows, symFilter]);
  const idx = selected ? rows.findIndex((t) => t.id === selected.id) : -1;
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const next = idx < 0 ? (d === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + d));
    const t = rows[next];
    if (t) selectTrip(t, true);
  };
  const pick = (t: RoundTrip, fromChart: boolean) => selectTrip(t, fromChart ? prefs.follow : true);

  const onKey = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "]") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft" || e.key === "[") { e.preventDefault(); step(-1); }
    else if (e.key === "Escape" && selected) { e.preventDefault(); selectTrip(null); }
  };

  const goFirst = () => {
    const first = [...registry.charts.values()][0];
    if (!first || !win) return;
    const stream = visible[0] ?? all[0];
    const mine = rows.filter((t) => !stream || t.symbol === `${stream.broker}:${stream.symbol}` || t.symbol === stream.symbol);
    const r = firstTradesRange(mine, registry.tfMs, win.from, win.to);
    registry.range = r; safeRange(first, r);
  };
  const fitAll = () => { const first = [...registry.charts.values()][0]; try { first?.timeScale().fitContent(); } catch { /* no data */ } };

  if (!results || !meta || !win) {
    return (
      <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
        {running ? <><span className="spin" /><b>Running…</b>The chart appears here when the run finishes.</>
          : run?.status === "failed" ? <><b>The last run failed.</b>Open the Pipeline tab to see which step stopped it.</>
          : <><b>Nothing to show yet</b>Run a strategy to see its candles with every entry, exit and trade box, one chart per timeframe.</>}
      </div>
    );
  }
  const addable = tfOptions.flatMap((o) => o.tfs.filter((tf) => !all.some((s) => s.broker === o.broker && s.symbol === o.symbol && s.tf === tf)).map((tf) => ({ broker: o.broker, symbol: o.symbol, tf })));
  const inChartTab = prefs.tab === "chart";

  return (
    <div className={`chart-body${resultsStale ? " dim" : ""}`} tabIndex={0} role="region" aria-label="Candlestick chart with trades" onKeyDown={onKey}>
      <ChartToolbar
        streams={sorted} hidden={prefs.hidden} layout={prefs.layout} follow={prefs.follow} tab={prefs.tab} addable={addable} extra={extra}
        activeKey={active ? keyOf(active) : null} count={rows.length} total={trips.total} index={idx} truncated={trips.truncated}
        onToggle={(k) => prefs.toggle(k)} onMove={(k, i) => prefs.move(k, i, sorted.map(keyOf))} onLayout={(l) => prefs.set({ layout: l })}
        onFollow={(v) => prefs.set({ follow: v })} onTab={(t) => prefs.set({ tab: t })} onActive={(k) => prefs.set({ activeKey: k })}
        onAdd={(s) => setExtra((x) => [...x, s])} onRemoveExtra={(k) => setExtra((x) => x.filter((y) => keyOf(y) !== k))}
        onPrev={() => step(-1)} onNext={() => step(1)} onFirst={goFirst} onFit={fitAll}
      />
      {meta.strategies.length > 1 && <StrategyLegend ids={meta.strategies} />}
      <div className="chart-area" data-layout={prefs.layout} style={{ display: inChartTab ? undefined : "none" }}>
        {shown.length === 0 && <div className="empty" style={{ flex: 1 }}><b>All charts are hidden</b>Turn one on from <em>Charts</em> in the toolbar.</div>}
        {visible.map((s) => (
          <PriceChart key={keyOf(s)} stream={s} win={win} runId={results.runId} registry={registry} trips={rows} tripsReady={trips.ready}
            maximized={maxed === keyOf(s)} onMax={() => setMaxed(maxed === keyOf(s) ? null : keyOf(s))}
            onHide={() => { if (maxed === keyOf(s)) setMaxed(null); prefs.toggle(keyOf(s)); }} onSelect={(t) => pick(t, true)} />
        ))}
      </div>
      {!inChartTab && <TradesTab rows={listRows} selectedId={selected?.id ?? null} onSelect={(t) => pick(t, false)}
        all={results.summary.trades + results.summary.openTrades} matched={trips.truncated && !symFilter ? trips.total : null} />}
      <TradeStrip trip={selected} index={idx} count={rows.length} startBalance={results.equity.equity[0] ?? 0} multi={meta.strategies.length > 1} onPrev={() => step(-1)} onNext={() => step(1)} onClose={() => selectTrip(null)} />
      <span hidden>{String(!!onOpenJournal)}</span>
    </div>
  );
}
