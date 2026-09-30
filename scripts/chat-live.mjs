// scripts/chat-live.mjs -- STUDIO=http://bot2:8080 TOKEN=<studio token> node scripts/chat-live.mjs
// The spec's section 2 tasks through the studio's own chat (the real CLI on Haiku): pass/fail, tool calls, tokens, time.
// Open the strategy in the studio and run it once first (the window comes from its newest run). Start that studio with
// CHAT_RECORD_DIR=<dir> to also keep each message's raw stream-json; copy those files to
// packages/server/test/fixtures/fake-claude/recorded/ and the parser test replays them from then on.
if (!process.env.STUDIO) { console.error("usage: STUDIO=http://host:8080 [TOKEN=...] [STRATEGY=strategies/x.qkt] node scripts/chat-live.mjs"); process.exit(2); }
const H = { "Content-Type": "application/json", ...(process.env.TOKEN ? { Authorization: `Bearer ${process.env.TOKEN}` } : {}) };
const api = async (path, body) => {
  const r = await fetch(`${process.env.STUDIO}${path}`, body ? { method: "POST", headers: H, body: JSON.stringify(body) } : { headers: H });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error ?? ""}`);
  return j;
};
if (!(await api("/api/chat/status")).loggedIn) { console.error("Claude Code is not signed in on that studio"); process.exit(2); }
const STRAT = process.env.STRATEGY ?? "strategies/ema_cross.qkt";
const used = (m, name) => m.items.some((i) => i.type === "tool" && i.name === name && i.result && !i.result.isError);
const CASES = [
  { name: "stop 2 percent", text: `In ${STRAT} make the stop-loss 2 percent and let's see.`, pass: (m) => used(m, "try_change") },
  { name: "omit a date", text: `In ${STRAT} omit trading on 2024-01-10 and show the result.`, pass: (m) => used(m, "try_change") },
  { name: "new idea", text: "Create a new strategy rsi_live: buy XAUUSD 15m when RSI(14) crosses above 30 and price is above the 4h EMA 200; stop 1%, target 2%.", pass: (m) => used(m, "create_strategy") },
];
let failed = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const { conversationId } = await api("/api/chat/send", { text: c.text });
  let m;
  for (;;) { m = (await api(`/api/chat/conversations/${conversationId}`)).messages.at(-1); if (m.status !== "running") break; await new Promise((r) => setTimeout(r, 1000)); }
  const good = m.status === "done" && c.pass(m);
  if (!good) failed++;
  const u = m.usage ?? {};
  console.log(`${good ? "ok  " : "FAIL"} ${c.name}: ${m.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s, calls [${m.items.filter((i) => i.type === "tool").map((i) => i.name).join(", ")}], in ${u.inputTokens}+${u.cacheReadTokens} cached, out ${u.outputTokens}, API-equivalent $${u.costUsd}\n     ${String(m.text || m.error).replace(/\s+/g, " ").slice(0, 200)}`);
}
process.exit(failed ? 1 : 0);
