import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8101/", WS = process.env.WS ?? "/tmp/ws-shell";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 950 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGE " + e.message)); p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("CON " + m.text().slice(0, 200)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c, x = "") => { console.log(c ? "PASS" : "FAIL", n, c ? "" : x); if (!c) fail++; };
const api = (u, o) => fetch(BASE + u, o).then((r) => r.json());
// make 3 runs (different windows so none is a cache hit)
const ids = [];
for (const [f, t] of [["2024-10-01", "2024-10-05"], ["2024-10-06", "2024-10-12"], ["2024-10-13", "2024-10-19"]]) {
  const r = await api("api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy: "strategies/xau-ema.qkt", from: f, to: t, tier: "draft" }) }); ids.push(r.runId);
}
for (let i = 0; i < 60; i++) { const rs = await Promise.all(ids.map((id) => api(`api/runs/${id}`))); if (rs.every((r) => ["done", "failed"].includes(r.status))) break; await sleep(500); }
await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
await p.goto(BASE); await sleep(3500);
const txt = () => p.evaluate(() => document.body.innerText);
const click = (label) => p.evaluate((l) => document.querySelector(`[aria-label="${l}"]`)?.click(), label);

// ---- Files: banner + dotfiles
fs.rmSync(WS + "/instruments.yaml", { force: true }); fs.rmSync(WS + "/.env", { force: true });
await p.reload(); await sleep(3000);
ok("Files shows the missing-files banner", /Missing project files/.test(await txt()) && /instruments\.yaml/.test(await txt()));
await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Add missing/.test(b.textContent))?.click()); for (let i = 0; i < 20 && !fs.existsSync(WS + "/instruments.yaml"); i++) await sleep(500);
await sleep(1200);
ok("scaffold created instruments.yaml and .env on disk", fs.existsSync(WS + "/instruments.yaml") && fs.existsSync(WS + "/.env"));
const rows = await p.evaluate(() => [...document.querySelectorAll(".tree-row .name")].map((e) => e.textContent));
ok("tree lists dotfiles and config, config first", rows.includes(".env") && rows.includes("instruments.yaml") && rows.indexOf("qkt.config.yaml") < rows.indexOf("instruments.yaml"), rows.join(","));
ok("banner gone after adding", !/Missing project files/.test(await txt()));

// ---- Runs: usage, per-run delete, bulk delete
await p.keyboard.down("Control"); await p.keyboard.press("3"); await p.keyboard.up("Control"); await sleep(1200);
ok("runs list shows disk usage", /\d+(\.\d+)? (KB|MB)/.test(await txt()));
const dirs = () => fs.readdirSync(WS + "/runs").filter((d) => !d.startsWith("."));
const before = dirs().length;
await p.evaluate(() => document.querySelector('[aria-label^="Delete run"]').click()); await sleep(500);
ok("delete asks for confirmation with size", /permanently deletes/.test(await txt()));
await p.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => /^\s*Delete\s*$/.test(b.textContent))?.click()); await sleep(1500);
ok("single delete removes the folder", dirs().length === before - 1, `${before} -> ${dirs().length}`);
ok("toast reports freed space", /freed/.test(await txt()));
await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Select$/.test(b.textContent.trim()))?.click()); await sleep(300);
await p.evaluate(() => [...document.querySelectorAll(".runs-bulk button")].find((b) => /^All$/.test(b.textContent.trim()))?.click()); await sleep(200);
await p.evaluate(() => [...document.querySelectorAll(".runs-bulk button")].find((b) => /Delete/.test(b.textContent))?.click()); await sleep(400);
await p.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => /^\s*Delete\s*$/.test(b.textContent))?.click()); await sleep(1500);
ok("bulk delete leaves no run folders", dirs().length === 0, String(dirs().length));
ok("empty state shown", /No runs yet/.test(await txt()));

// ---- Terminal builtins
await p.keyboard.down("Control"); await p.keyboard.press("1"); await p.keyboard.up("Control");
await p.evaluate(() => [...document.querySelectorAll(".dock-tab")].find((t) => /Terminal/.test(t.textContent)).click()); await sleep(1500);
await p.click(".xterm"); 
const send = async (line) => { await p.keyboard.type(line); await p.keyboard.press("Enter"); await sleep(700); };
const screen = () => p.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n"));
await send("ls"); let sc = await screen(); ok("ls lists workspace", /strategies\//.test(sc) && /qkt\.config\.yaml/.test(sc), sc.slice(-300));
await send("cd strategies"); await sleep(600); await send("ls"); sc = await screen(); ok("cd + ls", /xau-ema\.qkt/.test(sc));
ok("prompt shows the folder", /\/strategies/.test(sc), sc.slice(-200));
await send("cat xau-ema.qkt"); sc = await screen(); ok("cat prints the file", /CROSSES ABOVE/.test(sc));
await send("qkt --version"); await sleep(1200); sc = await screen(); ok("qkt --version runs", /\d+\.\d+/.test(sc));
await send("help"); sc = await screen(); ok("help lists commands", /Restricted terminal/.test(sc));
await send("clear"); sc = await screen(); ok("clear empties the screen", !/STRATEGY xau_ema/.test(sc) && !/Restricted terminal/.test(sc), sc.slice(0, 200));
await send("rm -rf x"); sc = await screen(); ok("unknown command explained", /command not found/.test(sc));
console.log("errors:", JSON.stringify(errs));
ok("no page errors", errs.length === 0);
await b.close(); process.exit(fail ? 1 : 0);
