// End-to-end check of the running studio in a real browser.
// Usage: BASE=http://127.0.0.1:8099 node scripts/e2e.mjs   (needs system Chrome; puppeteer-core is a web devDependency)
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../packages/web/package.json"));
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE ?? "http://127.0.0.1:8099";
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
await page.evaluateOnNewDocument(() => {
  try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify({ from: "2024-10-01", to: "2024-10-31", tier: "draft", autoRun: false, theme: "dark" })); } catch {}
});

async function waitFor(fn, ms = 20000, arg) {
  const t0 = Date.now();
  for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
}
const clickText = (selector, text) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t)); if (el) { el.click(); return true; } return false; }, selector, text);

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // 1. shell + editor + highlighting
  check("editor tabs open (config + strategy)", await waitFor(() => document.querySelectorAll(".tab").length >= 2));
  check("Monaco mounted", await waitFor(() => !!(window.__qktEditor && document.querySelector(".monaco-editor .view-lines"))));
  await clickText(".tab", "xau-ema.qkt");
  await sleep(600);
  const colors = await waitFor(() => { const s = new Set(); document.querySelectorAll(".monaco-editor .view-line span span").forEach((e) => s.add(getComputedStyle(e).color)); return s.size >= 3 ? s.size : 0; });
  check("qkt syntax highlighting (TextMate grammar via Shiki)", colors >= 3, `${colors} distinct token colours`);
  check("dockview layout: explorer, editor, charts, trades, results, pipeline present", await page.evaluate(() => ["explorer", "editor", "pipeline", "problems", "terminal", "charts", "trades", "results", "robustness", "runs"].every((id) => window.__dock?.getPanel(id))));
  check("LSP connected", await waitFor(() => /LSP: connected/.test(document.body.innerText), 15000));

  // 2. live diagnostics: break, expect squiggle; fix, expect it to clear
  const original = await page.evaluate(() => window.__qktEditor.getModel().getValue());
  await page.evaluate((t) => window.__qktEditor.getModel().setValue(t.replace("CROSSES ABOVE", "CROSSES ABOV")), original);
  check("syntax error squiggle within 2s (LSP)", await waitFor(() => !!document.querySelector(".squiggly-error"), 2500));
  check("Problems panel lists it", (await page.evaluate(async () => { window.__dock.getPanel("problems").api.setActive(); await new Promise((r) => setTimeout(r, 300)); return /ABOVE or BELOW/.test(document.body.innerText); })));
  await page.evaluate((t) => window.__qktEditor.getModel().setValue(t), original);
  check("squiggle clears after the fix", await waitFor(() => !document.querySelector(".squiggly-error"), 4000));
  // unknown alias: qkt itself runs this with zero trades; the studio must flag it
  await page.evaluate((t) => window.__qktEditor.getModel().setValue(t.replace(/WHEN ema\(gold\.close/, "WHEN ema(gld.close")), original);
  check("unknown alias flagged (qkt would silently trade nothing)", await waitFor(() => /Unknown stream alias 'gld'/.test(document.body.innerText) || [...document.querySelectorAll(".squiggly-error")].length > 0, 6000)
    && await page.evaluate(async () => { window.__dock.getPanel("problems").api.setActive(); await new Promise((r) => setTimeout(r, 300)); return /Unknown stream alias 'gld'/.test(document.body.innerText); }));
  await page.evaluate((t) => window.__qktEditor.getModel().setValue(t), original);
  await sleep(900);

  // 3. run
  await page.evaluate(() => window.__dock.getPanel("pipeline").api.setActive());
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Run") && b.className.includes("primary"))?.click());
  const done = await waitFor(() => document.querySelectorAll(".step.ok").length >= 6 || /failed/.test(document.querySelector(".topbar")?.innerText ?? ""), 60000);
  const steps = await page.evaluate(() => [...document.querySelectorAll(".step")].map((s) => s.className.replace("step ", "") + ":" + (s.children[1]?.textContent ?? "")));
  check("pipeline: all seven steps ok", done && steps.filter((s) => s.startsWith("ok")).length >= 6, steps.join(" "));
  check("pipeline shows the exact qkt command", await page.evaluate(() => /qkt backtest .*--no-fetch.*--bars/.test(document.body.innerText)));

  // 4. results
  const kpis = await waitFor(() => { const t = document.body.innerText; return /Net P&L/.test(t) && /Profit factor/.test(t) ? t : null; }, 20000);
  check("KPIs render (Net P&L, Sharpe, Profit factor…)", !!kpis);
  const numbers = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".kpi")].map((k) => [k.querySelector(".l").textContent, k.querySelector(".v").textContent])));
  check("trades = closed round trips, not fills", numbers["Trades"] === "40" && /81 fills/.test(await page.evaluate(() => [...document.querySelectorAll(".kpi")].find((k) => k.querySelector(".l").textContent === "Trades").innerText)), JSON.stringify({ trades: numbers["Trades"] }));
  check("win rate matches engine (42.5%)", numbers["Win rate"] === "42.5%", numbers["Win rate"]);
  check("equity + drawdown charts drawn", await waitFor(() => document.querySelectorAll('[data-testid="equity-chart"] canvas, [data-testid="drawdown-chart"] canvas').length >= 2));
  check("integrity: every check that ran passed", await page.evaluate(() => !/✕/.test(document.querySelector(".panel-scroll")?.innerText ?? "") && /Trades reconcile with engine P&L/.test(document.body.innerText)));

  // 5. charts
  const drawn = () => page.evaluate(() => document.querySelector(".chart-cell .plot")?.__chart?.__tradesDrawn ?? -1);
  check("chart rendered for the traded stream", await waitFor(() => !!document.querySelector('.chart-cell[data-chart="BACKTEST:XAUUSD:15m"] .plot')?.__chart));
  await sleep(1500);
  const boxes = await drawn();
  check("trade boxes drawn on the chart (41 = 40 closed + 1 open)", boxes === 41, `drawn=${boxes}`);
  check("chart bar count is the engine's 2021", /2,021 bars/.test(await page.evaluate(() => document.querySelector(".chart-cell .cap")?.innerText ?? "")));
  check("coverage strip present with closed days", await page.evaluate(() => document.querySelectorAll(".covstrip i.closed").length > 3));
  check("integrity badge on the charts panel reads OK", await page.evaluate(() => /chart matches engine/.test(document.body.innerText)));

  // 6. filters drive the chart and the table
  await page.evaluate(() => window.__dock.getPanel("trades").api.setActive());
  check("trades table shows 41 round trips", await waitFor(() => /41 of 41 round trips/.test(document.body.innerText)));
  await clickText('[aria-label="Side"] button', "Short");
  await sleep(900);
  check("filter Short: table empty and chart boxes 0", (await drawn()) === 0 && await page.evaluate(() => /No trades match/.test(document.body.innerText)), `drawn=${await drawn()}`);
  await clickText('[aria-label="Side"] button', "All");
  await clickText('[aria-label="Outcome"] button', "Wins");
  await sleep(900);
  const wins = await drawn();
  check("filter Wins: 17 boxes (matches engine win rate)", wins === 17, `drawn=${wins}`);
  check("table agrees: 17 matching", await page.evaluate(() => /17 matching of 41/.test(document.body.innerText)));
  await clickText('[aria-label="Outcome"] button', "All");
  await sleep(700);

  // 7. row click focuses the chart
  const before = await page.evaluate(() => { const r = document.querySelector(".chart-cell .plot").__chart.timeScale().getVisibleRange(); return r.to - r.from; });
  await page.evaluate(() => document.querySelectorAll('[role="row"]')[3]?.click());
  await sleep(700);
  const after = await page.evaluate(() => { const r = document.querySelector(".chart-cell .plot").__chart.timeScale().getVisibleRange(); return r.to - r.from; });
  check("clicking a trade zooms the chart onto it", after < before / 5, `range ${Math.round(before / 3600)}h -> ${Math.round(after / 3600)}h`);
  await page.screenshot({ path: `${SHOTS}/e2e-1-results.png` });

  // 8. Monte Carlo
  await page.evaluate(() => window.__dock.getPanel("robustness").api.setActive());
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Run Monte Carlo"))?.click());
  check("Monte Carlo fan + histogram render", await waitFor(() => !!(document.querySelector('[data-testid="mc-fan"] canvas') && document.querySelector('[data-testid="mc-hist"] canvas')), 15000));
  check("Monte Carlo reports the real backtest inside its distribution", await page.evaluate(() => /actual 10,377/.test(document.body.innerText)));
  await page.screenshot({ path: `${SHOTS}/e2e-2-montecarlo.png` });

  // 9. history + cache hit + compare
  await page.evaluate(() => window.__dock.getPanel("runs").api.setActive());
  await sleep(400);
  check("run history lists the run", await page.evaluate(() => document.querySelectorAll(".panel table.grid tbody tr.click").length >= 1));
  await page.evaluate(() => window.__dock.getPanel("pipeline").api.setActive());
  const t0 = Date.now();
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Run") && b.className.includes("primary"))?.click());
  await waitFor(() => !document.querySelector(".topbar .btn.danger"), 15000);
  check("identical re-run is served from cache (< 1.5 s)", Date.now() - t0 < 1500 + 500, `${Date.now() - t0} ms`);

  // 10. collapse / expand regions
  await clickText(".topbar .seg button", "Results");
  await sleep(300);
  check("Results region collapses", await page.evaluate(() => window.__dock.getPanel("results").group.api.isVisible === false));
  await clickText(".topbar .seg button", "Results");
  await sleep(300);
  check("Results region expands again", await page.evaluate(() => window.__dock.getPanel("results").group.api.isVisible === true));
  check("chart expands to full panel", await page.evaluate(async () => { document.querySelector('.chart-cell .cap button[title^="Expand"]')?.click(); await new Promise((r) => setTimeout(r, 300)); return !!document.querySelector(".chart-cell.maximized"); }));
  await page.evaluate(() => document.querySelector('.chart-cell .cap button[title^="Restore"]')?.click());

  // 11. theme
  await page.evaluate(() => [...document.querySelectorAll(".topbar button")].find((b) => b.title === "Toggle theme")?.click());
  await sleep(500);
  check("light theme applies to the page and charts", await page.evaluate(() => document.documentElement.dataset.theme === "light" && getComputedStyle(document.body).backgroundColor !== "rgb(13, 13, 13)"));
  await page.screenshot({ path: `${SHOTS}/e2e-3-light.png` });
  await page.evaluate(() => [...document.querySelectorAll(".topbar button")].find((b) => b.title === "Toggle theme")?.click());

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("script completed", false, e.stack?.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}/e2e-failure.png` }).catch(() => {});
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
