#!/usr/bin/env node
// packages/server/test/fixtures/fake-claude/fake-claude.mjs
// Test stand-in for the `claude` CLI. Replays a scenario of stream-json lines picked by the user's text, and makes the tool
// calls a scenario asks for against the studio's real /api/mcp with the token from --mcp-config. Never contacts Anthropic.
//   scenarios/scenarios.json: [{ "match": <regex on the user's text>, "file": <jsonl> }], first match wins, else hello.jsonl
//   a scenario line is a stream-json object ({{session}} replaced) or a directive:
//     {"$call": {"name", "arguments"}, "$repeat"?: n}  emit the tool_use, call the studio, emit the tool_result
//     {"$echo_prompt": true}  an assistant text with the whole prompt received     {"$sleep": ms}   {"$hang": true}
//     {"$stderr": "text"}   {"$exit": code}
// Sessions behave like the CLI's: --session-id must be new, --resume must exist (markers in $CLAUDE_CONFIG_DIR/fake-sessions).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "/tmp", ".claude");
if (process.env.FAKE_CLAUDE_ARGV_LOG) appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, `${JSON.stringify(argv)}\n`);

if (argv[0] === "--version") { process.stdout.write("2.1.285 (Claude Code)\n"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = !existsSync(path.join(home, "fake-signed-out"));
  // the real status also names the account; the studio must drop these fields
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty", email: "person@example.com", orgId: "org-123", orgName: "Org", subscriptionType: loggedIn ? "max" : undefined, configDirectory: home }, null, 2)}\n`);
  process.exit(loggedIn ? 0 : 1);
}
if (!argv.includes("-p")) { process.stderr.write("fake claude: only -p, --version and auth status\n"); process.exit(2); }

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const prompt = readFileSync(0, "utf8");
const userText = prompt.replace(/<studio-view>[\s\S]*?<\/studio-view>\s*/, "");
const resume = flag("--resume"), fresh = flag("--session-id");
const session = resume ?? fresh ?? "no-session";
const sessions = path.join(home, "fake-sessions");
mkdirSync(sessions, { recursive: true });
if (resume && !existsSync(path.join(sessions, resume))) { process.stderr.write(`No conversation found with session ID: ${resume}\n`); process.exit(1); }
if (fresh && existsSync(path.join(sessions, fresh))) { process.stderr.write(`Error: Session ID ${fresh} is already in use.\n`); process.exit(1); }
if (fresh) writeFileSync(path.join(sessions, fresh), "");

const index = JSON.parse(readFileSync(path.join(here, "scenarios", "scenarios.json"), "utf8"));
const file = index.find((s) => new RegExp(s.match, "i").test(userText))?.file ?? "hello.jsonl";
const lines = readFileSync(path.join(here, "scenarios", file), "utf8").split("\n").filter((l) => l.trim());

const mcp = (() => { try { return JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.studio; } catch { return null; } })();
let rpcId = 0, initialized = false, toolN = 0;
async function rpc(method, params) {
  const id = ++rpcId;
  const r = await fetch(mcp.url, { method: "POST", headers: { ...mcp.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const body = await r.text();
  if (!r.ok) return { error: { message: `HTTP ${r.status}: ${body.slice(0, 200)}` } };
  const msgs = (r.headers.get("content-type") ?? "").includes("text/event-stream")
    ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(body)].flat();
  return msgs.find((m) => m.id === id) ?? { error: { message: "no response" } };
}
async function call(name, args) {
  const id = `toolu_fake_${++toolN}`;
  out({ type: "assistant", message: { id: `msg_call_${toolN}`, role: "assistant", model: "claude-haiku-4-5", content: [{ type: "tool_use", id, name: `mcp__studio__${name}`, input: args }] }, parent_tool_use_id: null, session_id: session, uuid: `u-call-${toolN}` });
  let text = "no --mcp-config", isError = true;
  if (mcp) {
    if (!initialized) { await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } }); initialized = true; }
    const res = await rpc("tools/call", { name, arguments: args });
    text = res.error ? res.error.message : (res.result?.content ?? []).map((c) => c.text ?? "").join("");
    isError = !!res.error || !!res.result?.isError;
  }
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] }, parent_tool_use_id: null, session_id: session, uuid: `u-res-${toolN}` });
}

for (const line of lines) {
  const o = JSON.parse(line.replaceAll("{{session}}", session));
  if (o.$sleep) await new Promise((r) => setTimeout(r, o.$sleep));
  else if (o.$hang) await new Promise(() => setInterval(() => undefined, 1 << 30));
  else if (o.$stderr) process.stderr.write(`${o.$stderr}\n`);
  else if (o.$exit !== undefined) process.exit(o.$exit);
  else if (o.$echo_prompt) out({ type: "assistant", message: { id: "msg_echo", role: "assistant", content: [{ type: "text", text: `You said:\n${prompt}` }] }, parent_tool_use_id: null, session_id: session, uuid: "u-echo" });
  else if (o.$call) for (let i = 0; i < (o.$repeat ?? 1); i++) await call(o.$call.name, o.$call.arguments ?? {});
  else out(o);
}
