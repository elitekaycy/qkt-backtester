// Journal browser checks: scrim/close behaviour, search-first filters, chart hover/zoom/drill, maximize double-click.
// Needs a running studio with a finished run of the strategy (BASE, default :8103) and system Chrome.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url).pathname);
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8103/";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });
const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify({ from: "2024-01-01", to: "2024-12-15", tier: "draft", theme: "dark" })); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
const ctrl = async (k) => { await page.keyboard.down("Control"); await page.keyboard.press(k); await page.keyboard.up("Control"); };
const count = () => page.evaluate(() => Number(/Showing\s+(\d+)/.exec(document.querySelector(".filterbar .stat")?.textContent ?? "")?.[1] ?? -1));
const nav = async (i) => { await page.evaluate((k) => document.querySelectorAll(".jnav-btn")[k]?.click(), i); await sleep(1300); };
const chips = () => page.evaluate(() => [...document.querySelectorAll(".fsearch .chip .mono")].map((e) => e.textContent));
const typeFilter = async (t) => { await page.click(".fsearch .fin"); await page.keyboard.type(t); await sleep(250); };

await page.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3000);
await ctrl("Enter"); await sleep(6500);
await ctrl("j"); await sleep(1500);
ok("journal opens", !!(await page.$(".drawer")));

// ---- scrim ----
const sc = await page.evaluate(() => { const r = document.querySelector(".scrim").getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
ok("scrim covers the whole window (rail and sidebar too)", sc.w === sc.vw && sc.h === sc.vh, JSON.stringify(sc));
ok("outside point is the scrim, inside point is the drawer", await page.evaluate(() => document.elementFromPoint(30, 400)?.classList.contains("scrim") && !!document.elementFromPoint(1200, 400)?.closest(".drawer")));
await page.mouse.click(30, 400); await sleep(500);
ok("clicking outside closes the journal", !(await page.$(".drawer")));
await ctrl("j"); await sleep(1200);
await page.keyboard.press("Escape"); await sleep(400);
ok("Esc closes the journal", !(await page.$(".drawer")));
await page.click('nav.rail button[aria-label="Journal"]'); await sleep(1200);
await page.keyboard.press("Escape"); await sleep(500);
ok("focus returns to the button that opened the journal", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Journal"));
await page.click('nav.rail button[aria-label="Journal"]'); await sleep(1200);
await page.keyboard.press("Tab"); await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
ok("Tab stays inside the journal", await page.evaluate(() => !!document.activeElement?.closest(".drawer")));

// ---- filters: search with completion ----
const all = await count();
await typeFilter("lon");
ok("typing shows suggestions", (await page.$$(".fsug li[role=option]")).length > 0);
await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await sleep(700);
ok("Enter on a suggestion adds a chip", (await chips()).includes("side:long"), JSON.stringify(await chips()));
const longCount = await count();
ok("the trade count reacts", longCount > 0 && longCount <= all, `${all} -> ${longCount}`);
await typeFilter("held:<4h "); await sleep(700);
ok("typing a full filter and a space commits it", (await chips()).includes("held:<4h"), JSON.stringify(await chips()));
ok("count narrows again", (await count()) < longCount);
await typeFilter("banana"); await page.keyboard.press("Enter"); await sleep(300);
ok("a bad word explains itself and keeps your text", !!(await page.$(".ferr")) && (await page.$eval(".fsearch .fin", (e) => e.value)) === "banana");
await page.$eval(".fsearch .fin", (e) => { e.select(); }); await page.keyboard.press("Backspace"); await sleep(200);
await page.keyboard.press("Backspace"); await sleep(700);
ok("Backspace on an empty box removes the last chip", !(await chips()).includes("held:<4h"));
await page.evaluate(() => [...document.querySelectorAll(".fsearch .chip button")][0]?.click()); await sleep(600);
ok("a chip's x removes it", (await chips()).length === 0 && (await count()) === all);
// panel + popover click must not close the journal
await page.evaluate(() => [...document.querySelectorAll(".filterbar .btn")].find((b) => /Filters/.test(b.textContent))?.click()); await sleep(500);
ok("Filters panel opens", !!(await page.$(".popover .fpanel")));
await page.evaluate(() => [...document.querySelectorAll(".popover .seg button")].find((b) => b.textContent === "Long")?.click()); await sleep(600);
ok("clicking inside the popover keeps the journal open and applies the filter", !!(await page.$(".drawer")) && (await chips()).includes("side:long"));
await page.keyboard.press("Escape"); await sleep(300);
ok("Esc closes only the popover", !!(await page.$(".drawer")) && !(await page.$(".popover")));
await page.evaluate(() => [...document.querySelectorAll(".filterbar .btn")].find((b) => /Clear all/.test(b.textContent))?.click()); await sleep(600);

// ---- daily chart: hover, zoom, drill ----
await nav(2);
const box = await page.evaluate(() => { const r = document.querySelector('[data-testid], .widget [role=img]')?.getBoundingClientRect(); const c = [...document.querySelectorAll('[role=img][aria-label="Profit and loss per day"]')][0].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
await page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.4); await sleep(500);
const tip = await page.evaluate(() => [...document.querySelectorAll("div")].map((d) => d.textContent).find((t) => /Win rate/.test(t) && /Cumulative/.test(t) && t.length < 240) ?? "");
ok("hovering a day shows date, P&L, trades, win rate, cumulative", /Trades/.test(tip) && /Win rate/.test(tip), tip.slice(0, 120));
ok("zoom bar reads 'Whole period' before zooming", /Whole period/.test(await page.$eval(".zoombar", (e) => e.textContent)));
await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -400 }); await sleep(60); }
await sleep(600);
const zt = await page.$eval(".zoombar", (e) => e.textContent);
ok("wheel zoom narrows the window and the summary follows", /Showing/.test(zt), zt.slice(0, 80));
await page.evaluate(() => [...document.querySelectorAll(".zoombar .btn")][0]?.click()); await sleep(500);
ok("Reset zoom restores the whole period", /Whole period/.test(await page.$eval(".zoombar", (e) => e.textContent)));
await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.35); await sleep(800);
ok("clicking a bar drills to that day (chip + trades list)", (await chips()).some((c) => c.startsWith("day:")), JSON.stringify(await chips()));
await page.evaluate(() => [...document.querySelectorAll(".filterbar .btn")].find((b) => /Clear all/.test(b.textContent))?.click()); await sleep(500);

// ---- monthly click -> calendar ----
await nav(3);
const mb = await page.evaluate(() => { const c = document.querySelector('[role=img][aria-label="Profit and loss per month"]').getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
await page.mouse.click(mb.x + mb.w * 0.27, mb.y + mb.h * 0.35); await sleep(900);
ok("clicking a month opens it in the calendar", await page.evaluate(() => document.querySelector(".jnav-btn[aria-current=page]")?.textContent === "Calendar"));

// ---- empty state through filters ----
await typeFilter("pnl:>100000 "); await sleep(900);
await nav(2);
ok("an empty selection explains itself in one message", /No closed trades in this selection/.test(await page.$eval(".jbody", (e) => e.textContent)));
await page.evaluate(() => [...document.querySelectorAll(".filterbar .btn")].find((b) => /Clear all/.test(b.textContent))?.click()); await sleep(500);

// ---- maximize: double-click safe, charts survive ----
const before = errs.length;
await page.evaluate(() => { const b = document.querySelector('.jhead button[aria-label*="width"]'); b.click(); b.click(); }); await sleep(600);
await page.evaluate(() => { const b = document.querySelector('.jhead button[aria-label*="width"]'); b.click(); }); await sleep(700);
await page.click('.jhead button[aria-label*="width"]', { count: 2, delay: 30 }); await sleep(700);
ok("double-tapping maximize raises no errors and keeps the journal open", errs.length === before && !!(await page.$(".drawer")), errs.slice(before).join(" | "));
ok("charts still render after the resize storm", await page.evaluate(() => document.querySelector(".drawer canvas")?.width > 50));

// ---- trades keyboard ----
await nav(4);
await page.focus(".vrow[data-row='0']"); await page.keyboard.press("ArrowDown"); await sleep(300);
ok("arrow keys move the trade selection", await page.evaluate(() => document.querySelector(".vrow[aria-selected=true]")?.getAttribute("data-row") === "1"));

console.log("page errors:", JSON.stringify(errs)); if (errs.length) fail++;
await browser.close(); process.exit(fail ? 1 : 0);
