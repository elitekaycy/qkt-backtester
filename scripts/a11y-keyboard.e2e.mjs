// Keyboard-only navigation of the file tree, the Runs list, the Data section's symbol list, dialog focus traps and
// the rail. Needs a running studio (BASE, default :8099) with the sample workspace (a .qkt strategy open, a data
// source scanned) and system Chrome. Types nothing into files, so it is safe to run against any workspace.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8099/";
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 950 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
await p.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3500);

const active = () => p.evaluate(() => ({ tag: document.activeElement?.tagName, cls: document.activeElement?.className?.toString().slice(0, 40), text: document.activeElement?.textContent?.slice(0, 30), aria: document.activeElement?.getAttribute("role") }));
const ctrl = async (k) => { await p.keyboard.down("Control"); await p.keyboard.press(k); await p.keyboard.up("Control"); };

// ---- rail: roving focus, Up/Down cycles ----------------------------------------------------------------------------
await p.evaluate(() => document.querySelector('button[aria-label="Files"]')?.focus());
await p.keyboard.press("ArrowDown"); await sleep(100);
ok("rail: ArrowDown moves focus to the next rail button", (await active()).cls?.includes("rail-btn"));

// ---- file tree: WAI-ARIA tree keyboard pattern ---------------------------------------------------------------------
await ctrl("1"); await sleep(500);
await p.evaluate(() => document.querySelector('[role="treeitem"]')?.focus());
let a = await active();
ok("tree: a treeitem is the tab stop", a.aria === "treeitem", JSON.stringify(a));
const treeLabel = () => p.evaluate(() => document.activeElement?.getAttribute("aria-label"));
const before = await treeLabel();
await p.keyboard.press("ArrowDown"); await sleep(100);
ok("tree: ArrowDown moves to the next row", (await treeLabel()) !== before, `${before} -> ${await treeLabel()}`);
await p.keyboard.press("ArrowUp"); await sleep(100);
ok("tree: ArrowUp moves back", (await treeLabel()) === before);
const expandable = await p.evaluate(() => { const rows = [...document.querySelectorAll('[role="treeitem"]')]; const r = rows.find((x) => x.getAttribute("aria-expanded") === "false"); if (r) r.focus(); return !!r; });
if (expandable) {
  await p.keyboard.press("ArrowRight"); await sleep(150);
  ok("tree: ArrowRight expands a closed folder", (await p.evaluate(() => document.activeElement?.getAttribute("aria-expanded"))) === "true");
  await p.keyboard.press("ArrowLeft"); await sleep(150);
  ok("tree: ArrowLeft collapses it back", (await p.evaluate(() => document.activeElement?.getAttribute("aria-expanded"))) === "false");
} else console.log("SKIP tree: no closed folder to expand/collapse in this workspace");
await p.evaluate(() => document.querySelector('[role="treeitem"]')?.focus());
await p.keyboard.press("End"); await sleep(100);
const endLabel = await treeLabel();
await p.keyboard.press("Home"); await sleep(100);
ok("tree: Home/End jump to the first and last row", (await treeLabel()) !== endLabel);
// type-ahead
await p.keyboard.type("q"); await sleep(200);
ok("tree: typing a letter jumps to a name starting with it", /qkt/i.test((await treeLabel()) ?? ""), await treeLabel());
// roving tabindex: only one treeitem is a tab stop
const stops = await p.evaluate(() => [...document.querySelectorAll('[role="treeitem"]')].filter((e) => e.tabIndex === 0).length);
ok("tree: exactly one row is in the tab order (roving tabindex)", stops === 1, String(stops));

// ---- Runs list: Up/Down, roving tabindex --------------------------------------------------------------------------
await ctrl("3"); await sleep(500);
const hasRuns = await p.evaluate(() => document.querySelectorAll('[role="listitem"]').length > 0);
if (hasRuns) {
  await p.evaluate(() => document.querySelector('[role="list"][aria-label="Runs"] [role="listitem"]')?.focus());
  const runStops = () => p.evaluate(() => [...document.querySelectorAll('[role="list"][aria-label="Runs"] [role="listitem"]')].filter((e) => e.tabIndex === 0).length);
  ok("runs: exactly one row is in the tab order", (await runStops()) === 1, String(await runStops()));
  await p.keyboard.press("ArrowDown"); await sleep(100);
  ok("runs: ArrowDown moves focus", (await active()).aria === "listitem");
} else console.log("SKIP runs list: no runs in this workspace");

// ---- Data section: symbol list Up/Down -----------------------------------------------------------------------------
await ctrl("2"); await sleep(1200);
const hasSyms = await p.evaluate(() => document.querySelectorAll('[role="list"][aria-label="Symbols"] [data-symbol]').length > 1);
if (hasSyms) {
  await p.evaluate(() => document.querySelector('[role="list"][aria-label="Symbols"] [data-symbol]')?.focus());
  const first = await p.evaluate(() => document.activeElement?.dataset.symbol);
  await p.keyboard.press("ArrowDown"); await sleep(100);
  ok("data: ArrowDown moves to the next symbol", (await p.evaluate(() => document.activeElement?.dataset.symbol)) !== first);
} else console.log("SKIP data symbol list: fewer than 2 symbols scanned");

// ---- dialog: focus trap and return ----------------------------------------------------------------------------------
await ctrl(","); await sleep(700);
ok("run settings: focus moved into the popover", !!(await p.evaluate(() => document.querySelector(".popover")?.contains(document.activeElement))));
await p.keyboard.press("Escape"); await sleep(300);
ok("run settings: Esc closes it", !(await p.evaluate(() => !!document.querySelector(".popover"))));

await ctrl("k"); await sleep(500);
ok("palette: focus is the search box", (await active()).tag === "INPUT");
await p.keyboard.press("Escape"); await sleep(300);

// ---- Esc never leaves a full-screen editor (still true after the a11y pass) -----------------------------------------
await p.evaluate(() => document.querySelector('button[aria-label="Full screen editor"]')?.click()); await sleep(400);
await p.evaluate(() => window.__qktEditor?.focus());
await p.keyboard.press("Escape"); await sleep(200);
ok("editor: Esc keeps a full-screen editor full screen", await p.evaluate(() => document.querySelector(".app")?.dataset.maxed === "editor"));
await p.evaluate(() => document.querySelector('button[aria-label="Restore editor"]')?.click());

console.log("errors:", JSON.stringify(errs));
if (errs.length) fail++;
await b.close();
process.exit(fail ? 1 : 0);
