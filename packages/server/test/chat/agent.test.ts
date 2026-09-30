// packages/server/test/chat/agent.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatEvent } from "@qkt-studio/core";
import { agentArgs, agentEnv, mcpHost, startAgent, writeMcpConfig } from "../../src/chat/agent.js";
import { readClaudeStatus } from "../../src/chat/auth.js";
import { fakeClaude } from "../helpers.js";

let home: string;
beforeAll(() => { home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-home-"))); process.env.CLAUDE_CONFIG_DIR = home; });
afterAll(() => { delete process.env.CLAUDE_CONFIG_DIR; rmSync(home, { recursive: true, force: true }); });
const run = { model: "haiku" as const, sessionId: "0b7c1f7e-5a0e-4d7c-9d7e-2f0a3c1b2a11", resume: false, systemPrompt: "SYS", mcpConfigPath: "/x/mcp.json" };

describe("the CLI process", () => {
  it("passes exactly the design's flags; a later message resumes the session", () => {
    expect(agentArgs(run)).toEqual(["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--mcp-config", "/x/mcp.json",
      "--allowedTools", "mcp__studio__*", "--permission-mode", "dontAsk", "--system-prompt", "SYS",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", run.sessionId]);
    expect(agentArgs({ ...run, resume: true, model: "sonnet" }).slice(-2)).toEqual(["--resume", run.sessionId]);
    expect(agentArgs({ ...run, model: "sonnet" })[2]).toBe("sonnet");
  });
  it("never hands the studio's own token to the CLI", () => {
    expect(agentEnv({ STUDIO_TOKEN: "s", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
  it("writes the MCP config readable by this user only", async () => {
    const f = await writeMcpConfig(home, "m1", "http://127.0.0.1:1/api/mcp", "tok");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: { studio: { type: "http", url: "http://127.0.0.1:1/api/mcp", headers: { Authorization: "Bearer tok" } } } });
  });
  it("reaches the studio on loopback unless it listens on one specific address", () => {
    expect(["0.0.0.0", "::", "127.0.0.1", "localhost"].map(mcpHost)).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1", "127.0.0.1"]);
    expect(mcpHost("::1")).toBe("[::1]");
    expect(mcpHost("100.64.0.7")).toBe("100.64.0.7");
  });
  it("sends the prompt on stdin and streams parsed events", async () => {
    const got: ChatEvent[] = [];
    const p = startAgent(fakeClaude, { ...run, sessionId: "0b7c1f7e-5a0e-4d7c-9d7e-2f0a3c1b2a12" }, "echo ping", { cwd: home, onEvent: (e) => got.push(e) });
    expect((await p.exited).code).toBe(0);
    expect(got.map((e) => e.k)).toEqual(["session", "text", "result"]);
    expect((got[1] as { text: string }).text).toMatch(/echo ping/);
  });
});

describe("sign-in status", () => {
  it("keeps only whether it is signed in, how, and the plan: never the account's email or organisation", async () => {
    const s = await readClaudeStatus(fakeClaude, agentEnv(), home);
    expect(s).toEqual({ installed: true, version: "2.1.285", loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", error: null });
    expect(JSON.stringify(s)).not.toMatch(/person@example|org-123/);
  });
  it("signed out, and not installed", async () => {
    writeFileSync(path.join(home, "fake-signed-out"), "");
    try { expect(await readClaudeStatus(fakeClaude, agentEnv(), home)).toMatchObject({ installed: true, loggedIn: false }); }
    finally { rmSync(path.join(home, "fake-signed-out")); }
    expect(await readClaudeStatus("/nonexistent/claude", agentEnv(), home)).toMatchObject({ installed: false, loggedIn: false });
  });
});
