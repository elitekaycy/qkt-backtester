import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { DockviewReact, DockviewReadyEvent, IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import * as monaco from "monaco-editor/editor/editor.api.js";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { createHighlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import qktGrammar from "./qkt.tmLanguage.json";
import { createChart, CandlestickSeries, createSeriesMarkers, ColorType } from "lightweight-charts";
import * as echarts from "echarts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

(self as any).MonacoEnvironment = { getWorker: () => new editorWorker() };
const probe: Record<string, unknown> = ((window as any).__spike = { ready: {} });
const ok = (k: string, v: unknown) => ((probe.ready as any)[k] = v);
const data = fetch("/spike-data.json").then((r) => r.json());

function EditorPanel() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (async () => {
      const text = await (await fetch("/sample.qkt")).text();
      monaco.languages.register({ id: "qkt" });
      const hl = await createHighlighter({ themes: ["github-dark"], langs: [{ ...(qktGrammar as any), name: "qkt" }] });
      shikiToMonaco(hl, monaco);
      const ed = monaco.editor.create(el.current!, { value: text, language: "qkt", theme: "github-dark", automaticLayout: true, minimap: { enabled: false } });
      // marker = what LSP diagnostics would drive
      monaco.editor.setModelMarkers(ed.getModel()!, "qkt-lsp", [{ severity: monaco.MarkerSeverity.Error, message: "expected ABOVE or BELOW", startLineNumber: 7, startColumn: 37, endLineNumber: 7, endColumn: 41 }]);
      setTimeout(() => {
        const toks = new Set<string>();
        el.current!.querySelectorAll(".view-line span span").forEach((s) => toks.add((s as HTMLElement).style.color));
        ok("monacoDistinctTokenColors", toks.size);
        ok("monacoSquiggles", el.current!.querySelectorAll(".squiggly-error").length);
      }, 800);
    })();
  }, []);
  return <div ref={el} style={{ height: "100%" }} />;
}

class BoxPrimitive {
  n = 0;
  constructor(private trips: any[]) {}
  attached(p: any) { this.p = p; }
  p: any;
  updateAllViews() {}
  paneViews() {
    const self = this;
    return [{ zOrder: () => "bottom" as const, renderer: () => ({ draw: (target: any) => target.useBitmapCoordinateSpace((s: any) => {
      const ts = self.p.chart.timeScale(); let n = 0;
      for (const t of self.trips) {
        const x1 = ts.timeToCoordinate(t.t), x2 = ts.timeToCoordinate(t.xt);
        const y1 = self.p.series.priceToCoordinate(t.p), y2 = self.p.series.priceToCoordinate(t.xp);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        s.context.fillStyle = t.pnl >= 0 ? "rgba(38,166,154,.25)" : "rgba(239,83,80,.25)";
        s.context.fillRect(x1 * s.horizontalPixelRatio, Math.min(y1, y2) * s.verticalPixelRatio, (x2 - x1) * s.horizontalPixelRatio, Math.abs(y2 - y1) * s.verticalPixelRatio);
        n++;
      }
      self.n = n; (probe as any).boxesDrawn = n;
    }) }) }];
  }
}

function ChartPanel() {
  const a = useRef<HTMLDivElement>(null), b = useRef<HTMLDivElement>(null);
  useEffect(() => {
    data.then((d) => {
      const mk = (el: HTMLElement) => createChart(el, { autoSize: true, layout: { background: { type: ColorType.Solid, color: "#0d1117" }, textColor: "#c9d1d9" }, grid: { vertLines: { color: "#1f2630" }, horzLines: { color: "#1f2630" } } });
      const c1 = mk(a.current!), c2 = mk(b.current!);
      const s1 = c1.addSeries(CandlestickSeries), s2 = c2.addSeries(CandlestickSeries);
      s1.setData(d.bars);
      // derive 1h bars from 15m to prove multi-timeframe
      const h: any[] = [];
      for (const x of d.bars) { const t = Math.floor(x.time / 3600) * 3600; const l = h[h.length - 1]; if (l && l.time === t) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; } else h.push({ ...x, time: t }); }
      s2.setData(h);
      const prim = new BoxPrimitive(d.trips); s1.attachPrimitive(prim as any);
      createSeriesMarkers(s1, d.trips.flatMap((t: any) => [
        { time: t.t, position: "belowBar", shape: "arrowUp", color: "#26a69a" },
        { time: t.xt, position: "aboveBar", shape: "arrowDown", color: t.pnl >= 0 ? "#26a69a" : "#ef5350" }]));
      let lock = false;
      const link = (from: any, to: any) => from.timeScale().subscribeVisibleTimeRangeChange((r: any) => { if (lock || !r) return; lock = true; to.timeScale().setVisibleRange(r); lock = false; });
      link(c1, c2); link(c2, c1);
      c1.timeScale().setVisibleRange({ from: d.bars[300].time, to: d.bars[700].time });
      setTimeout(() => {
        const r2 = c2.timeScale().getVisibleRange() as any;
        ok("chartSyncTf15to1h", !!r2 && Math.abs(r2.from - d.bars[300].time) < 3600 * 2);
        ok("markers", d.trips.length * 2);
        ok("canvasCount", document.querySelectorAll("canvas").length);
        ok("bars15m", d.bars.length); ok("bars1h", h.length);
      }, 600);
    });
  }, []);
  return <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", height: "100%" }}><div ref={a} /><div ref={b} /></div>;
}

function ResultsPanel() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { data.then((d) => {
    const c = echarts.init(el.current!, "dark");
    c.setOption({ backgroundColor: "#0d1117", xAxis: { type: "time" }, yAxis: { type: "value", scale: true }, series: [{ type: "line", showSymbol: false, data: d.equity }], grid: { left: 50, right: 10, top: 20, bottom: 30 } });
    ok("echartsRendered", !!el.current!.querySelector("canvas"));
  }); }, []);
  return <div ref={el} style={{ height: "100%" }} />;
}

function TerminalPanel() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = new Terminal({ fontSize: 12, theme: { background: "#0d1117" } }); const f = new FitAddon(); t.loadAddon(f);
    t.open(el.current!); f.fit(); t.writeln("\x1b[32m$\x1b[0m qkt parse strategies/xau-ema.qkt"); t.writeln("ok");
    setTimeout(() => ok("xtermRows", el.current!.querySelectorAll(".xterm-rows > div").length), 300);
  }, []);
  return <div ref={el} style={{ height: "100%" }} />;
}

const components = { editor: EditorPanel, chart: ChartPanel, results: ResultsPanel, terminal: TerminalPanel };
function App() {
  const onReady = (e: DockviewReadyEvent) => {
    const ed = e.api.addPanel({ id: "editor", component: "editor", title: "xau-ema.qkt" });
    e.api.addPanel({ id: "terminal", component: "terminal", title: "Terminal", position: { referencePanel: ed, direction: "below" } });
    const ch = e.api.addPanel({ id: "chart", component: "chart", title: "Charts", position: { referencePanel: ed, direction: "right" } });
    e.api.addPanel({ id: "results", component: "results", title: "Results", position: { referencePanel: ch, direction: "right" } });
    (window as any).__dock = e.api;
    ok("dockPanels", e.api.panels.length);
  };
  return <DockviewReact className="dockview-theme-dark" components={components as any} onReady={onReady} />;
}
createRoot(document.getElementById("root")!).render(<App />);
