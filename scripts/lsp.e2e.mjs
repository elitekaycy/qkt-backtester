// Completions from qkt lsp reach the editor, for member access (`gold.cl` -> close) as well as keywords, even when typing fast.
// Needs a running studio (BASE, default :8099) with a strategy open; system Chrome.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8099/";
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1500, height: 900 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
await p.evaluateOnNewDocument(() => { localStorage.clear(); });
await p.goto(BASE); await sleep(4000);
// NOTE: this types into the open file and auto-save writes it: run it against a scratch workspace, never a real one.
await p.click(".monaco-editor .view-lines");
await p.keyboard.down("Control"); await p.keyboard.press("End"); await p.keyboard.up("Control");
const rows = () => p.evaluate(() => [...document.querySelectorAll(".suggest-widget .monaco-list-row")].map((r) => r.textContent));
await p.keyboard.type("\n    THEN BU", { delay: 30 }); await sleep(1500);
ok("keyword completion", (await rows()).some((r) => r.startsWith("BUY")), JSON.stringify(await rows()));
// the label must be VISIBLE: it once collided with an app CSS class and rendered as icons only
const vis = await p.evaluate(() => { const l = document.querySelector(".suggest-widget .monaco-list-row .label-name"); if (!l) return false; const r = l.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 4 && r.height > 4 && (l === at || l.contains(at) || at?.closest(".monaco-icon-label") !== null); });
ok("suggestion labels are visible (not just icons)", vis);
await p.keyboard.press("Escape"); await p.keyboard.press("Escape");
await p.keyboard.type("\n    WHEN ema(gold.cl", { delay: 30 }); await sleep(1500);
ok("member completion right after typing (the server saw the latest text)", (await rows()).includes("close"), JSON.stringify(await rows()));
await b.close(); process.exit(fail ? 1 : 0);
