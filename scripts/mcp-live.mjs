// scripts/mcp-live.mjs  -- STUDIO=http://bot2:8080 TOKEN=... node scripts/mcp-live.mjs
// Runs the spec's example requests through Claude Code (Haiku) against the studio's tools; prints pass/fail, turns, tokens.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os"; import path from "node:path";
if (!process.env.STUDIO || !process.env.TOKEN) { console.error("usage: STUDIO=http://bot2:8080 TOKEN=<studio token> node scripts/mcp-live.mjs"); process.exit(2); }
const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-live-"));
writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { studio: { type: "http", url: `${process.env.STUDIO}/api/mcp`, headers: { Authorization: `Bearer ${process.env.TOKEN}` } } } }));
const ask = (prompt) => JSON.parse(execFileSync("claude", ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--mcp-config", path.join(dir, "mcp.json"), "--allowedTools", "mcp__studio__*", "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence", "--system-prompt", "You drive the qkt studio through its tools. Map the request onto the fewest tool calls (prefer try_change). Be brief."], { input: prompt, encoding: "utf8", timeout: 300_000 }));
const CASES = [
  ["stop 2 percent", "In strategies/ema_cross.qkt make the stop-loss 2 percent and let's see."],
  ["omit a date", "In strategies/ema_cross.qkt omit trading on 2024-01-10 and show the result."],
  ["new idea", "Create a new strategy rsi_live: buy XAUUSD 15m when RSI(14) crosses above 30 and price is above the 4h EMA 200; stop 1%, target 2%."],
];
let failed = 0;
try {
  for (const [name, prompt] of CASES) {
    try {
      const r = ask(prompt);
      if (r.is_error) failed++;
      console.log(`${r.is_error ? "FAIL" : "ok  "} ${name}: turns ${r.num_turns}, in ${r.usage?.input_tokens}+${r.usage?.cache_read_input_tokens} cached, out ${r.usage?.output_tokens}\n     ${String(r.result).replace(/\s+/g, " ").slice(0, 200)}`);
    } catch (e) { failed++; console.log(`FAIL ${name}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
