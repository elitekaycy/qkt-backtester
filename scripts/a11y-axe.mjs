// Optional accessibility audit: runs axe-core on every major screen in dark and light and prints the violations.
// axe-core is NOT a dependency of this repo: install it anywhere (`npm i axe-core` in a temp folder) and point AXE at axe.min.js.
//   AXE=/tmp/axe/node_modules/axe-core/axe.min.js BASE=http://127.0.0.1:8111/ node scripts/a11y-axe.mjs
// Needs a running studio with a finished run of strategies/xau-both.qkt (bracket strategy) and system Chrome. Exit code 1 when a
// serious or critical violation is found (JSON=1 prints machine-readable output). Skips (exit 0) when axe-core is not installed.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const AXE = process.env.AXE ?? "/tmp/axe/node_modules/axe-core/axe.min.js";
if (!fs.existsSync(AXE)) { console.log("axe-core not found; set AXE=/path/to/axe.min.js (skipping)"); process.exit(0); }
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8111/";
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const axeSrc = fs.readFileSync(AXE, "utf8");
const results = [];
const ctrl = async (p, k) => { await p.keyboard.down("Control"); await p.keyboard.press(k); await p.keyboard.up("Control"); };
const click = (p, sel) => p.evaluate((s) => document.querySelector(s)?.click(), sel);
const clickText = (p, sel, re) => p.evaluate((s, r) => [...document.querySelectorAll(s)].find((e) => new RegExp(r, "i").test(e.textContent))?.click(), sel, re.source);

async function audit(p, theme, screen) {
  await p.evaluate(axeSrc);
  const r = await p.evaluate(async (DETAIL) => {
    window.__detail = DETAIL; const res = await window.axe.run(document, { resultTypes: ["violations"] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, window.__detail ? 40 : 3).map((n) => (n.target.join(" ").slice(0, 110) + (window.__detail ? "  ::  " + (n.any[0]?.message || n.all[0]?.message || n.none[0]?.message || "").slice(0, 200) : ""))) }));
  }, !!process.env.DETAIL);
  results.push({ theme, screen, violations: r });
}

for (const theme of (process.env.THEMES ?? "dark,light").split(",")) {
  const p = await b.newPage(); await p.setViewport({ width: 1600, height: 950 });
  await p.evaluateOnNewDocument((t) => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify({ from: "2024-10-01", to: "2024-12-16", tier: "draft", theme: t })); } catch {} }, theme);
  await p.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3500);
  await audit(p, theme, "workbench (files)");
  await ctrl(p, "Enter"); await sleep(6000);
  await audit(p, theme, "workbench + run loaded");
  await clickText(p, "[role=tab]", /^Trades/); await sleep(700); await audit(p, theme, "chart trades tab");
  await clickText(p, "[role=tab]", /^Chart$/); await sleep(300);
  for (const t of ["Problems", "Terminal", "Pipeline"]) { await clickText(p, ".dock-tab", new RegExp(t)); await sleep(1200); await audit(p, theme, `dock: ${t}`); }
  await ctrl(p, "2"); await sleep(1500); await audit(p, theme, "data section");
  await click(p, ".sym-head"); await sleep(1800); await audit(p, theme, "symbol dialog"); await p.keyboard.press("Escape"); await sleep(300);
  await ctrl(p, "3"); await sleep(800); await audit(p, theme, "runs section");
  await ctrl(p, "1"); await sleep(300);
  await ctrl(p, ","); await sleep(700); await audit(p, theme, "run settings popover"); await p.keyboard.press("Escape"); await sleep(300);
  await click(p, 'button[aria-label="Preferences"]'); await sleep(500); await audit(p, theme, "preferences popover"); await p.keyboard.press("Escape"); await sleep(300);
  await ctrl(p, "k"); await sleep(600); await audit(p, theme, "command palette"); await p.keyboard.press("Escape"); await sleep(300);
  await click(p, 'button[aria-label="Keyboard shortcuts"]'); await sleep(500); await audit(p, theme, "shortcuts dialog"); await p.keyboard.press("Escape"); await sleep(300);
  await ctrl(p, "j"); await sleep(1500);
  const n = await p.evaluate(() => document.querySelectorAll(".jnav-btn").length);
  for (let i = 0; i < n; i++) { await p.evaluate((k) => document.querySelectorAll(".jnav-btn")[k]?.click(), i); await sleep(1300); const name = await p.evaluate((k) => document.querySelectorAll(".jnav-btn")[k]?.textContent?.trim(), i); await audit(p, theme, `journal: ${name}`); }
  await p.close();
}
await b.close();

const rank = { critical: 3, serious: 2, moderate: 1, minor: 0 };
let bad = 0; const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 };
if (process.env.JSON) console.log(JSON.stringify(results, null, 1));
else for (const r of results) {
  const c = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of r.violations) { c[v.impact] += v.nodes; totals[v.impact] += v.nodes; if (rank[v.impact] >= 2) bad++; }
  console.log(`${r.theme.padEnd(5)} ${r.screen.padEnd(28)} critical ${c.critical} serious ${c.serious} moderate ${c.moderate} minor ${c.minor}`);
  if (process.env.VERBOSE) for (const v of r.violations) console.log(`      ${v.impact.padEnd(8)} ${v.id} (${v.nodes}) ${v.help}\n        ${v.sample.join("\n        ")}`);
}
console.log("TOTAL nodes:", JSON.stringify(totals));
process.exit(bad ? 1 : 0);
