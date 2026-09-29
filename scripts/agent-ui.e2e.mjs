// Drives the studio's UI through the MCP tools the way Claude Code would, and asserts what the user sees.
// Needs a running studio (BASE) with the demo data / a sample strategy (STRATEGY, default strategies/ema_cross.qkt).
// Adopt (and auto-save) writes the bracket into STRATEGY: run it once per workspace, or remove that BRACKET before a rerun.
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/");
const STRAT = process.env.STRATEGY ?? "strategies/ema_cross.qkt";
let failed = 0; const ok = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${cond ? "" : extra}`); if (!cond) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
await p.goto(BASE, { waitUntil: "networkidle2" }); await p.waitForFunction(() => !!window.__qktStore);
await p.evaluate(async (s) => { await window.__qktStore.getState().openFile(s); }, STRAT); await wait(1500);
const mcp = new Client({ name: "e2e", version: "0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}api/mcp`)));
const r = await mcp.callTool({ name: "try_change", arguments: { changes: [{ op: "set_bracket", stop: "1%", target: "2%" }], label: "1% / 2%", from: "2024-01-02", to: "2024-02-01" } });
ok("try_change succeeds", !r.isError, r.content?.[0]?.text?.slice(0, 200));
await p.waitForFunction(() => /Variant: 1% \/ 2%/.test(document.body.innerText), { timeout: 60_000 }).then(() => ok("the chart switches to the variant", true), () => ok("the chart switches to the variant", false));
await mcp.callTool({ name: "set_split", arguments: { split: { test_last: "1 weeks" } } });
await p.waitForFunction(() => /Split: test = last 1 weeks/.test(document.body.innerText), { timeout: 10_000 }).then(() => ok("the split chip follows set_split", true), () => ok("the split chip follows set_split", false));
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Adopt")?.click()); await wait(3000);
const text = await p.evaluate(() => window.__qktEditor?.getModel()?.getValue() ?? "");
ok("Adopt puts the change in the editor", /STOP_LOSS BY 1 PCT/.test(text), text.slice(0, 200));
await p.evaluate(() => window.__qktEditor.trigger("e2e", "undo", null)); await wait(300);
ok("one undo takes the adoption back", !/STOP_LOSS BY 1 PCT/.test(await p.evaluate(() => window.__qktEditor.getModel().getValue())));
await mcp.callTool({ name: "set_split", arguments: { split: { test_pct: 25 } } });
await b.close(); await mcp.close();
console.log(failed ? `agent-ui: ${failed} failed` : "agent-ui: all passed"); process.exit(failed ? 1 : 0);
