// End-to-end check of a FRESH install (sample workspace + synthetic demo data) in a real browser.
// Usage: BASE=http://127.0.0.1:8090 node scripts/e2e-demo.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../packages/web/package.json"));
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE ?? "http://127.0.0.1:8090";
const SHOTS = process.env.SHOTS ?? "/tmp";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1760, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });

async function waitFor(fn, ms = 30000, arg) {
  const t0 = Date.now();
  for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
}
const clickText = (selector, text) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)); if (el) { el.click(); return true; } return false; }, selector, text);
const clickRun = () => page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Run") && b.className.includes("primary"))?.click());
const runDone = () => waitFor(() => { const top = document.querySelector(".topbar")?.innerText ?? ""; return /\bdone\b/.test(top) && !document.querySelector(".topbar .btn.danger") ? "done" : /\bfailed\b/.test(top) ? "failed" : null; }, 60000);

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  check("app loads and opens the sample strategy", await waitFor(() => [...document.querySelectorAll(".tab")].some((t) => t.textContent.includes("demo_ema_cross.qkt"))));
  check("default date range is derived from the data actually present", await waitFor(() => { const d = [...document.querySelectorAll('input[type="date"]')].map((i) => i.value); return d.length >= 2 && d[0] && d[1] && d[1] > d[0] && d[1].startsWith("2024-03") ? d.join(" ") : null; }));
  check("LSP connected in the container", await waitFor(() => /LSP: connected/.test(document.body.innerText), 20000));
  check("no problems in the shipped sample strategy", await page.evaluate(async () => { window.__dock.getPanel("problems").api.setActive(); await new Promise((r) => setTimeout(r, 1500)); return /No problems/.test(document.body.innerText); }));
  await page.evaluate(() => window.__dock.getPanel("pipeline").api.setActive());

  // run 1: single timeframe, bracket exits, shorts
  await clickRun();
  check("first run completes", (await runDone()) === "done");
  const k1 = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".kpi")].map((k) => [k.querySelector(".l").textContent, k.querySelector(".v").textContent])));
  check("results show trades and metrics", Number(k1["Trades"]) > 20 && /%$/.test(k1["Win rate"] ?? ""), JSON.stringify({ trades: k1["Trades"], win: k1["Win rate"], sharpe: k1["Sharpe"] }));
  check("shorts and longs both present (bracket strategy)", await page.evaluate(() => { const t = [...document.querySelectorAll(".kpi")]; const n = (l) => Number(t.find((k) => k.querySelector(".l").textContent === l)?.querySelector(".v").textContent); return n("Long") > 0 && n("Short") > 0; }));
  check("one chart for one timeframe, all its trades drawn", await waitFor(() => document.querySelectorAll(".chart-cell").length === 1 && document.querySelector(".chart-cell .plot").__chart.__tradesDrawn > 0));
  check("bracket strategy in Draft: run bar warns that stops are approximated", await page.evaluate(() => /stops: Draft is approximate/.test(document.querySelector(".topbar").innerText)));
  check("Draft fill-outside-bar is amber (expected approximation), not a red failure", await waitFor(() => { const b = document.querySelector(".panel-head .badge.warn, .panel-head .badge.ok"); const t = [...document.querySelectorAll(".panel-head .badge")].map((x) => x.className + "|" + x.textContent).join(" ; "); return /warn\|! some fills outside bars|ok\|✓ chart matches engine/.test(t) && !/bad\|✕ integrity/.test(t) ? t : null; }));
  const draftTrades = k1["Trades"], draftNet = k1["Net P&L"];
  await page.evaluate(() => [...document.querySelectorAll(".topbar button")].find((b) => /Verify with Full/.test(b.textContent))?.click());
  check("Verify with Full completes and the charts integrity is green", (await runDone()) === "done" && await waitFor(() => /Full · ticks/.test(document.body.innerText) && /✓ chart matches engine/.test(document.body.innerText), 30000));
  const k2 = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".kpi")].map((k) => [k.querySelector(".l").textContent, k.querySelector(".v").textContent])));
  check("Full differs from Draft for a stop/target strategy (the warning is earned)", k2["Trades"] !== draftTrades || k2["Net P&L"] !== draftNet, `Draft ${draftTrades} trades ${draftNet} vs Full ${k2["Trades"]} trades ${k2["Net P&L"]}`);

  // run 2: two timeframes
  await clickText(".tree-row", "demo_two_timeframes.qkt");
  await sleep(700);
  await clickRun();
  check("two-timeframe run completes", (await runDone()) === "done");
  check("two charts (15m and 1h) are shown", await waitFor(() => document.querySelectorAll(".chart-cell").length === 2 && document.querySelector('.chart-cell[data-chart="BACKTEST:DEMOUSD:1h"]') && document.querySelector('.chart-cell[data-chart="BACKTEST:DEMOUSD:15m"]') ? true : null));
  await sleep(1500);
  const synced = await page.evaluate(async () => {
    const c15 = document.querySelector('.chart-cell[data-chart="BACKTEST:DEMOUSD:15m"] .plot').__chart, c1h = document.querySelector('.chart-cell[data-chart="BACKTEST:DEMOUSD:1h"] .plot').__chart;
    const r = c15.timeScale().getVisibleRange();
    const mid = (r.from + r.to) / 2, span = (r.to - r.from) / 6;
    c15.timeScale().setVisibleRange({ from: mid - span, to: mid + span });
    await new Promise((res) => setTimeout(res, 500));
    const b = c1h.timeScale().getVisibleRange();
    return { dFrom: Math.abs(b.from - (mid - span)), dTo: Math.abs(b.to - (mid + span)), span: 2 * span };
  });
  check("zooming the 15m chart moves the 1h chart to the same window", synced.dFrom < 3600 * 2 && synced.dTo < 3600 * 2, JSON.stringify(synced));
  check("both charts carry the same trades", await page.evaluate(() => { const t = [...document.querySelectorAll(".chart-cell .cap .badge")].map((b) => b.textContent).filter((x) => /trade/.test(x)); return t.length === 2 && t[0] === t[1]; }));
  check("Full-tier verification is offered after a Draft run", await page.evaluate(() => [...document.querySelectorAll(".topbar button")].some((b) => /Verify with Full/.test(b.textContent))));
  await page.screenshot({ path: `${SHOTS}/demo-1-two-timeframes.png` });

  // grid via the UI
  await clickText(".tree-row", "demo_ema_cross.qkt");
  await sleep(500);
  await page.evaluate(() => window.__dock.getPanel("robustness").api.setActive());
  await sleep(300);
  await clickText('[role="tablist"] button', "Grid");
  await sleep(300);
  await page.evaluate(() => { const set = (input, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; s.call(input, v); input.dispatchEvent(new Event("input", { bubbles: true })); }; const ins = [...document.querySelectorAll(".form-row .field")].filter((f) => /^(fast|slow)/.test(f.textContent.trim())).map((f) => f.querySelector("input")); set(ins[0], "5,9"); set(ins[1], "21,34"); });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Run grid/.test(b.textContent))?.click());
  check("parameter grid produces 4 ranked runs", await waitFor(() => document.querySelectorAll(".panel table.grid tbody tr.click").length === 4, 60000));

  // walk-forward via the API through the UI tab
  await clickText('[role="tablist"] button', "Walk-forward");
  await sleep(300);
  check("walk-forward warns when the window is shorter than one fold", await page.evaluate(() => /needs train \+ test/.test(document.body.innerText) && [...document.querySelectorAll("button")].find((b) => /Run walk-forward/.test(b.textContent))?.disabled === true));
  await page.evaluate(() => { const set = (input, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; s.call(input, v); input.dispatchEvent(new Event("input", { bubbles: true })); }; for (const [label, v] of [["train", "10"], ["test", "5"], ["step", "5"]]) { const f = [...document.querySelectorAll(".form-row .field")].find((x) => x.textContent.trim().startsWith(label)); set(f.querySelector("input"), v); } });
  await sleep(200);
  await page.evaluate(() => { const set = (input, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; s.call(input, v); input.dispatchEvent(new Event("input", { bubbles: true })); }; const ins = [...document.querySelectorAll(".form-row .field")].filter((f) => /^(fast|slow)/.test(f.textContent.trim())).map((f) => f.querySelector("input")); set(ins[0], "5,9"); set(ins[1], "21,34"); });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Run walk-forward/.test(b.textContent))?.click());
  check("walk-forward shows in-sample vs out-of-sample and folds", await waitFor(() => /Mean out-of-sample score/.test(document.body.innerText) && document.querySelectorAll('[data-testid="wf-equity"] canvas').length > 0, 90000));

  // restricted terminal
  await page.evaluate(() => window.__dock.getPanel("terminal").api.setActive());
  await sleep(800);
  await page.evaluate(() => document.querySelector(".xterm-helper-textarea")?.focus());
  await page.keyboard.type("qkt --version");
  await page.keyboard.press("Enter");
  check("restricted terminal runs qkt inside the container", await waitFor(() => /qkt 0\.\d+\.\d+/.test(document.querySelector(".xterm-rows")?.innerText ?? ""), 15000));
  await waitFor(() => (document.querySelector(".xterm-rows")?.innerText.match(/\$ /g) ?? []).length >= 2, 8000);
  await page.keyboard.type("ls /");
  await page.keyboard.press("Enter");
  check("restricted terminal refuses non-qkt commands", await waitFor(() => /Only qkt commands/.test(document.querySelector(".xterm-rows")?.innerText ?? ""), 8000));

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("script completed", false, e.stack?.split("\n").slice(0, 2).join(" "));
  await page.screenshot({ path: `${SHOTS}/demo-failure.png` }).catch(() => {});
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
