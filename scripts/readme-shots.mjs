// Captures the README's screenshots from a studio running the way production does (Docker: /workspace and /data), so no
// machine path appears in a picture. Dark and light, 1800x1100 at 1.33x (about 2400x1460).
//
//   docker build -f docker/Dockerfile -t qkt-backtester:shots .
//   # <demo>/data: a qkt data store with XAUUSD 30m bars (Oct-Dec 2024), CME ES contracts + catalog + rolls (2018-2021),
//   #              BINANCE_UM BTCUSDT 1h bars + funding (Jan-Feb 2024) and an instruments.yaml; <demo>/workspace: EMPTY (it is seeded)
//   docker run -d --name qb-shots -p 127.0.0.1:8110:8080 -v <demo>/workspace:/workspace -v <demo>/data:/data qkt-backtester:shots
//   # then add strategies/{xau_ema_cross,es_trend,nq_trend,btc_perp,cfd_leak}.qkt (see docs/futures-and-options.md for the shapes)
//   STUDIO=http://127.0.0.1:8110/ SHOTS=docs/assets node scripts/readme-shots.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const STUDIO = process.env.STUDIO ?? "http://127.0.0.1:8110/";
const SHOTS = process.env.SHOTS ?? "docs/assets";
const ONLY = process.env.THEMES ? process.env.THEMES.split(",") : ["dark", "light"];
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--font-render-hinting=none"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(prefs, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1800, height: 1100, deviceScaleFactor: 1.33 });
  await page.evaluateOnNewDocument((p) => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify(p)); } catch { /* storage blocked */ } }, prefs);
  await page.goto(STUDIO, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rail-btn", { timeout: 20000 });
  await sleep(2500);
  await setTheme(page, theme);
  return page;
}
const clickText = (page, text, sel = "button") => page.evaluate((t, s) => { const e = [...document.querySelectorAll(s)].find((b) => b.getAttribute("aria-label") === t || b.textContent.trim() === t); e?.click(); return !!e; }, text, sel);
const ctrl = async (page, k) => { await page.keyboard.down("Control"); await page.keyboard.press(k); await page.keyboard.up("Control"); };
const rail = async (page, label) => {
  const on = await page.evaluate((l) => document.querySelector(`.rail-btn[aria-label="${l}"]`)?.getAttribute("aria-pressed") === "true", label);
  if (!on) await clickText(page, label); await sleep(900);
};
const openFile = async (page, name) => {
  await rail(page, "Files");
  await page.evaluate((n) => { const e = [...document.querySelectorAll("*")].find((x) => x.children.length === 0 && x.textContent.trim() === n); e?.click(); return !!e; }, name);
  await sleep(2200);
};
const setTheme = async (page, theme) => { const cur = await page.evaluate(() => document.documentElement.dataset.theme); if (cur !== theme) { await clickText(page, theme === "light" ? "Switch to light theme" : "Switch to dark theme"); await sleep(700); } };
async function run(page, wait = 90000) {
  await clickText(page, "Run"); await sleep(1500);
  const t0 = Date.now();
  while (Date.now() - t0 < wait) { await sleep(1500); if (await page.evaluate(() => !document.querySelector("button.btn.danger"))) break; }
  await sleep(2000);
}
const shot = (page, name, theme) => page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
const firstTrade = async (page) => { await clickText(page, "Start at the first trade"); await sleep(2000); };
// the card of a trade that won reads better in a picture than the first trade of a run, which is often a stop-out
const winningTrade = async (page) => {
  await clickText(page, "Start at the first trade"); await sleep(1500);
  for (let i = 0; i < 20; i++) {
    const won = await page.evaluate(() => { const t = document.body.innerText; const m = /P&L\s*\n?\s*([+\u2212-])/.exec(t.slice(t.lastIndexOf("trade") - 400)); return /Target hit|Rule exit/.test(t) && /P&L\s*\n\s*\+/.test(t); });
    if (won) break;
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].filter((x) => x.getAttribute("aria-label") === "Next trade"); b[b.length - 1]?.click(); });
    await sleep(900);
  }
  await sleep(800);
};
const closeTabs = async (page, keep) => { for (const n of ["qkt.config.yaml", "btc_perp.qkt", "xau_ema_cross.qkt", "cfd_leak.qkt", "es_trend.qkt", "nq_trend.qkt"]) if (n !== keep) { await page.evaluate((x) => { const e = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("Close") && (b.getAttribute("aria-label") || "").endsWith(x)); e?.click(); }, n); await sleep(250); } };

for (const theme of ONLY) {
  // gold: hero and journal
  let page = await open({ from: "2024-10-01", to: "2024-12-15", tier: "draft", autoRun: false }, theme);
  await openFile(page, "xau_ema_cross.qkt");
  await closeTabs(page, "xau_ema_cross.qkt");
  await run(page);
  await winningTrade(page);
  await shot(page, "hero", theme);
  await ctrl(page, "j"); await sleep(2000);
  await clickText(page, "Overview"); await sleep(1500);
  await shot(page, "journal", theme);
  await ctrl(page, "j"); await sleep(800);
  // write: the editor refusing a futures field on a CFD
  await openFile(page, "cfd_leak.qkt"); await sleep(2500);
  await page.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Problems"))?.click(); });
  await sleep(1200);
  await shot(page, "write", theme);
  await page.close();

  // perpetual: candles, boxes, a trade card
  page = await open({ from: "2024-01-01", to: "2024-03-01", tier: "draft", autoRun: false }, theme);
  await openFile(page, "btc_perp.qkt");
  await closeTabs(page, "btc_perp.qkt");
  await run(page);
  await winningTrade(page);
  await shot(page, "run", theme);
  await page.close();

  // futures: the journal's Futures & options view
  page = await open({ from: "2019-01-02", to: "2020-12-31", tier: "draft", autoRun: false }, theme);
  await openFile(page, "es_trend.qkt");
  await closeTabs(page, "es_trend.qkt");
  await run(page);
  await ctrl(page, "j"); await sleep(2000);
  await clickText(page, "Futures & options"); await sleep(2200);
  await shot(page, "futures", theme);
  await ctrl(page, "j"); await sleep(600);

  // data: roots beside symbols, and a strategy whose data is missing naming the fix
  await openFile(page, "nq_trend.qkt");
  await closeTabs(page, "nq_trend.qkt");
  await rail(page, "Data"); await sleep(1500);
  await clickText(page, "Collapse chart"); await sleep(1200); // the chart still holds the previous run: it would sit beside a different file
  await shot(page, "data", theme);
  await page.close();
}
await browser.close();
