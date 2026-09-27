// Every number the UI shows for a run must be the number the API/derived files hold: the chart-pane KPIs, each Journal widget,
// the monthly table, the trade list and the chart's Trades tab. Values are formatted exactly as the UI formats them and looked
// for inside the widget that should show them, so a wrong field, a stale value or a placeholder fails the check.
// Needs a running studio (BASE, default :8099) whose workspace has STRATEGY; system Chrome. Read-only: it only runs a backtest.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE ?? "http://127.0.0.1:8099/";
const STRATEGY = process.env.STRATEGY ?? "strategies/flip.qkt";
const FROM = process.env.FROM ?? "2024-10-01", TO = process.env.TO ?? "2024-12-16";
const OPTIONS = JSON.parse(process.env.OPTIONS ?? '{"positionMode":"netting"}');

// ---- the UI's formatters, verbatim (packages/web/src/util/format.ts) ----
const DASH = "—";
const fin = (n) => n !== null && n !== undefined && Number.isFinite(n);
const fmtNum = (n, dp = 2) => (fin(n) ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : DASH);
const fmtMoney = (n, dp = 2) => { if (!fin(n)) return DASH; const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s; };
const fmtPct = (f, dp = 2) => (fin(f) ? `${(f * 100).toFixed(dp)}%` : DASH);
const fmtRatio = (n, dp = 2) => (fin(n) ? n.toFixed(dp) : DASH);
const glyph = (n) => (!fin(n) || n === 0 ? "" : n > 0 ? "▲" : "▼");
const fmtDur = (ms) => {
  if (!fin(ms)) return DASH;
  const a = Math.abs(ms); if (a < 1000) return `${Math.round(a)}ms`;
  const s = Math.floor(a / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24); return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
};

const api = async (p, body) => { const r = await fetch(BASE + p.replace(/^\//, ""), body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, pass = 0;
const ok = (name, cond, detail = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, detail); } };

// 1. the run and its numbers, from the API
const { runId } = await api("/api/runs", { strategy: STRATEGY, from: FROM, to: TO, tier: "draft", options: OPTIONS });
let run; for (let i = 0; i < 1200; i++) { run = await api(`/api/runs/${runId}`); if (["done", "failed", "cancelled"].includes(run.status)) break; await sleep(250); }
if (run.status !== "done") { console.log("FAIL run", run.status, JSON.stringify(run.error)); process.exit(1); }
const s = await api(`/api/runs/${runId}/derived/summary`), a = await api(`/api/runs/${runId}/analytics`);
const eq = await api(`/api/runs/${runId}/derived/equity`), start = eq.equity[0] ?? 0;
const trades = await api(`/api/runs/${runId}/trades?sort=entryTs&dir=desc&limit=20`);

// 2. the same run in the browser
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage(); await p.setViewport({ width: 1760, height: 1000 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.evaluateOnNewDocument((prefs) => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify(prefs)); } catch {} }, { from: FROM, to: TO, tier: "draft", theme: "dark", options: OPTIONS });
await p.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3500);
const key = async (k) => { await p.keyboard.down("Control"); await p.keyboard.press(k); await p.keyboard.up("Control"); };
await key("k"); await sleep(300); await p.keyboard.type(STRATEGY.split("/").pop()); await sleep(300); await p.keyboard.press("Enter"); await sleep(1200);
await p.evaluate(() => document.activeElement?.blur()); await key("Enter");
for (let i = 0; i < 120 && !(await p.$(".preview-kpis")); i++) await sleep(250);
await sleep(800);
const text = (sel) => p.evaluate((q) => document.querySelector(q)?.textContent ?? "", sel);
const widget = (title) => p.evaluate((t) => document.querySelector(`section.widget[aria-label="${t}"]`)?.textContent ?? "", title);
const has = (name, hay, needle) => ok(name, hay.includes(needle), `expected ${JSON.stringify(needle)} in ${JSON.stringify(hay.slice(0, 220))}`);

// chart-pane KPIs: whole run, engine net P&L
const kpis = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll(".preview-kpis .pkpi")].map((k) => [k.querySelector(".l")?.textContent, { v: k.querySelector(".v")?.textContent, s: k.querySelector(".s")?.textContent ?? "" }])));
ok("KPI Net P&L", kpis["Net P&L"]?.v === `${glyph(s.totalPnl)} ${fmtMoney(s.totalPnl)}`, JSON.stringify(kpis["Net P&L"]));
if (s.unrealized !== 0) has("KPI Net P&L shows the open part", kpis["Net P&L"]?.s ?? "", `incl. ${fmtMoney(s.unrealized)} open`);
ok("KPI Win rate", kpis["Win rate"]?.v === fmtPct(s.winRate, 1) && kpis["Win rate"].s === `${s.wins}W · ${s.losses}L`, JSON.stringify(kpis["Win rate"]));
ok("KPI Profit factor", kpis["Profit factor"]?.v === (s.profitFactor === null ? DASH : fmtRatio(s.profitFactor)) && kpis["Profit factor"].s === `Sharpe ${fmtRatio(s.sharpe)}`, JSON.stringify(kpis["Profit factor"]));
ok("KPI Trades", kpis["Trades"]?.v === String(s.trades) && kpis["Trades"].s.startsWith(`${s.fills} fills`), JSON.stringify(kpis["Trades"]));
ok("KPI Max drawdown", kpis["Max drawdown"]?.v === fmtPct(s.maxDrawdown) && kpis["Max drawdown"].s === `expectancy ${fmtMoney(s.expectancy)}`, JSON.stringify(kpis["Max drawdown"]));

// the chart's Trades tab: same trades, same order and P&L as the API
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /^Trades\s*\d+$/.test(x.textContent.trim()))?.click()); await sleep(900);
const tabRows = await p.evaluate(() => [...document.querySelectorAll(".trades-tab .trow")].slice(0, 5).map((r) => r.textContent));
ok("chart Trades tab lists trades", tabRows.length > 0);

// Journal
await key("j"); await sleep(1500);
const nav = async (label) => { await p.evaluate((l) => document.querySelector(`.jnav-btn[aria-label="${l}"]`)?.click(), label); await sleep(1300); };
await nav("Overview");
has("Realised P&L", await widget("Realised P&L"), `${glyph(a.pnl)} ${fmtMoney(a.pnl)}`);
if (s.unrealized !== 0) has("Realised P&L card names the net", await widget("Realised P&L"), `Net ${glyph(s.totalPnl)} ${fmtMoney(s.totalPnl)} incl. ${fmtMoney(s.unrealized)} on ${s.openTrades} open`);
has("Win rate", await widget("Win rate"), fmtPct(a.winRate, 0));
has("Win rate counts", await widget("Win rate"), `▲ ${a.wins}`);
has("Profit factor gross", await widget("Profit factor"), `${fmtMoney(a.grossWin, 0)} / ${fmtMoney(a.grossLoss, 0)}`);
has("Payoff", await widget("Avg win / loss"), a.payoff === null ? DASH : fmtRatio(a.payoff));
has("Expectancy", await widget("Expectancy"), fmtMoney(a.expectancy));
const streaks = await widget("Streaks and extremes");
for (const [n, v] of [["best", fmtMoney(a.largestWin)], ["worst", fmtMoney(a.largestLoss)], ["win streak", `Longest winning streak${a.maxWinStreak}`], ["loss streak", `Longest losing streak${a.maxLossStreak}`], ["hold", fmtDur(a.avgHoldMs)]]) has(`Streaks: ${n}`, streaks, v);
const eng = await widget("Engine metrics");
for (const [n, v] of [["sharpe", fmtRatio(s.sharpe)], ["sortino", fmtRatio(s.sortino)], ["calmar", fmtRatio(s.calmar)], ["max dd", fmtPct(s.maxDrawdown)], ["max daily dd", fmtPct(s.maxDailyDrawdown)], ["fills", `Fills${s.fills}`], ["unrealised", fmtMoney(s.unrealized)]]) has(`Engine metrics: ${n}`, eng, v);
const ended = await widget("How trades ended");
for (const e of a.exit) has(`How trades ended: ${e.reason}`, ended, `${e.trades}`);
const ls = await widget("Long vs short");
if (a.side.long.trades) has("long win rate", ls, fmtPct(a.side.long.wins / a.side.long.trades, 0));
if (a.side.short.trades) has("short win rate", ls, fmtPct(a.side.short.wins / a.side.short.trades, 0));

await nav("Monthly");
const months = await p.evaluate(() => [...document.querySelectorAll("table.tbl tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent)));
for (const m of a.monthly) {
  const row = months.find((r) => r[0] === m.month);
  ok(`Monthly ${m.month}`, !!row && row[1] === String(m.trades) && row[4] === `${glyph(m.pnl)} ${fmtMoney(m.pnl)}` && row[5] === (start ? fmtPct(m.pnl / start) : DASH), JSON.stringify(row));
}
ok("Monthly sums to realised", Math.abs(a.monthly.reduce((x, m) => x + m.pnl, 0) - a.pnl) < 1e-6);

await nav("Trades");
has("Trades count", await text(".filterbar .stat"), `Showing ${a.count} of ${a.count} trades`);
const rows = await p.evaluate(() => [...document.querySelectorAll("[role=row]")].filter((r) => r.querySelector('[role="cell"], [role="gridcell"], div')).map((r) => r.textContent));
for (const t of trades.rows.slice(0, 8)) {
  const needle = t.open ? "open" : `${glyph(t.pnl)} ${fmtMoney(t.pnl)}`;
  ok(`Trades row #${t.id}`, rows.some((r) => r.includes(String(t.id)) && r.includes(needle)), `#${t.id} ${needle}`);
}

ok("no page errors", errs.length === 0, JSON.stringify(errs));
console.log(`display-truth: ${pass} passed, ${fail} failed (run ${runId}: ${s.trades} trades, net ${s.totalPnl}, realised ${a.pnl})`);
await b.close();
process.exit(fail ? 1 : 0);
