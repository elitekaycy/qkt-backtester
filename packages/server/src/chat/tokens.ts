// packages/server/src/chat/tokens.ts
import { randomBytes } from "node:crypto";

/**
 * What one CLI process may do: its token, the runs/jobs its tool calls started (Stop cancels them), its call budget.
 * Run work itself is capped by phase 1's ToolBudget (ctx.budget), shared with every other /api/mcp caller: a grant counts
 * calls, it does not reserve runs. `afterStop` is set by Stop: a tool call still in flight when Stop ran (its handler keeps
 * going after the CLI is killed) may record a run afterwards, and that run is cancelled the moment it is recorded.
 */
export interface TurnGrant { token: string; started: Set<string>; calls: number; maxCalls: number; onLimit(): void; afterStop: ((id: string) => void) | null }

/** Random per-process tokens for /api/mcp, created for one CLI process and revoked when it exits. */
export class ChatTokens {
  private grants = new Map<string, TurnGrant>();
  issue(o: { maxCalls: number; onLimit(): void }): TurnGrant {
    const g: TurnGrant = { token: randomBytes(24).toString("hex"), started: new Set(), calls: 0, maxCalls: o.maxCalls, onLimit: o.onLimit, afterStop: null };
    this.grants.set(g.token, g);
    return g;
  }
  lookup(token: string | undefined): TurnGrant | undefined { return token ? this.grants.get(token) : undefined; }
  revoke(token: string): void { this.grants.delete(token); }
  size(): number { return this.grants.size; }
}

/**
 * ctx.started for one chat message's tool calls: records into the shared set (what the `cancel` tool checks) and the
 * message's own list (what Stop cancels). Only add/has are used on ctx.started (tools-runs.ts, tools-try.ts); the TeeSet's
 * own storage stays empty, so never iterate it.
 */
export class TeeSet extends Set<string> {
  constructor(private shared: Set<string>, private grant: Pick<TurnGrant, "started" | "afterStop">) { super(); }
  override add(v: string): this { this.shared.add(v); this.grant.started.add(v); this.grant.afterStop?.(v); return this; }
  override has(v: string): boolean { return this.shared.has(v); }
}

const isCall = (m: unknown): boolean => (m as { method?: unknown } | null)?.method === "tools/call";
/** How many tool calls a JSON-RPC request (or batch) makes. */
export const toolCalls = (body: unknown): number => (Array.isArray(body) ? body.filter(isCall).length : isCall(body) ? 1 : 0);
export const LIMIT_TEXT = (n: number) => `stopped: this message reached its limit of ${n} tool calls. Answer with what you have.`;
/** The answer to a tool call past the limit: a tool error the model reads, as plain JSON-RPC (a valid streamable-HTTP reply). */
export function limitReply(body: unknown, maxCalls: number): unknown {
  const one = (m: unknown) => ({ jsonrpc: "2.0", id: (m as { id?: unknown }).id ?? null, result: { content: [{ type: "text", text: LIMIT_TEXT(maxCalls) }], isError: true } });
  return Array.isArray(body) ? body.filter(isCall).map(one) : one(body);
}
