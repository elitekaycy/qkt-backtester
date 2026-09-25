import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent, MarkAreaComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useStore } from "../state/store.js";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

export const tok = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Shared chart chrome: recessive grid, muted axis labels, ink tooltip, no animation. */
export function baseOption(over: echarts.EChartsCoreOption = {}): echarts.EChartsCoreOption {
  const ink2 = tok("--ink-2"), ink3 = tok("--ink-3"), grid = tok("--grid"), axis = tok("--axis");
  return {
    animation: false, backgroundColor: "transparent", textStyle: { color: ink2, fontFamily: tok("--font") || "system-ui" },
    grid: { left: 52, right: 12, top: 12, bottom: 24 },
    tooltip: { trigger: "axis", backgroundColor: tok("--surface-3"), borderColor: tok("--border"), textStyle: { color: tok("--ink"), fontSize: 12 }, axisPointer: { type: "line", lineStyle: { color: axis } }, confine: true },
    xAxis: { axisLine: { lineStyle: { color: axis } }, axisTick: { show: false }, axisLabel: { color: ink3, fontSize: 11 }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: ink3, fontSize: 11 }, splitLine: { lineStyle: { color: grid } }, scale: true },
    ...over,
  };
}

/** Thin wrapper: build the option from a function so it re-reads theme tokens when the theme changes. */
export function EChart({ build, height, deps, testId }: { build: () => echarts.EChartsCoreOption; height: number; deps: unknown[]; testId?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);
  useEffect(() => { chart.current?.setOption(build(), true); }, [theme, ...deps]);
  return <div ref={el} className="chart-box" style={{ height }} data-testid={testId} />;
}
