import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent, MarkAreaComponent, VisualMapComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useStore } from "../state/store.js";
import { DASH, fmtMoney, fmtNum } from "../util/format.js";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, DataZoomComponent, CanvasRenderer]);

export const tok = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const reduce = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Quiet chart chrome: recessive grid, muted labels, an ink tooltip, short animation so changes are visible but never slow. */
export function chartBase(over: echarts.EChartsCoreOption = {}): echarts.EChartsCoreOption {
  const ink3 = tok("--ink-3"), grid = tok("--grid"), axis = tok("--axis");
  return {
    animation: !reduce(), animationDuration: 350, animationDurationUpdate: 380, animationEasing: "cubicOut", animationEasingUpdate: "cubicOut",
    backgroundColor: "transparent", textStyle: { color: ink3, fontFamily: tok("--font") || "system-ui" },
    grid: { left: 44, right: 12, top: 14, bottom: 22 },
    tooltip: { trigger: "axis", backgroundColor: tok("--card-3"), borderColor: tok("--line-2"), borderWidth: 1, padding: [8, 10], textStyle: { color: tok("--ink"), fontSize: 12 }, axisPointer: { type: "line", lineStyle: { color: axis } }, confine: true, transitionDuration: 0.1, extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-variant-numeric:tabular-nums" },
    xAxis: { axisLine: { lineStyle: { color: axis } }, axisTick: { show: false }, axisLabel: { color: ink3, fontSize: 11 }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: ink3, fontSize: 11, formatter: (v: number) => compactMoney(v) }, splitLine: { lineStyle: { color: grid } } },
    ...over,
  };
}

/** 1200 -> 1.2k, so axis labels stay short and the tooltip carries the exact figure. */
export const compactMoney = (v: number): string => (Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(0)}k` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Tooltip body: a title, one headline figure (signed, coloured, with a glyph so colour is never the only signal) and aligned rows. */
export function tipHtml(title: string, headline: { value: number; text: string } | null, rows: Array<[string, string]>, hint?: string): string {
  const gain = tok("--gain-ink"), loss = tok("--loss-ink"), muted = tok("--ink-3");
  const head = headline ? `<div style="font-size:15px;font-weight:650;margin:2px 0 4px;color:${headline.value >= 0 ? gain : loss}">${headline.value > 0 ? "▲ " : headline.value < 0 ? "▼ " : ""}${esc(headline.text)}</div>` : "";
  const body = rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:${muted}">${esc(k)}</span><b style="font-weight:600">${esc(v)}</b></div>`).join("");
  return `<div style="min-width:170px"><div style="color:${muted};font-size:11px">${esc(title)}</div>${head}${body}${hint ? `<div style="margin-top:6px;color:${muted};font-size:11px">${esc(hint)}</div>` : ""}</div>`;
}

/**
 * Wheel/drag zoom plus a slider under the plot, for charts with many points. Below `min` points the whole series fits and
 * the controls would only add noise, so nothing is added and the grid keeps its normal bottom margin.
 */
export function zoomOptions(n: number, min = 24): { dataZoom?: echarts.EChartsCoreOption["dataZoom"]; grid?: object } {
  if (n < min) return {};
  return {
    grid: { left: 44, right: 12, top: 14, bottom: 48 },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false, minValueSpan: 5 },
      { type: "slider", xAxisIndex: 0, filterMode: "none", height: 18, bottom: 6, borderColor: "transparent", backgroundColor: tok("--card-2"), fillerColor: tok("--accent-soft"), handleSize: "110%",
        handleStyle: { color: tok("--card-3"), borderColor: tok("--ctl") }, moveHandleStyle: { color: tok("--ctl") }, dataBackground: { lineStyle: { color: tok("--axis") }, areaStyle: { color: tok("--grid") } },
        selectedDataBackground: { lineStyle: { color: tok("--accent-hi") }, areaStyle: { color: tok("--accent-soft") } }, textStyle: { color: tok("--ink-3"), fontSize: 10 }, brushSelect: false },
    ],
  };
}

export interface ChartHandle { resetZoom(): void }
export interface ZoomRange { start: number; end: number }

/** ECharts host. `build` is re-run on data or theme change and merged, so the same chart animates between states. */
export const Chart = forwardRef<ChartHandle, { build: () => echarts.EChartsCoreOption; height: number; deps: unknown[]; label: string; onClick?: (p: { dataIndex: number; name: string }) => void; onZoom?: (r: ZoomRange) => void; testId?: string }>(function Chart({ build, height, deps, label, onClick, onZoom, testId }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const cb = useRef(onClick), zb = useRef(onZoom);
  cb.current = onClick; zb.current = onZoom;
  const theme = useStore((s) => s.theme);
  useImperativeHandle(ref, () => ({ resetZoom: () => chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 }) }), []);
  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const c = echarts.init(host, undefined, { renderer: "canvas" });
    chart.current = c;
    // The whole column under the pointer is the click target (a day is only a few pixels wide): map the pixel to the category.
    c.getZr().on("click", (ev: { offsetX: number; offsetY: number }) => {
      if (!cb.current) return;
      const pt: [number, number] = [ev.offsetX, ev.offsetY];
      if (!c.containPixel({ gridIndex: 0 }, pt)) return;
      const conv = c.convertFromPixel({ xAxisIndex: 0 }, ev.offsetX) as number | number[];
      const idx = Array.isArray(conv) ? conv[0] : conv;
      if (idx === undefined || !Number.isFinite(idx)) return;
      const i = Math.round(idx);
      const cats = ((c.getOption() as { xAxis?: Array<{ data?: unknown[] }> }).xAxis?.[0]?.data) ?? [];
      if (cats.length && (i < 0 || i >= cats.length)) return;
      cb.current({ dataIndex: i, name: String(cats[i] ?? "") });
    });
    c.on("datazoom", () => { const z = (c.getOption() as { dataZoom?: Array<{ start?: number; end?: number }> }).dataZoom?.[0]; if (z && z.start !== undefined && z.end !== undefined) zb.current?.({ start: z.start, end: z.end }); });
    // a hidden or collapsing container reports 0x0: resizing then throws inside zrender and blanks the chart
    const ro = new ResizeObserver(() => { if (host.clientWidth > 0 && host.clientHeight > 0 && !c.isDisposed()) { try { c.resize(); } catch { /* mid-collapse; the next observation fixes it */ } } });
    ro.observe(host);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);
  useEffect(() => { const c = chart.current; if (c && !c.isDisposed()) c.setOption(build(), { notMerge: false, lazyUpdate: true }); }, [theme, ...deps]);
  return <div ref={el} role="img" aria-label={label} data-testid={testId} style={{ width: "100%", height }} />;
});

export function Widget({ title, icon, right, children, className = "", style }: { title: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <section className={`widget ${className}`} style={style} aria-label={title}>
      <div className="wh">{icon}<span>{title}</span><span className="grow" />{right}</div>
      {children}
    </section>
  );
}

/** Smooth donut. Colours are paired with text, never the only signal. */
export function Ring({ parts, size = 112, center, sub }: { parts: Array<{ value: number; color: string; label: string }>; size?: number; center: string; sub?: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const r = size / 2 - 9, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tok("--card-2")} strokeWidth={9} />
        {parts.map((p, i) => {
          const len = (p.value / total) * c, seg = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={9} strokeLinecap="butt"
              strokeDasharray={`${Math.max(0, len - (parts.length > 1 && p.value ? 2 : 0))} ${c}`} strokeDashoffset={-off} style={{ transition: "stroke-dasharray 0.4s var(--ease), stroke-dashoffset 0.4s var(--ease)" }} />);
          off += len; return seg;
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div><div style={{ fontSize: "var(--fs-xl)", fontWeight: 650, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{center}</div>{sub && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{sub}</div>}</div>
      </div>
    </div>
  );
}

/** Half-circle gauge for a ratio (profit factor). `max` is where the arc is full; 1.0 is marked as break-even. */
export function Gauge({ value, max = 3, label }: { value: number | null; max?: number; label: string }) {
  const w = 132, h = 78, r = 54, cx = w / 2, cy = 68;
  const arc = (from: number, to: number) => { const a = (t: number) => Math.PI * (1 - t); const p = (t: number) => `${cx + r * Math.cos(a(t))} ${cy - r * Math.sin(a(t))}`; return `M ${p(from)} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${p(to)}`; };
  const t = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const good = (value ?? 0) >= 1;
  return (
    <div style={{ position: "relative", width: w, height: h, flex: "none" }} role="img" aria-label={`${label}: ${value === null ? "no losing trades" : value.toFixed(2)}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <path d={arc(0, 1)} fill="none" stroke={tok("--card-2")} strokeWidth={9} strokeLinecap="round" />
        <path d={arc(0, Math.max(t, 0.001))} fill="none" stroke={good ? tok("--gain") : tok("--loss")} strokeWidth={9} strokeLinecap="round" style={{ transition: "d 0.4s var(--ease)" }} />
        <line x1={cx + (r - 8) * Math.cos(Math.PI * (1 - 1 / max))} y1={cy - (r - 8) * Math.sin(Math.PI * (1 - 1 / max))} x2={cx + (r + 6) * Math.cos(Math.PI * (1 - 1 / max))} y2={cy - (r + 6) * Math.sin(Math.PI * (1 - 1 / max))} stroke={tok("--ink-3")} strokeWidth={1.5} />
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, textAlign: "center", fontSize: "var(--fs-xl)", fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{value === null ? "∞" : value.toFixed(2)}</div>
    </div>
  );
}

/** Tiny area sparkline drawn behind a KPI. Purely decorative (aria-hidden); the number beside it is the data. */
export function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const w = 160, h = 44, lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - lo) / span) * (h - 10)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={color} opacity="0.12" /><path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface BarItem { key: string; label: string; value: number; sub?: string; count?: number }
/** Horizontal bars centred on zero: gains grow right in the gain colour, losses left in the loss colour, with the value printed. */
export function SignedBars({ items, onPick, active, fmt = (v: number) => fmtMoney(v, 0), compact }: { items: BarItem[]; onPick?: (k: string) => void; active?: string | null; fmt?: (v: number) => string; compact?: boolean }) {
  const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.value)));
  return (
    <div className="bars-list">
      {items.map((i) => {
        const pct = (Math.abs(i.value) / max) * 50;
        return (
          <div key={i.key} className={`bar-row${onPick ? " click" : ""}${compact ? " compact" : ""}`} role={onPick ? "button" : undefined} tabIndex={onPick ? 0 : undefined} aria-pressed={onPick ? active === i.key : undefined}
            onClick={() => onPick?.(i.key)} onKeyDown={(e) => { if (onPick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(i.key); } }} style={compact ? undefined : { gridTemplateColumns: "84px 1fr 96px" }}>
            <span className="ink2" style={{ whiteSpace: "nowrap" }}>{i.label}</span>
            <span className="track"><span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: tok("--axis") }} />
              <span className="fill" style={{ background: i.value >= 0 ? "var(--gain)" : "var(--loss)", left: i.value >= 0 ? "50%" : `${50 - pct}%`, width: `${pct}%` }} /></span>
            <span className={`num ${i.value >= 0 ? "gain" : "loss"}`} style={{ textAlign: "right" }}>{i.count !== undefined ? <span className="muted">{i.count} · </span> : null}{fmt(i.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

export const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s3)", padding: "3px 0", borderBottom: "1px solid var(--line)" }}>
    <span className="ink2">{label}</span><span className={`num ${tone ?? ""}`} style={{ fontWeight: 600 }}>{value}</span>
  </div>
);
export const pf = (a: { grossWin: number; grossLoss: number }) => (a.grossLoss < 0 ? fmtNum(a.grossWin / -a.grossLoss) : a.grossWin > 0 ? "∞" : DASH);
