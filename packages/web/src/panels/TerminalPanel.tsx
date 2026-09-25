import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "../api/client.js";
import { useStore } from "../state/store.js";

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export function TerminalPanel() {
  const host = useRef<HTMLDivElement>(null);
  const theme = useStore((s) => s.theme);
  const [mode, setMode] = useState<"shell" | "restricted" | "…">("…");
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [nonce, setNonce] = useState(0);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ fontSize: 12, fontFamily: "ui-monospace, Menlo, Consolas, monospace", cursorBlink: true, convertEol: true, theme: { background: css("--surface"), foreground: css("--ink"), cursor: css("--ink"), selectionBackground: "#3987e566" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    const doFit = () => { try { fit.fit(); } catch { /* not laid out yet */ } };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(host.current);

    const ws = new WebSocket(wsUrl("/ws/term"));
    let restricted = false, line = "", running = false;
    const hist: string[] = []; let hi = 0;
    const prompt = () => term.write("\x1b[32m$\x1b[0m ");
    ws.onopen = () => setState("open");
    ws.onclose = () => { setState("closed"); term.writeln("\r\n\x1b[90m[disconnected]\x1b[0m"); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; d?: string; mode?: "shell" | "restricted"; code?: number };
      if (m.t === "hello") {
        setMode(m.mode!); restricted = m.mode === "restricted";
        if (restricted) { term.writeln("qkt terminal (restricted): parse, backtest, sweep, walkforward, data, fetch, experiment. Example: qkt parse strategies/x.qkt"); prompt(); }
      } else if (m.t === "out") term.write(m.d ?? "");
      else if (m.t === "exit") { running = false; if (restricted) { term.writeln(m.code ? `\x1b[90m[exit ${m.code}]\x1b[0m` : ""); prompt(); } }
    };
    term.onData((d) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!restricted) { ws.send(JSON.stringify({ t: "in", d })); return; }
      if (d === "\x03") { if (running) ws.send(JSON.stringify({ t: "interrupt" })); else { line = ""; term.write("^C\r\n"); prompt(); } return; }
      if (running) return;
      if (d === "\r") {
        term.write("\r\n");
        const cmd = line.trim(); line = "";
        if (cmd) { hist.push(cmd); hi = hist.length; running = true; ws.send(JSON.stringify({ t: "cmd", line: cmd })); } else prompt();
      } else if (d === "\x7f") { if (line) { line = line.slice(0, -1); term.write("\b \b"); } }
      else if (d === "\x1b[A" || d === "\x1b[B") {
        hi = Math.max(0, Math.min(hist.length, hi + (d === "\x1b[A" ? -1 : 1)));
        term.write("\b \b".repeat(line.length)); line = hist[hi] ?? ""; term.write(line);
      } else if (d >= " " && !d.startsWith("\x1b")) { line += d; term.write(d); }
    });
    return () => { ro.disconnect(); ws.close(); term.dispose(); termRef.current = null; };
  }, [nonce]);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = { background: css("--surface"), foreground: css("--ink"), cursor: css("--ink"), selectionBackground: "#3987e566" }; }, [theme]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Terminal</span>
        <span className="badge">{mode === "shell" ? "shell" : mode === "restricted" ? "qkt only" : "…"}</span>
        <span className="muted">cwd = workspace · QKT_DATA_HOME set</span>
        <span className="grow" />
        {state === "closed" && <button className="btn sm" onClick={() => setNonce((n) => n + 1)}>Reconnect</button>}
      </div>
      <div className="term-wrap"><div ref={host} style={{ height: "100%" }} /></div>
    </div>
  );
}
