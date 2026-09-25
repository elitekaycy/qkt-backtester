import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const URL_ = process.env.URL ?? "http://127.0.0.1:8099/";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); localStorage.setItem("qkt-studio-prefs-v1", JSON.stringify({ from: "2024-10-01", to: "2024-10-31", tier: "draft", theme: "dark" })); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
const ctrl = async (k) => { await page.keyboard.down("Control"); await page.keyboard.press(k); await page.keyboard.up("Control"); };
await page.goto(URL_, { waitUntil: "domcontentloaded" }); await sleep(3500);
// a11y: icon-only buttons labelled
const unl = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => !(b.textContent || "").trim() && !b.getAttribute("aria-label") && !b.title).length);
ok("icon-only buttons have labels", unl === 0, String(unl));
// theme toggle
await ctrl("k"); await sleep(300); await page.keyboard.type("light"); await sleep(200); await page.keyboard.press("Enter"); await sleep(300);
ok("theme switches to light", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
// kill: a tick run is slow enough to stop midway
const runsBefore = fs.readdirSync("/tmp/e2e-ws/runs").length;
await ctrl("k"); await sleep(400); await page.keyboard.type("ticks"); await sleep(200); await page.keyboard.press("Enter"); await sleep(1500);
ok("Stop button present while running", !!(await page.$("button.btn.danger"))); if (!(await page.$("button.btn.danger"))) await page.screenshot({ path: "/tmp/kill.png" });
await page.click("button.btn.danger"); await sleep(3000);
ok("stop removes partial run dir", fs.readdirSync("/tmp/e2e-ws/runs").length === runsBefore, `${runsBefore}->${fs.readdirSync("/tmp/e2e-ws/runs").length}`);
ok("stop hides the button", !(await page.$("button.btn.danger")));
// run to completion, journal
await ctrl("k"); await sleep(400); await page.keyboard.type("on bars"); await sleep(200); await page.keyboard.press("Enter"); await sleep(9000);
await ctrl("j"); await sleep(1500);
ok("journal open", !!(await page.$(".jnav-btn")));
await page.evaluate(() => document.querySelectorAll(".jnav-btn")[4]?.click()); await sleep(1200);
const rows0 = await page.evaluate(() => Number(/Showing\s+(\d+)/.exec(document.body.innerText)?.[1] ?? 0));
await page.click(".fsearch .fin"); await page.keyboard.type("outcome:win"); await sleep(400); await page.keyboard.press("Enter"); await sleep(1500);
const rows1 = await page.evaluate(() => Number(/Showing\s+(\d+)/.exec(document.body.innerText)?.[1] ?? 0));
ok("filter reacts (a filter narrows trades)", rows1 > 0 && rows1 < rows0, `${rows0}->${rows1}`);
await page.keyboard.press("Escape"); await sleep(300); await page.keyboard.press("Escape"); await sleep(300); // first Esc closes the suggestions, second the journal
// vim
await ctrl("k"); await sleep(300); await page.keyboard.type("vim"); await sleep(200); await page.keyboard.press("Enter"); await sleep(1500);
await page.click(".monaco-editor .view-lines"); await sleep(300);
let st = await page.evaluate(() => document.querySelector(".vim-status")?.textContent ?? "");
ok("vim status shows NORMAL", /NORMAL/i.test(st) || st === "" ? /NORMAL/i.test(st) : false, st);
const before = await page.evaluate(() => document.querySelector(".monaco-editor .view-lines")?.textContent?.length);
await page.keyboard.press("i"); await page.keyboard.type("// hi\n"); await page.keyboard.press("Escape"); await sleep(300);
st = await page.evaluate(() => document.querySelector(".vim-status")?.textContent ?? "");
const after = await page.evaluate(() => document.querySelector(".monaco-editor .view-lines")?.textContent?.length);
ok("vim insert typed text", after > before, `${before}->${after}`);
ok("vim back to NORMAL", /NORMAL/i.test(st), st);
await page.keyboard.type("dd"); await sleep(300);
const after2 = await page.evaluate(() => document.querySelector(".monaco-editor .view-lines")?.textContent?.length);
ok("vim dd deletes line", after2 < after, `${after}->${after2}`);
await page.evaluate(() => { const ed = window.__qktEditor; ed?.getModel()?.setValue(ed.getModel().getValue()); });
// data section
await ctrl("2"); await sleep(1500);
ok("data section shows symbols", (await page.$$(".sym-head")).length > 0);
console.log("page errors:", JSON.stringify(errs)); if (errs.length) fail++;
await browser.close(); process.exit(fail ? 1 : 0);
