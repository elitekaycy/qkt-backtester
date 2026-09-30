// packages/server/src/chat/agent.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatEvent } from "@qkt-studio/core";
import { spawnGroup, type ProcHandle } from "../proc.js";
import { StreamParser } from "./stream.js";

export type AgentModel = "haiku" | "sonnet";
export interface AgentRun { model: AgentModel; sessionId: string; resume: boolean; systemPrompt: string; mcpConfigPath: string }

/** The design's flags (section 5): only the studio's MCP tools, no built-in ones, no permission prompts, streamed JSON.
 *  Plus `--setting-sources user`: settings files from the workspace (project, local) are not loaded, only the studio's
 *  own Claude Code config directory (docs/production.md, "What the CLI loads"). */
export function agentArgs(r: AgentRun): string[] {
  if (r.model !== "haiku" && r.model !== "sonnet") throw new Error(`model must be "haiku" or "sonnet", got ${JSON.stringify(r.model)}`);
  return ["-p", "--model", r.model, "--tools", "", "--strict-mcp-config", "--mcp-config", r.mcpConfigPath, "--setting-sources", "user",
    "--allowedTools", "mcp__studio__*", "--permission-mode", "dontAsk", "--system-prompt", r.systemPrompt,
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(r.resume ? ["--resume", r.sessionId] : ["--session-id", r.sessionId])];
}

/** The studio's environment minus its access token and anything else that looks like a secret (the CLI gets its own
 *  per-process token in the MCP config instead). ANTHROPIC_API_KEY stays: the user may set it for the API-key backend. */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "STUDIO_TOKEN" || (k !== "ANTHROPIC_API_KEY" && /TOKEN|SECRET|PASSWORD|API_KEY/i.test(k))) continue;
    env[k] = v;
  }
  return env;
}

/** The --mcp-config file (endpoint + this process's token), readable by this user only; the caller deletes it. */
export async function writeMcpConfig(dir: string, name: string, url: string, token: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700); // mkdir's mode is ignored when the directory already exists
  const file = path.join(dir, `${name}.json`);
  // "wx": never write a token into a file that already exists (its mode and owner would be unknown)
  await fs.writeFile(file, JSON.stringify({ mcpServers: { studio: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600, flag: "wx" });
  return file;
}

/** Where the CLI reaches the studio: loopback when the studio listens on every address or on loopback, else that address. */
export function mcpHost(host: string): string {
  if (["", "0.0.0.0", "::", "127.0.0.1", "localhost"].includes(host)) return "127.0.0.1";
  return host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host;
}

export interface AgentProcess extends ProcHandle { parser: StreamParser }
/** One CLI process for one user message, in its own process group. The prompt goes in on stdin: the variadic flags
 *  (--mcp-config, --allowedTools, --tools) would swallow a positional prompt. */
export function startAgent(bin: string, run: AgentRun, prompt: string, o: { cwd: string; env?: NodeJS.ProcessEnv; onEvent(ev: ChatEvent): void; onRaw?(line: string): void }): AgentProcess {
  const parser = new StreamParser();
  const h = spawnGroup(bin, agentArgs(run), {
    cwd: o.cwd, env: o.env ?? agentEnv(), input: prompt,
    onLine: (line, stream) => { if (stream !== "out") return; o.onRaw?.(line); for (const ev of parser.feed(line)) o.onEvent(ev); },
  });
  return Object.assign(h, { parser });
}
