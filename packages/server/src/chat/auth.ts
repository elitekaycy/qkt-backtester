// packages/server/src/chat/auth.ts
import { spawnGroup } from "../proc.js";
import { agentEnv } from "./agent.js";

export interface ClaudeStatus { installed: boolean; version: string | null; loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; error: string | null }
const none = (error: string): ClaudeStatus => ({ installed: false, version: null, loggedIn: false, authMethod: null, subscriptionType: null, error });

/**
 * `claude --version` and `claude auth status --json` (which exits 1 when signed out, still printing JSON). Only three fields
 * leave this function: the status also names the account (email, organisation), which the studio has no business keeping.
 * Credentials themselves are never read: the CLI reads its own config directory.
 */
export async function readClaudeStatus(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ClaudeStatus> {
  const v = await spawnGroup(bin, ["--version"], { cwd, env, timeoutMs: 15_000 }).exited;
  if (v.code === 127 || v.stderr.startsWith("spawn error")) return none("Claude Code is not installed");
  const version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0] ?? null;
  const a = await spawnGroup(bin, ["auth", "status", "--json"], { cwd, env, timeoutMs: 15_000 }).exited;
  try {
    const j = JSON.parse(a.stdout) as Record<string, unknown>;
    return { installed: true, version, loggedIn: j.loggedIn === true, authMethod: typeof j.authMethod === "string" ? j.authMethod : null,
      subscriptionType: typeof j.subscriptionType === "string" ? j.subscriptionType : null, error: null };
  } catch {
    return { installed: true, version, loggedIn: false, authMethod: null, subscriptionType: null, error: `could not read \`claude auth status\` (exit ${a.code})` };
  }
}

/** The status, re-read at most every 30 s (or on demand: "Check again", and before refusing a send as signed out). */
export class ClaudeStatusCache {
  private last: { at: number; value: ClaudeStatus } | null = null;
  private inflight: Promise<ClaudeStatus> | null = null;
  constructor(private bin: string, private cwd: string, private ttlMs = 30_000) {}
  get(force = false): Promise<ClaudeStatus> {
    if (!force && this.last && Date.now() - this.last.at < this.ttlMs) return Promise.resolve(this.last.value);
    // a forced read while another is in flight waits for it, then reads afresh: the running one may predate the change
    if (this.inflight && !force) return this.inflight;
    const read = (this.inflight ?? Promise.resolve()).catch(() => undefined).then(() => readClaudeStatus(this.bin, agentEnv(), this.cwd))
      .then((value) => { this.last = { at: Date.now(), value }; return value; })
      .finally(() => { if (this.inflight === read) this.inflight = null; });
    this.inflight = read;
    return read;
  }
}
