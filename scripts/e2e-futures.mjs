// Futures and options flow of the studio, driven in a real browser. The CFD flow is scripts/e2e.mjs; this one proves the same
// screens carry futures and options, and that a CFD-only workspace shows none of it.
//
//   FUT=http://127.0.0.1:8097/  OPT=http://127.0.0.1:8095/  CFD=http://127.0.0.1:8096/  SHOTS=/tmp/shots  node scripts/e2e-futures.mjs
//
// FUT: a studio over a store with CME ES contracts (catalog, rolls, 1d bars), a Binance perpetual with hourly bars and stored funding,
//      and a workspace holding strategies/{es_trend,btc_perp,cfd_leak,nq_trend}.qkt.
// CFD: a studio over a CFD-only store with strategies/demo_cross.qkt.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const FUT = process.env.FUT ?? "http://127.0.0.1:8097/", CFD = process.env.CFD ?? "http://127.0.0.1:8096/", OPT = process.env.OPT ?? "http://127.0.0.1:8095/";
const SHOTS = process.env.SHOTS ?? "/tmp/qkt-studio-e2e-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };

async function open(url, prefs) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("framenavigated", (f) => { if (f === page.mainFrame() && f.url() !== url) console.log("NAVIGATED", f.url()); });
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`console: ${m.text()}`); });
  await page.evaluateOnNewDocument((p) => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify(p)); } catch { /* storage blocked */ } }, prefs);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rail-btn", { timeout: 20000 });
  await sleep(2500);
  return { page, errs };
}
const clickText = (page, text, sel = "button") => page.evaluate((t, s) => { const e = [...document.querySelectorAll(s)].find((b) => b.getAttribute("aria-label") === t || b.textContent.trim() === t); e?.click(); return !!e; }, text, sel);
const body = (page) => page.evaluate(() => document.body.innerText);
const ctrl = async (page, k) => { await page.keyboard.down("Control"); await page.keyboard.press(k); await page.keyboard.up("Control"); };
const rail = async (page, label) => { // a rail button toggles: only click when its section is not already showing
  const on = await page.evaluate((l) => document.querySelector(`.rail-btn[aria-label="${l}"]`)?.getAttribute("aria-pressed") === "true", label);
  if (!on) await clickText(page, label); await sleep(900);
};
const openFile = async (page, name) => {
  await rail(page, "Files");
  const hit = await page.evaluate((n) => { const e = [...document.querySelectorAll("*")].find((x) => x.children.length === 0 && x.textContent.trim() === n); e?.click(); return !!e; }, name);
  await sleep(2200); return hit;
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const scrollTo = (page, text) => page.evaluate((t) => { [...document.querySelectorAll("h2, h3, .widget-title, .widget header, .widget > div:first-child")].find((e) => e.textContent.trim().startsWith(t))?.scrollIntoView({ block: "center" }); }, text);
const setTheme = async (page, theme) => { const cur = await page.evaluate(() => document.documentElement.dataset.theme); if (cur !== theme) { await clickText(page, theme === "light" ? "Switch to light theme" : "Switch to dark theme"); await sleep(600); } };
async function run(page, wait = 40000) {
  await clickText(page, "Run"); await sleep(1500);
  const t0 = Date.now();
  while (Date.now() - t0 < wait) { await sleep(1500); const done = await page.evaluate(() => !document.querySelector("button.btn.danger")); if (done) break; }
  await sleep(1500);
}

// ---------------------------------------------------------------- futures workspace
{
  const { page, errs } = await open(FUT, { from: "2019-01-01", to: "2021-01-01", tier: "draft", autoRun: false });

  // Data: roots next to the symbols
  await rail(page, "Data"); await sleep(1500);
  let t = await body(page);
  ok("data lists a Futures group with the ES root", /FUTURES/i.test(t) && /\bES\b/.test(t) && /92 contracts/.test(t), t.slice(0, 400));
  ok("a root says how many rolls were measured", /\d+ rolls/.test(t));
  await page.evaluate(() => document.querySelector('[data-root="CME:ES"]')?.click()); await sleep(1500);
  t = await body(page);
  ok("a root dialog opens with catalog, rolls and terms", /CME:ES · futures/.test(t) && /Catalog/.test(t) && /Rolls/.test(t) && /Multiplier/.test(t) && /Margin/.test(t));
  await page.evaluate(() => [...document.querySelectorAll(".modal tr.click")][0]?.click()); await sleep(2500);
  ok("a contract opens its day-by-day calendar", (await page.$$(".modal .hc")).length > 20, "no calendar cells");
  await shot(page, "data-roots");
  await page.keyboard.press("Escape"); await sleep(400);

  // editor: kind chip, squiggle for a derivatives field on a CFD
  await openFile(page, "es_trend.qkt");
  ok("a continuous stream shows its kind after its line", (await page.evaluate(() => [...document.querySelectorAll(".kind-chip")].map((e) => e.textContent))).includes("Continuous"));
  await openFile(page, "cfd_leak.qkt"); await sleep(2500);
  const marks = await page.evaluate(() => document.querySelectorAll(".monaco-editor .squiggly-error").length);
  ok("`fx.dte` on a CFD alias is underlined as an error", marks > 0, String(marks));
  ok("a CFD stream gets no kind chip", (await page.$$(".kind-chip")).length === 0);

  // readiness: a continuous stream whose root has no catalog names the fix, with Copy and Run it
  await openFile(page, "nq_trend.qkt"); await rail(page, "Data"); await sleep(1500);
  t = await body(page);
  ok("a blocked futures stream shows the exact command", /qkt fetch CME:NQ --catalog/.test(t), t.slice(0, 600));
  ok("the command has Copy and Run it", /Copy/.test(t) && /Run it/.test(t));
  await shot(page, "readiness-blocked");

  // tier control: continuous futures have no ticks
  await openFile(page, "es_trend.qkt");
  const ticksDisabled = await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => /Ticks/.test(b.textContent))?.getAttribute("aria-disabled"));
  ok("Ticks is disabled for a continuous futures strategy", ticksDisabled === "true", String(ticksDisabled));

  // run it
  await run(page);
  await ctrl(page, "j"); await sleep(1500);
  const nav = await page.evaluate(() => [...document.querySelectorAll(".jnav-btn")].map((b) => b.getAttribute("aria-label")));
  ok("the journal has a Futures & options view", nav.includes("Futures & options"), nav.join(","));
  t = await body(page);
  ok("the Overview shows the cost bridge", /From P&L to cost/.test(t) && /Roll costs/.test(t), t.slice(0, 300));
  await scrollTo(page, "From P&L to cost"); await sleep(500);
  await shot(page, "overview-futures");
  await clickText(page, "Futures & options"); await sleep(2000);
  t = await body(page);
  ok("margin, rolls and contracts are there", /Margin and equity/.test(t) && /Rolls/.test(t) && /Contracts behind the fills/.test(t));
  await shot(page, "derivatives-journal");
  await clickText(page, "Trades"); await sleep(1800);
  t = await body(page);
  ok("trades show the contract column", /CONTRACT/i.test(t) && /ES[FGHJKMNQUVXZ]\d\d/.test(t));
  // filter by contract
  await page.click(".fsearch .fin"); await page.keyboard.type("contract:ESH19"); await sleep(300); await page.keyboard.press("Enter"); await sleep(1500);
  ok("a contract filter becomes a chip", /contract:ESH19/.test(await body(page)));
  await shot(page, "trades-futures");
  await page.keyboard.press("Escape"); await sleep(300); await page.keyboard.press("Escape"); await sleep(400);

  // the chart for a continuous stream says why it has no candles
  ok("the continuous stream's chart explains itself", /continuous series built from each contract/.test(await body(page)));
  await shot(page, "workbench-futures");
  await setTheme(page, "light"); await sleep(800);
  await shot(page, "workbench-futures-light");
  await ctrl(page, "j"); await sleep(1200);
  await clickText(page, "Futures & options"); await sleep(1500);
  await shot(page, "derivatives-journal-light");
  await ctrl(page, "j"); await sleep(600);
  await setTheme(page, "dark");

  // a perpetual has candles like any symbol, and its funding shows up in the cost bridge
  await openFile(page, "btc_perp.qkt"); await rail(page, "Data"); await sleep(800);
  await clickText(page, "Use the complete stretch"); await sleep(600);
  await run(page);
  ok("a perpetual run draws candles", (await page.$$(".chart-cell canvas")).length > 0);
  await rail(page, "Files");
  await shot(page, "workbench-perp");
  await ctrl(page, "j"); await sleep(1500);
  await clickText(page, "Overview"); await sleep(1200);
  ok("a contract filter from the ES run does not follow to a perpetual run", !/contract:ESH19/.test(await body(page)));
  t = await body(page);
  ok("the perpetual's funding is in the cost bridge", /Funding/.test(t) && /perpetual funding paid/.test(t), t.slice(0, 200));
  await scrollTo(page, "From P&L to cost"); await sleep(500);
  await shot(page, "overview-perp");
  await ctrl(page, "j"); await sleep(600);
  await setTheme(page, "light"); await sleep(800);
  await shot(page, "workbench-perp-light");
  await setTheme(page, "dark");

  // perpetual: Funding toggle appears, and only there
  await ctrl(page, ","); await sleep(800);
  ok("a perpetual strategy has the Funding option", /Charge funding on perpetuals/.test(await body(page)));
  await page.keyboard.press("Escape"); await sleep(300);
  await openFile(page, "es_trend.qkt");
  await ctrl(page, ","); await sleep(800);
  ok("a dated future has no Funding option", !/Charge funding on perpetuals/.test(await body(page)));
  await page.keyboard.press("Escape");

  ok("no page errors on the futures workspace", errs.length === 0, errs.join(" | "));
  await page.close();
}

// ---------------------------------------------------------------- options workspace (skipped when OPT is empty)
if (OPT) {
  const { page, errs } = await open(OPT, { from: "2026-09-25", to: "2026-09-27", tier: "draft", autoRun: false });
  await rail(page, "Data"); await sleep(1500);
  let t = await body(page);
  ok("data lists an Options group with the Deribit root", /OPTIONS/.test(t) && /BTC_USDC/.test(t) && /trade chains/i.test(t), t.slice(0, 400));
  await page.evaluate(() => document.querySelector('[data-root="DERIBIT:BTC_USDC"]')?.click()); await sleep(1200);
  t = await body(page);
  ok("an option root dialog shows its catalog, chains and terms", /DERIBIT:BTC_USDC · options/.test(t) && /Trade chains/.test(t) && /Contract size/.test(t));
  await shot(page, "data-options-root");
  await page.keyboard.press("Escape"); await sleep(400);
  await openFile(page, "call_to_expiry.qkt");
  ok("an option contract shows its kind", (await page.evaluate(() => [...document.querySelectorAll(".kind-chip")].map((e) => e.textContent))).includes("Option"));
  const barsDisabled = await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => /Bars/.test(b.textContent))?.getAttribute("aria-disabled"));
  ok("Bars is disabled for an option strategy (chains are not bars)", barsDisabled === "true", String(barsDisabled));
  await run(page, 60000);
  await ctrl(page, "j"); await sleep(1500);
  await clickText(page, "Overview"); await sleep(1200);
  t = await body(page);
  ok("the Overview counts the trade the venue settled", /Closed by the venue/.test(t) && /Expiry settlement/.test(t), t.slice(0, 300));
  await clickText(page, "Futures & options"); await sleep(1800);
  t = await body(page);
  ok("the view lists the settlement", /Settled at expiry/.test(t) && /84000_C/.test(t));
  await shot(page, "derivatives-options");
  await clickText(page, "Trades"); await sleep(1500);
  await page.click(".fsearch .fin"); await page.keyboard.type("exit:expiry"); await sleep(300); await page.keyboard.press("Enter"); await sleep(1500);
  t = await body(page);
  ok("exit:expiry filters to the settled trade and shows its badge", /exit:expiry/.test(t) && /expiry/.test(t) && /Showing\s+1\s+of\s+1/.test(t), t.slice(0, 200));
  await shot(page, "trades-options");
  ok("no page errors on the options workspace", errs.length === 0, errs.join(" | "));
  await page.close();
}

// ---------------------------------------------------------------- CFD-only workspace: nothing new shows up
{
  const { page, errs } = await open(CFD, { from: "2024-01-05", to: "2024-02-05", tier: "full", autoRun: false });
  await rail(page, "Data"); await sleep(1500);
  let t = await body(page);
  ok("CFD workspace: no Futures or Options groups", !/\bFUTURES\b/.test(t) && !/\bOPTIONS\b/.test(t), t.slice(0, 300));
  await openFile(page, "demo_cross.qkt");
  ok("CFD workspace: no kind chip in the editor", (await page.$$(".kind-chip")).length === 0);
  const tickOk = await page.evaluate(() => [...document.querySelectorAll(".seg button")].filter((b) => /Bars|Ticks/.test(b.textContent)).every((b) => b.getAttribute("aria-disabled") !== "true"));
  ok("CFD workspace: both data tiers are available", tickOk);
  await run(page);
  await ctrl(page, "j"); await sleep(1500);
  const nav = await page.evaluate(() => [...document.querySelectorAll(".jnav-btn")].map((b) => b.getAttribute("aria-label")));
  ok("CFD workspace: the journal menu is the usual one", !nav.includes("Futures & options") && nav.includes("Overview") && nav.includes("Trades"), nav.join(","));
  t = await body(page);
  ok("CFD workspace: Overview has no cost bridge or venue closes", !/From P&L to cost/.test(t) && !/Closed by the venue/.test(t));
  await clickText(page, "Trades"); await sleep(1500);
  t = await body(page);
  await shot(page, "cfd-trades");
  ok("CFD workspace: the run produced trades", /round trips/.test(t), t.slice(0, 300));
  ok("CFD workspace: trades have no Contract column", !/CONTRACT/.test(t));
  await page.click(".fsearch .fin"); await page.keyboard.type("exit:"); await sleep(500);
  ok("CFD workspace: exit suggestions offer no expiry or liquidation", !/expiry|liquidat/i.test(await page.evaluate(() => document.querySelector(".fsearch")?.parentElement?.innerText ?? "")));
  ok("no page errors on the CFD workspace", errs.length === 0, errs.join(" | "));
  await page.close();
}

await browser.close();
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
