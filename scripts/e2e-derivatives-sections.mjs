// Renders every section of the Futures & options journal view from real qkt runs, and fails on a section that is missing, empty,
// overflows its panel or leaves the page with an error. The runs are made through the studio's own API on real data:
//   OPT: a studio over qkt's Deribit book snapshot store, strategy spread.qkt (a put spread) with a starting balance just above the
//        structure's worst-case loss: a structure still open, a margin call.
//   FUT: a studio over CME ES contracts with a margin block on the root: es_liq (ES@front held until the venue liquidates it) and
//        es_exp (the ESH19 contract held to its expiry: a settlement).
//
//   OPT=http://127.0.0.1:8201/ FUT=http://127.0.0.1:8202/ SHOTS=/tmp/shots node scripts/e2e-derivatives-sections.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const OPT = process.env.OPT ?? "http://127.0.0.1:8201/", FUT = process.env.FUT ?? "http://127.0.0.1:8202/";
const SHOTS = process.env.SHOTS ?? "/tmp/deriv-sections";
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
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`console: ${m.text()}`); });
  await page.evaluateOnNewDocument((p) => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify(p)); } catch { /* blocked */ } }, prefs);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rail-btn", { timeout: 20000 });
  await sleep(2500);
  return { page, errs };
}
const clickText = (page, text, sel = "button") => page.evaluate((t, s) => { const e = [...document.querySelectorAll(s)].find((b) => b.getAttribute("aria-label") === t || b.textContent.trim() === t); e?.click(); return !!e; }, text, sel);
const ctrl = async (page, k) => { await page.keyboard.down("Control"); await page.keyboard.press(k); await page.keyboard.up("Control"); };

/** Open the run of `strategy` from the Runs section, then the journal's Futures & options view. */
async function showRun(page, strategy) {
  await clickText(page, "Runs"); await sleep(1200);
  const hit = await page.evaluate((s) => { const e = [...document.querySelectorAll("*")].find((x) => x.children.length === 0 && x.textContent.trim().includes(s)); e?.click(); return !!e; }, strategy);
  await sleep(2500);
  await ctrl(page, "j"); await sleep(1500);
  await clickText(page, "Futures & options"); await sleep(2200);
  return hit;
}

/** Each widget of the view: its title, whether it has rows, and whether anything inside it spills past its own box. */
const widgets = (page) => page.evaluate(() => [...document.querySelectorAll(".widget")].map((w) => {
  const box = w.getBoundingClientRect();
  const spill = [...w.querySelectorAll("*")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > box.right + 2 || b.left < box.left - 2) && getComputedStyle(e).position !== "fixed" && !e.closest("[style*='overflow']") && !e.closest(".scroll,.table-wrap,.tbl-scroll"); }).length;
  return { title: (w.getAttribute("aria-label") ?? "").slice(0, 40), rows: w.querySelectorAll("tbody tr").length, text: w.innerText.length, spill, h: Math.round(box.height), w: Math.round(box.width) };
}));

async function scenario(url, strategy, name, expectTitles, expectIn) {
  const { page, errs } = await open(url, { from: "2019-01-01", to: "2021-01-01", tier: "draft", autoRun: false });
  const hit = await showRun(page, strategy);
  ok(`${name}: the run is on screen`, hit);
  const ws = await widgets(page);
  console.log(`  ${name}:`, ws.map((w) => `${w.title} [${w.rows} rows, spill ${w.spill}]`).join(" | "));
  for (const t of expectTitles) ok(`${name}: shows "${t}"`, ws.some((w) => w.title.startsWith(t)), ws.map((w) => w.title).join(","));
  ok(`${name}: nothing spills out of its panel`, ws.every((w) => w.spill === 0), JSON.stringify(ws.filter((w) => w.spill)));
  for (const [title, text] of expectIn) {
    const body = await page.evaluate((t) => [...document.querySelectorAll(".widget")].find((w) => (w.getAttribute("aria-label") ?? "").startsWith(t))?.innerText ?? "", title);
    ok(`${name}: "${title}" says ${JSON.stringify(text)}`, body.includes(text), body.slice(0, 200));
  }
  // one screenshot of the view, and one per widget scrolled into view
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  const n = await page.evaluate(() => document.querySelectorAll(".widget").length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((k) => document.querySelectorAll(".widget")[k]?.scrollIntoView({ block: "start" }), i); await sleep(500);
    await page.screenshot({ path: `${SHOTS}/${name}-${i}.png` });
  }
  ok(`${name}: no page errors`, errs.length === 0, errs.join(" | "));
  await page.close();
}

await scenario(OPT, "spread", "options-margin-call", ["Margin and equity", "Option structures"], [["Margin and equity", "1 below"], ["Option structures", "Sell 0.1 · 4OCT26 83000 P"]]);
await scenario(FUT, "es_liq", "futures-liquidation", ["Margin and equity", "Liquidations"], [["Liquidations", "17,173"]]);
await scenario(FUT, "es_exp", "futures-settlement", ["Settled at expiry"], [["Settled at expiry", "ESH19"]]);

await browser.close();
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
