// Keyboard operability of the Files tree, roving tabindex, icon-button labels, and the Journal focus trap.
// Needs a running studio (BASE, default :8099) with a portfolio in its workspace (a book.qkt importing others);
// system Chrome. Read-only: does not type into any editor.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8099/";
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1500, height: 950 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };

await p.evaluateOnNewDocument(() => localStorage.clear());
await p.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3500);

// --- Files tree: keyboard operability -------------------------------------------------------------------------
const focused = () => p.evaluate(() => { const e = document.activeElement; return e?.getAttribute("role") === "treeitem" ? (e.querySelector(".name")?.textContent ?? "").trim() : null; });
const rows = () => p.evaluate(() => [...document.querySelectorAll("[role=treeitem]")].map((r) => ({ name: (r.querySelector(".name")?.textContent ?? "").trim(), level: r.getAttribute("aria-level"), expanded: r.getAttribute("aria-expanded"), tabindex: r.tabIndex })));

await p.evaluate(() => document.querySelector("[role=treeitem]")?.focus());
const r0 = await rows();
ok("exactly one tree row is tab-stoppable", r0.filter((r) => r.tabindex === 0).length === 1, JSON.stringify(r0.map((r) => r.tabindex)));

const bookIdx = r0.findIndex((r) => /book\.qkt$/.test(r.name));
ok("workspace has a portfolio file to test against", bookIdx >= 0, JSON.stringify(r0.map((r) => r.name)));
await p.evaluate((i) => document.querySelectorAll("[role=treeitem]")[i]?.focus(), bookIdx);
ok("roving tabindex follows real focus (not stuck on row 0)", (await p.evaluate(() => document.activeElement.tabIndex)) === 0);

await p.keyboard.press("ArrowRight"); await sleep(250);
const afterRight = await rows();
ok("Right expands a closed portfolio", afterRight[bookIdx].expanded === "true");
ok("expanding reveals member rows one level deeper", afterRight[bookIdx + 1]?.level === String(Number(afterRight[bookIdx].level) + 1));

await p.keyboard.press("ArrowDown"); await sleep(150);
const memberName = await focused();
ok("Down moves focus into the first member", !!memberName && memberName !== "book.qkt");

await p.keyboard.press("ArrowLeft"); await sleep(150);
ok("Left from a member moves focus to its parent portfolio", (await focused()) === "book.qkt");

await p.keyboard.press("ArrowLeft"); await sleep(250);
ok("Left again collapses the parent", (await rows())[bookIdx].expanded === "false");

await p.keyboard.press("End"); await sleep(150);
const last = (await rows()).length - 1;
ok("End jumps to the last row", (await p.evaluate((n) => document.activeElement.querySelector(".name")?.textContent?.trim() === n, (await rows())[last].name)));

await p.keyboard.press("Home"); await sleep(150);
ok("Home jumps to the first row", (await focused()) === (await rows())[0].name);

// typeahead: press a letter that should jump to a row starting with it
const targetLetter = (await rows()).find((r, i) => i > 0 && /^[a-z]/i.test(r.name))?.name?.[0];
if (targetLetter) {
  await p.keyboard.press("Home"); await sleep(100);
  await p.keyboard.type(targetLetter); await sleep(150);
  const landed = await focused();
  ok(`typeahead "${targetLetter}" jumps to a matching row`, !!landed && landed.toLowerCase().startsWith(targetLetter.toLowerCase()), landed ?? "null");
}

// --- global sweeps ----------------------------------------------------------------------------------------------
const unlabeled = await p.evaluate(() => [...document.querySelectorAll("button")].filter((b) => !(b.textContent || "").trim() && !b.getAttribute("aria-label") && !b.title).map((b) => b.className));
ok("every icon-only button has an accessible name", unlabeled.length === 0, JSON.stringify(unlabeled.slice(0, 5)));

const badOutline = await p.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")) {
    if (el.offsetParent === null) continue;
    const cs = getComputedStyle(el, ":focus-visible");
    if (cs.outlineStyle === "none" && cs.boxShadow === "none") bad.push(el.tagName + "." + el.className);
  }
  return bad;
});
ok("no focusable element loses BOTH outline and box-shadow on focus-visible", badOutline.length === 0, JSON.stringify(badOutline.slice(0, 5)));

// --- Journal: open moves focus in, Esc returns it (regression) ---------------------------------------------------
await p.evaluate(() => document.querySelector('button[aria-label="Journal"]')?.focus());
const opener = await p.evaluate(() => document.activeElement?.getAttribute("aria-label"));
await p.keyboard.down("Control"); await p.keyboard.press("j"); await p.keyboard.up("Control"); await sleep(600);
ok("opening the journal moves focus inside it", (await p.evaluate(() => !!document.activeElement?.closest(".jnav, .journal, [aria-label='Journal sections']"))));
await p.keyboard.press("Escape"); await sleep(400);
ok("Esc returns focus to the opener", (await p.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === opener);

console.log("page errors:", JSON.stringify(errs));
await b.close(); process.exit(fail || errs.length ? 1 : 0);
