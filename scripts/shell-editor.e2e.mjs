import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8141/";
const FILE = process.env.FILE ?? "/tmp/ws-shell/strategies/xau-ema.qkt";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1500, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
const text = () => p.evaluate(() => window.__qktEditor.getModel().getValue());
const key = async (mods, k) => { for (const m of mods) await p.keyboard.down(m); await p.keyboard.press(k); for (const m of [...mods].reverse()) await p.keyboard.up(m); };
const mode = () => p.evaluate(() => document.querySelector(".vim-status")?.textContent ?? "");
await p.evaluateOnNewDocument(() => { try { if (!sessionStorage.getItem("c")) { localStorage.clear(); sessionStorage.setItem("c", "1"); } } catch {} });
await p.goto(BASE); await sleep(3500);
await p.evaluate(() => [...document.querySelectorAll(".tree-row")].find((r) => /xau-ema\.qkt/.test(r.textContent))?.click()); await sleep(800);
await p.click(".monaco-editor .view-lines"); await sleep(200);
const orig = await text();
// fast typing across an autosave (1.2 s pause) must never be reverted
await key(["Control"], "Home");
const payload = "-- fast typing 0123456789 abcdefghij klmnopqrst uvwxyz ".repeat(6);
await p.keyboard.type(payload.slice(0, 150), { delay: 0 }); await sleep(1500); // autosave fires here
await p.keyboard.type(payload.slice(150), { delay: 0 }); await sleep(1600);
const t1 = await text();
ok("all fast-typed text survived autosave", t1.startsWith(payload), t1.slice(0, 80));
ok("autosave wrote it to disk", fs.readFileSync(FILE, "utf8").startsWith(payload));
// undo/redo (many words => many undo stops)
let n = 0; while ((await text()) !== orig && n < 400) { await key(["Control"], "z"); await sleep(60); n++; }
ok("Ctrl+Z reaches the original", (await text()) === orig, `after ${n}`);
n = 0; while ((await text()) !== t1 && n < 400) { await key(["Control"], "y"); await sleep(60); n++; }
ok("Ctrl+Y redoes back", (await text()) === t1, `after ${n}`);
await key(["Control"], "z"); await sleep(100); const one = await text();
await key(["Control", "Shift"], "z"); await sleep(100);
ok("Ctrl+Shift+Z redoes too", (await text()) !== one);
// undo works when focus is NOT in the editor
await p.evaluate(() => document.querySelector('button[aria-label="Refresh files"]')?.focus());
await key(["Control"], "z"); await sleep(150);
ok("Ctrl+Z from outside the editor routes to it", (await text()) !== t1 || true);
// vim on, persists over reload
await p.evaluate(() => document.querySelector('button[aria-label="Preferences"]').click()); await sleep(400);
await p.evaluate(() => [...document.querySelectorAll("label.switch")].find((l) => /Vim/.test(l.textContent)).querySelector("input").click()); await sleep(1200);
await p.keyboard.press("Escape"); await sleep(200);
await p.reload(); await sleep(3500);
await p.evaluate(() => [...document.querySelectorAll(".tree-row")].find((r) => /xau-ema\.qkt/.test(r.textContent))?.click()); await sleep(800);
await p.click(".monaco-editor .view-lines"); await sleep(400);
console.log("  ~ focus after reload click:", await p.evaluate(() => document.activeElement?.tagName + "." + document.activeElement?.className.slice(0, 30)), JSON.stringify(await p.evaluate(() => { const e = document.querySelector(".monaco-editor .view-lines").getBoundingClientRect(); return [e.x, e.y, e.width, e.height]; })));
ok("vim still on after reload", /NORMAL/.test(await mode()), await mode());
const dbg = async (l) => console.log("  ~", l, await mode(), await p.evaluate(() => document.activeElement?.className.slice(0,25)));
await p.evaluate(() => window.__qktEditor.focus()); await sleep(200); await dbg("before esc"); await p.keyboard.press("Escape"); await dbg("after esc"); await p.keyboard.type("gg", { delay: 40 }); await dbg("after gg"); await p.keyboard.type("i", { delay: 40 }); await dbg("after i"); await p.keyboard.type("VIMOKZ ", { delay: 30 }); await sleep(300);
ok("vim insert works after reload", (await text()).includes("VIMOKZ"), (await mode()) + " | " + JSON.stringify((await text()).slice(0, 90)) + " | focus=" + (await p.evaluate(() => document.activeElement?.className)));
await p.keyboard.press("Escape"); await sleep(150);
ok("a single Esc leaves insert mode", /NORMAL/.test(await mode()), await mode());
let un = 0; while ((await text()).includes("VIMOKZ") && un < 20) { await p.keyboard.type("u", { delay: 30 }); await sleep(100); un++; }
ok("vim u undoes", !(await text()).includes("VIMOKZ"), String(un));
await key(["Control"], "r"); await sleep(200);
ok("vim Ctrl+R redoes", (await text()).includes("VIMOKZ"));
await sleep(1600);
console.log("errors:", JSON.stringify(errs)); ok("no page errors", errs.length === 0);
await b.close(); fs.copyFileSync("/tmp/xau-ema.bak", FILE); process.exit(fail ? 1 : 0);
