// Deterministic SYNTHETIC demo data so a fresh install can run a backtest with zero setup.
// It is a seeded random walk with alternating trend regimes. It is NOT market data and the symbol is named DEMOUSD.
// Usage: node tools/demo-data.mjs <dataRoot> [days=90] [startDate=2024-01-01]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const [root, daysArg, startArg] = process.argv.slice(2);
if (!root) { console.error("usage: demo-data.mjs <dataRoot> [days] [startDate]"); process.exit(2); }
const days = Number(daysArg ?? 90), start = Date.parse((startArg ?? "2024-01-01") + "T00:00:00Z");

function mulberry32(a) { return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20240101);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

const dir = path.join(root, "symbols", "DEMOUSD");
mkdirSync(dir, { recursive: true });
let price = 100, drift = 0.00002, regimeLeft = 0;
const STEP = 120_000; // one tick every 2 minutes, 24/7
for (let d = 0; d < days; d++) {
  const day0 = start + d * 86_400_000;
  const rows = ["timestamp,symbol,price,volume,bid,ask,bidVolume,askVolume"];
  for (let t = day0; t < day0 + 86_400_000; t += STEP) {
    if (regimeLeft <= 0) { drift = (rnd() - 0.5) * 0.00012; regimeLeft = 720 * (2 + Math.floor(rnd() * 5)); }
    regimeLeft--;
    price *= 1 + drift + 0.00045 * gauss();
    const half = 0.01;
    rows.push(`${t},DEMOUSD,${price.toFixed(4)},1,${(price - half).toFixed(4)},${(price + half).toFixed(4)},1,1`);
  }
  writeFileSync(path.join(dir, `${new Date(day0).toISOString().slice(0, 10)}.csv.gz`), gzipSync(rows.join("\n") + "\n"));
}
const last = new Date(start + (days - 1) * 86_400_000).toISOString().slice(0, 10);
writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, schema: "qkt-csv-v1", symbol: "DEMOUSD", source: "qkt-backtester synthetic demo (NOT market data)", ranges: [{ from: new Date(start).toISOString().slice(0, 10), to: last }], lastUpdated: new Date(0).toISOString() }, null, 2));
// qkt refuses to backtest a symbol whose instrument spec it cannot resolve; never overwrite an existing file.
const instruments = path.join(root, "instruments.yaml");
if (!existsSync(instruments)) writeFileSync(instruments, `# Synthetic demo instrument (qkt-backtester). Delete this file together with symbols/DEMOUSD if you do not want the demo.
instruments:
  - qktSymbol: BACKTEST:DEMOUSD
    contractSize: 1
    volumeStep: 0.01
    volumeMin: 0.01
    volumeMax: 100000
    pointSize: 0.01
    digits: 2
    tradeStopsLevelPoints: 0
`);
console.log(`demo-data: wrote ${days} days of synthetic DEMOUSD ticks to ${dir}`);
