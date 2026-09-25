// Probe: drive `qkt lsp` over stdio like an editor would. Measures cold start,
// diagnostics latency after edits, error multiplicity, completion, hover, RSS.
import { spawn, execSync } from "node:child_process";

const proc = spawn("qkt", ["lsp"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0);
const waiters = [];
const seen = [];
proc.stderr.on("data", () => {});
proc.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, he).toString());
    const len = Number(m[1]);
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString());
    buf = buf.slice(he + 4 + len);
    seen.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.res(msg); }
  }
});
const send = (o) => { const s = JSON.stringify({ jsonrpc: "2.0", ...o }); proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
const wait = (pred, ms = 8000) => new Promise((res, rej) => { waiters.push({ pred, res }); setTimeout(() => rej(new Error("timeout")), ms); });
let id = 0;
const req = async (method, params) => { const i = ++id; send({ id: i, method, params }); return wait((m) => m.id === i); };
const uri = "file:///ws/strategies/t.qkt";
const t0 = performance.now();
const init = await req("initialize", { processId: process.pid, rootUri: "file:///ws", capabilities: {} });
console.log(`initialize: ${(performance.now() - t0).toFixed(0)}ms; capabilities:`, Object.keys(init.result.capabilities).join(","));
send({ method: "initialized", params: {} });

const diag = async (version, text, label) => {
  const t = performance.now();
  if (version === 1) send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "qkt", version, text } } });
  else send({ method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
  const m = await wait((x) => x.method === "textDocument/publishDiagnostics" && x.params.uri === uri);
  const d = m.params.diagnostics;
  console.log(`${label}: ${(performance.now() - t).toFixed(0)}ms -> ${d.length} diagnostic(s)`);
  for (const x of d) console.log(`   L${x.range.start.line + 1}:${x.range.start.character + 1}-${x.range.end.character + 1} sev=${x.severity} ${x.message.slice(0, 110)}`);
  return d;
};

const good = `STRATEGY t VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m

RULES
    WHEN ema(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1
`;
await diag(1, good, "open valid doc (cold)");
await diag(2, good.replace("CROSSES ABOVE", "CROSSES ABOV"), "typo keyword");
await diag(3, good.replace("ema(gold.close, 9)", "emaa(gold.close, 9)"), "unknown indicator");
await diag(4, good.replace("BUY gold SIZING 0.1", "BUY gld SIZING 0.1"), "unknown alias");
await diag(5, good.replace("EVERY 15m", "EVERY 15x").replace("SIZING 0.1", "SIZING"), "two separate errors");
await diag(6, good, "back to valid (warm)");

// completion + hover
const line = (s) => good.split("\n").findIndex((l) => l.includes(s));
send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 7 }, contentChanges: [{ text: good.replace("ema(gold.close, 9)", "e") }] } });
await wait((x) => x.method === "textDocument/publishDiagnostics");
const li = line("WHEN"), ci = good.split("\n")[li].indexOf("ema") + 1 - 3 + 6;
const t1 = performance.now();
const comp = await req("textDocument/completion", { textDocument: { uri }, position: { line: li, character: ci } });
const items = comp.result?.items ?? comp.result ?? [];
console.log(`completion after "WHEN e": ${(performance.now() - t1).toFixed(0)}ms, ${items.length} items, e.g.`, items.slice(0, 8).map((i) => i.label).join(", "));
send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 8 }, contentChanges: [{ text: good }] } });
await wait((x) => x.method === "textDocument/publishDiagnostics");
const t2 = performance.now();
const hov = await req("textDocument/hover", { textDocument: { uri }, position: { line: li, character: good.split("\n")[li].indexOf("ema") + 1 } });
console.log(`hover on ema: ${(performance.now() - t2).toFixed(0)}ms ->`, JSON.stringify(hov.result?.contents ?? null).slice(0, 220));

// burst: 30 rapid edits; count diagnostics messages and time until quiet
const tb = performance.now();
const before = seen.length;
for (let v = 10; v < 40; v++) send({ method: "textDocument/didChange", params: { textDocument: { uri, version: v }, contentChanges: [{ text: good + "\n".repeat(v) }] } });
let lastN = -1, lastT = performance.now();
while (performance.now() - lastT < 300) { await new Promise((r) => setTimeout(r, 25)); const n = seen.length - before; if (n !== lastN) { lastN = n; lastT = performance.now(); } }
console.log(`30 rapid edits -> ${lastN} messages, quiet after ${(lastT - tb).toFixed(0)}ms`);

const rss = execSync(`ps -o rss= -p ${proc.pid} $(pgrep -P ${proc.pid} | tr '\\n' ' ') 2>/dev/null | awk '{s+=$1} END {print s/1024}'`).toString().trim();
console.log(`RSS of qkt lsp (+children): ~${Number(rss).toFixed(0)} MB`);
proc.kill();
