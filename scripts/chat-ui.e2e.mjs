// scripts/chat-ui.e2e.mjs -- BASE=http://127.0.0.1:8081/ CONTAINER=studio-chat node scripts/chat-ui.e2e.mjs
// A studio whose CLAUDE_BIN is the stand-in CLI (packages/server/test/fixtures/fake-claude): the Chat tab end to end without
// spending tokens - send, see the steps, the variant on the chart, the split changed from the chat and every view following,
// Adopt -> file changed and the run re-done, a proposal going stale, Stop, and the sign-in card.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8081/").replace(/\/?$/, "/");
const STRAT = process.env.STRATEGY ?? "strategies/ema_cross.qkt";
const CONTAINER = process.env.CONTAINER; // lets the check flip the stand-in's signed-out marker
let failed = 0; const ok = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${cond ? "" : extra}`); if (!cond) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
const until = (fn, arg, ms = 60_000) => p.waitForFunction(fn, { timeout: ms }, arg).then(() => true, () => false);
const bodyHas = (re, ms) => until((src) => new RegExp(src).test(document.body.innerText), re.source, ms);
const click = (label, within = "body") => p.evaluate((l, w) => { const el = [...document.querySelector(w).querySelectorAll("button")].reverse().find((x) => x.textContent.trim() === l); el?.click(); return !!el; }, label, within);
const openChat = async () => (await click("Chat")) && until(() => !!document.querySelector("textarea[aria-label=Message]"), null, 15_000);
const send = async (msg) => { await p.focus("textarea[aria-label=Message]"); await p.keyboard.type(msg); await p.keyboard.press("Enter"); };
const idle = () => until(() => !![...document.querySelectorAll(".chat-actions button")].find((x) => x.textContent.trim() === "Send"), null, 90_000);

await p.goto(BASE, { waitUntil: "networkidle2" }); await p.waitForFunction(() => !!window.__qktStore);
await p.evaluate(async (s) => { await window.__qktStore.getState().openFile(s); }, STRAT); await wait(1500);
ok("the Chat tab opens", await openChat());
ok("the chips show the open file", await until(() => /ema_cross\.qkt/.test(document.querySelector(".chat-chips")?.textContent ?? ""), null, 5000));

// a change: the step, the variant on the chart, the card, the usage line
await send("make the stop 1 percent and let's see");
ok("the step shows", await bodyHas(/tried a change/, 90_000));
ok("the chart switches to the variant", await bodyHas(/Variant: 1% \/ 2%/, 90_000));
ok("the message ends with its usage", await idle() && await bodyHas(/counts toward your Claude plan/, 5000));
ok("the dock stayed on Chat while the chat's run ran", await until(() => !!document.querySelector("#dock-panel-chat"), null, 1000));

// the split from the chat: the chip and the card's test part follow, without a re-run
await send("make the split the last week");
ok("the split chip follows", await bodyHas(/Split: test = last 1 week(?!s)/, 30_000));
ok("the variant card recomputes its test part", await bodyHas(/Test part \(test = last 1 week\)/, 15_000));
await idle();

// Adopt from the card: the change lands in the editor and the run is re-done
const before = await p.evaluate(() => window.__qktStore.getState().runId);
await p.evaluate(() => [...document.querySelectorAll(".chat-card button")].find((x) => x.textContent.trim() === "Adopt")?.click());
ok("Adopt puts the change in the editor", await until(() => /STOP_LOSS BY 1 PCT/.test(window.__qktEditor?.getModel()?.getValue() ?? ""), null, 15_000));
ok("and the run is re-done", await until((r) => window.__qktStore.getState().runId !== r, before, 90_000));

// a proposal going stale: the file changes before Apply
await openChat();
await send("propose a wider stop");
ok("the proposal card shows its diff", await until(() => !!document.querySelector(".chat-card .diff"), null, 60_000));
await idle();
// the file changes on disk (through the file API, as another editor would: no auto-run takes the dock away from Chat)
await p.evaluate(async (s) => {
  const f = await (await fetch(`api/file?path=${encodeURIComponent(s)}`)).json();
  await fetch("api/file", { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": f.etag }, body: JSON.stringify({ path: s, content: `${f.content}\n# edited\n` }) });
}, STRAT);
await openChat();
await p.evaluate(() => [...document.querySelectorAll(".chat-card button")].reverse().find((x) => x.textContent.trim() === "Apply")?.click());
ok("applying it after the edit says it is out of date", await bodyHas(/out of date/, 15_000));

// Stop
await send("keep working on it");
ok("Stop is offered while it works", await until(() => [...document.querySelectorAll(".chat-actions button")].some((x) => x.textContent.trim() === "Stop"), null, 15_000));
await click("Stop", ".chat-actions");
ok("Stop ends the message", await bodyHas(/Stopped\./, 15_000));

// signed out: the sign-in card with the command, and back
if (CONTAINER) {
  execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "touch /home/studio/.claude/fake-signed-out"]);
  await p.evaluate(async () => { await fetch("api/chat/status?refresh=1"); });
  await p.reload({ waitUntil: "networkidle2" }); await p.waitForFunction(() => !!window.__qktStore);
  await click("Chat");
  ok("signed out shows the sign-in card with the command", await bodyHas(/claude auth login/, 15_000));
  execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "rm -f /home/studio/.claude/fake-signed-out"]);
  await click("Check again");
  ok("Check again brings the chat back", await until(() => !!document.querySelector("textarea[aria-label=Message]"), null, 15_000));
}
await b.close();
console.log(failed ? `chat-ui: ${failed} failed` : "chat-ui: all passed"); process.exit(failed ? 1 : 0);
