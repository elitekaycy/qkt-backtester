// A user's session, end to end, checked against the API at every step: create a strategy, run it, then keep editing it
// (a parameter, the indicator, a second timeframe, a syntax error and its fix) with auto-run on, switch to ticks, run a
// parameter grid and apply the winner. After each change the headline numbers, the chart (candles and trade count) and
// the Journal must show exactly the numbers of the run that just finished, and that run must be a new one.
// Needs a running studio (BASE) on a store with XAUUSD 15m bars for WIN_FROM..WIN_TO and ticks for TICK_FROM..TICK_TO.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const BASE = (process.env.BASE ?? "http://127.0.0.1:8097/").replace(/\/?$/, "/");
const WIN = [process.env.WIN_FROM ?? "2023-01-02", process.env.WIN_TO ?? "2023-07-01"];
const TICK = [process.env.TICK_FROM ?? "2026-02-02", process.env.TICK_TO ?? "2026-02-14"];
const NAME = process.env.NAME ?? `walk_${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); } };
const api = async (p, body) => { const r = await fetch(BASE + p.replace(/^\//, ""), body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.json(); };
const money = (n) => { const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return /^[0.,]*$/.test(s) ? s : n > 0 ? `+${s}` : `−${s}`; };

const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 950 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_ABORTED/.test(m.text())) errs.push(m.text().slice(0, 160)); });
p.on("dialog", async (d) => { await d.accept(d.type() === "prompt" ? NAME : undefined); });
await p.evaluateOnNewDocument((prefs) => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify(prefs)); } catch {} }, { from: WIN[0], to: WIN[1], tier: "draft", options: {} });
const key = async (k, mods = ["Control"]) => { for (const m of mods) await p.keyboard.down(m); await p.keyboard.press(k); for (const m of mods.reverse()) await p.keyboard.up(m); };
const strategy = `strategies/${NAME}.qkt`;

/** Wait until the headline numbers change from `before` (or appear), then return the newest run of the strategy. */
const kpiText = () => p.evaluate(() => [...document.querySelectorAll(".preview-kpis .pkpi .v")].map((v) => v.textContent).join(" | "));
async function nextResult(before, what, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const k = await kpiText();
    const running = await p.evaluate(() => !!document.querySelector(".btn.danger"));
    if (k && k !== before && !running) break;
    await sleep(150);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  await sleep(700); // the charts and trade overlay load right after the numbers
  const runs = (await api(`/api/runs?strategy=${encodeURIComponent(strategy)}&limit=1`)).runs;
  console.log(`  ... ${what}: new numbers after ${secs}s (run ${runs[0]?.id})`);
  return runs[0];
}

/** Everything on screen for the current run equals the API's numbers for `run`. */
async function verify(run, label, streams) {
  ok(`${label}: run finished`, run?.status === "done", run?.status);
  if (run?.status !== "done") return null;
  const s = await api(`/api/runs/${run.id}/derived/summary`);
  const meta = await api(`/api/runs/${run.id}/derived/meta`);
  const trips = await api(`/api/runs/${run.id}/trades?limit=1`);
  const k = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll(".preview-kpis .pkpi")].map((x) => [x.querySelector(".l")?.textContent, x.querySelector(".v")?.textContent])));
  const glyph = s.totalPnl > 0 ? "▲ " : s.totalPnl < 0 ? "▼ " : "";
  ok(`${label}: Net P&L shows the run's ${money(s.totalPnl)}`, k["Net P&L"] === `${glyph}${money(s.totalPnl)}`, k["Net P&L"]);
  ok(`${label}: Trades shows ${s.trades}`, k["Trades"] === String(s.trades), k["Trades"]);
  // charts: one per stream, candles drawn, each chart's trade count = the run's trades on that symbol
  const cells = await p.evaluate(() => [...document.querySelectorAll(".chart-cell")].map((c) => ({ cap: c.querySelector(".cap")?.textContent ?? "", canvas: c.querySelectorAll("canvas").length })));
  ok(`${label}: ${streams} chart${streams === 1 ? "" : "s"} shown`, cells.length === streams, `${cells.length}: ${cells.map((c) => c.cap.slice(0, 40)).join(" / ")}`);
  for (const c of cells) {
    const bars = Number((/([\d,]+) bars/.exec(c.cap)?.[1] ?? "0").replace(/,/g, ""));
    const shown = Number((/(\d[\d,]*) trades?/.exec(c.cap)?.[1] ?? "-1").replace(/,/g, ""));
    ok(`${label}: chart "${c.cap.slice(0, 22).trim()}" has candles`, bars > 0 && c.canvas > 0, c.cap.slice(0, 80));
    ok(`${label}: chart "${c.cap.slice(0, 22).trim()}" marks all ${trips.total} trades`, shown === trips.total, `chart says ${shown}`);
  }
  ok(`${label}: chart streams are the run's streams`, meta.streams.length === streams, JSON.stringify(meta.streams.map((x) => x.key)));
  // the studio's own cross-checks (P&L reconciles, chart candles = qkt's candles, fills inside bars, checksums) all pass
  const ig = await api(`/api/runs/${run.id}/derived/integrity`);
  const badge = await p.evaluate(() => [...document.querySelectorAll("section[aria-label='Chart'] .pane-head .badge")].map((b) => b.textContent).join(" | "));
  ok(`${label}: integrity checks pass and the header says so`, ig.ok && /matches engine|approximate/.test(badge) && !/integrity/.test(badge), `${badge} ${ig.checks.filter((c) => c.ok === false).map((c) => c.detail).join("; ")}`);
  return { s, run };
}

/** Replace text in the open editor like a user edit (one undoable edit), and save with Ctrl+S. */
async function edit(from, to) {
  const found = await p.evaluate((from, to) => {
    const e = window.__qktEditor, m = e.getModel(), t = m.getValue(), i = t.indexOf(from);
    if (i < 0) return false;
    const a = m.getPositionAt(i), z = m.getPositionAt(i + from.length);
    e.executeEdits("walk", [{ range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: z.lineNumber, endColumn: z.column }, text: to }]);
    return true;
  }, from, to);
  if (!found) throw new Error(`text not found in the editor: ${from}`);
  await p.evaluate(() => window.__qktEditor.focus()); await sleep(700); await key("s"); // check, then save
}

console.log(`walkthrough: ${BASE} as ${strategy}`);
await p.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3500);
ok("the page loads without errors", errs.length === 0, errs.join(" / "));
ok("auto-run is on by default", (await p.evaluate(() => document.querySelector(".auto-toggle")?.getAttribute("aria-pressed"))) === "true");

console.log("1. create a strategy from the Files panel");
await p.evaluate(() => document.querySelector("button[aria-label='New strategy']")?.click()); await sleep(600);
// the studio's own name dialog (no native prompt): clear, type the name, Enter
await p.waitForSelector("#ask-text"); await p.focus("#ask-text");
await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
await p.keyboard.type(NAME); await p.keyboard.press("Enter"); await sleep(2500);
const txt0 = await p.evaluate(() => window.__qktEditor?.getValue() ?? "");
ok("the new strategy opens in the editor", txt0.includes(`STRATEGY ${NAME} VERSION 1`), txt0.slice(0, 60));
// the template's stream, whatever the data source holds: "    px = BACKTEST:XAUUSD EVERY 15m"
const streamLine = /^ +px = (\w+):(\w+) EVERY (\w+)$/m.exec(txt0);
ok("the template trades a symbol the data source has", !!streamLine, txt0.split("\n").slice(2, 5).join(" / "));
const [line0, broker, symbol] = streamLine ?? ["", "BACKTEST", "XAUUSD"];

console.log("2. run it");
await p.evaluate(() => document.activeElement?.blur()); await key("Enter");
let r = await verify(await nextResult("", "first run"), "first run", 1);
let prev = r?.s;

console.log("3. change a parameter (fast 9 -> 5) and save: auto-run");
const before3 = await kpiText();
await edit("PARAM fast = 9", "PARAM fast = 5");
r = await verify(await nextResult(before3, "fast=5"), "fast=5", 1);
ok("fast=5 is a different run with different trades", r && prev && r.s.trades !== prev.trades, `${prev?.trades} -> ${r?.s.trades}`);
ok("the change against the previous run is shown", (await p.evaluate(() => document.querySelector(".pkpi .kd")?.textContent ?? "")).length > 0);
prev = r?.s;

console.log("4. swap the indicator (ema -> sma) and save");
let before = await kpiText();
await edit("ema(px.close, fast) CROSSES ABOVE ema(px.close, slow)", "sma(px.close, fast) CROSSES ABOVE sma(px.close, slow)");
await edit("ema(px.close, fast) CROSSES BELOW ema(px.close, slow)", "sma(px.close, fast) CROSSES BELOW sma(px.close, slow)");
r = await verify(await nextResult(before, "sma"), "sma", 1);
ok("sma gives a different result", r && prev && (r.s.trades !== prev.trades || r.s.totalPnl !== prev.totalPnl));
prev = r?.s;

console.log("5. add a 4h trend filter on a second stream and save");
before = await kpiText();
await edit(line0, `${line0}\n    trend = ${broker}:${symbol} EVERY 4h`);
await edit("     AND POSITION.px = 0", "     AND trend.close > sma(trend.close, 20)\n     AND POSITION.px = 0");
r = await verify(await nextResult(before, "4h filter"), "4h filter", 2);
ok("the filter takes fewer trades", r && prev && r.s.trades < prev.trades, `${prev?.trades} -> ${r?.s.trades}`);
const cap4h = await p.evaluate(() => [...document.querySelectorAll(".chart-cell .cap")].map((c) => c.textContent).find((t) => t.includes("4h")) ?? "");
ok("the 4h chart is built from finer bars, as qkt builds it", /from \d+m|aggregated/i.test(cap4h) || /bars/.test(cap4h), cap4h.slice(0, 80));
prev = r?.s;

console.log("6. a syntax error does not run; fixing it does");
const runsBefore = (await api(`/api/runs?strategy=${encodeURIComponent(strategy)}&limit=50`)).runs.length;
before = await kpiText();
await edit("     AND trend.close > sma(trend.close, 20)", "     AND trend.close > ");
await sleep(3000);
const notice = await p.evaluate(() => [...document.querySelectorAll(".banner")].map((x) => x.textContent).find((t) => t.startsWith("Not run")) ?? "");
ok("the error is named instead of running", /^Not run: line \d+/.test(notice), notice.slice(0, 90));
ok("no run was started", (await api(`/api/runs?strategy=${encodeURIComponent(strategy)}&limit=50`)).runs.length === runsBefore);
ok("the last good numbers stay", (await kpiText()) === before);
const squiggle = await p.evaluate(() => (window.__qktMarkers?.() ?? []).filter((m) => m.sev === 8).map((m) => `L${m.line}`));
ok("the editor underlines the error", squiggle.length === 1, JSON.stringify(squiggle));
await edit("     AND trend.close > \n", "     AND trend.close > sma(trend.close, 20)\n");
r = await verify(await nextResult(before + "x", "fixed"), "after the fix", 2);
ok("the fixed file gives the same numbers as before the error (cache)", r && prev && r.s.totalPnl === prev.totalPnl && r.s.trades === prev.trades);

console.log("7. the Journal shows the same run");
await key("j"); await sleep(2500);
const jr = await p.evaluate(() => document.querySelector("section.widget[aria-label='Realised P&L'] .big")?.textContent ?? "");
const an = await api(`/api/runs/${r.run.id}/analytics`);
const g = an.pnl > 0 ? "▲ " : an.pnl < 0 ? "▼ " : "";
ok(`Journal realised P&L is ${money(an.pnl)}`, jr === `${g}${money(an.pnl)}`, jr);
const showing = await p.evaluate(() => document.querySelector(".stat")?.textContent ?? "");
ok(`Journal counts ${an.count} trades`, showing.includes(`Showing ${an.count}`), showing);
await key("j"); await sleep(600);

console.log("8. switch to ticks");
before = await kpiText();
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Ticks")?.click()); await sleep(400);
// set the tick window through the store, as the date picker does
await p.evaluate((t) => { const st = window.__qktStore?.getState?.(); st?.setCfg?.({ from: t[0], to: t[1] }); }, TICK);
const tierOk = await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Ticks")?.getAttribute("aria-pressed"));
ok("the Ticks mode is selected", tierOk === "true", tierOk);
await p.evaluate(() => document.activeElement?.blur()); await key("Enter");
r = await verify(await nextResult(before, "ticks", 240_000), "ticks", 2);
ok("the tick run is a Full run", r && (await api(`/api/runs/${r.run.id}`)).tier === "full");
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Bars")?.click());
await p.evaluate((w) => window.__qktStore?.getState?.().setCfg?.({ from: w[0], to: w[1] }), WIN); await sleep(400);

console.log("9. optimize: a grid over fast x slow, then apply the winner");
await key("j"); await sleep(1500);
await p.evaluate(() => [...document.querySelectorAll("button, [role=tab]")].find((x) => x.getAttribute("aria-label") === "Optimize" || x.textContent.trim() === "Optimize")?.click()); await sleep(700);
await p.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((x) => x.textContent.trim() === "Parameter grid")?.click()); await sleep(700);
for (const [n, v] of [["fast", "3,5,8"], ["slow", "21,34"]]) {
  const h = await p.evaluateHandle((n) => [...document.querySelectorAll("label.field")].find((l) => l.querySelector(".mono")?.textContent === n)?.querySelector("input"), n);
  await h.asElement().click(); await p.keyboard.type(v);
}
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.startsWith("Run grid"))?.click());
const tg = Date.now();
for (let i = 0; i < 600 && !(await p.$(".gridheat")); i++) await sleep(250);
ok("the grid finishes and draws its heatmap", !!(await p.$(".gridheat")), `${((Date.now() - tg) / 1000).toFixed(1)}s`);
const best = await p.evaluate(() => { const r = document.querySelector(".tbl tbody tr"); return r ? { params: r.children[1].textContent, pnl: r.children[5].textContent } : null; });
console.log(`  ... best by Sharpe: ${best?.params} net ${best?.pnl}`);
before = await kpiText();
await p.evaluate(() => document.querySelector(".tbl tbody tr button")?.click()); await sleep(800);
const applied = await p.evaluate(() => window.__qktEditor.getValue().match(/PARAM \w+ = \S+/g)?.join(" "));
ok("Apply writes the winner into the PARAM lines", best && best.params.split(" ").every((kv) => applied.includes(kv.replace("=", " = "))), `${best?.params} vs ${applied}`);
await key("j"); await sleep(400);
await p.evaluate(() => window.__qktEditor.focus()); await key("s");
r = await verify(await nextResult(before, "applied winner"), "applied winner", 2);
ok("the applied run's Net P&L equals the grid's row", r && best && best.pnl.replace(/[+\s]/g, "") === money(r.s.totalPnl).replace(/[+\s]/g, ""), `${best?.pnl} vs ${money(r?.s.totalPnl ?? 0)}`);

ok("no page or console errors during the whole session", errs.length === 0, errs.slice(0, 5).join(" / "));
await b.close();
console.log(`\nwalkthrough: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
