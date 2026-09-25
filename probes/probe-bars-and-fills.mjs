// Probe: decode qkt's binary bar store from outside the JVM, then use it to
// (1) cross-check the engine's candle count, (2) test fills-inside-bar,
// (3) reconcile fill rows against the engine's own realized P&L.
// Usage: node probe-bars-and-fills.mjs <dataRoot> <broker> <symbol> <tf> <from> <to> <runDir>
import fs from "node:fs";
import path from "node:path";

const [dataRoot, broker, symbol, tf, from, to, runDir] = process.argv.slice(2);

function readDay(file) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.toString("latin1", 0, 4) !== "QKB1") throw new Error("bad magic " + file);
  let o = 4;
  const version = dv.getInt32(o, true); o += 4;
  const scale = dv.getInt32(o, true); o += 4;
  const tfMs = Number(dv.getBigInt64(o, true)); o += 8;
  const symLen = dv.getInt32(o, true); o += 4;
  o += symLen;
  const n = dv.getInt32(o, true); o += 4;
  if (version !== 1) throw new Error("unsupported version " + version);
  const div = 10 ** scale;
  const col = () => {
    const a = new Array(n);
    for (let i = 0; i < n; i++, o += 8) a[i] = Number(dv.getBigInt64(o, true));
    return a;
  };
  const ts = col(), open = col(), high = col(), low = col(), close = col(), vol = col();
  return { tfMs, n, ts, open: open.map((x) => x / div), high: high.map((x) => x / div),
           low: low.map((x) => x / div), close: close.map((x) => x / div), vol };
}

const bars = { ts: [], high: [], low: [], open: [], close: [] };
let tfMs = 0, days = 0;
for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(d.getTime() + 86400000)) {
  const f = path.join(dataRoot, "bars", broker, symbol, tf, d.toISOString().slice(0, 10) + ".bin");
  if (!fs.existsSync(f)) continue;
  const r = readDay(f); days++; tfMs = r.tfMs;
  for (const k of ["ts", "high", "low", "open", "close"]) bars[k].push(...r[k]);
}
console.log(`decoded ${bars.ts.length} bars from ${days} day files (tf=${tfMs}ms)`);

const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
console.log("engine inputSummary:", JSON.stringify(result.inputSummary));

// (2) fills inside their bar
const rows = fs.readFileSync(path.join(runDir, "trades.csv"), "utf8").trim().split("\n");
const head = rows[0].split(",");
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
const fills = rows.slice(1).map((l) => l.split(","));
let inside = 0, outside = 0, nobar = 0, maxOut = 0;
const idx = new Map(bars.ts.map((t, i) => [t, i]));
for (const f of fills) {
  const ts = Number(f[ix.timestamp]), px = Number(f[ix.price]);
  const start = ts - (((ts % tfMs) + tfMs) % tfMs);
  const i = idx.get(start);
  if (i === undefined) { nobar++; continue; }
  if (px >= bars.low[i] - 1e-9 && px <= bars.high[i] + 1e-9) inside++;
  else { outside++; maxOut = Math.max(maxOut, px < bars.low[i] ? bars.low[i] - px : px - bars.high[i]); }
}
console.log(`fills=${fills.length} inside-bar=${inside} outside=${outside} (max excursion ${maxOut.toFixed(4)}) no-bar=${nobar}`);

// (3) reconcile realized P&L and pair round trips (simple flat->flat pairing per symbol)
let sumRealized = 0;
const pos = new Map();
const trips = [];
for (const f of fills) {
  sumRealized += Number(f[ix.realized]);
  const sym = f[ix.symbol], eff = f[ix.positionEffect];
  const q = Number(f[ix.strategyPositionQtyAfter] || f[ix.accountPositionQtyAfter] || 0);
  let p = pos.get(sym);
  if (!p) { p = { open: null, pnl: 0, fills: 0 }; pos.set(sym, p); }
  if (!p.open) p.open = { ts: Number(f[ix.timestamp]), px: Number(f[ix.price]), side: f[ix.side] };
  p.pnl += Number(f[ix.realized]); p.fills++;
  if (eff.startsWith("CLOSE") && Math.abs(q) < 1e-12) {
    trips.push({ sym, entry: p.open, exitTs: Number(f[ix.timestamp]), exitPx: Number(f[ix.price]), pnl: p.pnl, fills: p.fills });
    pos.set(sym, null);
  }
}
const engine = Number(result.global.realizedTotal);
console.log(`round trips=${trips.length} engine.tradeCount=${result.global.tradeCount}`);
console.log(`sum(realized)=${sumRealized.toFixed(4)} engine.realizedTotal=${engine.toFixed(4)} diff=${(sumRealized - engine).toFixed(6)}`);
console.log(`sum(trip.pnl)=${trips.reduce((a, t) => a + t.pnl, 0).toFixed(4)}`);
