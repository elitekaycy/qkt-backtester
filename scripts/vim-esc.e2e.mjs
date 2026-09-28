// Esc in the vim editor must stay in the editor even when a browser extension with its own vim keys (Vimium, Surfingkeys)
// swallows the key and blurs the editor: this page script does what those extensions do, before the studio's own handlers.
// Needs a running studio (BASE) whose workspace has STRATEGY (a file name the command palette finds); system Chrome.
// Read-only: it presses i, v and Esc and types nothing, with auto-save off.
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8080/", FILE = process.env.STRATEGY ?? "ema_cross.qkt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
for (const vim of [true, false]) {
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
  await p.evaluateOnNewDocument((vim) => {
    try { localStorage.setItem("qkt-studio-ui-v3", JSON.stringify({ vim, autosave: false })); } catch {}
    window.addEventListener("keydown", (e) => {
      const t = document.activeElement;
      if (e.key === "Escape" && t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName) || t.classList.contains("native-edit-context"))) {
        t.blur(); e.preventDefault(); e.stopImmediatePropagation();
      }
    }, true);
  }, vim);
  await p.goto(BASE, { waitUntil: "domcontentloaded" }); await sleep(3500);
  await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control"); await sleep(400);
  await p.keyboard.type(FILE); await sleep(400); await p.keyboard.press("Enter"); await sleep(2000);
  const bx = await (await p.$(".monaco-host .view-lines")).boundingBox();
  await p.mouse.click(bx.x + 120, bx.y + 60); await sleep(300);
  const state = () => p.evaluate(() => ({ inEditor: !!document.activeElement?.closest(".monaco-editor"), mode: (document.querySelector(".vim-status")?.textContent ?? "").replace(/<.*$/, "") }));
  const expect = (name, got, want) => { const ok = Object.entries(want).every(([k, v]) => got[k] === v); if (!ok) { fail++; console.log("FAIL", name, JSON.stringify(got), "want", JSON.stringify(want)); } };
  if (vim) {
    for (const key of ["i", "v"]) {
      await p.keyboard.press(key); await sleep(200);
      await p.keyboard.press("Escape"); await sleep(300);
      expect(`vim: Esc from ${key === "i" ? "insert" : "visual"} mode`, await state(), { inEditor: true, mode: "--NORMAL--" });
    }
    await p.mouse.click(5, 5); await sleep(300);
    expect("vim: a click outside still leaves the editor", await state(), { inEditor: false });
  } else {
    await p.keyboard.press("Escape"); await sleep(300);
    expect("no vim: the extension's Esc is respected", await state(), { inEditor: false });
  }
  await p.close();
}
await b.close();
console.log(`vim-esc: ${fail ? `${fail} failed` : "ok"}`);
process.exit(fail ? 1 : 0);
