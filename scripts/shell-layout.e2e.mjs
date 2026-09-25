import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8101/";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 950 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGE " + e.message)); p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("CON " + m.text().slice(0, 200)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
await p.goto(BASE); await sleep(3500);
const rect = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), hidden: cs.display === "none" || r.width === 0 }; }, sel);
const click = (label) => p.evaluate((l) => document.querySelector(`button[aria-label="${l}"]`)?.click(), label);
const dbl = async (label) => { await click(label); await click(label); };

// 1. every pane: maximize -> others hidden -> Esc restores
for (const [pane, label, expectHidden] of [["sidebar", "Full screen sidebar", ".main"], ["editor", "Full screen editor", ".pv-wrap"], ["chart", "Full screen chart", ".editor-col"], ["output panel", "Full screen output panel", ".pv-wrap"]]) {
  if (!(await p.$(`button[aria-label="${label}"]`))) { ok(`${pane}: full-screen button exists`, false, label); continue; }
  await click(label); await sleep(300);
  ok(`${pane}: maximized hides the rest`, (await rect(expectHidden))?.hidden === true);
  await p.evaluate(() => document.activeElement?.blur?.()); await p.keyboard.press("Escape"); await sleep(300);
  ok(`${pane}: Esc restores`, (await rect(".main"))?.hidden === false && (await rect(".pv-wrap"))?.hidden === false && (await rect(".editor-col"))?.hidden === false);
}
// 2. double click every expand icon, also with the terminal open: no errors, always restored to a valid layout
await p.evaluate(() => [...document.querySelectorAll(".dock-tab")].find((t) => /Terminal/.test(t.textContent)).click()); await sleep(1500);
for (const l of ["output panel", "editor", "chart", "sidebar"]) { for (let i = 0; i < 3; i++) await dbl(`Full screen ${l}`).catch(() => {}); await dbl(`Restore ${l}`).catch(() => {}); await sleep(200); }
for (let i = 0; i < 4; i++) { await dbl("Collapse output panel"); await dbl("Expand output panel"); }
await sleep(600);
ok("double taps leave no page errors", errs.length === 0, JSON.stringify(errs));
// 3. sidebar collapse / expand / reset / big drag
const sw0 = (await rect(".sidebar")).w;
await click("Collapse sidebar"); await sleep(200);
ok("sidebar collapse hides it", (await rect(".sidebar")) === null);
await p.evaluate(() => document.querySelector('button[aria-label="Files"]').click()); await sleep(200);
ok("rail restores it", (await rect(".sidebar"))?.w > 100);
const sp = await p.$('[aria-label="Resize sidebar"]'); const sb = await sp.boundingBox();
await p.mouse.move(sb.x + 4, sb.y + 200); await p.mouse.down(); await p.mouse.move(1300, sb.y + 200, { steps: 8 }); await p.mouse.up(); await sleep(300);
const big = (await rect(".sidebar")).w; ok("sidebar can be dragged wide", big > 900, String(big));
await click("Reset sidebar size"); await sleep(200);
ok("reset returns default width", (await rect(".sidebar")).w === sw0, `${(await rect(".sidebar")).w} vs ${sw0}`);
// 4. chart pane drag to nearly full, editor strip, chart strip
const cp = await p.$('[aria-label="Resize chart"]'); const cb = await cp.boundingBox();
await p.mouse.move(cb.x + 4, cb.y + 200); await p.mouse.down(); await p.mouse.move(300, cb.y + 200, { steps: 8 }); await p.mouse.up(); await sleep(300);
const cw = (await rect(".pv-wrap")).w; ok("chart can take most of the workbench", cw > 800, String(cw));
if (await p.$('button[aria-label="Collapse editor"]')) { await click("Collapse editor"); await sleep(300); const eh = (await rect('section[aria-label="Editor"]')).h; ok("editor collapses to a strip", eh < 60, String(eh)); await click("Expand editor"); await sleep(200); }
console.log("errors:", JSON.stringify(errs));
await b.close(); process.exit(fail ? 1 : 0);
