# Research chat, phase 1: studio MCP tools and the fast change-and-show path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the studio's abilities as MCP tools at `/api/mcp` (context, knowledge, analysis, authoring, try-a-change with
variants, the split, runs), and show their effects in the UI (variant view with Adopt, proposals with Apply, the split chip
and test-part shading), usable from Claude Code on the user's laptop before the chat panel (phase 2) exists.

**Architecture:** A stateless MCP server (`@modelcontextprotocol/sdk`, streamable HTTP) mounted inside the existing Fastify
app under `/api`, so the existing token, host and cross-site checks apply. Every tool is a thin adapter over code the studio
already has (runner, file jail, trip queries, analytics, bars, `qkt parse`), extracted into shared modules where it was
route-local. New pure logic (exit/entry diagnostics, DSL change operations, split partitioning) lives in `@qkt-studio/core`
with unit tests. The UI learns about tool effects through one server-sent event stream.

**Tech Stack:** Node 22, TypeScript, Fastify, Vitest, React + Zustand (web), `@modelcontextprotocol/sdk` 1.31.x, `zod` 3,
`yaml` 2 (already a core dependency), qkt 0.54 in the image.

**Spec:** `docs/specs/2026-09-29-research-chat-design.md` (sections 3, 4, 6, 7-variant view, 11, 12 phase 1). Phase 2 (chat
tab, Claude Code process, sign-in) gets its own plan after this lands.

## Global Constraints

- MCP endpoint path: `/api/mcp` (so the existing onRequest hooks in `packages/server/src/app.ts` enforce token/host/origin).
- MCP SDK: `@modelcontextprotocol/sdk@^1.31.0`, stateless transport: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, a fresh `McpServer` per request.
- Tool results: compact JSON text (`JSON.stringify(x)`, no indentation), capped at 8,000 characters; longer results end with `"truncated": true` and say which argument (`limit`, `offset`, `fields`) gets more.
- Tool descriptions: one or two sentences, at most 200 characters (they are sent on every model call).
- A tool never writes a file that already exists. Tools may create new files (`create_strategy`, variant copies under `.qkt-studio/variants/`) and create **proposals**; only a user click applies a proposal or adopts a variant.
- Every strategy source a tool saves or runs passes `checkQktSource` (qkt parse + lint) first; one that does not parse is never saved.
- Portfolio files (`PORTFOLIO ...`) are read-only to the change operations in phase 1: operations refuse them with the message `"change operations work on STRATEGY files; open the child strategy"`.
- The split partitions a run's trades by **exit time**; default `{ test_pct: 25 }`; stored in `.qkt-studio/settings.json` as `split`.
- Dates in tools are ISO `YYYY-MM-DD` UTC; weekdays accept `mon..sun` or `monday..sunday` (case-insensitive) and qkt's numbering Monday = 0.
- Commit messages describe the change; they never mention AI or assistants.
- Release at the end: all four `package.json` versions `0.2.0`, tag `v0.2.0` (the release workflow checks they match).

## Review Focus

1. **The user saves the open file while `try_change` runs** -> the variant is built from the text read at call time and its run is labelled with that text's hash; the user's newer save is not overwritten and the next `try_change` uses it (test in Task 9).
2. **A strategy whose rules have no BRACKET, several entry rules, or exit-only rules** -> `set_bracket` without `rule` changes every BUY/SELL rule, adds a BRACKET line where one is missing, never touches CLOSE-only rules, and reports which rules changed (test in Task 6).
3. **Dates and weekdays in loose forms** ("2026/08/14", "Friday", "fri", an invalid "2026-02-30") -> ISO and names normalize, invalid ones are refused with a message naming the bad value, nothing is half-applied (test in Task 6).
4. **A split that leaves a part with no trades, or a window shorter than the split** -> that part reports `trades: 0` and nulls for ratios, never `NaN` or a crash (test in Task 8).
5. **The MCP endpoint without the token on a studio started with STUDIO_TOKEN** -> 401, exactly like `/api`; with the token a tool call works (test in Task 2).

## Deviations from the spec (deliberate, phase 1)

- `set_bracket` / `set_param` / `set_sizing` are not separate tools: they are operations inside `propose_strategy_edit` and `try_change` (one schema, fewer tool descriptions sent per call).
- `equity_stats` and the trend context in `diagnose_entries` are left out: the journal already shows equity and monthly results, and nothing in the example requests needs them. Add when a request does.
- The sweep table with both split columns for the user lands with the chat's tables in phase 2; in phase 1 the Lab shows sweeps as today and `job_status` gives the model the first part only.
- Proposals live behind a "Proposals (n)" button in the top bar until the chat (phase 2) shows them inline.

## File Structure

Layout rule: `server/src/mcp/` holds only the MCP endpoint and tool adapters; `server/src/agent/` holds what the tools do on
the user's behalf (events, view state, proposals, variants) and the REST routes the UI uses to show it; phase 2 adds
`server/src/chat/`. Things the studio would have without the AI stay at the `server/src/` root (`split.ts`, `run-data.ts`,
`check.ts`); pure logic lives in `core/src/` (`dslops.ts`, `diagnose.ts`, `split.ts`).


Created:
- `packages/server/src/run-data.ts` — shared loaders for a run's derived files (trips with cache, summary, meta, run.json); used by run routes and tools.
- `packages/server/src/check.ts` — `checkQktSource()`: qkt parse + lint of a source string (extracted from check-routes).
- `packages/server/src/agent/events.ts` — in-process event bus + `GET /api/events` (SSE) for tool effects the UI must show.
- `packages/server/src/agent/view-state.ts` — what the browser is looking at (`POST /api/view`), read by `get_context`.
- `packages/server/src/agent/proposals.ts` — proposals (file edits, config/instrument changes, data jobs) + `GET/POST /api/proposals...`.
- `packages/server/src/agent/variants.ts` — variant copies, their runs, and `GET/DELETE /api/variants...`.
- `packages/server/src/split.ts` — split setting + `GET/PUT /api/split` + `GET /api/runs/:id/parts`.
- `packages/server/src/mcp/index.ts` — `/api/mcp` route and the per-request `McpServer`.
- `packages/server/src/mcp/tools-context.ts`, `tools-knowledge.ts`, `tools-analysis.ts`, `tools-authoring.ts`, `tools-try.ts`, `tools-runs.ts` — tool groups, each `register(server, ctx)`.
- `packages/server/src/mcp/util.ts` — `ok()`, `fail()`, the 8k cap, `ToolCtx` type.
- `packages/server/assets/dsl/cheatsheet.md` — the compact DSL reference; `packages/server/assets/dsl/*.md` — qkt's DSL pages, synced by `scripts/sync-dsl-docs.mjs`.
- `packages/core/src/diagnose.ts` — excursions, exit/entry diagnostics, what-if brackets.
- `packages/core/src/dslops.ts` — segmenting a strategy and applying change operations.
- `packages/core/src/split.ts` — split cut time and per-part metrics.
- `packages/web/src/state/agent.ts` — Zustand slice: variants, proposals, split, event stream.
- `packages/web/src/preview/VariantBar.tsx`, `packages/web/src/shell/Proposals.tsx`, `packages/web/src/preview/SplitChip.tsx`.
- Tests: `packages/core/test/{diagnose,dslops,split}.test.ts`, `packages/server/test/mcp/tools.test.ts` (the tools end to end, through a real MCP client), `scripts/mcp-live.mjs` (opt-in live check), `scripts/agent-ui.e2e.mjs`.

Modified: `packages/server/src/{main.ts,run-routes.ts,check-routes.ts,settings.ts}`, `packages/server/package.json`,
`packages/core/src/index.ts`, `packages/web/src/{state/store.ts,preview/PreviewPane.tsx,preview/Charts.tsx,shell/App.tsx}`,
`docker/Dockerfile` (copy `packages/server/assets`), `docs/production.md`, `.github/workflows/check.yml`.

---

### Task 1: Shared run data and source check

Extract the two route-local pieces every tool needs, with no behaviour change.

**Files:**
- Create: `packages/server/src/run-data.ts`, `packages/server/src/check.ts`
- Modify: `packages/server/src/run-routes.ts` (use `RunData`), `packages/server/src/check-routes.ts` (use `checkQktSource`), `packages/server/src/main.ts`
- Create: `packages/server/test/helpers.ts` (shared by every new server test)
- Test: `packages/server/test/rundata.test.ts`

**Interfaces:**
- Produces:
  - `class RunData { constructor(runner: Runner, cfg: ServerConfig); trips(id: string): Promise<RoundTrip[] | null>; summary(id: string): Promise<Summary | null>; meta(id: string): Promise<RunMeta | null>; run(id: string): Promise<RunJson | null> }` where `RunMeta` is the parsed `derived/meta.json` (`{ runId, tier, from, to, streams: Array<{ key, broker, symbol, tf, base }>, strategies: string[], fills, trips, currency? }`).
  - `checkQktSource(cfg: ServerConfig, content: string, rel?: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }>` — `ok` is true when no diagnostic has severity `"error"`.

- [ ] **Step 1: Write the test helper and the failing test**

```ts
// packages/server/test/helpers.ts
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerConfig } from "../src/config.js";
/** The local qkt data store the existing api tests use; tests that need real bars skip without it. */
export const realData = path.join(os.homedir(), ".qkt", "data");
export const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));
export const testConfig = (workspace: string, extra: Partial<ServerConfig> = {}): ServerConfig =>
  ({ workspace, dataRoot: realData, qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted", ...extra });
```

```ts
// packages/server/test/rundata.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { checkQktSource } from "../src/check.js";
import { testConfig } from "./helpers.js";
import type { ServerConfig } from "../src/config.js";

let cfg: ServerConfig;
beforeAll(async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  cfg = testConfig(ws);
});

describe("checkQktSource", () => {
  it("passes a valid strategy and names the error line of a broken one", async () => {
    const good = "STRATEGY t VERSION 1\n\nSYMBOLS\n    g = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN g.close > 0\n    THEN BUY g SIZING 0.1\n";
    expect((await checkQktSource(cfg, good)).ok).toBe(true);
    const bad = good.replace("THEN BUY", "THEN BUYY");
    const r = await checkQktSource(cfg, bad);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.line).toBe(8);
  });
});
```

(Server tests build the config as a plain object, as `api.test.ts` does; `testConfig` in `helpers.ts` is that object.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/rundata.test.ts`
Expected: FAIL, `Cannot find module '../src/check.js'`.

- [ ] **Step 3: Implement `check.ts`** — move the body of the `/api/check` qkt branch into a function; the route becomes a caller.

```ts
// packages/server/src/check.ts
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintAliases, normalizeError, relocate, type Diagnostic } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { execQkt } from "./proc.js";
import { rememberParsed } from "./parse-cache.js";
import { resolveInJail } from "./jail.js";

/**
 * `qkt parse` plus the studio's lint on a source string, checked as a hidden sibling of `rel` (so relative IMPORTs
 * resolve as in a run), or in /tmp. Shared by the editor's live check and every tool that writes or runs DSL.
 */
export async function checkQktSource(cfg: ServerConfig, content: string, rel?: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  const name = `.qkt-check-${randomBytes(6).toString("hex")}.qkt`;
  const dir = typeof rel === "string" && rel.endsWith(".qkt") ? await resolveInJail(cfg.workspace, rel).then((abs) => path.dirname(abs), () => null) : null;
  let tmp = dir ? path.join(dir, name) : path.join(os.tmpdir(), name);
  try {
    try { await fs.writeFile(tmp, content, { flag: "wx" }); }
    catch { tmp = path.join(os.tmpdir(), name); await fs.writeFile(tmp, content, { flag: "wx" }); }
    const r = await execQkt(cfg.qktBin, ["parse", tmp], { cwd: cfg.workspace, timeoutMs: 20_000 });
    const diagnostics: Diagnostic[] = [];
    if (r.code !== 0) {
      const err = normalizeError(r.stderr || r.stdout, r.code);
      if (err.kind === "file_not_found" && err.file) err.message = `Imported file not found: ${path.relative(cfg.workspace, err.file).split(path.sep).join("/") || err.file}`;
      let { line, col } = err;
      let endCol = (col ?? 1) + 1;
      if (err.kind === "unknown_indicator") { const loc = relocate(content, err.message); if (loc) { line = loc.line; col = loc.col; endCol = loc.endCol; } }
      diagnostics.push({ severity: "error", code: err.kind, message: err.message, line: line ?? 1, col: col ?? 1, endCol });
    }
    if (r.code === 0) rememberParsed(content);
    diagnostics.push(...lintAliases(content));
    return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
```

In `check-routes.ts`, replace the block from `const name = ...` to the end of the `try/finally` with:

```ts
    try { return { diagnostics: (await checkQktSource(cfg, content, rel)).diagnostics }; }
    finally { inflight--; }
```

and delete the now-unused imports (`randomBytes`, `fs`, `os`, `path`, `execQkt`, `rememberParsed`, `resolveInJail`, `normalizeError`, `relocate`, `lintAliases`).

- [ ] **Step 4: Implement `run-data.ts`** — move `loadTrips` (with its cache and in-flight map) out of `run-routes.ts` unchanged, and add the three small loaders.

```ts
// packages/server/src/run-data.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RoundTrip, RunJson, Summary } from "@qkt-studio/core";
import type { Runner } from "./runner.js";
import type { ServerConfig } from "./config.js";

export interface RunMeta {
  runId: string; tier: string; from: string; to: string;
  streams: Array<{ key: string; broker: string; symbol: string; tf: string; base: string }>;
  strategies: string[]; fills: number; trips: number; currency?: string;
}

const TRIP_CACHE_MAX_TRIPS = 1_500_000;

/** A run's derived files, read once and shared by the run routes and the MCP tools. */
export class RunData {
  private tripCache = new Map<string, RoundTrip[]>();
  private loading = new Map<string, Promise<RoundTrip[] | null>>();
  constructor(private runner: Runner, private cfg: ServerConfig) {}

  private async json<T>(id: string, rel: string): Promise<T | null> {
    await this.runner.ensureDerived(id).catch(() => undefined);
    try { return JSON.parse(await fs.readFile(path.join(this.runner.runDir(id), rel), "utf8")) as T; } catch { return null; }
  }
  summary(id: string) { return this.json<Summary>(id, "derived/summary.json"); }
  meta(id: string) { return this.json<RunMeta>(id, "derived/meta.json"); }
  run(id: string): Promise<RunJson | null> { return this.runner.getRun(id); }

  async trips(id: string): Promise<RoundTrip[] | null> {
    // body moved verbatim from run-routes.ts `loadTrips` (cache hit refresh, one parse per run in flight, size-capped eviction)
  }
}
```

Move the existing `loadTrips` body (run-routes.ts lines ~47-70) into `trips()`, replacing `tripCache`/`loading` with the fields above and `TRIP_CACHE_MAX_TRIPS` with the constant. In `run-routes.ts`: `export function registerRunRoutes(app, runner, data: RunData)`; delete `loadTrips` and its cache; replace every `loadTrips(` with `data.trips(`. In `main.ts`: `const data = new RunData(runner, cfg);` after `runner.init()`, pass it to `registerRunRoutes(a, runner, data)`, and return it from `createStudio` (`return { app, runner, jobs, data }`).

- [ ] **Step 5: Run the new test and the whole server suite**

Run: `cd packages/server && npx vitest run`
Expected: all pass (the existing run-route tests prove the move changed nothing).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/{run-data.ts,check.ts,check-routes.ts,run-routes.ts,main.ts} packages/server/test/rundata.test.ts
git commit -m "refactor(server): shared run data loader and source check"
```

---

### Task 2: The MCP endpoint, the event stream, view state and context tools

**Files:**
- Create: `packages/server/src/mcp/index.ts`, `packages/server/src/mcp/util.ts`, `packages/server/src/mcp/tools-context.ts`, `packages/server/src/agent/events.ts`, `packages/server/src/agent/view-state.ts`
- Modify: `packages/server/package.json` (dependencies), `packages/server/src/main.ts`
- Test: `packages/server/test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `RunData` (Task 1), `Runner.list(strategy?, limit?)`, `resolveInJail`.
- Produces:
  - `interface ToolCtx { cfg: ServerConfig; runner: Runner; jobs: Jobs; data: RunData; events: EventBus; view: ViewState }` (in `mcp/util.ts`).
  - `ok(value: unknown): CallToolResult`, `fail(message: string): CallToolResult` (in `mcp/util.ts`).
  - `class EventBus { emit(e: StudioEvent): void; subscribe(fn: (e: StudioEvent) => void): () => void }`, `type StudioEvent = { t: "variant"; variantId: string; runId: string } | { t: "proposal"; id: string } | { t: "split" } | { t: "open"; path: string } | { t: "run"; runId: string }`.
  - `class ViewState { get(): View; set(v: Partial<View>): void }`, `interface View { openFile: string | null; cursorLine: number | null; selection: string | null; runId: string | null; visibleFrom: number | null; visibleTo: number | null; selectedTrade: number | null; variantId: string | null; runWindow: { from: string; to: string; tier: string } | null }`.
  - `registerMcp(app: FastifyInstance, ctx: ToolCtx): void` mounting `ALL /api/mcp`.

- [ ] **Step 1: Add the dependencies**

Run: `cd packages/server && pnpm add @modelcontextprotocol/sdk@^1.31.0 zod@^3.25.0`
Expected: both in `packages/server/package.json` dependencies.

- [ ] **Step 2: Write the failing test** (an MCP client against the real app on a random port)

```ts
// packages/server/test/mcp/tools.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createStudio } from "../../src/main.js";
import { testConfig, realData, haveData } from "../helpers.js";

export async function mcpClient(base: string, token?: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
  return c;
}
export const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

let studio: Awaited<ReturnType<typeof createStudio>>, base: string, ws: string;
beforeAll(async () => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "strategies", "ema.qkt"), "STRATEGY ema VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN gold.close > 0\n    THEN BUY gold SIZING 0.1\n");
  studio = await createStudio(testConfig(ws, { token: "t0k" }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); });

describe("/api/mcp", () => {
  it("refuses a client without the token, like the rest of /api", async () => {
    await expect(mcpClient(base)).rejects.toThrow(/401/);
  });
  it("lists the tools and answers get_context from what the browser reported", async () => {
    const c = await mcpClient(base, "t0k");
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_context", "list_files", "read_file", "list_runs", "get_run"]));
    await fetch(`${base}/api/view`, { method: "POST", headers: { Authorization: "Bearer t0k", "Content-Type": "application/json" }, body: JSON.stringify({ openFile: "strategies/ema.qkt", cursorLine: 7 }) });
    const ctx = await call(c, "get_context");
    expect(ctx.json.openFile).toMatchObject({ path: "strategies/ema.qkt", cursorLine: 7 });
    expect((await call(c, "read_file", { path: "strategies/ema.qkt" })).json.text).toMatch(/STRATEGY ema/);
    expect((await call(c, "read_file", { path: "../etc/passwd" })).isError).toBe(true);
    for (const t of (await c.listTools()).tools) expect((t.description ?? "").length).toBeLessThanOrEqual(200);
    await c.close();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/mcp/tools.test.ts`
Expected: FAIL (`/api/mcp` 404 or module not found).

- [ ] **Step 4: Implement the event bus, view state and util**

```ts
// packages/server/src/agent/events.ts
import type { FastifyInstance } from "fastify";
export type StudioEvent =
  | { t: "variant"; variantId: string; runId: string }
  | { t: "proposal"; id: string }
  | { t: "split" }
  | { t: "open"; path: string }
  | { t: "run"; runId: string };
/** Effects of tool calls the UI must show (a variant to display, a proposal to review): one SSE stream per browser tab. */
export class EventBus {
  private subs = new Set<(e: StudioEvent) => void>();
  emit(e: StudioEvent): void { for (const s of this.subs) s(e); }
  subscribe(fn: (e: StudioEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
}
export function registerEvents(app: FastifyInstance, bus: EventBus): void {
  app.get("/api/events", async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    raw.write(": ok\n\n");
    const off = bus.subscribe((e) => raw.write(`event: ${e.t}\ndata: ${JSON.stringify(e)}\n\n`));
    const beat = setInterval(() => raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => { off(); clearInterval(beat); raw.end(); });
  });
}
```

```ts
// packages/server/src/agent/view-state.ts
import type { FastifyInstance } from "fastify";
export interface View {
  openFile: string | null; cursorLine: number | null; selection: string | null; runId: string | null;
  visibleFrom: number | null; visibleTo: number | null; selectedTrade: number | null; variantId: string | null;
  runWindow: { from: string; to: string; tier: string } | null;
}
const EMPTY: View = { openFile: null, cursorLine: null, selection: null, runId: null, visibleFrom: null, visibleTo: null, selectedTrade: null, variantId: null, runWindow: null };
/** What the user is looking at, reported by the browser; the tools resolve "this file", "this trade", "the chart" from it. */
export class ViewState {
  private v: View = { ...EMPTY };
  get(): View { return this.v; }
  set(p: Partial<View>): void {
    const keys = Object.keys(EMPTY) as Array<keyof View>;
    for (const k of keys) if (k in p) (this.v as unknown as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k] ?? null;
    if (typeof this.v.selection === "string") this.v.selection = this.v.selection.slice(0, 4000);
  }
}
export function registerView(app: FastifyInstance, view: ViewState): void {
  app.post<{ Body: Partial<View> }>("/api/view", async (req) => { view.set(req.body ?? {}); return { ok: true }; });
}
```

```ts
// packages/server/src/mcp/util.ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { Jobs } from "../jobs.js";
import type { RunData } from "../run-data.js";
import type { EventBus } from "../agent/events.js";
import type { ViewState } from "../agent/view-state.js";

export interface ToolCtx { cfg: ServerConfig; runner: Runner; jobs: Jobs; data: RunData; events: EventBus; view: ViewState }
export const MAX_CHARS = 8000;
/** Compact JSON for the model; cut at MAX_CHARS with a note on how to ask for the rest. */
export function ok(value: unknown, more = "narrow it with limit/offset/fields"): CallToolResult {
  let text = JSON.stringify(value);
  if (text.length > MAX_CHARS) text = JSON.stringify({ truncated: true, hint: more, head: text.slice(0, MAX_CHARS - 200) });
  return { content: [{ type: "text", text }] };
}
export const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
/** Run a tool body; any thrown error becomes a tool error the model can read and act on. */
export const guard = (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => fn().catch((e: unknown) => fail((e as Error).message));
```

- [ ] **Step 5: Implement the context tools**

```ts
// packages/server/src/mcp/tools-context.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listStrategies } from "../data-scan.js";
import { resolveInJail } from "../jail.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

export function registerContextTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("get_context", { description: "What the user is looking at: open file, cursor, selection, the run on screen with its headline numbers, visible chart range, selected trade, variant, split." },
    () => guard(async () => {
      const v = ctx.view.get();
      const summary = v.runId ? await ctx.data.summary(v.runId) : null;
      const files = await listStrategies(ctx.cfg.workspace, 50);
      return ok({
        openFile: v.openFile ? { path: v.openFile, cursorLine: v.cursorLine, selection: v.selection } : null,
        run: v.runId ? { id: v.runId, window: v.runWindow, summary: summary && { trades: summary.trades, totalPnl: summary.totalPnl, winRate: summary.winRate, maxDrawdown: summary.maxDrawdown } } : null,
        chart: { visibleFrom: v.visibleFrom && new Date(v.visibleFrom).toISOString(), visibleTo: v.visibleTo && new Date(v.visibleTo).toISOString(), selectedTrade: v.selectedTrade },
        variantId: v.variantId, strategies: files,
      });
    }));
  s.registerTool("list_files", { description: "Workspace files (strategies, qkt.config.yaml, instruments.yaml, notes), optionally under one folder.", inputSchema: { dir: z.string().optional() } },
    ({ dir }) => guard(async () => {
      const root = await resolveInJail(ctx.cfg.workspace, dir ?? ".");
      const out: string[] = [];
      const walk = async (d: string, depth: number) => {
        if (depth > 3 || out.length >= 300) return;
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.name === "runs" || e.name === "node_modules" || (e.name.startsWith(".") && e.name !== ".env")) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p, depth + 1); else out.push(path.relative(ctx.cfg.workspace, p).split(path.sep).join("/"));
        }
      };
      await walk(root, 0);
      return ok(out.sort());
    }));
  s.registerTool("read_file", { description: "Read a workspace file (whole, or a line range).", inputSchema: { path: z.string(), from_line: z.number().int().optional(), to_line: z.number().int().optional() } },
    ({ path: rel, from_line, to_line }) => guard(async () => {
      if (/(^|\/)\.env$/.test(rel)) return fail(".env holds secrets and is not readable by tools");
      const abs = await resolveInJail(ctx.cfg.workspace, rel);
      const lines = (await fs.readFile(abs, "utf8")).split("\n");
      const a = Math.max(1, from_line ?? 1), b = Math.min(lines.length, to_line ?? lines.length);
      return ok({ path: rel, lines: `${a}-${b} of ${lines.length}`, text: lines.slice(a - 1, b).join("\n") }, "read a line range with from_line/to_line");
    }));
  s.registerTool("list_runs", { description: "Recent runs, newest first, optionally of one strategy: id, window, tier, status, trades, net P&L.", inputSchema: { strategy: z.string().optional(), limit: z.number().int().max(50).optional() } },
    ({ strategy, limit }) => guard(async () => ok(ctx.runner.list(strategy, limit ?? 15).map((r) => ({ id: r.id, strategy: r.strategy, from: r.from_d, to: r.to_d, tier: r.tier, status: r.status, trades: r.trades, net: r.total_pnl, sharpe: r.sharpe })))));
  s.registerTool("get_run", { description: "One run: status, window, tier, params, error if it failed, and headline numbers.", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => {
      const r = await ctx.data.run(id);
      if (!r) return fail(`no run ${id}`);
      const summary = r.status === "done" ? await ctx.data.summary(id) : null;
      return ok({ id: r.id, strategy: r.strategy, status: r.status, from: r.from, to: r.to, tier: r.tier, params: r.params, error: r.error, warnings: r.warnings, summary });
    }));
}
```

- [ ] **Step 6: Mount `/api/mcp`**

```ts
// packages/server/src/mcp/index.ts
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { STUDIO_VERSION } from "../postprocess.js";
import { registerContextTools } from "./tools-context.js";
import type { ToolCtx } from "./util.js";

/** Every tool group registers here; later tasks add their `register...` calls to this list. */
export function buildMcp(ctx: ToolCtx): McpServer {
  const s = new McpServer({ name: "qkt-studio", version: STUDIO_VERSION }, { instructions: "Tools of the qkt backtesting studio. Prefer try_change for any strategy change; read dsl_reference before writing DSL." });
  registerContextTools(s, ctx);
  return s;
}

/**
 * Stateless streamable HTTP at /api/mcp: a fresh server + transport per request (no session to leak or expire). Under /api,
 * so the token, host and cross-site checks of app.ts apply unchanged.
 */
export function registerMcp(app: FastifyInstance, ctx: ToolCtx): void {
  app.route({
    method: ["GET", "POST", "DELETE"], url: "/api/mcp",
    handler: async (req, reply) => {
      if (req.method !== "POST") return reply.code(405).header("Allow", "POST").send({ error: "stateless MCP: POST only" });
      reply.hijack();
      const server = buildMcp(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      reply.raw.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}
```

In `main.ts`, after building `data`: `const events = new EventBus(); const view = new ViewState();` and inside the `buildApp` callback add
`registerEvents(a, events); registerView(a, view); registerMcp(a, { cfg, runner, jobs, data, events, view });`; return `events` and `view` from `createStudio` too.

- [ ] **Step 7: Run the test**

Run: `cd packages/server && npx vitest run test/mcp/tools.test.ts`
Expected: PASS (both tests).

- [ ] **Step 8: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/{mcp,agent,main.ts} packages/server/test/mcp/tools.test.ts
git commit -m "feat(server): MCP endpoint at /api/mcp with context tools, view state and an event stream"
```

---

### Task 3: Knowledge tools (DSL cheat sheet, docs, examples, config and instrument references, data status)

**Files:**
- Create: `packages/server/assets/dsl/cheatsheet.md`, `scripts/sync-dsl-docs.mjs`, `packages/server/src/mcp/tools-knowledge.ts`
- Create (by running the sync script): `packages/server/assets/dsl/{index,strategy-block,conditions,expressions,indicators,actions,bracket,sizing,now,series,schedule}.md`, `packages/server/assets/dsl/examples/*.qkt`
- Modify: `packages/server/src/mcp/index.ts` (register), `docker/Dockerfile` (copy assets)
- Test: `packages/server/test/mcp/tools.test.ts` (add), `packages/server/test/cheatsheet.test.ts`

**Interfaces:**
- Consumes: `ToolCtx`, `ok/fail/guard` (Task 2), `completeConfig` and `instrumentsTemplate` (`scaffold.ts`), `scanSymbolIn` (`data-scan.ts`), `listStrategies`.
- Produces: tools `dsl_reference(topic?)`, `dsl_examples(query)`, `config_reference(key?)`, `instruments_reference(symbol?)`, `data_status(symbol?)`; `ASSETS_DIR` constant (`packages/server/src/mcp/tools-knowledge.ts`) resolving to `packages/server/assets` in dev and `/app/server/assets` in the image.

- [ ] **Step 1: Write the sync script** (copies qkt's DSL pages and example strategies into the studio, so the image ships the docs of the qkt it pins)

```js
// scripts/sync-dsl-docs.mjs  -- usage: node scripts/sync-dsl-docs.mjs [path/to/qkt]   (default ../qkt)
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const qkt = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "..", "qkt"));
const out = path.join(import.meta.dirname, "..", "packages", "server", "assets", "dsl");
const PAGES = ["index", "strategy-block", "conditions", "expressions", "indicators", "actions", "bracket", "sizing", "now", "series", "schedule"];
mkdirSync(path.join(out, "examples"), { recursive: true });
for (const p of PAGES) cpSync(path.join(qkt, "docs", "reference", "dsl", `${p}.md`), path.join(out, `${p}.md`));
const ex = path.join(qkt, "examples");
const picked = readdirSync(ex).filter((f) => f.endsWith(".qkt")).slice(0, 40);
for (const f of picked) cpSync(path.join(ex, f), path.join(out, "examples", f));
writeFileSync(path.join(out, "SOURCE.txt"), `Synced from ${qkt} (docs/reference/dsl, examples) on ${new Date().toISOString().slice(0, 10)}.\n`);
console.log(`synced ${PAGES.length} pages and ${picked.length} examples`);
```

Run: `node scripts/sync-dsl-docs.mjs ../qkt` — Expected: `synced 11 pages and N examples`. If a page name does not exist in qkt's `docs/reference/dsl/`, remove it from `PAGES` (check with `ls ../qkt/docs/reference/dsl`).

- [ ] **Step 2: Write the cheat sheet** — `packages/server/assets/dsl/cheatsheet.md`, exactly:

````markdown
# qkt DSL cheat sheet (read this first; `dsl_reference(topic)` has the full pages)

A strategy file:
```qkt
STRATEGY name VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m
    gold4h = BACKTEST:XAUUSD EVERY 4h
    fx = BACKTEST:NZDUSD EVERY 4h

PARAM fast = 9
PARAM slow = 21

RULES
    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, slow)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1
        BRACKET { STOP_LOSS BY 1.0 PCT, TAKE_PROFIT BY 2.0 PCT }

    WHEN ema(gold.close, fast) CROSSES BELOW ema(gold.close, slow)
     AND POSITION.gold > 0
    THEN CLOSE gold
```

- Streams: `alias = BROKER:SYMBOL EVERY <tf>` (`1m 5m 15m 30m 1h 4h 1d`). Fields: `alias.open .high .low .close .volume`; lookback `gold.close[1]` = previous bar.
- A rule: `WHEN <condition>` then lines starting `AND` / `OR`, then `THEN <action>` (actions separated by `;`). Rules are separated by a blank line.
- Compare: `> >= < <= = !=`, `a CROSSES ABOVE b`, `a CROSSES BELOW b` (true only on the crossing bar), `x IN [1, 2, 3]`, `NOT (...)`.
- Indicators: `sma(v, N) ema(v, N) wma(v, N) rsi(v, N) atr(alias, N) macd(v, F, S, sig) zscore(v, N) percentile_rank(v, N) correlation(a, b, N) vwap(alias, N)`; `v` is a series like `gold.close`.
- Position: `POSITION.gold` (net qty: >0 long, <0 short, 0 flat), `POSITION.gold.entry_price`, `POSITION.gold.pnl`, `POSITION.gold.holding_duration` (seconds).
- Time (UTC): `NOW.hour_utc` 0-23, `NOW.weekday` 0-6 (Monday = 0), `NOW.month`, `NOW.day`, `NOW.date_utc` (days since 1970-01-01), `SESSION_WINDOW(h1, m1, h2, m2)`, `CALENDAR_WINDOW(month1, day1, month2, day2)`.
- Actions: `BUY alias SIZING ...`, `SELL alias SIZING ...`, `CLOSE alias`.
- Sizing: `SIZING 0.1` (lots), `SIZING 0.5 PCT RISK` (a stop-out loses 0.5 % of equity; needs a STOP_LOSS), `SIZING 5 PCT OF EQUITY`.
- Bracket (after BUY/SELL): `BRACKET { STOP_LOSS BY 12, TAKE_PROFIT BY 24 }` - BY is a distance in the symbol's own price units (12 = $12 on gold, but 12.0 on a pair near 0.6: use 0.0012 there); `BY 1.0 PCT` = percent of the entry price (works on any symbol); `AT <expr>` = an absolute price, e.g. `STOP_LOSS AT gold.close - atr(gold, 14) * 2`.

Skip a date / weekday / hours / season (add to the rule's conditions):
```qkt
STRATEGY skip_days VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m

RULES
    WHEN gold.close > ema(gold.close, 50)
     AND POSITION.gold = 0
     AND NOT (NOW.date_utc IN [20679])
     AND NOT (NOW.weekday IN [4])
     AND NOT (NOW.hour_utc IN [21, 22])
    THEN BUY gold SIZING 0.1
```

Common mistakes: comparing two different symbols' prices (gold ~4000 vs a pair ~0.6 never cross); a BY distance sized for gold on a pair (lands below zero); `POSITION.x = 0` guard missing (orders stack).
````

- [ ] **Step 3: Test that every example in the cheat sheet parses** (keeps it honest as qkt evolves)

```ts
// packages/server/test/cheatsheet.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkQktSource } from "../src/check.js";
import { testConfig } from "./helpers.js";

describe("the DSL cheat sheet", () => {
  it("every qkt block parses with the qkt the studio runs", async () => {
    const md = readFileSync(path.join(import.meta.dirname, "..", "assets", "dsl", "cheatsheet.md"), "utf8");
    const blocks = [...md.matchAll(/```qkt\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const cfg = testConfig("/tmp");
    for (const b of blocks) expect((await checkQktSource(cfg, b)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
```

Run: `cd packages/server && npx vitest run test/cheatsheet.test.ts` — Expected: PASS.

- [ ] **Step 4: Add the failing MCP test**

```ts
// append to packages/server/test/mcp/tools.test.ts
describe("knowledge tools", () => {
  it("serve the cheat sheet, a page, examples and the config reference", async () => {
    const c = await mcpClient(base, "t0k");
    const sheet = await call(c, "dsl_reference");
    expect(sheet.text).toMatch(/cheat sheet/);
    expect(sheet.text).toMatch(/topics: .*bracket/);
    expect((await call(c, "dsl_reference", { topic: "bracket" })).text).toMatch(/STOP_LOSS/);
    expect((await call(c, "dsl_reference", { topic: "../../etc/passwd" })).isError).toBe(true);
    expect((await call(c, "dsl_examples", { query: "ema" })).json.length).toBeGreaterThan(0);
    expect((await call(c, "config_reference", { key: "risk" })).text).toMatch(/max_daily_loss/);
    expect((await call(c, "instruments_reference")).text).toMatch(/contractSize/);
    await c.close();
  });
});
```

Run: `npx vitest run test/mcp/tools.test.ts` — Expected: FAIL (`Tool dsl_reference not found`).

- [ ] **Step 5: Implement `tools-knowledge.ts`**

```ts
// packages/server/src/mcp/tools-knowledge.ts
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDocument } from "yaml";
import { completeConfig, instrumentsTemplate } from "../scaffold.js";
import { listStrategies, scanSymbolIn, scanCached } from "../data-scan.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

/** A symbol's entry in instruments.yaml (`instruments:` is a list of entries keyed by `qktSymbol: BROKER:SYMBOL`). */
export async function instrumentEntry(workspace: string, symbol: string): Promise<Record<string, unknown> | null> {
  const doc = parseDocument(await fs.readFile(path.join(workspace, "instruments.yaml"), "utf8").catch(() => ""));
  const list = (doc.toJSON() as { instruments?: Array<Record<string, unknown>> } | null)?.instruments ?? [];
  const want = symbol.includes(":") ? symbol : `BACKTEST:${symbol}`;
  return list.find((e) => e.qktSymbol === want) ?? null;
}

/** packages/server/assets in development (src/mcp -> ../../assets), /app/server/assets in the image (dist/mcp -> ../../assets). */
export const ASSETS_DIR = path.resolve(import.meta.dirname, "..", "..", "assets");
const DSL = path.join(ASSETS_DIR, "dsl");
const TOPIC = /^[a-z][a-z0-9-]{0,40}$/;

export function registerKnowledgeTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("dsl_reference", { description: "qkt DSL reference. No topic: the cheat sheet (read first) and the topic list. With a topic: that full page.", inputSchema: { topic: z.string().optional() } },
    ({ topic }) => guard(async () => {
      const topics = (await fs.readdir(DSL)).filter((f) => f.endsWith(".md") && f !== "cheatsheet.md").map((f) => f.slice(0, -3)).sort();
      if (!topic) return { content: [{ type: "text", text: `${await fs.readFile(path.join(DSL, "cheatsheet.md"), "utf8")}\n\ntopics: ${topics.join(", ")}` }] };
      const t = topic.replace(/\.md$/, "");
      if (!TOPIC.test(t) || !topics.includes(t)) return fail(`unknown topic "${topic}"; topics: ${topics.join(", ")}`);
      const text = await fs.readFile(path.join(DSL, `${t}.md`), "utf8");
      return { content: [{ type: "text", text: text.slice(0, 12_000) }] };
    }));
  s.registerTool("dsl_examples", { description: "Example strategies matching words in the query (workspace strategies and qkt's examples), shortest first.", inputSchema: { query: z.string(), limit: z.number().int().max(5).optional() } },
    ({ query, limit }) => guard(async () => {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
      const files: Array<{ name: string; text: string }> = [];
      for (const rel of await listStrategies(ctx.cfg.workspace, 200)) files.push({ name: rel, text: await fs.readFile(path.join(ctx.cfg.workspace, rel), "utf8").catch(() => "") });
      const ex = path.join(DSL, "examples");
      if (existsSync(ex)) for (const f of await fs.readdir(ex)) files.push({ name: `qkt:examples/${f}`, text: await fs.readFile(path.join(ex, f), "utf8") });
      const scored = files.map((f) => ({ ...f, score: words.filter((w) => f.text.toLowerCase().includes(w) || f.name.toLowerCase().includes(w)).length }))
        .filter((f) => f.score > 0 && f.text.length < 6000).sort((a, b) => b.score - a.score || a.text.length - b.text.length).slice(0, limit ?? 3);
      return ok(scored.map((f) => ({ name: f.name, source: f.text })));
    }));
  s.registerTool("config_reference", { description: "qkt.config.yaml reference: every option with its meaning and default; with key, only that section (e.g. risk, execution).", inputSchema: { key: z.string().optional() } },
    ({ key }) => guard(async () => {
      const ref = completeConfig("");
      if (!key) return { content: [{ type: "text", text: ref.slice(0, 12_000) }] };
      const lines = ref.split("\n"), start = lines.findIndex((l) => new RegExp(`^(#\\s?)?${key.replace(/\W/g, "")}:`).test(l));
      if (start < 0) return fail(`no section "${key}" in the config reference`);
      let end = start + 1;
      while (end < lines.length && !/^(#\s?)?[a-z_]+:/.test(lines[end]!)) end++;
      return { content: [{ type: "text", text: lines.slice(Math.max(0, start - 3), end).join("\n") }] };
    }));
  s.registerTool("instruments_reference", { description: "instruments.yaml fields (contract size, lot rules, costs, swap) and, with symbol, that symbol's current entry.", inputSchema: { symbol: z.string().optional() } },
    ({ symbol }) => guard(async () => {
      const head = instrumentsTemplate([]).split("\n").filter((l) => l.startsWith("#")).join("\n");
      if (!symbol) return { content: [{ type: "text", text: head }] };
      const entry = await instrumentEntry(ctx.cfg.workspace, symbol);
      return ok({ symbol, entry: entry ?? `no entry: qkt uses its built-in table for ${symbol}, or refuses a symbol it does not know`, fields: head });
    }));
  s.registerTool("data_status", { description: "What market data exists: per symbol the bar timeframes, first/last day, complete windows, ticks. With symbol, only that one.", inputSchema: { symbol: z.string().optional() } },
    ({ symbol }) => guard(async () => {
      if (symbol) {
        const r = await scanSymbolIn(ctx.cfg.dataRoot, symbol.replace(/^.*:/, ""));
        if (!r) return fail(`no data for ${symbol}`);
        return ok({ symbol: r.symbol, status: r.status, market: r.market, bars: r.bars.filter((b) => b.files > 0).map((b) => ({ tf: b.tf, first: b.first, last: b.last, status: b.status, missing: b.missing, longestComplete: b.usable.sort((x, y) => (Date.parse(y.to) - Date.parse(y.from)) - (Date.parse(x.to) - Date.parse(x.from)))[0] ?? null })), ticks: r.ticks && { first: r.ticks.first, last: r.ticks.last, status: r.ticks.status } });
      }
      const scan = await scanCached(ctx.cfg.dataRoot);
      return ok(scan.symbols.map((x) => ({ symbol: x.symbol, status: x.status, tfs: x.bars.filter((b) => b.files > 0 && !b.qktReads).map((b) => b.tf), last: x.bars.map((b) => b.last).filter(Boolean).sort().pop() ?? x.ticks?.last ?? null })));
    }));
}
```

Add `registerKnowledgeTools(s, ctx);` to `buildMcp` in `mcp/index.ts`. In `docker/Dockerfile`, next to the line that copies `packages/server/dist`, add `COPY packages/server/assets /app/server/assets`.

- [ ] **Step 6: Run the tests**

Run: `cd packages/server && npx vitest run test/mcp/tools.test.ts test/cheatsheet.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-dsl-docs.mjs packages/server/assets packages/server/src/mcp packages/server/test docker/Dockerfile
git commit -m "feat(mcp): knowledge tools - DSL cheat sheet and pages, examples, config and instrument references, data status"
```

---

### Task 4: Exit diagnostics in core (excursions and what-if brackets)

**Files:**
- Create: `packages/core/src/diagnose.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/diagnose.test.ts`

**Interfaces:**
- Consumes: `RoundTrip` (`roundtrips.ts`).
- Produces:
  - `interface PathBars { ts: ArrayLike<number>; high: ArrayLike<number>; low: ArrayLike<number> }` (bar open times, ascending).
  - `excursion(t: RoundTrip, bars: PathBars): { mfe: number; mae: number; bars: number } | null` — price distances from entry, favourable and adverse, over bars from the entry bar to the exit bar inclusive.
  - `whatIf(t: RoundTrip, bars: PathBars, stop: number, target: number, horizonBars: number): "target" | "stop" | "open"` — walks bars after the entry bar; a bar touching both counts as `"stop"` (conservative).
  - `diagnoseExits(trips: RoundTrip[], barsOf: (t: RoundTrip) => PathBars | null, grid?: { stops: number[]; targets: number[] }): ExitDiagnosis` with
    `interface ExitDiagnosis { trades: number; exits: Record<"stop" | "target" | "signal" | "open", number>; bracket: { medianStop: number | null; medianTarget: number | null }; mfe: Dist; mae: Dist; mfeR: Dist | null; barsToExit: Dist; whatIf: Array<{ stop: number; target: number; targetFirst: number; stopFirst: number; open: number; netPoints: number; expectancyR: number | null }>; note: string }`,
    `interface Dist { p25: number; median: number; p75: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/diagnose.test.ts
import { describe, it, expect } from "vitest";
import { excursion, whatIf, diagnoseExits, type PathBars } from "../src/diagnose.js";
import type { RoundTrip } from "../src/roundtrips.js";

const H = 3_600_000;
const trip = (o: Partial<RoundTrip>): RoundTrip => ({ id: 1, strategy: "s", symbol: "BACKTEST:XAUUSD", side: "long", entryTs: 0, entryPx: 100, exitTs: 4 * H, exitPx: 88, qty: 1, pnl: -12, fills: 2, holdMs: 4 * H, open: false, sl: 88, tp: 124, exit: "stop", ...o });
// entry bar at 0, then bars rising to +3, falling through the stop at 88
const bars: PathBars = { ts: [0, H, 2 * H, 3 * H, 4 * H, 5 * H], high: [100.5, 103, 101, 95, 90, 90], low: [99.5, 100, 96, 90, 87, 85] };

describe("excursion", () => {
  it("measures favourable and adverse moves from entry to exit, long and short", () => {
    expect(excursion(trip({}), bars)).toEqual({ mfe: 3, mae: 13, bars: 5 });
    const short = trip({ side: "short", entryPx: 100, sl: 112, tp: 76 });
    expect(excursion(short, bars)).toEqual({ mfe: 13, mae: 3, bars: 5 });
  });
  it("is null without bars inside the trade", () => {
    expect(excursion(trip({ entryTs: 99 * H, exitTs: 100 * H }), bars)).toBeNull();
  });
});

describe("whatIf", () => {
  it("a 2-point target is reached before the 12-point stop; a 24-point target is not", () => {
    expect(whatIf(trip({}), bars, 12, 2, 50)).toBe("target");
    expect(whatIf(trip({}), bars, 12, 24, 50)).toBe("stop");
  });
  it("a bar touching both counts as the stop, and no touch within the horizon is open", () => {
    const both: PathBars = { ts: [0, H], high: [100, 130], low: [100, 80] };
    expect(whatIf(trip({}), both, 12, 24, 50)).toBe("stop");
    expect(whatIf(trip({}), { ts: [0, H], high: [100, 101], low: [100, 99] }, 12, 24, 50)).toBe("open");
  });
});

describe("diagnoseExits", () => {
  it("summarises how trades ended and ranks bracket alternatives", () => {
    const trips = [trip({ id: 1 }), trip({ id: 2 }), trip({ id: 3, exit: "target", exitPx: 124, pnl: 24 })];
    const d = diagnoseExits(trips, () => bars, { stops: [12], targets: [2, 24] });
    expect(d.trades).toBe(3);
    expect(d.exits).toEqual({ stop: 2, target: 1, signal: 0, open: 0 });
    expect(d.bracket).toEqual({ medianStop: 12, medianTarget: 24 });
    expect(d.mfe.median).toBe(3);
    const t2 = d.whatIf.find((w) => w.target === 2)!;
    expect(t2).toMatchObject({ stop: 12, targetFirst: 3, stopFirst: 0, open: 0, netPoints: 6 });
    expect(d.note).toMatch(/estimate on bars/);
  });
  it("handles no trades without NaN", () => {
    const d = diagnoseExits([], () => null);
    expect(d.trades).toBe(0);
    expect(JSON.stringify(d)).not.toMatch(/NaN/);
  });
});
```

- [ ] **Step 2: Run to fail** — `cd packages/core && npx vitest run test/diagnose.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/diagnose.ts
import type { RoundTrip } from "./roundtrips.js";

/** Bars a trade is judged on: open times ascending, with highs and lows. */
export interface PathBars { ts: ArrayLike<number>; high: ArrayLike<number>; low: ArrayLike<number> }
export interface Dist { p25: number; median: number; p75: number }
export interface ExitDiagnosis {
  trades: number;
  exits: Record<"stop" | "target" | "signal" | "open", number>;
  bracket: { medianStop: number | null; medianTarget: number | null };
  mfe: Dist; mae: Dist; mfeR: Dist | null; barsToExit: Dist;
  whatIf: Array<{ stop: number; target: number; targetFirst: number; stopFirst: number; open: number; netPoints: number; expectancyR: number | null }>;
  note: string;
}

const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!; };
const dist = (xs: number[]): Dist => ({ p25: round(q(xs, 0.25)), median: round(q(xs, 0.5)), p75: round(q(xs, 0.75)) });
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const median = (xs: number[]) => (xs.length ? round(q(xs, 0.5)) : null);

/** First bar index at or after `ts` (bars are open times, ascending). */
function firstAtOrAfter(b: PathBars, ts: number): number { let i = 0; while (i < b.ts.length && b.ts[i]! < ts) i++; return i; }
/** The bar that contains `ts`: the last bar opening at or before it. */
function barOf(b: PathBars, ts: number): number { let i = firstAtOrAfter(b, ts); if (i >= b.ts.length || b.ts[i]! > ts) i--; return i; }

/** Maximum favourable / adverse price move from the entry, over the entry bar through the exit bar. */
export function excursion(t: RoundTrip, bars: PathBars): { mfe: number; mae: number; bars: number } | null {
  const a = barOf(bars, t.entryTs), z = t.exitTs === null ? bars.ts.length - 1 : barOf(bars, t.exitTs);
  if (a < 0 || z < a || bars.ts[a]! > t.entryTs || (t.exitTs !== null && t.exitTs - bars.ts[a]! > 400 * 86_400_000)) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = a; i <= z; i++) { hi = Math.max(hi, bars.high[i]!); lo = Math.min(lo, bars.low[i]!); }
  const long = t.side === "long";
  return { mfe: round(Math.max(0, long ? hi - t.entryPx : t.entryPx - lo)), mae: round(Math.max(0, long ? t.entryPx - lo : hi - t.entryPx)), bars: z - a + 1 };
}

/** Which of a stop / target (price distances from entry) is touched first on the bars after the entry bar. */
export function whatIf(t: RoundTrip, bars: PathBars, stop: number, target: number, horizonBars: number): "target" | "stop" | "open" {
  const a = barOf(bars, t.entryTs);
  if (a < 0) return "open";
  const long = t.side === "long";
  const sl = long ? t.entryPx - stop : t.entryPx + stop, tp = long ? t.entryPx + target : t.entryPx - target;
  for (let i = a + 1; i < bars.ts.length && i <= a + horizonBars; i++) {
    const hitStop = long ? bars.low[i]! <= sl : bars.high[i]! >= sl;
    const hitTarget = long ? bars.high[i]! >= tp : bars.low[i]! <= tp;
    if (hitStop) return "stop";         // a bar touching both: the stop, as a conservative guess
    if (hitTarget) return "target";
  }
  return "open";
}

/**
 * How the trades ended and what other stop/target distances would have done. Distances are in the symbol's price units.
 * The grid defaults to multiples of the median stop distance the trades carried.
 */
export function diagnoseExits(trips: RoundTrip[], barsOf: (t: RoundTrip) => PathBars | null, grid?: { stops: number[]; targets: number[] }): ExitDiagnosis {
  const closed = trips.filter((t) => !t.open);
  const exits = { stop: 0, target: 0, signal: 0, open: 0 };
  for (const t of trips) exits[t.exit]++;
  const stops = closed.filter((t) => t.sl !== undefined).map((t) => Math.abs(t.entryPx - t.sl!));
  const targets = closed.filter((t) => t.tp !== undefined).map((t) => Math.abs(t.tp! - t.entryPx));
  const mfe: number[] = [], mae: number[] = [], mfeR: number[] = [], held: number[] = [];
  const withBars: Array<{ t: RoundTrip; b: PathBars }> = [];
  for (const t of closed) {
    const b = barsOf(t);
    const e = b && excursion(t, b);
    if (!b || !e) continue;
    withBars.push({ t, b });
    mfe.push(e.mfe); mae.push(e.mae); held.push(e.bars);
    if (t.sl !== undefined && t.entryPx !== t.sl) mfeR.push(e.mfe / Math.abs(t.entryPx - t.sl));
  }
  const base = median(stops) ?? median(mae) ?? 0;
  const g = grid ?? { stops: [0.5, 1, 1.5, 2].map((m) => round(base * m)).filter((x) => x > 0), targets: [0.5, 1, 1.5, 2, 3].map((m) => round(base * m)).filter((x) => x > 0) };
  const rows: ExitDiagnosis["whatIf"] = [];
  for (const stop of g.stops) for (const target of g.targets) {
    let tf = 0, sf = 0, op = 0;
    for (const { t, b } of withBars) { const r = whatIf(t, b, stop, target, 2000); if (r === "target") tf++; else if (r === "stop") sf++; else op++; }
    const net = tf * target - sf * stop, n = tf + sf;
    rows.push({ stop, target, targetFirst: tf, stopFirst: sf, open: op, netPoints: round(net), expectancyR: n ? round(net / n / stop) : null });
  }
  rows.sort((x, y) => y.netPoints - x.netPoints);
  return {
    trades: trips.length, exits, bracket: { medianStop: median(stops), medianTarget: median(targets) },
    mfe: dist(mfe), mae: dist(mae), mfeR: mfeR.length ? dist(mfeR) : null, barsToExit: dist(held), whatIf: rows.slice(0, 12),
    note: `what-if is an estimate on bars for ${withBars.length} of ${closed.length} closed trades (a bar touching both levels counts as the stop); confirm with try_change`,
  };
}
```

Add `export * from "./diagnose.js";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run** — `npx vitest run test/diagnose.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diagnose.ts packages/core/src/index.ts packages/core/test/diagnose.test.ts
git commit -m "feat(core): exit diagnostics - excursions and what-if brackets on bars"
```

---

### Task 5: Analysis tools

**Files:**
- Create: `packages/server/src/mcp/tools-analysis.ts`
- Modify: `packages/server/src/run-routes.ts` (move `parseTripQuery` to `run-data.ts` and re-export), `packages/server/src/run-data.ts` (add `barsFor`), `packages/server/src/mcp/index.ts`
- Test: `packages/server/test/mcp/tools.test.ts` (add, using a real run on real data)

**Interfaces:**
- Consumes: `RunData` (Task 1), `diagnoseExits` (Task 4), `analyze`, `queryTrips`, `readBars` (core).
- Produces:
  - `RunData.barsFor(runId: string, symbol: string, fromMs: number, toMs: number): Promise<{ tf: string; cols: BarCols } | null>` — the run's finest built stream of that symbol (`meta.streams[].base`), read with `readBars`.
  - `parseTripQuery` exported from `run-data.ts`.
  - Tools: `run_summary(run?)`, `diagnose_exits(run?, stops?, targets?)`, `diagnose_entries(run?)`, `trades(run?, side?, outcome?, exit?, weekday?, from?, to?, sort?, limit?, offset?)`, `trade_detail(run?, id, bars_before?, bars_after?)`, `compare_runs(a, b)`. `run` defaults to the run on screen (`view.runId`), else the newest done run of the open file.

- [ ] **Step 1: Write the failing test** (runs a real bars backtest on the repo's real data fixture, like `api.test.ts` does)

```ts
// append to packages/server/test/mcp/tools.test.ts
describe.skipIf(!haveData)("analysis tools", () => {
  it("summarise, diagnose and list the trades of a real run", async () => {
    const s2 = await createStudio(testConfig(ws, { token: "t0k", dataRoot: realData }));
    await s2.app.listen({ port: 0, host: "127.0.0.1" });
    const b2 = `http://127.0.0.1:${(s2.app.server.address() as { port: number }).port}`;
    writeFileSync(path.join(ws, "strategies", "bracket.qkt"), "STRATEGY bracket VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN ema(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n        BRACKET { STOP_LOSS BY 5, TAKE_PROFIT BY 20 }\n");
    const { runId } = await s2.runner.submit({ strategy: "strategies/bracket.qkt", from: "2024-10-01", to: "2024-10-15", tier: "draft" });
    await s2.runner.waitFor(runId);
    const c = await mcpClient(b2, "t0k");
    const sum = await call(c, "run_summary", { run: runId });
    expect(sum.json.trades).toBeGreaterThan(0);
    const d = await call(c, "diagnose_exits", { run: runId });
    expect(d.json.exits.stop + d.json.exits.target + d.json.exits.signal + d.json.exits.open).toBe(d.json.trades);
    expect(d.json.bracket.medianStop).toBeCloseTo(5, 1);
    expect(d.json.whatIf.length).toBeGreaterThan(0);
    const t = await call(c, "trades", { run: runId, limit: 3 });
    expect(t.json.rows.length).toBeLessThanOrEqual(3);
    const one = await call(c, "trade_detail", { run: runId, id: t.json.rows[0].id, bars_before: 5, bars_after: 5 });
    expect(one.json.bars.length).toBeGreaterThan(5);
    expect((await call(c, "run_summary", { run: "nope" })).isError).toBe(true);
    await c.close(); await s2.app.close();
  }, 120_000);
});
```

Run: `npx vitest run test/mcp/tools.test.ts -t "analysis"` — Expected: FAIL (`Tool run_summary not found`).

- [ ] **Step 2: Add `barsFor` and move `parseTripQuery`** — cut `parseTripQuery` from `run-routes.ts` into `run-data.ts` (export it; `run-routes.ts` imports it from there). Then:

```ts
// in class RunData (run-data.ts)
  /** Bars of `symbol` ("BROKER:SYM" or "SYM") over [fromMs, toMs), from the finest stream this run read for it. */
  async barsFor(runId: string, symbol: string, fromMs: number, toMs: number): Promise<{ tf: string; cols: BarCols } | null> {
    const meta = await this.meta(runId);
    const [broker, sym] = symbol.includes(":") ? symbol.split(":") as [string, string] : ["BACKTEST", symbol];
    const streams = (meta?.streams ?? []).filter((s) => s.broker === broker && s.symbol === sym).sort((a, b) => tfToMs(a.base) - tfToMs(b.base));
    const s = streams[0];
    if (!s) return null;
    const r = await readBars(rootFor(this.cfg, sym), broker, sym, s.base, fromMs, toMs);
    return r.cols.ts.length ? { tf: s.base, cols: r.cols } : null;
  }
```

with imports `import { readBars, tfToMs, type BarCols } from "@qkt-studio/core";` and `import { rootFor } from "./settings.js";` (the per-symbol data source the runner already uses).

- [ ] **Step 3: Implement the tools**

```ts
// packages/server/src/mcp/tools-analysis.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyze, diagnoseExits, queryTrips, type PathBars, type RoundTrip } from "@qkt-studio/core";
import { parseTripQuery } from "../run-data.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const runArg = { run: z.string().optional().describe("run id; default: the run on screen") };

/** The run a tool works on: the one given, else the one on screen, else the newest finished run of the open file. */
export async function resolveRun(ctx: ToolCtx, run?: string): Promise<string> {
  if (run) { if (!(await ctx.data.run(run))) throw new Error(`no run ${run}`); return run; }
  const v = ctx.view.get();
  if (v.runId) return v.runId;
  const newest = ctx.runner.list(v.openFile ?? undefined, 20).find((r) => r.status === "done");
  if (!newest) throw new Error("no run on screen and none finished for the open file; run one first (run_backtest or try_change)");
  return newest.id;
}

export function registerAnalysisTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("run_summary", { description: "Headline numbers of a run: net, trades, win rate, profit factor, drawdown, Sharpe; its window, tier, warnings.", inputSchema: runArg },
    ({ run }) => guard(async () => {
      const id = await resolveRun(ctx, run);
      const [r, sm] = [await ctx.data.run(id), await ctx.data.summary(id)];
      if (!sm) return fail(`run ${id} has no results (status ${r?.status})`);
      return ok({ id, strategy: r?.strategy, from: r?.from, to: r?.to, tier: r?.tier, net: sm.totalPnl, trades: sm.trades, winRate: sm.winRate, profitFactor: sm.profitFactor, expectancy: sm.expectancy, maxDrawdown: sm.maxDrawdown, sharpe: sm.sharpe, long: sm.long, short: sm.short, warnings: r?.warnings ?? [] });
    }));
  s.registerTool("diagnose_exits", { description: "How trades ended (stop/target/signal), how far they moved for and against before exiting, and a what-if table of other stop/target distances.", inputSchema: { ...runArg, stops: z.array(z.number().positive()).max(6).optional(), targets: z.array(z.number().positive()).max(8).optional() } },
    ({ run, stops, targets }) => guard(async () => {
      const id = await resolveRun(ctx, run);
      const trips = await ctx.data.trips(id);
      if (!trips) return fail(`run ${id} has no trades`);
      const bySymbol = new Map<string, PathBars | null>();
      for (const sym of new Set(trips.map((t) => t.symbol))) {
        const ts = trips.filter((t) => t.symbol === sym);
        const from = Math.min(...ts.map((t) => t.entryTs)) - 86_400_000, to = Math.max(...ts.map((t) => t.exitTs ?? t.entryTs)) + 30 * 86_400_000;
        const b = await ctx.data.barsFor(id, sym, from, to);
        bySymbol.set(sym, b ? { ts: b.cols.ts, high: b.cols.high, low: b.cols.low } : null);
      }
      const grid = stops || targets ? { stops: stops ?? [], targets: targets ?? [] } : undefined;
      return ok(diagnoseExits(trips, (t: RoundTrip) => bySymbol.get(t.symbol) ?? null, grid && grid.stops.length && grid.targets.length ? grid : undefined));
    }));
  s.registerTool("diagnose_entries", { description: "Where the results come from: trades, win rate and P&L by UTC hour, weekday, side and exit reason.", inputSchema: runArg },
    ({ run }) => guard(async () => {
      const id = await resolveRun(ctx, run);
      const trips = await ctx.data.trips(id);
      if (!trips) return fail(`run ${id} has no trades`);
      const a = analyze(trips);
      return ok({ id, hour: a.hour, weekday: a.weekday, side: a.side, exit: a.exit, note: "weekday 0 = Monday; hours are UTC entry hours" });
    }));
  s.registerTool("trades", { description: "A run's trades, filtered and sorted: side, outcome (win/loss), exit (stop/target/signal), weekday, date range; compact rows.", inputSchema: {
      ...runArg, side: z.enum(["long", "short"]).optional(), outcome: z.enum(["win", "loss", "breakeven", "open", "closed"]).optional(), exit: z.enum(["stop", "target", "signal", "open"]).optional(),
      weekday: z.number().int().min(0).max(6).optional(), from: z.string().optional(), to: z.string().optional(),
      sort: z.enum(["entryTs", "pnl", "r", "holdMs"]).optional(), dir: z.enum(["asc", "desc"]).optional(), limit: z.number().int().max(50).optional(), offset: z.number().int().optional() } },
    (a) => guard(async () => {
      const id = await resolveRun(ctx, a.run);
      const trips = await ctx.data.trips(id);
      if (!trips) return fail(`run ${id} has no trades`);
      const q = parseTripQuery({ side: a.side, outcome: a.outcome, exit: a.exit, weekday: a.weekday?.toString(), sort: a.sort, dir: a.dir, limit: String(a.limit ?? 20), offset: a.offset?.toString(),
        from: a.from ? String(Date.parse(`${a.from}T00:00:00Z`)) : undefined, to: a.to ? String(Date.parse(`${a.to}T00:00:00Z`) + 86_400_000) : undefined });
      const page = queryTrips(trips, q);
      const iso = (x: number | null) => (x === null ? null : new Date(x).toISOString().slice(0, 16).replace("T", " "));
      return ok({ total: page.total, rows: page.rows.map((t) => ({ id: t.id, side: t.side, symbol: t.symbol, entry: iso(t.entryTs), entryPx: t.entryPx, exit: iso(t.exitTs), exitPx: t.exitPx, why: t.exit, sl: t.sl, tp: t.tp, pnl: t.pnl, r: t.r })) });
    }));
  s.registerTool("trade_detail", { description: "One trade: entry, exit, stop, target, result, and the OHLC bars around it (what the chart shows).", inputSchema: { ...runArg, id: z.number().int(), bars_before: z.number().int().max(60).optional(), bars_after: z.number().int().max(60).optional() } },
    ({ run, id, bars_before, bars_after }) => guard(async () => {
      const rid = await resolveRun(ctx, run);
      const t = (await ctx.data.trips(rid))?.find((x) => x.id === id);
      if (!t) return fail(`no trade ${id} in run ${rid}`);
      const b = await ctx.data.barsFor(rid, t.symbol, t.entryTs - 7 * 86_400_000, (t.exitTs ?? t.entryTs) + 7 * 86_400_000);
      const bars: Array<[string, number, number, number, number]> = [];
      if (b) {
        const ts = b.cols.ts; let a = 0; while (a < ts.length && ts[a]! < t.entryTs) a++; let z = a; while (z < ts.length && ts[z]! < (t.exitTs ?? t.entryTs)) z++;
        for (let i = Math.max(0, a - (bars_before ?? 10)); i < Math.min(ts.length, z + 1 + (bars_after ?? 10)); i++) bars.push([new Date(ts[i]!).toISOString().slice(0, 16).replace("T", " "), b.cols.open[i]!, b.cols.high[i]!, b.cols.low[i]!, b.cols.close[i]!]);
      }
      return ok({ trade: { ...t, entry: new Date(t.entryTs).toISOString(), exit: t.exitTs && new Date(t.exitTs).toISOString() }, tf: b?.tf ?? null, bars, columns: ["time", "open", "high", "low", "close"] });
    }));
  s.registerTool("compare_runs", { description: "Two runs side by side: headline numbers and how many trades each has that the other does not.", inputSchema: { a: z.string(), b: z.string() } },
    ({ a, b }) => guard(async () => {
      const [sa, sb, ta, tb] = [await ctx.data.summary(a), await ctx.data.summary(b), await ctx.data.trips(a), await ctx.data.trips(b)];
      if (!sa || !sb) return fail("both runs must be finished");
      const keyOf = (t: RoundTrip) => `${t.symbol}|${t.side}|${t.entryTs}`;
      const ka = new Set((ta ?? []).map(keyOf)), kb = new Set((tb ?? []).map(keyOf));
      const pick = (s: typeof sa) => ({ net: s.totalPnl, trades: s.trades, winRate: s.winRate, profitFactor: s.profitFactor, maxDrawdown: s.maxDrawdown, sharpe: s.sharpe });
      return ok({ a: { id: a, ...pick(sa) }, b: { id: b, ...pick(sb) }, onlyInA: [...ka].filter((k) => !kb.has(k)).length, onlyInB: [...kb].filter((k) => !ka.has(k)).length });
    }));
}
```

Register it in `buildMcp`: `registerAnalysisTools(s, ctx);`.

- [ ] **Step 4: Run** — `npx vitest run test/mcp/tools.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(mcp): analysis tools - summary, exit and entry diagnosis, trades, a trade with its bars, run comparison"
```

---

### Task 6: DSL change operations in core

The model maps words to operations; this module applies them exactly. Pure, line-based (qkt strategy files are small),
atomic (an error throws and nothing is returned half-changed).

**Files:**
- Create: `packages/core/src/dslops.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/dslops.test.ts`

**Interfaces:**
- Consumes: `canonicalTf` (`strategy.ts`).
- Produces:
  - `type RuleRef = number | string` — 1-based rule number, or text contained in the rule (case-insensitive).
  - `type Change = { op: "set_bracket"; rule?: RuleRef; stop?: string | number; target?: string | number } | { op: "set_param"; name: string; value: string | number | boolean } | { op: "set_sizing"; rule?: RuleRef; sizing: string } | { op: "add_condition"; rule?: RuleRef; expr: string; mode?: "and" | "or" } | { op: "remove_condition"; rule?: RuleRef; match: string } | { op: "exclude"; rule?: RuleRef; dates?: string[]; weekdays?: Array<string | number>; hours_utc?: number[]; calendar_window?: [number, number, number, number] } | { op: "add_rule"; source: string } | { op: "remove_rule"; match: string } | { op: "add_symbol"; alias: string; symbol: string; tf: string } | { op: "replace_text"; find: string; replace: string } | { op: "source"; text: string }`
  - `class ChangeError extends Error {}`
  - `applyChanges(source: string, changes: Change[]): { source: string; notes: string[] }`
  - `lineDiff(before: string, after: string): string` — each changed block as `@@ line N`, then its removed (`-`) and added (`+`) lines.
  - `describeRules(source: string): Array<{ n: number; entry: boolean; text: string }>` — for error messages and the `get_rules` view.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/dslops.test.ts
import { describe, it, expect } from "vitest";
import { applyChanges, ChangeError, lineDiff, describeRules } from "../src/dslops.js";

const SRC = `STRATEGY xau_both VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m
    fx =  BACKTEST:NZDUSD EVERY 4h

PARAM fast = 9

RULES
    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1
        BRACKET {
          STOP_LOSS BY 2,
          TAKE_PROFIT BY 24
        }

    WHEN ema(gold.close, fast) CROSSES BELOW ema(gold.close, 21)
     AND POSITION.gold = 0
    THEN SELL gold SIZING 0.1

    WHEN POSITION.gold > 0 AND gold.close < ema(gold.close, 50)
    THEN CLOSE gold
`;

describe("set_bracket", () => {
  it("changes every entry rule's stop, adds a BRACKET where missing, and leaves the exit-only rule alone", () => {
    const r = applyChanges(SRC, [{ op: "set_bracket", stop: "2%" }]);
    expect(r.source).toContain("BRACKET { STOP_LOSS BY 2 PCT, TAKE_PROFIT BY 24 }");
    expect(r.source).toMatch(/THEN SELL gold SIZING 0\.1\n\s+BRACKET \{ STOP_LOSS BY 2 PCT \}/);
    expect(r.source).toMatch(/THEN CLOSE gold\n$/);
    expect(r.notes.join(" ")).toMatch(/rule 1.*rule 2 \(added a BRACKET\)/);
  });
  it("targets one rule by number or text, and accepts BY / AT / plain numbers", () => {
    const r = applyChanges(SRC, [{ op: "set_bracket", rule: 1, target: 6 }, { op: "set_bracket", rule: "CROSSES BELOW", stop: "AT gold.close + 10" }]);
    expect(r.source).toContain("BRACKET { STOP_LOSS BY 2, TAKE_PROFIT BY 6 }");
    expect(r.source).toContain("BRACKET { STOP_LOSS AT gold.close + 10 }");
  });
  it("refuses a spec it cannot read, and a rule that does not exist", () => {
    expect(() => applyChanges(SRC, [{ op: "set_bracket", stop: "a lot" }])).toThrow(ChangeError);
    expect(() => applyChanges(SRC, [{ op: "set_bracket", rule: 9, stop: 2 }])).toThrow(/no rule 9; rules: 1: WHEN ema/);
  });
});

describe("params, sizing, conditions", () => {
  it("set_param replaces or adds", () => {
    expect(applyChanges(SRC, [{ op: "set_param", name: "fast", value: 12 }]).source).toContain("PARAM fast = 12");
    expect(applyChanges(SRC, [{ op: "set_param", name: "slow", value: 30 }]).source).toMatch(/PARAM fast = 9\nPARAM slow = 30\n/);
  });
  it("set_sizing changes entry rules only", () => {
    const r = applyChanges(SRC, [{ op: "set_sizing", sizing: "0.5 PCT RISK" }]).source;
    expect(r.match(/SIZING 0\.5 PCT RISK/g)!.length).toBe(2);
  });
  it("add_condition goes before THEN with the rule's indentation; remove_condition promotes the next line when WHEN goes", () => {
    const a = applyChanges(SRC, [{ op: "add_condition", rule: 1, expr: "ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)" }]).source;
    expect(a).toContain("     AND POSITION.gold = 0\n     AND ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)\n    THEN BUY");
    const b = applyChanges(SRC, [{ op: "remove_condition", rule: 1, match: "crosses above" }]).source;
    expect(b).toContain("    WHEN POSITION.gold = 0\n    THEN BUY gold");
    expect(() => applyChanges(SRC, [{ op: "remove_condition", rule: 3, match: "POSITION.gold > 0" }])).toThrow(/needs a condition/);
  });
});

describe("exclude", () => {
  it("turns dates, weekday names and hours into NOW conditions on entry rules", () => {
    const r = applyChanges(SRC, [{ op: "exclude", dates: ["2026-08-14", "2026/08/15"], weekdays: ["Friday"], hours_utc: [21, 22] }]).source;
    expect(r).toContain("AND NOT (NOW.date_utc IN [20679, 20680])");
    expect(r).toContain("AND NOT (NOW.weekday IN [4])");
    expect(r).toContain("AND NOT (NOW.hour_utc IN [21, 22])");
    expect(r.match(/NOW\.date_utc/g)!.length).toBe(2); // rules 1 and 2, not the exit rule
  });
  it("refuses an impossible date or weekday and changes nothing", () => {
    expect(() => applyChanges(SRC, [{ op: "exclude", dates: ["2026-02-30"] }])).toThrow(/2026-02-30/);
    expect(() => applyChanges(SRC, [{ op: "exclude", weekdays: ["funday"] }])).toThrow(/funday/);
  });
});

describe("rules, symbols, text", () => {
  it("add_rule appends with the file's indentation; remove_rule needs exactly one match", () => {
    const a = applyChanges(SRC, [{ op: "add_rule", source: "WHEN POSITION.gold < 0 AND gold.close > ema(gold.close, 50)\nTHEN CLOSE gold" }]).source;
    expect(a).toMatch(/THEN CLOSE gold\n\n    WHEN POSITION\.gold < 0 AND gold\.close > ema\(gold\.close, 50\)\n    THEN CLOSE gold\n$/);
    expect(() => applyChanges(SRC, [{ op: "remove_rule", match: "POSITION.gold = 0" }])).toThrow(/2 rules match/);
    expect(applyChanges(SRC, [{ op: "remove_rule", match: "THEN CLOSE" }]).source).not.toContain("CLOSE gold");
  });
  it("add_symbol adds a stream line; replace_text needs a unique match", () => {
    expect(applyChanges(SRC, [{ op: "add_symbol", alias: "silver", symbol: "XAGUSD", tf: "15m" }]).source).toContain("    silver = BACKTEST:XAGUSD EVERY 15m\n");
    expect(() => applyChanges(SRC, [{ op: "add_symbol", alias: "gold", symbol: "XAGUSD", tf: "15m" }])).toThrow(/already/);
    expect(() => applyChanges(SRC, [{ op: "replace_text", find: "SIZING 0.1", replace: "SIZING 0.2" }])).toThrow(/2 places/);
  });
  it("refuses portfolio files", () => {
    expect(() => applyChanges("PORTFOLIO p VERSION 1\n\nRULES\n    RUN a\n", [{ op: "set_param", name: "x", value: 1 }])).toThrow(/STRATEGY files/);
  });
});

describe("lineDiff and describeRules", () => {
  it("shows each changed block with its line number", () => {
    const d = lineDiff(SRC, applyChanges(SRC, [{ op: "set_param", name: "fast", value: 12 }]).source);
    expect(d).toBe("@@ line 7\n-PARAM fast = 9\n+PARAM fast = 12\n");
  });
  it("lists rules with whether they enter", () => {
    expect(describeRules(SRC).map((r) => [r.n, r.entry])).toEqual([[1, true], [2, true], [3, false]]);
  });
});
```

- [ ] **Step 2: Run to fail** — `cd packages/core && npx vitest run test/dslops.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/dslops.ts
import { canonicalTf } from "./strategy.js";

export type RuleRef = number | string;
export type Change =
  | { op: "set_bracket"; rule?: RuleRef; stop?: string | number; target?: string | number }
  | { op: "set_param"; name: string; value: string | number | boolean }
  | { op: "set_sizing"; rule?: RuleRef; sizing: string }
  | { op: "add_condition"; rule?: RuleRef; expr: string; mode?: "and" | "or" }
  | { op: "remove_condition"; rule?: RuleRef; match: string }
  | { op: "exclude"; rule?: RuleRef; dates?: string[]; weekdays?: Array<string | number>; hours_utc?: number[]; calendar_window?: [number, number, number, number] }
  | { op: "add_rule"; source: string }
  | { op: "remove_rule"; match: string }
  | { op: "add_symbol"; alias: string; symbol: string; tf: string }
  | { op: "replace_text"; find: string; replace: string }
  | { op: "source"; text: string };

export class ChangeError extends Error {}

interface Rule { n: number; start: number; end: number; when: number; then: number; bracket: [number, number] | null; entry: boolean }
interface Seg { kind: "strategy" | "portfolio" | "unknown"; lines: string[]; rulesLine: number; rules: Rule[]; symbols: [number, number] | null; params: number[] }

const indentOf = (l: string) => /^\s*/.exec(l)![0];
const isTop = (l: string) => /^\S/.test(l) && !/^--/.test(l);
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function segment(src: string): Seg {
  const lines = src.split("\n");
  const first = lines.find((l) => l.trim() && !l.trim().startsWith("--")) ?? "";
  const kind = /^STRATEGY\b/.test(first) ? "strategy" : /^PORTFOLIO\b/.test(first) ? "portfolio" : "unknown";
  const rulesLine = lines.findIndex((l) => /^RULES\b/.test(l));
  const symLine = lines.findIndex((l) => /^SYMBOLS\b/.test(l));
  let symbols: [number, number] | null = null;
  if (symLine >= 0) { let e = symLine + 1; while (e < lines.length && !isTop(lines[e]!)) e++; symbols = [symLine, e]; }
  const params = lines.flatMap((l, i) => (/^PARAM\s/.test(l) ? [i] : []));
  const rules: Rule[] = [];
  if (rulesLine >= 0) {
    let regionEnd = rulesLine + 1;
    while (regionEnd < lines.length && !isTop(lines[regionEnd]!)) regionEnd++;
    const starts: number[] = [];
    for (let i = rulesLine + 1; i < regionEnd; i++) if (/^\s+WHEN\b/.test(lines[i]!)) starts.push(i);
    starts.forEach((s, k) => {
      let end = k + 1 < starts.length ? starts[k + 1]! : regionEnd;
      while (end > s && !lines[end - 1]!.trim()) end--;
      const then = lines.slice(s, end).findIndex((l) => /^\s+THEN\b/.test(l));
      const thenAt = then < 0 ? end : s + then;
      let bracket: [number, number] | null = null;
      for (let i = thenAt; i < end; i++) if (/\bBRACKET\b/.test(lines[i]!)) {
        let depth = 0, j = i;
        for (; j < end; j++) { for (const ch of lines[j]!) { if (ch === "{") depth++; else if (ch === "}") depth--; } if (depth <= 0 && lines[j]!.includes("}")) break; }
        bracket = [i, Math.min(j, end - 1) + 1]; break;
      }
      rules.push({ n: k + 1, start: s, end, when: s, then: thenAt, bracket, entry: /\b(BUY|SELL)\b/.test(lines.slice(thenAt, end).join("\n")) });
    });
  }
  return { kind, lines, rulesLine, rules, symbols, params };
}

export function describeRules(src: string): Array<{ n: number; entry: boolean; text: string }> {
  const g = segment(src);
  return g.rules.map((r) => ({ n: r.n, entry: r.entry, text: g.lines.slice(r.start, r.end).map((l) => l.trim()).join(" ").slice(0, 120) }));
}

function pick(g: Seg, ref: RuleRef | undefined, entryOnly: boolean): Rule[] {
  const list = () => g.rules.map((r) => `${r.n}: ${g.lines[r.when]!.trim().slice(0, 60)}`).join("; ");
  if (ref === undefined) {
    const rs = entryOnly ? g.rules.filter((r) => r.entry) : g.rules;
    if (!rs.length) throw new ChangeError(`no ${entryOnly ? "entry (BUY/SELL) " : ""}rules; rules: ${list()}`);
    return rs;
  }
  if (typeof ref === "number") { const r = g.rules.find((x) => x.n === ref); if (!r) throw new ChangeError(`no rule ${ref}; rules: ${list()}`); return [r]; }
  const rs = g.rules.filter((r) => norm(g.lines.slice(r.start, r.end).join(" ")).includes(norm(ref)));
  if (!rs.length) throw new ChangeError(`no rule matches "${ref}"; rules: ${list()}`);
  return rs;
}

function bracketSpec(v: string | number): string {
  if (typeof v === "number" && v > 0) return `BY ${v}`;
  const s = String(v).trim();
  const pct = /^(?:BY\s+)?(\d+(?:\.\d+)?)\s*(?:%|pct|percent)$/i.exec(s);
  if (pct) return `BY ${pct[1]} PCT`;
  const num = /^(?:BY\s+)?(\d+(?:\.\d+)?)$/i.exec(s);
  if (num) return `BY ${num[1]}`;
  if (/^AT\s+\S/i.test(s)) return `AT ${s.replace(/^AT\s+/i, "")}`;
  if (/^BY\s+\S/i.test(s)) return `BY ${s.replace(/^BY\s+/i, "")}`;
  throw new ChangeError(`cannot read the bracket level "${s}": use a distance (12), a percent ("2%"), "BY <expr>" or "AT <price expression>"`);
}

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function weekdayOf(w: string | number): number {
  if (typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 6) return w;
  const k = String(w).trim().toLowerCase().slice(0, 3), i = WEEKDAYS.indexOf(k);
  if (i < 0 || (String(w).length > 3 && !["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(String(w).trim().toLowerCase()))) throw new ChangeError(`"${w}" is not a weekday (use Monday..Sunday, or 0..6 with Monday = 0)`);
  return i;
}
function epochDay(d: string): number {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(d.trim());
  if (!m) throw new ChangeError(`"${d}" is not a date (use YYYY-MM-DD)`);
  const [y, mo, da] = [+m[1]!, +m[2]!, +m[3]!], t = Date.UTC(y, mo - 1, da), back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) throw new ChangeError(`"${d}" is not a real date`);
  return t / 86_400_000;
}

function addCondition(g: Seg, rules: Rule[], expr: string, mode: "and" | "or"): string[] {
  const lines = [...g.lines];
  for (const r of [...rules].sort((a, b) => b.then - a.then)) {
    const andLine = lines.slice(r.when + 1, r.then).find((l) => /^\s+(AND|OR)\b/.test(l));
    const ind = andLine ? indentOf(andLine) : `${indentOf(lines[r.when]!)} `;
    lines.splice(r.then, 0, `${ind}${mode === "or" ? "OR" : "AND"} ${expr.trim()}`);
  }
  return lines;
}

function apply1(src: string, c: Change, notes: string[]): string {
  const g = segment(src);
  if (c.op === "source") return c.text;
  if (g.kind === "portfolio") throw new ChangeError("change operations work on STRATEGY files; open the child strategy");
  if (c.op === "replace_text") {
    const n = src.split(c.find).length - 1;
    if (n !== 1) throw new ChangeError(n === 0 ? `"${c.find}" is not in the file` : `"${c.find}" is in ${n} places; give more of the surrounding text`);
    return src.replace(c.find, c.replace);
  }
  const lines = [...g.lines];
  switch (c.op) {
    case "set_bracket": {
      if (c.stop === undefined && c.target === undefined) throw new ChangeError("set_bracket needs stop or target");
      const stop = c.stop !== undefined ? bracketSpec(c.stop) : null, target = c.target !== undefined ? bracketSpec(c.target) : null;
      const done: string[] = [];
      for (const r of [...pick(g, c.rule, true)].sort((a, b) => b.start - a.start)) {
        if (r.bracket) {
          const [a, z] = r.bracket, text = lines.slice(a, z).join(" ");
          const inner = /\{([\s\S]*)\}/.exec(text)?.[1] ?? "";
          const parts = splitTop(inner).map((p) => p.replace(/\s+/g, " "));
          const set = (key: string, spec: string | null) => { if (!spec) return; const i = parts.findIndex((p) => p.startsWith(key)); if (i >= 0) parts[i] = `${key} ${spec}`; else parts.push(`${key} ${spec}`); };
          set("STOP_LOSS", stop); set("TAKE_PROFIT", target);
          lines.splice(a, z - a, `${indentOf(lines[a]!)}BRACKET { ${parts.join(", ")} }`);
          done.unshift(`rule ${r.n}`);
        } else {
          const parts = [stop && `STOP_LOSS ${stop}`, target && `TAKE_PROFIT ${target}`].filter(Boolean);
          lines.splice(r.end, 0, `${indentOf(lines[r.then]!)}    BRACKET { ${parts.join(", ")} }`);
          done.unshift(`rule ${r.n} (added a BRACKET)`);
        }
      }
      notes.push(`set_bracket: ${done.join(", ")}`);
      return lines.join("\n");
    }
    case "set_param": {
      if (!/^[A-Za-z_]\w*$/.test(c.name)) throw new ChangeError(`"${c.name}" is not a parameter name`);
      const v = typeof c.value === "string" && !/^-?\d+(\.\d+)?$/.test(c.value) && !/^(true|false)$/.test(c.value) ? `"${c.value.replace(/"/g, "")}"` : String(c.value);
      const at = lines.findIndex((l) => new RegExp(`^PARAM\\s+${c.name}\\s*=`).test(l));
      if (at >= 0) { lines[at] = `PARAM ${c.name} = ${v}`; notes.push(`set_param: ${c.name} = ${v}`); return lines.join("\n"); }
      const after = g.params.length ? g.params[g.params.length - 1]! + 1 : g.rulesLine;
      if (after < 0) throw new ChangeError("no RULES section to put a PARAM before");
      lines.splice(after, 0, ...(g.params.length ? [`PARAM ${c.name} = ${v}`] : [`PARAM ${c.name} = ${v}`, ""]));
      notes.push(`set_param: added ${c.name} = ${v}`);
      return lines.join("\n");
    }
    case "set_sizing": {
      const sizing = c.sizing.replace(/^\s*SIZING\s+/i, "").trim();
      if (!sizing) throw new ChangeError("set_sizing needs a sizing, e.g. 0.1 or \"0.5 PCT RISK\"");
      const rs = pick(g, c.rule, true);
      for (const r of rs) for (let i = r.then; i < r.end; i++) lines[i] = lines[i]!.replace(/\bSIZING\s+.*?(?=\s+BRACKET\b|\s*;|\s*$)/, `SIZING ${sizing}`);
      notes.push(`set_sizing: rules ${rs.map((r) => r.n).join(", ")}`);
      return lines.join("\n");
    }
    case "add_condition": {
      if (!c.expr.trim()) throw new ChangeError("add_condition needs an expression");
      const rs = pick(g, c.rule, true);
      notes.push(`add_condition: rules ${rs.map((r) => r.n).join(", ")}`);
      return addCondition(g, rs, c.expr, c.mode ?? "and").join("\n");
    }
    case "remove_condition": {
      const rs = pick(g, c.rule, false);
      for (const r of [...rs].sort((a, b) => b.start - a.start)) {
        const at = lines.slice(r.when, r.then).findIndex((l) => norm(l).includes(norm(c.match)));
        if (at < 0) throw new ChangeError(`rule ${r.n} has no condition matching "${c.match}"`);
        const i = r.when + at;
        if (i === r.when) {
          if (r.then - r.when < 2) throw new ChangeError(`rule ${r.n} needs a condition: this is its only one`);
          lines[i + 1] = lines[i + 1]!.replace(/^(\s*)(AND|OR)\b/, `${indentOf(lines[i]!)}WHEN`);
        }
        lines.splice(i, 1);
      }
      notes.push(`remove_condition: rules ${rs.map((r) => r.n).join(", ")}`);
      return lines.join("\n");
    }
    case "exclude": {
      const exprs: string[] = [];
      if (c.dates?.length) exprs.push(`NOT (NOW.date_utc IN [${c.dates.map(epochDay).join(", ")}])`);
      if (c.weekdays?.length) exprs.push(`NOT (NOW.weekday IN [${[...new Set(c.weekdays.map(weekdayOf))].sort().join(", ")}])`);
      if (c.hours_utc?.length) {
        for (const h of c.hours_utc) if (!Number.isInteger(h) || h < 0 || h > 23) throw new ChangeError(`${h} is not an hour (0-23 UTC)`);
        exprs.push(`NOT (NOW.hour_utc IN [${[...new Set(c.hours_utc)].sort((a, b) => a - b).join(", ")}])`);
      }
      if (c.calendar_window) exprs.push(`NOT CALENDAR_WINDOW(${c.calendar_window.join(", ")})`);
      if (!exprs.length) throw new ChangeError("exclude needs dates, weekdays, hours_utc or calendar_window");
      let cur = src;
      for (const e of exprs) { const gg = segment(cur); cur = addCondition(gg, pick(gg, c.rule, true), e, "and").join("\n"); }
      notes.push(`exclude: ${exprs.join(" AND ")} on entry rules (exits still happen on those days)`);
      return cur;
    }
    case "add_rule": {
      const body = c.source.replace(/\s+$/, "").split("\n");
      if (!/^\s*WHEN\b/.test(body[0] ?? "")) throw new ChangeError("a rule starts with WHEN");
      if (g.rulesLine < 0) throw new ChangeError("no RULES section");
      const minInd = Math.min(...body.filter((l) => l.trim()).map((l) => indentOf(l).length));
      const ind = g.rules.length ? indentOf(lines[g.rules[0]!.when]!) : "    ";
      const shaped = body.map((l) => (l.trim() ? ind + l.slice(minInd) : ""));
      const at = g.rules.length ? g.rules[g.rules.length - 1]!.end : g.rulesLine + 1;
      lines.splice(at, 0, "", ...shaped.map((l, i) => (i > 0 && /^\s*(AND|OR)\b/.test(l) ? ` ${l}` : l)));
      notes.push(`add_rule: rule ${g.rules.length + 1}`);
      return lines.join("\n");
    }
    case "remove_rule": {
      const rs = g.rules.filter((r) => norm(lines.slice(r.start, r.end).join(" ")).includes(norm(c.match)));
      if (rs.length !== 1) throw new ChangeError(rs.length ? `${rs.length} rules match "${c.match}": give text only one of them has` : `no rule matches "${c.match}"`);
      const r = rs[0]!, blankBefore = r.start > 0 && !lines[r.start - 1]!.trim() ? 1 : 0;
      lines.splice(r.start - blankBefore, r.end - r.start + blankBefore);
      notes.push(`remove_rule: rule ${r.n}`);
      return lines.join("\n");
    }
    case "add_symbol": {
      if (!/^[A-Za-z_]\w*$/.test(c.alias)) throw new ChangeError(`"${c.alias}" is not an alias name`);
      if (!g.symbols) throw new ChangeError("no SYMBOLS section");
      const [a, z] = g.symbols;
      if (lines.slice(a + 1, z).some((l) => new RegExp(`^\\s+${c.alias}\\s*=`).test(l))) throw new ChangeError(`alias "${c.alias}" is already declared`);
      const tf = canonicalTf(c.tf);
      if (!tf) throw new ChangeError(`"${c.tf}" is not a timeframe (1m 5m 15m 30m 1h 4h 1d)`);
      const sym = c.symbol.includes(":") ? c.symbol : `BACKTEST:${c.symbol}`;
      let last = z - 1; while (last > a && !lines[last]!.trim()) last--;
      lines.splice(last + 1, 0, `    ${c.alias} = ${sym} EVERY ${tf}`);
      notes.push(`add_symbol: ${c.alias} = ${sym} EVERY ${tf}`);
      return lines.join("\n");
    }
  }
}

/** Apply operations in order. Atomic: any error throws ChangeError and the caller keeps the original text. */
export function applyChanges(source: string, changes: Change[]): { source: string; notes: string[] } {
  const notes: string[] = [];
  let cur = source;
  for (const c of changes) cur = apply1(cur, c, notes);
  return { source: cur, notes };
}

/** What changed, block by block: `@@ line N` (N = first changed line of the original), removed lines, then added lines. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n"), n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));   // LCS table; strategy files are small
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let out = "", i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    const at = i + 1, del: string[] = [], add: string[] = [];
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) add.push(b[j++]!); else del.push(a[i++]!);
    }
    out += `@@ line ${at}\n${del.map((l) => `-${l}\n`).join("")}${add.map((l) => `+${l}\n`).join("")}`;
  }
  return out;
}
```

Add `export * from "./dslops.js";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run** — `npx vitest run test/dslops.test.ts` — Expected: PASS. Then `npx tsc -p .` — Expected: no errors.

- [ ] **Step 5: Verify real qkt accepts every operation's output** (a unit test proves text; this proves the DSL)

```ts
// append to packages/server/test/cheatsheet.test.ts
import { applyChanges } from "@qkt-studio/core";
it("every change operation produces DSL that qkt parses", async () => {
  const base = "STRATEGY t VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n    fx = BACKTEST:NZDUSD EVERY 4h\n\nPARAM fast = 9\n\nRULES\n    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, 21)\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n\n    WHEN POSITION.gold > 0 AND gold.close < ema(gold.close, 50)\n    THEN CLOSE gold\n";
  const out = applyChanges(base, [
    { op: "set_bracket", stop: "2%", target: 4 }, { op: "set_param", name: "fast", value: 12 }, { op: "set_sizing", sizing: "0.5 PCT RISK" },
    { op: "add_condition", expr: "ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)" }, { op: "exclude", dates: ["2026-08-14"], weekdays: ["fri"], hours_utc: [21] },
    { op: "add_symbol", alias: "silver", symbol: "XAGUSD", tf: "15m" }, { op: "add_rule", source: "WHEN POSITION.silver = 0 AND silver.close > 0\nTHEN BUY silver SIZING 0.1" },
  ]).source;
  expect((await checkQktSource(testConfig("/tmp"), out)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
});
```

Run: `cd packages/server && npx vitest run test/cheatsheet.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/dslops.ts packages/core/src/index.ts packages/core/test/dslops.test.ts packages/server/test/cheatsheet.test.ts
git commit -m "feat(core): DSL change operations - brackets, params, sizing, conditions, exclusions, rules, symbols"
```

---

### Task 7: Proposals and authoring tools

Tools never edit an existing file; they create proposals the user applies. New strategy files are created directly.

**Files:**
- Create: `packages/server/src/agent/proposals.ts`, `packages/server/src/mcp/schemas.ts`, `packages/server/src/mcp/tools-authoring.ts`
- Modify: `packages/server/src/main.ts` (construct + routes), `packages/server/src/mcp/util.ts` (`ToolCtx.proposals`), `packages/server/src/mcp/index.ts`
- Test: `packages/server/test/mcp/tools.test.ts` (add)

**Interfaces:**
- Consumes: `applyChanges`, `lineDiff`, `ChangeError`, `checkConfig` (core); `checkQktSource` (Task 1); `EventBus` (Task 2); `resolveInJail`; `Jobs.buildBars`.
- Produces:
  - `interface Proposal { id: string; kind: "file" | "job"; title: string; path?: string; before?: string; after?: string; diff?: string; job?: { symbol: string; tf: string; from: string; to: string }; created: string; status: "open" | "applied" | "rejected" | "stale" }`
  - `class Proposals { constructor(cfg: ServerConfig, events: EventBus, jobs: Jobs); init(): Promise<void>; create(p: Omit<Proposal, "id" | "created" | "status">): Promise<Proposal>; list(): Proposal[]; apply(id: string): Promise<Proposal>; reject(id: string): Promise<Proposal> }` — persisted in `.qkt-studio/proposals.json` (last 50); `apply` of a file proposal throws `ProposalStale` (HTTP 409) when the file's text is no longer `before`.
  - Routes: `GET /api/proposals`, `POST /api/proposals/:id/apply`, `POST /api/proposals/:id/reject`.
  - `changeSchema` (zod discriminated union over `Change`, in `mcp/schemas.ts`), reused by Task 9.
  - Tools: `check_strategy(source, path?)`, `create_strategy(name, source, dir?)`, `propose_strategy_edit(path, changes)`, `get_config()`, `propose_config(set: Record<string, unknown>, unset?: string[])`, `get_instrument(symbol)`, `propose_instrument(symbol, fields)`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/server/test/mcp/tools.test.ts
describe("authoring tools", () => {
  it("check, create, and propose edits that only a user apply writes", async () => {
    const c = await mcpClient(base, "t0k");
    const bad = await call(c, "check_strategy", { source: "STRATEGY x VERSION 1\n\nRULES\n    WHEN\n" });
    expect(bad.json.ok).toBe(false);
    const created = await call(c, "create_strategy", { name: "rsi_dip", source: "STRATEGY rsi_dip VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN rsi(gold.close, 14) CROSSES ABOVE 30\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n" });
    expect(created.json.path).toBe("strategies/rsi_dip.qkt");
    expect((await call(c, "create_strategy", { name: "rsi_dip", source: "STRATEGY rsi_dip VERSION 1\n" })).isError).toBe(true); // never overwrites
    const before = readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8");
    const p = await call(c, "propose_strategy_edit", { path: "strategies/rsi_dip.qkt", changes: [{ op: "set_bracket", stop: "1%", target: "2%" }] });
    expect(p.json.diff).toMatch(/\+\s+BRACKET \{ STOP_LOSS BY 1 PCT, TAKE_PROFIT BY 2 PCT \}/);
    expect(readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8")).toBe(before); // nothing written yet
    const hdr = { Authorization: "Bearer t0k" };
    expect((await fetch(`${base}/api/proposals/${p.json.proposalId}/apply`, { method: "POST", headers: hdr })).status).toBe(200);
    expect(readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8")).toMatch(/STOP_LOSS BY 1 PCT/);
    // a proposal made on text the user has since changed is refused as stale
    const p2 = await call(c, "propose_strategy_edit", { path: "strategies/rsi_dip.qkt", changes: [{ op: "set_param", name: "n", value: 3 }] });
    writeFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), `${readFileSync(path.join(ws, "strategies", "rsi_dip.qkt"), "utf8")}\n-- edited\n`);
    expect((await fetch(`${base}/api/proposals/${p2.json.proposalId}/apply`, { method: "POST", headers: hdr })).status).toBe(409);
    await c.close();
  });
  it("proposes config and instrument changes, validated, keeping comments", async () => {
    writeFileSync(path.join(ws, "qkt.config.yaml"), "# my config\nstarting_balance: 10000 # keep\nrisk:\n  max_daily_loss: \"1000\"\n");
    const c = await mcpClient(base, "t0k");
    const p = await call(c, "propose_config", { set: { "risk.max_daily_loss": "0", "execution.position_mode": "netting" } });
    expect(p.json.diff).toMatch(/\+\s+max_daily_loss: "0"/);
    expect((await call(c, "propose_config", { set: { "not_a_key": 1 } })).json.warnings.join(" ")).toMatch(/Unknown top-level key/);
    const pi = await call(c, "propose_instrument", { symbol: "XAGUSD", fields: { contractSize: 5000, volumeStep: 0.01 } });
    expect(pi.json.diff).toMatch(/\+\s+- qktSymbol: BACKTEST:XAGUSD/);
    await c.close();
  });
});
```

Add `import { readFileSync } from "node:fs";` to the test file's imports.

Run: `npx vitest run test/mcp/tools.test.ts -t "authoring"` — Expected: FAIL (`Tool check_strategy not found`).

- [ ] **Step 2: Implement `agent/proposals.ts`**

```ts
// packages/server/src/agent/proposals.ts
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "../config.js";
import type { EventBus } from "./events.js";
import type { Jobs } from "../jobs.js";
import { resolveInJail } from "../jail.js";

export interface Proposal {
  id: string; kind: "file" | "job"; title: string;
  path?: string; before?: string; after?: string; diff?: string;
  job?: { symbol: string; tf: string; from: string; to: string };
  created: string; status: "open" | "applied" | "rejected" | "stale";
}
export class ProposalStale extends Error {}

/** Changes a tool wants to make to the user's files (or a data job to start), applied only by the user's click. */
export class Proposals {
  private items: Proposal[] = [];
  private file: string;
  constructor(private cfg: ServerConfig, private events: EventBus, private jobs: Jobs) { this.file = path.join(cfg.workspace, ".qkt-studio", "proposals.json"); }
  async init(): Promise<void> { try { this.items = JSON.parse(await fs.readFile(this.file, "utf8")) as Proposal[]; } catch { this.items = []; } }
  private async save(): Promise<void> {
    this.items = this.items.slice(-50);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.items));
    await fs.rename(`${this.file}.tmp`, this.file);
  }
  list(): Proposal[] { return [...this.items].reverse(); }
  get(id: string): Proposal | undefined { return this.items.find((p) => p.id === id); }
  async create(p: Omit<Proposal, "id" | "created" | "status">): Promise<Proposal> {
    const full: Proposal = { ...p, id: randomBytes(6).toString("hex"), created: new Date().toISOString(), status: "open" };
    this.items.push(full);
    await this.save();
    this.events.emit({ t: "proposal", id: full.id });
    return full;
  }
  async apply(id: string): Promise<Proposal> {
    const p = this.get(id);
    if (!p || p.status !== "open") throw new Error(p ? `proposal is ${p.status}` : "no such proposal");
    if (p.kind === "file") {
      const abs = await resolveInJail(this.cfg.workspace, p.path!);
      const cur = await fs.readFile(abs, "utf8").catch(() => "");
      if (cur !== p.before) { p.status = "stale"; await this.save(); throw new ProposalStale(`${p.path} changed since this was proposed; ask again on the current text`); }
      await fs.writeFile(abs, p.after!);
    } else if (p.job) {
      await this.jobs.buildBars(p.job);
    }
    p.status = "applied";
    await this.save();
    this.events.emit({ t: "proposal", id });
    return p;
  }
  async reject(id: string): Promise<Proposal> {
    const p = this.get(id);
    if (!p) throw new Error("no such proposal");
    p.status = "rejected";
    await this.save();
    this.events.emit({ t: "proposal", id });
    return p;
  }
}

export function registerProposalRoutes(app: FastifyInstance, proposals: Proposals): void {
  app.get("/api/proposals", async () => ({ proposals: proposals.list() }));
  app.post<{ Params: { id: string } }>("/api/proposals/:id/apply", async (req, reply) => {
    try { return await proposals.apply(req.params.id); }
    catch (e) { return reply.code(e instanceof ProposalStale ? 409 : 400).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>("/api/proposals/:id/reject", async (req, reply) => {
    try { return await proposals.reject(req.params.id); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
}
```

In `main.ts`: `const proposals = new Proposals(cfg, events, jobs); await proposals.init();`, register `registerProposalRoutes(a, proposals)`, add `proposals` to the `ToolCtx` passed to `registerMcp` and to `createStudio`'s return. Add `proposals: Proposals` to `ToolCtx` in `mcp/util.ts`.

- [ ] **Step 3: Implement the change schema**

```ts
// packages/server/src/mcp/schemas.ts
import { z } from "zod";
const rule = z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("rule number (1-based) or text in the rule; default: every BUY/SELL rule");
const level = z.union([z.number().positive(), z.string()]).optional();
/** The operations of @qkt-studio/core `Change`, as the model sees them. */
export const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_bracket"), rule, stop: level, target: level }),
  z.object({ op: z.literal("set_param"), name: z.string(), value: z.union([z.number(), z.string(), z.boolean()]) }),
  z.object({ op: z.literal("set_sizing"), rule, sizing: z.string() }),
  z.object({ op: z.literal("add_condition"), rule, expr: z.string(), mode: z.enum(["and", "or"]).optional() }),
  z.object({ op: z.literal("remove_condition"), rule, match: z.string() }),
  z.object({ op: z.literal("exclude"), rule, dates: z.array(z.string()).optional(), weekdays: z.array(z.union([z.string(), z.number().int()])).optional(), hours_utc: z.array(z.number().int()).optional(), calendar_window: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).optional() }),
  z.object({ op: z.literal("add_rule"), source: z.string() }),
  z.object({ op: z.literal("remove_rule"), match: z.string() }),
  z.object({ op: z.literal("add_symbol"), alias: z.string(), symbol: z.string(), tf: z.string() }),
  z.object({ op: z.literal("replace_text"), find: z.string(), replace: z.string() }),
  z.object({ op: z.literal("source"), text: z.string() }),
]);
export const changesSchema = z.array(changeSchema).min(1).max(20).describe("operations applied in order; see dsl_reference for expressions");
```

- [ ] **Step 4: Implement the authoring tools**

```ts
// packages/server/src/mcp/tools-authoring.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyChanges, checkConfig, lineDiff, type Change } from "@qkt-studio/core";
import { checkQktSource } from "../check.js";
import { resolveInJail } from "../jail.js";
import { changesSchema } from "./schemas.js";
import { instrumentEntry } from "./tools-knowledge.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const brief = (ds: Array<{ severity: string; line: number; message: string; code: string }>) => ds.map((d) => ({ severity: d.severity, line: d.line, code: d.code, message: d.message }));

export function registerAuthoringTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("check_strategy", { description: "Parse and lint strategy source without saving: ok, or the exact errors and warnings with line numbers.", inputSchema: { source: z.string(), path: z.string().optional() } },
    ({ source, path: rel }) => guard(async () => { const r = await checkQktSource(ctx.cfg, source, rel); return ok({ ok: r.ok, diagnostics: brief(r.diagnostics) }); }));

  s.registerTool("create_strategy", { description: "Create a NEW strategy file (never overwrites). The source must pass check_strategy. Opens it in the editor.", inputSchema: { name: z.string(), source: z.string(), dir: z.string().optional() } },
    ({ name, source, dir }) => guard(async () => {
      const slug = name.replace(/\.qkt$/i, "").replace(/[^\w.-]+/g, "_");
      const rel = `${(dir ?? "strategies").replace(/\/+$/, "")}/${slug}.qkt`;
      const abs = await resolveInJail(ctx.cfg.workspace, rel);
      const r = await checkQktSource(ctx.cfg, source, rel);
      if (!r.ok) return fail(`not created, the source does not parse: ${JSON.stringify(brief(r.diagnostics))}`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try { await fs.writeFile(abs, source.endsWith("\n") ? source : `${source}\n`, { flag: "wx" }); }
      catch { return fail(`${rel} already exists; pick another name, or change it with propose_strategy_edit / try_change`); }
      ctx.events.emit({ t: "open", path: rel });
      return ok({ path: rel, warnings: brief(r.diagnostics) });
    }));

  s.registerTool("propose_strategy_edit", { description: "Propose changes to an existing strategy as a diff the user applies. For trying a change and seeing results, use try_change instead.", inputSchema: { path: z.string(), changes: changesSchema } },
    ({ path: rel, changes }) => guard(async () => {
      const abs = await resolveInJail(ctx.cfg.workspace, rel);
      const before = await fs.readFile(abs, "utf8");
      const { source: after, notes } = applyChanges(before, changes as Change[]);
      const r = await checkQktSource(ctx.cfg, after, rel);
      if (!r.ok) return fail(`the change would not parse: ${JSON.stringify(brief(r.diagnostics))}`);
      const diff = lineDiff(before, after);
      const p = await ctx.proposals.create({ kind: "file", title: `Edit ${rel}: ${notes.join("; ")}`, path: rel, before, after, diff });
      return ok({ proposalId: p.id, diff, notes, warnings: brief(r.diagnostics), next: "the user applies or rejects it in the studio" });
    }));

  const yamlTool = (file: string) => async (mutate: (doc: ReturnType<typeof parseDocument>) => void, title: string) => {
    const abs = path.join(ctx.cfg.workspace, file);
    const before = await fs.readFile(abs, "utf8").catch(() => "");
    const doc = parseDocument(before);
    mutate(doc);
    const after = doc.toString();
    const warnings = file === "qkt.config.yaml" ? checkConfig(after, true, { QKT_DATA_HOME: ctx.cfg.dataRoot }).map((f) => f.message) : [];
    const diff = lineDiff(before, after);
    if (!diff) return fail("no change: the file already has those values");
    const p = await ctx.proposals.create({ kind: "file", title, path: file, before, after, diff });
    return ok({ proposalId: p.id, diff, warnings });
  };
  const keyPath = (k: string) => k.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : x));

  s.registerTool("get_config", { description: "The workspace's qkt.config.yaml as it is now." },
    () => guard(async () => ({ content: [{ type: "text", text: await fs.readFile(path.join(ctx.cfg.workspace, "qkt.config.yaml"), "utf8").catch(() => "(no qkt.config.yaml)") }] })));
  s.registerTool("propose_config", { description: "Propose qkt.config.yaml changes: set dotted keys (risk.max_daily_loss) and/or unset keys; comments are kept; validated.", inputSchema: { set: z.record(z.unknown()).optional(), unset: z.array(z.string()).optional() } },
    ({ set, unset }) => guard(() => yamlTool("qkt.config.yaml")((doc) => {
      for (const [k, v] of Object.entries(set ?? {})) doc.setIn(keyPath(k), v);
      for (const k of unset ?? []) doc.deleteIn(keyPath(k));
    }, `Config: ${[...Object.keys(set ?? {}), ...(unset ?? []).map((k) => `-${k}`)].join(", ")}`)));
  s.registerTool("get_instrument", { description: "A symbol's entry in instruments.yaml, or that it has none.", inputSchema: { symbol: z.string() } },
    ({ symbol }) => guard(async () => ok({ symbol, entry: await instrumentEntry(ctx.cfg.workspace, symbol) })));
  s.registerTool("propose_instrument", { description: "Propose adding or changing a symbol's instruments.yaml entry (contractSize, volumeStep, commissionPerLot...).", inputSchema: { symbol: z.string(), fields: z.record(z.union([z.number(), z.string(), z.boolean()])) } },
    ({ symbol, fields }) => guard(() => yamlTool("instruments.yaml")((doc) => {
      // `instruments:` is a list of entries keyed by qktSymbol (see instrumentsTemplate in scaffold.ts)
      const want = symbol.includes(":") ? symbol : `BACKTEST:${symbol}`;
      if (!doc.has("instruments")) doc.set("instruments", doc.createNode([]));
      const items = (doc.toJSON() as { instruments?: Array<Record<string, unknown>> }).instruments ?? [];
      const i = items.findIndex((e) => e.qktSymbol === want);
      if (i >= 0) for (const [k, v] of Object.entries(fields)) doc.setIn(["instruments", i, k], v);
      else doc.addIn(["instruments"], doc.createNode({ qktSymbol: want, ...fields }));
    }, `Instrument ${symbol}: ${Object.keys(fields).join(", ")}`)));
}
```

Register `registerAuthoringTools(s, ctx)` in `buildMcp`.

- [ ] **Step 5: Run** — `npx vitest run test/mcp/tools.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(mcp): authoring tools - check, create strategies, and proposals for strategy, config and instrument changes"
```

---

### Task 8: The split

**Files:**
- Create: `packages/core/src/split.ts`, `packages/server/src/split.ts`
- Modify: `packages/core/src/index.ts`, `packages/server/src/settings.ts` (`split` field), `packages/server/src/main.ts`, `packages/server/src/mcp/index.ts`
- Test: `packages/core/test/split.test.ts`, `packages/server/test/mcp/tools.test.ts` (add)

**Interfaces:**
- Consumes: `RoundTrip`, `analyze` is not needed (small own stats).
- Produces (core):
  - `type Split = { none: true } | { test_pct: number } | { test_last: string } | { test_from: string }`; `DEFAULT_SPLIT: Split = { test_pct: 25 }`.
  - `parseSplit(x: unknown): Split` (throws `Error` with the reason on anything else; `test_pct` 5..95; `test_last` like `"3 months"`, `"2 weeks"`, `"10 days"`; `test_from` ISO date).
  - `splitCut(split: Split, from: string, to: string): number | null` — ms where the test part starts, `null` for none or a cut outside `(from, to)`.
  - `interface PartStats { from: string; to: string; trades: number; net: number; winRate: number | null; profitFactor: number | null; avgR: number | null }`
  - `partsOf(trips: RoundTrip[], from: string, to: string, split: Split): { split: Split; cut: string | null; first: PartStats; test: PartStats | null }`
  - `describeSplit(split: Split): string` — e.g. `"test = last 25 %"`, `"test = last 3 months"`, `"test from 2026-07-01"`, `"no split"`.
- Produces (server): `getSplit(cfg): Promise<Split>`, `GET /api/split`, `PUT /api/split`, `GET /api/runs/:id/parts`; tools `get_split()`, `set_split(split)`.

- [ ] **Step 1: Write the failing core tests**

```ts
// packages/core/test/split.test.ts
import { describe, it, expect } from "vitest";
import { parseSplit, splitCut, partsOf, describeSplit } from "../src/split.js";
import type { RoundTrip } from "../src/roundtrips.js";

const t = (id: number, exitIso: string, pnl: number): RoundTrip => ({ id, strategy: "s", symbol: "X", side: "long", entryTs: Date.parse(exitIso) - 3_600_000, entryPx: 1, exitTs: Date.parse(exitIso), exitPx: 1, qty: 1, pnl, fills: 2, holdMs: 3_600_000, open: false, exit: pnl > 0 ? "target" : "stop", r: pnl > 0 ? 2 : -1 });

describe("split", () => {
  it("parses the four forms and refuses the rest", () => {
    expect(parseSplit({ test_pct: 25 })).toEqual({ test_pct: 25 });
    expect(parseSplit({ test_last: "3 months" })).toEqual({ test_last: "3 months" });
    expect(parseSplit({ test_from: "2026-07-01" })).toEqual({ test_from: "2026-07-01" });
    expect(parseSplit({ none: true })).toEqual({ none: true });
    expect(() => parseSplit({ test_pct: 99 })).toThrow(/5 and 95/);
    expect(() => parseSplit({ test_last: "soon" })).toThrow(/days, weeks or months/);
  });
  it("finds the cut inside the window", () => {
    expect(new Date(splitCut({ test_pct: 25 }, "2026-01-01", "2026-05-01")!).toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(new Date(splitCut({ test_last: "1 months" }, "2026-01-01", "2026-05-01")!).toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(splitCut({ none: true }, "2026-01-01", "2026-05-01")).toBeNull();
    expect(splitCut({ test_from: "2027-01-01" }, "2026-01-01", "2026-05-01")).toBeNull();
  });
  it("splits trades by exit time, and a part with no trades has zeros and nulls, never NaN", () => {
    const trips = [t(1, "2026-01-10T10:00:00Z", 5), t(2, "2026-02-10T10:00:00Z", -2), t(3, "2026-04-10T10:00:00Z", 4)];
    const p = partsOf(trips, "2026-01-01", "2026-05-01", { test_last: "1 months" });
    expect(p.first).toMatchObject({ trades: 2, net: 3, winRate: 0.5 });
    expect(p.test).toMatchObject({ trades: 1, net: 4, winRate: 1 });
    const empty = partsOf(trips.slice(0, 2), "2026-01-01", "2026-05-01", { test_last: "1 months" });
    expect(empty.test).toEqual({ from: "2026-04-01", to: "2026-05-01", trades: 0, net: 0, winRate: null, profitFactor: null, avgR: null });
    expect(JSON.stringify(empty)).not.toMatch(/NaN/);
    expect(describeSplit({ test_last: "3 months" })).toBe("test = last 3 months");
  });
});
```

Run: `cd packages/core && npx vitest run test/split.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement core `split.ts`**

```ts
// packages/core/src/split.ts
import type { RoundTrip } from "./roundtrips.js";

export type Split = { none: true } | { test_pct: number } | { test_last: string } | { test_from: string };
export const DEFAULT_SPLIT: Split = { test_pct: 25 };
export interface PartStats { from: string; to: string; trades: number; net: number; winRate: number | null; profitFactor: number | null; avgR: number | null }

const DAY = 86_400_000;
const LAST = /^(\d{1,3})\s*(day|week|month)s?$/i;

export function parseSplit(x: unknown): Split {
  const o = (x ?? {}) as Record<string, unknown>;
  if (o.none === true) return { none: true };
  if (typeof o.test_pct === "number") { if (o.test_pct < 5 || o.test_pct > 95) throw new Error("test_pct must be between 5 and 95"); return { test_pct: o.test_pct }; }
  if (typeof o.test_last === "string") { if (!LAST.test(o.test_last.trim())) throw new Error(`test_last "${o.test_last}": use a number of days, weeks or months, e.g. "3 months"`); return { test_last: o.test_last.trim() }; }
  if (typeof o.test_from === "string") { if (!/^\d{4}-\d{2}-\d{2}$/.test(o.test_from) || Number.isNaN(Date.parse(`${o.test_from}T00:00:00Z`))) throw new Error(`test_from "${o.test_from}" is not a YYYY-MM-DD date`); return { test_from: o.test_from }; }
  throw new Error('a split is {"none": true}, {"test_pct": 25}, {"test_last": "3 months"} or {"test_from": "2026-07-01"}');
}

export function splitCut(split: Split, from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`), z = Date.parse(`${to}T00:00:00Z`);
  let cut: number | null = null;
  if ("test_pct" in split) cut = a + Math.round(((z - a) * (100 - split.test_pct)) / 100 / DAY) * DAY;
  else if ("test_last" in split) {
    const [, n, unit] = LAST.exec(split.test_last)!;
    const d = new Date(z);
    if (/month/i.test(unit!)) d.setUTCMonth(d.getUTCMonth() - Number(n)); else d.setUTCDate(d.getUTCDate() - Number(n) * (/week/i.test(unit!) ? 7 : 1));
    cut = d.getTime();
  } else if ("test_from" in split) cut = Date.parse(`${split.test_from}T00:00:00Z`);
  return cut !== null && cut > a && cut < z ? cut : null;
}

function stats(trips: RoundTrip[], from: string, to: string): PartStats {
  const closed = trips.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const rs = closed.filter((t) => typeof t.r === "number").map((t) => t.r!);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { from, to, trades: closed.length, net: r6(closed.reduce((s, t) => s + t.pnl, 0)),
    winRate: closed.length ? r6(wins.length / closed.length) : null, profitFactor: gl > 0 ? r6(gw / gl) : null, avgR: rs.length ? r6(rs.reduce((s, x) => s + x, 0) / rs.length) : null };
}

export function partsOf(trips: RoundTrip[], from: string, to: string, split: Split): { split: Split; cut: string | null; first: PartStats; test: PartStats | null } {
  const cut = splitCut(split, from, to);
  if (cut === null) return { split, cut: null, first: stats(trips, from, to), test: null };
  const cutIso = new Date(cut).toISOString().slice(0, 10);
  const at = (t: RoundTrip) => t.exitTs ?? t.entryTs;
  return { split, cut: cutIso, first: stats(trips.filter((t) => at(t) < cut), from, cutIso), test: stats(trips.filter((t) => at(t) >= cut), cutIso, to) };
}

export function describeSplit(split: Split): string {
  if ("none" in split) return "no split";
  if ("test_pct" in split) return `test = last ${split.test_pct} %`;
  if ("test_last" in split) return `test = last ${split.test_last}`;
  return `test from ${split.test_from}`;
}
```

Export from `packages/core/src/index.ts`. Run: `npx vitest run test/split.test.ts` — Expected: PASS.

- [ ] **Step 3: Server: setting, routes, tools — failing test first**

```ts
// append to packages/server/test/mcp/tools.test.ts
describe("the split", () => {
  it("is readable and changeable from tools and the API, and announced to the UI", async () => {
    const c = await mcpClient(base, "t0k");
    expect((await call(c, "get_split")).json).toMatchObject({ split: { test_pct: 25 }, text: "test = last 25 %" });
    const seen: string[] = [];
    const off = studio.events.subscribe((e) => seen.push(e.t));
    expect((await call(c, "set_split", { split: { test_last: "2 months" } })).json.text).toBe("test = last 2 months");
    off();
    expect(seen).toContain("split");
    const r = await fetch(`${base}/api/split`, { headers: { Authorization: "Bearer t0k" } });
    expect(await r.json()).toMatchObject({ split: { test_last: "2 months" } });
    expect((await call(c, "set_split", { split: { test_pct: 1 } })).isError).toBe(true);
    await call(c, "set_split", { split: { test_pct: 25 } });
    await c.close();
  });
});
```

Run: `cd packages/server && npx vitest run test/mcp/tools.test.ts -t "split"` — Expected: FAIL.

- [ ] **Step 4: Implement server split**

In `settings.ts`, add `split?: Split` to `StudioSettings` (import `type Split` from core).

```ts
// packages/server/src/split.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SPLIT, describeSplit, parseSplit, partsOf, type Split } from "@qkt-studio/core";
import type { ServerConfig } from "./config.js";
import { loadSettings, saveSettings } from "./settings.js";
import type { EventBus } from "./agent/events.js";
import type { RunData } from "./run-data.js";
import { ok, guard, type ToolCtx } from "./mcp/util.js";

export async function getSplit(cfg: ServerConfig): Promise<Split> { return (await loadSettings(cfg)).split ?? DEFAULT_SPLIT; }
export async function setSplit(cfg: ServerConfig, events: EventBus, x: unknown): Promise<Split> {
  const split = parseSplit(x);
  const s = await loadSettings(cfg);
  await saveSettings(cfg, { ...s, split });
  events.emit({ t: "split" });
  return split;
}

export function registerSplitRoutes(app: FastifyInstance, cfg: ServerConfig, events: EventBus, data: RunData): void {
  app.get("/api/split", async () => { const split = await getSplit(cfg); return { split, text: describeSplit(split) }; });
  app.put<{ Body: unknown }>("/api/split", async (req, reply) => {
    try { const split = await setSplit(cfg, events, req.body); return { split, text: describeSplit(split) }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  /** A run's trades divided by the split (no re-run: trades are grouped by exit time). */
  app.get<{ Params: { id: string } }>("/api/runs/:id/parts", async (req, reply) => {
    const [run, trips] = [await data.run(req.params.id), await data.trips(req.params.id)];
    if (!run || !trips) return reply.code(404).send({ error: "run has no trades" });
    return partsOf(trips, run.from, run.to, await getSplit(cfg));
  });
}

export function registerSplitTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("get_split", { description: "The split of backtest windows into a first part and a test part (the user's setting)." },
    () => guard(async () => { const split = await getSplit(ctx.cfg); return ok({ split, text: describeSplit(split) }); }));
  s.registerTool("set_split", { description: 'Change the split: {"test_pct": 25}, {"test_last": "3 months"}, {"test_from": "2026-07-01"} or {"none": true}. Every view updates.', inputSchema: { split: z.record(z.unknown()) } },
    ({ split }) => guard(async () => { const next = await setSplit(ctx.cfg, ctx.events, split); return ok({ split: next, text: describeSplit(next) }); }));
}
```

Register routes in `main.ts` (`registerSplitRoutes(a, cfg, events, data)`) and tools in `buildMcp` (`registerSplitTools(s, ctx)`).

- [ ] **Step 5: Run** — `cd packages/server && npx vitest run test/mcp/tools.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/split.ts packages/core/src/index.ts packages/core/test/split.test.ts packages/server/src packages/server/test
git commit -m "feat: the split - a user setting that divides every run into a first part and a test part"
```

---

### Task 9: Try a change: variants, their runs, and the comparison

**Files:**
- Create: `packages/server/src/agent/variants.ts`, `packages/server/src/mcp/tools-try.ts`
- Modify: `packages/server/src/main.ts`, `packages/server/src/mcp/util.ts` (`ToolCtx.variants`), `packages/server/src/mcp/index.ts`
- Test: `packages/server/test/mcp/tools.test.ts` (add; real runs, skipped without the local data store)

**Interfaces:**
- Consumes: `applyChanges`, `lineDiff`, `partsOf` (core); `checkQktSource`; `Runner.submit/waitFor/list`; `RunData`; `getSplit` (Task 8); `EventBus`; `changesSchema` (Task 7).
- Produces:
  - `interface Variant { id: string; label: string; base: string; baseText: string; path: string; changes: Change[]; diff: string; notes: string[]; created: string; window: { from: string; to: string; tier: Tier }; runId: string | null; baseRunId: string | null }`
  - `class Variants { constructor(cfg, runner, data, events); init(); create(base: string, label: string, changes: Change[], window: Variant["window"]): Promise<Variant>; run(v: Variant): Promise<Variant>; list(base?: string): Variant[]; get(id): Variant | undefined; discard(id): Promise<void> }` — files under `.qkt-studio/variants/<id>/<slug>.qkt`, index in `.qkt-studio/variants/index.json`.
  - `compareVariant(ctx: ToolCtx, v: Variant): Promise<{ variant: VariantResult; base: VariantResult }>` with `VariantResult = { runId: string; status: string; error?: string; net: number | null; trades: number | null; winRate: number | null; profitFactor: number | null; maxDrawdown: number | null; parts: ReturnType<typeof partsOf> | null }`.
  - Routes: `GET /api/variants?base=`, `GET /api/variants/:id` (includes `source`), `DELETE /api/variants/:id`.
  - Tools: `try_change(changes, base?, label?, from?, to?, tier?)`, `try_variants(variants: [{label, changes}], base?, from?, to?, tier?)`, `list_variants(base?)`, `discard_variant(id)`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/server/test/mcp/tools.test.ts
describe.skipIf(!haveData)("try_change", () => {
  it("runs the change on a copy, compares it with the base, announces it, and never touches the base file", async () => {
    const s3 = await createStudio(testConfig(ws, { token: "t0k", dataRoot: realData }));
    await s3.app.listen({ port: 0, host: "127.0.0.1" });
    const b3 = `http://127.0.0.1:${(s3.app.server.address() as { port: number }).port}`;
    const file = path.join(ws, "strategies", "trybase.qkt");
    writeFileSync(file, "STRATEGY trybase VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nRULES\n    WHEN ema(gold.close, 9) CROSSES ABOVE ema(gold.close, 21)\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n        BRACKET { STOP_LOSS BY 5, TAKE_PROFIT BY 20 }\n");
    const before = readFileSync(file, "utf8");
    const seen: Array<{ t: string }> = [];
    s3.events.subscribe((e) => seen.push(e));
    const c = await mcpClient(b3, "t0k");
    const r = await call(c, "try_change", { base: "strategies/trybase.qkt", changes: [{ op: "set_bracket", target: 5 }], from: "2024-10-01", to: "2024-10-15", tier: "draft" });
    expect(r.isError).toBe(false);
    expect(r.json.diff).toMatch(/TAKE_PROFIT BY 5/);
    expect(r.json.variant.status).toBe("done");
    expect(r.json.base.status).toBe("done");
    expect(r.json.variant.trades).toBeGreaterThan(0);
    expect(r.json.variant.parts.first).toBeDefined();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(seen.some((e) => e.t === "variant")).toBe(true);
    // the user saves a new version meanwhile: the next try builds on the new text, the old variant keeps its own copy
    writeFileSync(file, before.replace("ema(gold.close, 9)", "ema(gold.close, 12)"));
    const r2 = await call(c, "try_change", { base: "strategies/trybase.qkt", changes: [{ op: "set_bracket", stop: 8 }], from: "2024-10-01", to: "2024-10-15", tier: "draft" });
    const v1 = await (await fetch(`${b3}/api/variants/${r.json.variantId}`, { headers: { Authorization: "Bearer t0k" } })).json();
    const v2 = await (await fetch(`${b3}/api/variants/${r2.json.variantId}`, { headers: { Authorization: "Bearer t0k" } })).json();
    expect(v1.source).toMatch(/ema\(gold\.close, 9\)/);
    expect(v2.source).toMatch(/ema\(gold\.close, 12\)/);
    const bad = await call(c, "try_change", { base: "strategies/trybase.qkt", changes: [{ op: "set_bracket", stop: "a lot" }] });
    expect(bad.isError).toBe(true);
    await c.close(); await s3.app.close();
  }, 240_000);
});
```

Run: `npx vitest run test/mcp/tools.test.ts -t "try_change"` — Expected: FAIL (`Tool try_change not found`).

- [ ] **Step 2: Implement `agent/variants.ts`**

```ts
// packages/server/src/agent/variants.ts
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyChanges, lineDiff, type Change, type Tier } from "@qkt-studio/core";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { EventBus } from "./events.js";
import { checkQktSource } from "../check.js";
import { resolveInJail } from "../jail.js";

export interface Variant {
  id: string; label: string; base: string; baseText: string; path: string; changes: Change[]; diff: string; notes: string[];
  created: string; window: { from: string; to: string; tier: Tier }; runId: string | null; baseRunId: string | null;
}

const DIR = ".qkt-studio/variants";
const WAIT_MS = 180_000;

/** Copies of a strategy with changes applied, each run beside its base; the user adopts one or discards it. */
export class Variants {
  private items: Variant[] = [];
  constructor(private cfg: ServerConfig, private runner: Runner, private events: EventBus) {}
  private index() { return path.join(this.cfg.workspace, DIR, "index.json"); }
  async init(): Promise<void> { try { this.items = JSON.parse(await fs.readFile(this.index(), "utf8")) as Variant[]; } catch { this.items = []; } }
  private async save(): Promise<void> {
    await fs.mkdir(path.join(this.cfg.workspace, DIR), { recursive: true });
    this.items = this.items.slice(-200);
    await fs.writeFile(`${this.index()}.tmp`, JSON.stringify(this.items));
    await fs.rename(`${this.index()}.tmp`, this.index());
  }
  list(base?: string): Variant[] { return this.items.filter((v) => !base || v.base === base).slice().reverse(); }
  get(id: string): Variant | undefined { return this.items.find((v) => v.id === id); }

  /** The base text is read now: a save by the user after this call does not change this variant. */
  async create(base: string, label: string, changes: Change[], window: Variant["window"]): Promise<Variant> {
    const baseAbs = await resolveInJail(this.cfg.workspace, base);
    const baseText = await fs.readFile(baseAbs, "utf8");
    const { source, notes } = applyChanges(baseText, changes);
    const check = await checkQktSource(this.cfg, source, base);
    if (!check.ok) throw new Error(`the change does not parse: ${check.diagnostics.filter((d) => d.severity === "error").map((d) => `line ${d.line}: ${d.message}`).join("; ")}`);
    const id = randomBytes(5).toString("hex");
    const slug = path.basename(base, ".qkt");
    const rel = `${DIR}/${id}/${slug}.qkt`;
    await fs.mkdir(path.join(this.cfg.workspace, DIR, id), { recursive: true });
    await fs.writeFile(path.join(this.cfg.workspace, rel), source);
    const v: Variant = { id, label, base, baseText, path: rel, changes, diff: lineDiff(baseText, source), notes: [...notes, ...check.diagnostics.filter((d) => d.severity !== "error").map((d) => `warning line ${d.line}: ${d.message}`)], created: new Date().toISOString(), window, runId: null, baseRunId: null };
    this.items.push(v);
    await this.save();
    return v;
  }

  /** Run the variant and its base on the same window (the base run is cached when it already exists). */
  async run(v: Variant): Promise<Variant> {
    const req = { from: v.window.from, to: v.window.to, tier: v.window.tier };
    const [a, b] = await Promise.all([this.runner.submit({ ...req, strategy: v.path }), this.runner.submit({ ...req, strategy: v.base })]);
    v.runId = a.runId; v.baseRunId = b.runId;
    await this.save();
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS));
    await Promise.race([Promise.all([this.runner.waitFor(a.runId), this.runner.waitFor(b.runId)]), timeout]);
    this.events.emit({ t: "variant", variantId: v.id, runId: a.runId });
    return v;
  }

  async discard(id: string): Promise<void> {
    const v = this.get(id);
    if (!v) throw new Error("no such variant");
    await fs.rm(path.join(this.cfg.workspace, DIR, id), { recursive: true, force: true });
    this.items = this.items.filter((x) => x.id !== id);
    await this.save();
  }
}

export function registerVariantRoutes(app: FastifyInstance, cfg: ServerConfig, variants: Variants): void {
  app.get<{ Querystring: { base?: string } }>("/api/variants", async (req) => ({ variants: variants.list(req.query.base).map(({ baseText: _b, ...v }) => v) }));
  app.get<{ Params: { id: string } }>("/api/variants/:id", async (req, reply) => {
    const v = variants.get(req.params.id);
    if (!v) return reply.code(404).send({ error: "no such variant" });
    const { baseText: _b, ...rest } = v;
    return { ...rest, source: await fs.readFile(path.join(cfg.workspace, v.path), "utf8").catch(() => null) };
  });
  app.delete<{ Params: { id: string } }>("/api/variants/:id", async (req, reply) => {
    try { await variants.discard(req.params.id); return reply.code(204).send(); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });
}
```

The runner accepts any `.qkt` inside the workspace, including under `.qkt-studio/` (`resolveInJail` only refuses absolute paths, NUL and escapes), so variants need no runner change.

- [ ] **Step 3: Implement the tools**

```ts
// packages/server/src/mcp/tools-try.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { partsOf, type Change, type Tier } from "@qkt-studio/core";
import { getSplit } from "../split.js";
import type { Variant } from "../agent/variants.js";
import { changesSchema } from "./schemas.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const winArgs = { from: z.string().optional(), to: z.string().optional(), tier: z.enum(["draft", "full"]).optional().describe("draft = bars (fast, default), full = ticks") };

/** The window to run on: given, else the run on screen, else the base's newest run. */
async function windowFor(ctx: ToolCtx, base: string, a: { from?: string; to?: string; tier?: Tier }): Promise<Variant["window"]> {
  const v = ctx.view.get();
  const newest = ctx.runner.list(base, 5)[0];
  const from = a.from ?? v.runWindow?.from ?? newest?.from_d, to = a.to ?? v.runWindow?.to ?? newest?.to_d;
  if (!from || !to) throw new Error("no window: give from/to (YYYY-MM-DD), or run the strategy once first");
  return { from, to, tier: a.tier ?? "draft" };
}
const baseOf = (ctx: ToolCtx, base?: string) => { const b = base ?? ctx.view.get().openFile; if (!b || !b.endsWith(".qkt")) throw new Error("no strategy: give base, or open one in the editor"); return b; };

export async function compareVariant(ctx: ToolCtx, v: Variant) {
  const split = await getSplit(ctx.cfg);
  const one = async (id: string | null) => {
    if (!id) return null;
    const run = await ctx.data.run(id);
    if (!run) return null;
    const [sm, trips] = run.status === "done" ? [await ctx.data.summary(id), await ctx.data.trips(id)] : [null, null];
    return { runId: id, status: run.status, error: run.error?.message, net: sm?.totalPnl ?? null, trades: sm?.trades ?? null, winRate: sm?.winRate ?? null, profitFactor: sm?.profitFactor ?? null, maxDrawdown: sm?.maxDrawdown ?? null, parts: trips ? partsOf(trips, run.from, run.to, split) : null };
  };
  return { variant: await one(v.runId), base: await one(v.baseRunId) };
}

export function registerTryTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("try_change", { description: "Apply changes to a copy of the strategy, run it and its base on the same window, show it on the user's chart, and return both results. The user's file is untouched.", inputSchema: { changes: changesSchema, base: z.string().optional(), label: z.string().optional(), ...winArgs } },
    (a) => guard(async () => {
      const base = baseOf(ctx, a.base);
      const v = await ctx.variants.create(base, a.label ?? (a.changes as Change[]).map((c) => c.op).join(", "), a.changes as Change[], await windowFor(ctx, base, a));
      await ctx.variants.run(v);
      return ok({ variantId: v.id, label: v.label, diff: v.diff, notes: v.notes, ...(await compareVariant(ctx, v)), shown: "on the user's chart; they can Adopt, Discard or go back" });
    }));
  s.registerTool("try_variants", { description: "Several labelled alternatives at once (e.g. stop 1, 2, 3 %), each run beside the base; returns a comparison table.", inputSchema: { variants: z.array(z.object({ label: z.string(), changes: changesSchema })).min(2).max(6), base: z.string().optional(), ...winArgs } },
    (a) => guard(async () => {
      const base = baseOf(ctx, a.base), window = await windowFor(ctx, base, a);
      const made = [];
      for (const x of a.variants) made.push(await ctx.variants.create(base, x.label, x.changes as Change[], window));
      await Promise.all(made.map((v) => ctx.variants.run(v)));
      const rows = [];
      for (const v of made) rows.push({ variantId: v.id, label: v.label, ...(await compareVariant(ctx, v)).variant });
      return ok({ base: (await compareVariant(ctx, made[0]!)).base, variants: rows });
    }));
  s.registerTool("list_variants", { description: "Variants tried so far (newest first), optionally for one strategy.", inputSchema: { base: z.string().optional() } },
    ({ base }) => guard(async () => ok(ctx.variants.list(base).slice(0, 20).map((v) => ({ id: v.id, label: v.label, base: v.base, runId: v.runId, created: v.created })))));
  s.registerTool("discard_variant", { description: "Delete a variant copy (its runs stay in the run history).", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => { await ctx.variants.discard(id); return ok({ discarded: id }); }));
}
```

Add `variants: Variants` to `ToolCtx`; in `main.ts` construct `const variants = new Variants(cfg, runner, events); await variants.init();`, register `registerVariantRoutes(a, cfg, variants)`, pass it in the tool context; register `registerTryTools(s, ctx)` in `buildMcp`. `fail` is imported for symmetry with the other groups; remove it if the linter flags it unused.

- [ ] **Step 4: Run** — `cd packages/server && npx vitest run` — Expected: PASS (whole server suite).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(mcp): try_change - run a change on a copy beside its base, compared on the split, shown to the user"
```

---

### Task 10: Run and job tools (backtest, walk-forward, sweep, status, cancel, data job proposals)

**Files:**
- Create: `packages/server/src/mcp/tools-runs.ts`
- Modify: `packages/server/src/mcp/index.ts`
- Test: `packages/server/test/mcp/tools.test.ts` (add)

**Interfaces:**
- Consumes: `Runner.submit/waitFor/cancel`, `Jobs.grid/walkForward/get/cancel`, `compareVariant` is not used; `partsOf`, `getSplit`, `Proposals.create`.
- Produces tools: `run_backtest(path?, from?, to?, tier?, params?)`, `run_walkforward(path?, from, to, params, train, test, step)`, `sweep(path?, params, from?, to?)`, `job_status(id)`, `cancel(id)`, `propose_build_bars(symbol, tf, from, to)`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/server/test/mcp/tools.test.ts
describe.skipIf(!haveData)("run and job tools", () => {
  it("run_backtest waits and reports; sweep returns first-part numbers only; data jobs are proposals", async () => {
    const s4 = await createStudio(testConfig(ws, { token: "t0k", dataRoot: realData }));
    await s4.app.listen({ port: 0, host: "127.0.0.1" });
    const c = await mcpClient(`http://127.0.0.1:${(s4.app.server.address() as { port: number }).port}`, "t0k");
    writeFileSync(path.join(ws, "strategies", "sw.qkt"), "STRATEGY sw VERSION 1\n\nSYMBOLS\n    gold = BACKTEST:XAUUSD EVERY 15m\n\nPARAM fast = 9\n\nRULES\n    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, 21)\n     AND POSITION.gold = 0\n    THEN BUY gold SIZING 0.1\n        BRACKET { STOP_LOSS BY 5, TAKE_PROFIT BY 10 }\n");
    const r = await call(c, "run_backtest", { path: "strategies/sw.qkt", from: "2024-10-01", to: "2024-10-15" });
    expect(r.json.status).toBe("done");
    const sw = await call(c, "sweep", { path: "strategies/sw.qkt", params: { fast: ["5", "9"] }, from: "2024-10-01", to: "2024-10-15" });
    let st = await call(c, "job_status", { id: sw.json.jobId });
    for (let i = 0; i < 60 && st.json.status === "running"; i++) { await new Promise((z) => setTimeout(z, 2000)); st = await call(c, "job_status", { id: sw.json.jobId }); }
    expect(st.json.status).toBe("done");
    expect(st.json.rows[0].first).toBeDefined();
    expect(st.json.rows[0].test).toBeUndefined(); // the model tunes on the first part only
    const pb = await call(c, "propose_build_bars", { symbol: "XAUUSD", tf: "15m", from: "2024-10-01", to: "2024-10-02" });
    expect(pb.json.proposalId).toBeTruthy();
    await c.close(); await s4.app.close();
  }, 300_000);
});
```

Run: `npx vitest run test/mcp/tools.test.ts -t "run and job"` — Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
// packages/server/src/mcp/tools-runs.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { partsOf, type Tier } from "@qkt-studio/core";
import { getSplit } from "../split.js";
import { ok, fail, guard, type ToolCtx } from "./util.js";

const pathOf = (ctx: ToolCtx, p?: string) => { const x = p ?? ctx.view.get().openFile; if (!x?.endsWith(".qkt")) throw new Error("no strategy: give path, or open one in the editor"); return x; };
const windowOf = (ctx: ToolCtx, p: string, from?: string, to?: string) => {
  const v = ctx.view.get(), newest = ctx.runner.list(p, 5)[0];
  const f = from ?? v.runWindow?.from ?? newest?.from_d, t = to ?? v.runWindow?.to ?? newest?.to_d;
  if (!f || !t) throw new Error("no window: give from/to (YYYY-MM-DD), or run the strategy once first");
  return { from: f, to: t };
};

export function registerRunTools(s: McpServer, ctx: ToolCtx): void {
  s.registerTool("run_backtest", { description: "Run a strategy as the Run button does (it shows on the chart when it is the open file); waits up to 3 minutes.", inputSchema: { path: z.string().optional(), from: z.string().optional(), to: z.string().optional(), tier: z.enum(["draft", "full"]).optional(), params: z.record(z.string()).optional() } },
    (a) => guard(async () => {
      const p = pathOf(ctx, a.path), w = windowOf(ctx, p, a.from, a.to);
      const { runId, cached } = await ctx.runner.submit({ strategy: p, ...w, tier: (a.tier ?? "draft") as Tier, params: a.params });
      const run = await Promise.race([ctx.runner.waitFor(runId), new Promise<null>((r) => setTimeout(() => r(null), 180_000))]);
      ctx.events.emit({ t: "run", runId });
      if (!run) return ok({ runId, status: "running", note: "still running; ask get_run later" });
      const sm = run.status === "done" ? await ctx.data.summary(runId) : null;
      return ok({ runId, cached, status: run.status, error: run.error?.message, net: sm?.totalPnl, trades: sm?.trades, winRate: sm?.winRate, profitFactor: sm?.profitFactor, maxDrawdown: sm?.maxDrawdown });
    }));
  s.registerTool("run_walkforward", { description: "Walk-forward test (the Lab's): optimise params on rolling train windows, test on the next; returns a job id.", inputSchema: { path: z.string().optional(), from: z.string(), to: z.string(), params: z.record(z.array(z.string())), train: z.string().describe("e.g. 90d"), test: z.string().describe("e.g. 30d"), step: z.string().describe("e.g. 30d") } },
    (a) => guard(async () => ok({ jobId: (await ctx.jobs.walkForward({ strategy: pathOf(ctx, a.path), from: a.from, to: a.to, tier: "draft", params: a.params, train: a.train, test: a.test, step: a.step })).id })));
  s.registerTool("sweep", { description: "Grid over params (the Lab grid). The job's rows give you the FIRST part of the split only; the user sees both.", inputSchema: { path: z.string().optional(), params: z.record(z.array(z.string())), from: z.string().optional(), to: z.string().optional() } },
    (a) => guard(async () => { const p = pathOf(ctx, a.path); return ok({ jobId: (await ctx.jobs.grid({ strategy: p, ...windowOf(ctx, p, a.from, a.to), tier: "draft", params: a.params })).id }); }));
  s.registerTool("job_status", { description: "Progress and results of a job (sweep, walk-forward, data build).", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => {
      const j = ctx.jobs.get(id);
      if (!j) return fail(`no job ${id}`);
      const base = { id, kind: j.kind, status: j.status, progress: j.progress, error: j.error?.message };
      if (j.kind !== "grid" || j.status !== "done") return ok({ ...base, log: j.log.slice(-5) });
      const split = await getSplit(ctx.cfg);
      const rows = [];
      for (const r of ((j.result as { rows?: Array<{ params: Record<string, string>; runId?: string; status: string }> })?.rows ?? []).slice(0, 30)) {
        const run = r.runId ? await ctx.data.run(r.runId) : null, trips = r.runId ? await ctx.data.trips(r.runId) : null;
        const parts = run && trips ? partsOf(trips, run.from, run.to, split) : null;
        rows.push({ params: r.params, runId: r.runId, status: r.status, first: parts?.first ?? null }); // the test part is for the user's eyes
      }
      return ok({ ...base, split: split, rows });
    }));
  s.registerTool("cancel", { description: "Stop a run or job the tools started.", inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => ok({ cancelled: (await ctx.runner.cancel(id, { purge: true })) || (await ctx.jobs.cancel(id)) })));
  s.registerTool("propose_build_bars", { description: "Propose building bars from ticks for a symbol and timeframe; the user starts the job.", inputSchema: { symbol: z.string(), tf: z.string(), from: z.string(), to: z.string() } },
    (a) => guard(async () => { const p = await ctx.proposals.create({ kind: "job", title: `Build ${a.symbol} ${a.tf} bars ${a.from} to ${a.to}`, job: { symbol: a.symbol.replace(/^.*:/, ""), tf: a.tf, from: a.from, to: a.to } }); return ok({ proposalId: p.id }); }));
}
```

(`Job` in `jobs.ts` has `id, kind, status, log, progress?, result?, error?`; a grid's `kind` is `"grid"`.) Register `registerRunTools(s, ctx)` in `buildMcp`.

- [ ] **Step 3: Run** — `cd packages/server && npx vitest run test/mcp/tools.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/mcp packages/server/test
git commit -m "feat(mcp): run, walk-forward, sweep and job tools; data builds as proposals"
```

---

### Task 11: UI - agent state, reported view, and the variant bar with Adopt

**Files:**
- Create: `packages/web/src/state/agent.ts`, `packages/web/src/preview/VariantBar.tsx`
- Modify: `packages/web/src/api/client.ts` (export `withToken`; add calls), `packages/web/src/shell/App.tsx` (start the agent slice), `packages/web/src/preview/PreviewPane.tsx` (render the bar), `packages/web/src/state/store.ts` (report view changes)
- Test: `packages/web/src/state/agent.test.ts`; browser check in Task 14

**Interfaces:**
- Consumes: `GET /api/events`, `POST /api/view`, `GET /api/variants`, `GET /api/variants/:id`, `DELETE /api/variants/:id`, `GET /api/runs/:id/parts`, `GET /api/split` (Tasks 2, 8, 9); store's `selectRun(id)`, `openFile(path)`, `saveFile(path)`, `openFiles`, `results`.
- Produces:
  - `useAgent` (Zustand): `{ variants: VariantInfo[]; showing: VariantInfo | null; split: { split: Split; text: string } | null; proposals: ProposalInfo[]; start(): void; show(v: VariantInfo): Promise<void>; back(): Promise<void>; discard(id: string): Promise<void>; adopt(id: string): Promise<void>; refresh(): Promise<void> }`.
  - `viewReport(state): View` pure mapping from the store to the `POST /api/view` body (tested).

- [ ] **Step 1: Write the failing unit test**

```ts
// packages/web/src/state/agent.test.ts
import { describe, it, expect } from "vitest";
import { viewReport } from "./agent.js";

describe("viewReport", () => {
  it("maps what the user looks at into the server's view state", () => {
    const v = viewReport({ activePath: "strategies/ema.qkt", cursorLine: 12, selection: "", runId: "r1", cfg: { from: "2026-08-01", to: "2026-09-01", tier: "draft" }, visible: { from: 1, to: 2 }, selectedTripId: 7, variantId: null });
    expect(v).toEqual({ openFile: "strategies/ema.qkt", cursorLine: 12, selection: null, runId: "r1", runWindow: { from: "2026-08-01", to: "2026-09-01", tier: "draft" }, visibleFrom: 1, visibleTo: 2, selectedTrade: 7, variantId: null });
  });
});
```

Run: `cd packages/web && npx vitest run src/state/agent.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement the agent slice**

```ts
// packages/web/src/state/agent.ts
import { create } from "zustand";
import { api, withToken } from "../api/client.js";
import { useStore } from "./store.js";

export interface VariantInfo { id: string; label: string; base: string; runId: string | null; baseRunId: string | null; diff: string; notes: string[]; created: string }
export interface ProposalInfo { id: string; kind: "file" | "job"; title: string; path?: string; diff?: string; status: string; created: string }
type Split = Record<string, unknown>;

/** Pure: the store's view -> the body of POST /api/view. */
export function viewReport(s: { activePath: string | null; cursorLine: number | null; selection: string; runId: string | null; cfg: { from: string; to: string; tier: string }; visible: { from: number; to: number } | null; selectedTripId: number | null; variantId: string | null }) {
  return { openFile: s.activePath, cursorLine: s.cursorLine, selection: s.selection || null, runId: s.runId, runWindow: { from: s.cfg.from, to: s.cfg.to, tier: s.cfg.tier },
    visibleFrom: s.visible?.from ?? null, visibleTo: s.visible?.to ?? null, selectedTrade: s.selectedTripId, variantId: s.variantId };
}

export const useAgent = create<{
  variants: VariantInfo[]; showing: VariantInfo | null; split: { split: Split; text: string } | null; proposals: ProposalInfo[];
  start(): void; refresh(): Promise<void>; show(v: VariantInfo): Promise<void>; back(): Promise<void>; discard(id: string): Promise<void>; adopt(id: string): Promise<void>;
}>((set, get) => ({
  variants: [], showing: null, split: null, proposals: [],
  start() {
    void get().refresh();
    const es = new EventSource(withToken("/api/events"));
    es.addEventListener("variant", (m) => { const e = JSON.parse((m as MessageEvent).data) as { variantId: string }; void get().refresh().then(() => { const v = get().variants.find((x) => x.id === e.variantId); if (v) void get().show(v); }); });
    es.addEventListener("proposal", () => void get().refresh());
    es.addEventListener("split", () => void get().refresh());
    es.addEventListener("open", (m) => void useStore.getState().openFile((JSON.parse((m as MessageEvent).data) as { path: string }).path));
    es.addEventListener("run", (m) => { const e = JSON.parse((m as MessageEvent).data) as { runId: string }; void useStore.getState().refreshRuns(); if (useStore.getState().running === false) void useStore.getState().selectRun(e.runId); });
  },
  async refresh() {
    const [v, p, s] = await Promise.all([api.variants(), api.proposals(), api.split()]);
    set({ variants: v.variants, proposals: p.proposals, split: s });
  },
  async show(v) { set({ showing: v }); if (v.runId) await useStore.getState().selectRun(v.runId); },
  async back() { const v = get().showing; set({ showing: null }); if (v?.baseRunId) await useStore.getState().selectRun(v.baseRunId); },
  async discard(id) { await api.discardVariant(id); if (get().showing?.id === id) await get().back(); await get().refresh(); },
  /** Adopt = the variant's text becomes the base file, as ONE edit in the editor (so Ctrl+Z undoes it), then saved. */
  async adopt(id) {
    const v = await api.variant(id);
    if (!v.source) throw new Error("the variant file is gone");
    const store = useStore.getState();
    await store.openFile(v.base);
    const ed = (window as unknown as { __qktEditor?: { getModel(): { getFullModelRange(): unknown; uri: { path: string } } | null; executeEdits(src: string, edits: Array<{ range: unknown; text: string }>): void; pushUndoStop(): void } }).__qktEditor;
    const model = ed?.getModel();
    if (ed && model) { ed.pushUndoStop(); ed.executeEdits("adopt", [{ range: model.getFullModelRange(), text: v.source }]); ed.pushUndoStop(); }
    else store.setContent(v.base, v.source);
    await store.saveFile(v.base);
    set({ showing: null });
    await store.startRun();
  },
}));
```

(The store has `selectRun`, `openFile`, `setContent`, `saveFile`, `refreshRuns`, `startRun`, `running`; the editor branch is the normal path, `setContent` the fallback when no editor is mounted.) In `api/client.ts`: change `const withToken` to `export const withToken`, and add:

```ts
  variants: () => req<{ variants: import("../state/agent.js").VariantInfo[] }>("/api/variants"),
  variant: (id: string) => req<import("../state/agent.js").VariantInfo & { source: string | null }>(`/api/variants/${encodeURIComponent(id)}`),
  discardVariant: (id: string) => req<void>(`/api/variants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  proposals: () => req<{ proposals: import("../state/agent.js").ProposalInfo[] }>("/api/proposals"),
  applyProposal: (id: string) => req<unknown>(`/api/proposals/${encodeURIComponent(id)}/apply`, { method: "POST" }),
  rejectProposal: (id: string) => req<unknown>(`/api/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  split: () => req<{ split: Record<string, unknown>; text: string }>("/api/split"),
  setSplit: (split: Record<string, unknown>) => req<{ split: Record<string, unknown>; text: string }>("/api/split", { method: "PUT", body: JSON.stringify(split) }),
  runParts: (id: string) => req<{ cut: string | null; first: PartStats; test: PartStats | null }>(`/api/runs/${encodeURIComponent(id)}/parts`),
  reportView: (v: unknown) => req<unknown>("/api/view", { method: "POST", body: JSON.stringify(v) }),
```

with `export interface PartStats { from: string; to: string; trades: number; net: number; winRate: number | null; profitFactor: number | null; avgR: number | null }` in the same file.

- [ ] **Step 3: Report the view from the store** — in `App.tsx` (inside the shell, once): `useEffect(() => { useAgent.getState().start(); }, []);` and a debounced reporter:

```ts
useEffect(() => {
  let t: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    const s = useStore.getState();
    // cursor and selection live in the editor, not the store
    const ed = (window as unknown as { __qktEditor?: { getPosition(): { lineNumber: number } | null; getSelection(): unknown; getModel(): { getValueInRange(r: unknown): string } | null } }).__qktEditor;
    const sel = ed?.getSelection(), model = ed?.getModel();
    void api.reportView(viewReport({ activePath: s.activePath, cursorLine: ed?.getPosition()?.lineNumber ?? null, selection: sel && model ? model.getValueInRange(sel) : "", runId: s.runId, cfg: s.cfg,
      visible: s.focus ? { from: s.focus.from, to: s.focus.to } : null, selectedTripId: s.selectedTrip?.id ?? null, variantId: useAgent.getState().showing?.id ?? null })).catch(() => undefined);
  };
  const unsub = useStore.subscribe(() => { if (t) clearTimeout(t); t = setTimeout(send, 400); });
  send();
  return () => { unsub(); if (t) clearTimeout(t); };
}, []);
```

(Store fields used: `activePath`, `runId`, `cfg`, `focus` (the chart's visible range), `selectedTrip`.) Editor cursor moves do not change the store, so also call `send` from the editor's `onDidChangeCursorPosition` (debounced the same way) in `EditorPane.tsx`.

- [ ] **Step 4: The variant bar**

```tsx
// packages/web/src/preview/VariantBar.tsx
import { useEffect, useState } from "react";
import { api, type PartStats } from "../api/client.js";
import { useAgent } from "../state/agent.js";
import { fmtMoney } from "../util/format.js";

/** Above the chart while a variant's run is shown: what changed, how it compares, and Adopt / Discard / Back. */
export function VariantBar() {
  const showing = useAgent((s) => s.showing), variants = useAgent((s) => s.variants), split = useAgent((s) => s.split);
  const [nums, setNums] = useState<{ v: { first: PartStats; test: PartStats | null } | null; b: { first: PartStats; test: PartStats | null } | null }>({ v: null, b: null });
  useEffect(() => {
    if (!showing?.runId) return;
    void Promise.all([api.runParts(showing.runId).catch(() => null), showing.baseRunId ? api.runParts(showing.baseRunId).catch(() => null) : null]).then(([v, b]) => setNums({ v, b }));
  }, [showing?.runId, showing?.baseRunId, split?.text]);
  if (!showing) return null;
  const siblings = variants.filter((x) => x.base === showing.base).slice(0, 6);
  const net = (p: { first: PartStats; test: PartStats | null } | null) => (p ? p.first.net + (p.test?.net ?? 0) : null);
  return (
    <div className="banner info variant-bar" role="status">
      <b>Variant: {showing.label}</b>
      <span className="num">net {fmtMoney(net(nums.v) ?? 0)} vs {fmtMoney(net(nums.b) ?? 0)}</span>
      {nums.v?.test && nums.b?.test && <span className="num muted">(test part {fmtMoney(nums.v.test.net)} vs {fmtMoney(nums.b.test.net)} · {split?.text})</span>}
      {siblings.length > 1 && (
        <select className="select sm" aria-label="Other variants" value={showing.id} onChange={(e) => { const v = siblings.find((x) => x.id === e.target.value); if (v) void useAgent.getState().show(v); }}>
          {siblings.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      )}
      <span className="grow" />
      <button className="btn sm primary" onClick={() => void useAgent.getState().adopt(showing.id)}>Adopt</button>
      <button className="btn sm" onClick={() => void useAgent.getState().discard(showing.id)}>Discard</button>
      <button className="btn sm ghost" onClick={() => void useAgent.getState().back()}>Back to original</button>
    </div>
  );
}
```

Render `<VariantBar />` in `PreviewPane.tsx` directly above the KPI row. Add to the stylesheet next to `.banner` rules: `.variant-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }`.

- [ ] **Step 5: Run the unit test and build** — `cd packages/web && npx vitest run src/state/agent.test.ts && npx tsc --noEmit -p . && cd ../.. && pnpm -r build` — Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): variant bar with Adopt, Discard and Back; the browser reports what the user is looking at"
```

---

### Task 12: UI - proposals

**Files:**
- Create: `packages/web/src/shell/Proposals.tsx`
- Modify: `packages/web/src/shell/TopBar.tsx` (a "Proposals (n)" button when any are open), `packages/web/src/shell/App.tsx`

**Interfaces:**
- Consumes: `useAgent().proposals`, `api.applyProposal`, `api.rejectProposal` (Task 11); `Popover` (`ui/Popover.tsx`); `openFile`, `refreshTree` from the store.
- Produces: `<ProposalsButton />` in the top bar.

- [ ] **Step 1: Implement**

```tsx
// packages/web/src/shell/Proposals.tsx
import { useRef, useState } from "react";
import { api } from "../api/client.js";
import { useAgent } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";

/** Changes a tool proposed (a strategy edit, a config or instrument change, a data job): review the diff, Apply or Reject. */
export function ProposalsButton() {
  const open = useAgent((s) => s.proposals.filter((p) => p.status === "open"));
  const [show, setShow] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!open.length) return null;
  const act = async (id: string, apply: boolean, path?: string) => {
    try {
      if (apply) {
        await api.applyProposal(id);
        if (path) {
          // the file changed on disk: an open tab takes the new text as its saved state (no conflict banner)
          await useStore.getState().refreshTree("");
          if (useStore.getState().openFiles.some((f) => f.path === path)) {
            const r = await api.readFile(path);
            useStore.setState((st) => ({ openFiles: st.openFiles.map((f) => (f.path === path ? { ...f, content: r.content, saved: r.content, etag: r.etag, conflict: false } : f)) }));
          }
        }
      }
      else await api.rejectProposal(id);
    } catch (e) { useStore.getState().toast("error", (e as Error).message); }
    await useAgent.getState().refresh();
  };
  return (
    <>
      <button ref={btn} className="btn sm" aria-haspopup="dialog" aria-expanded={show} onClick={() => setShow(!show)}>Proposals ({open.length})</button>
      <Popover open={show} onClose={() => setShow(false)} anchor={btn} align="end" width={520} label="Proposed changes">
        <div className="settings-sec">
          {open.map((p) => (
            <div key={p.id} className="proposal">
              <div className="row" style={{ gap: 6 }}><b className="grow">{p.title}</b>
                <button className="btn sm primary" onClick={() => void act(p.id, true, p.path)}>{p.kind === "job" ? "Start" : "Apply"}</button>
                <button className="btn sm ghost" onClick={() => void act(p.id, false)}>Reject</button>
              </div>
              {p.diff && <pre className="diff mono">{p.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}</pre>}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
```

CSS beside the other popover rules: `.proposal { border-top: 1px solid var(--line); padding: 8px 0; } .diff { font-size: 12px; max-height: 240px; overflow: auto; margin: 6px 0 0; } .diff .add { color: var(--ok); } .diff .del { color: var(--danger); } .diff .hunk { color: var(--ink-3); }`. Place `<ProposalsButton />` in `TopBar.tsx` just before the run controls.

- [ ] **Step 2: Typecheck and build** — `cd packages/web && npx tsc --noEmit -p . && cd ../.. && pnpm -r build` — Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): proposed changes with their diff, Apply and Reject"
```

---

### Task 13: UI - the split chip and the test part on the chart

**Files:**
- Create: `packages/web/src/preview/SplitChip.tsx`, `packages/web/src/charts/SplitPrimitive.ts`
- Modify: `packages/web/src/preview/PreviewPane.tsx` (chip in the header), `packages/web/src/preview/Charts.tsx` (attach the primitive to each price chart)

**Interfaces:**
- Consumes: `useAgent().split`, `api.setSplit`, `api.runParts` (Task 11); lightweight-charts `ISeriesPrimitive` (pattern: `charts/TradesPrimitive.ts`).
- Produces: `<SplitChip />`; `class SplitPrimitive implements ISeriesPrimitive<Time> { setCut(ms: number | null): void }`.

- [ ] **Step 1: The chip**

```tsx
// packages/web/src/preview/SplitChip.tsx
import { useRef, useState } from "react";
import { api } from "../api/client.js";
import { useAgent } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";

const PRESETS: Array<{ label: string; split: Record<string, unknown> }> = [
  { label: "No split", split: { none: true } }, { label: "Test = last 25 %", split: { test_pct: 25 } }, { label: "Test = last 30 %", split: { test_pct: 30 } },
  { label: "Test = last 1 month", split: { test_last: "1 months" } }, { label: "Test = last 3 months", split: { test_last: "3 months" } },
];

/** The user's split of every window into a first part and a test part: shown, and changed here or from the tools. */
export function SplitChip() {
  const split = useAgent((s) => s.split);
  const [open, setOpen] = useState(false), [from, setFrom] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const set = async (x: Record<string, unknown>) => {
    try { await api.setSplit(x); await useAgent.getState().refresh(); setOpen(false); } catch (e) { useStore.getState().toast("error", (e as Error).message); }
  };
  return (
    <>
      <button ref={btn} className="chip" title="How each window is divided into a first part and a test part" onClick={() => setOpen(!open)}>Split: {split?.text ?? "…"}</button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={260} label="Split">
        <div className="settings-sec">
          {PRESETS.map((p) => <button key={p.label} className="btn sm ghost" style={{ justifyContent: "flex-start" }} onClick={() => void set(p.split)}>{p.label}</button>)}
          <div className="row" style={{ gap: 6 }}>
            <input className="input" type="date" aria-label="Test part starts on" value={from} onChange={(e) => setFrom(e.target.value)} />
            <button className="btn sm" disabled={!from} onClick={() => void set({ test_from: from })}>Set</button>
          </div>
        </div>
      </Popover>
    </>
  );
}
```

Put `<SplitChip />` in `PreviewPane.tsx`'s header row, next to the run badges.

- [ ] **Step 2: The chart shading**

```ts
// packages/web/src/charts/SplitPrimitive.ts
import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time, UTCTimestamp } from "lightweight-charts";

class SplitRenderer implements IPrimitivePaneRenderer {
  constructor(private x: number | null) {}
  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio }) => {
      if (this.x === null) return;
      const x = Math.round(this.x * horizontalPixelRatio);
      context.fillStyle = "rgba(128, 128, 128, 0.08)";
      context.fillRect(x, 0, bitmapSize.width - x, bitmapSize.height);
      context.fillStyle = "rgba(128, 128, 128, 0.55)";
      context.fillRect(x, 0, Math.max(1, Math.round(horizontalPixelRatio)), bitmapSize.height);
    });
  }
}
class SplitView implements IPrimitivePaneView {
  x: number | null = null;
  zOrder() { return "bottom" as const; }
  renderer() { return new SplitRenderer(this.x); }
}
/** Shades the test part of the split: from the cut to the right edge. */
export class SplitPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private request: (() => void) | null = null;
  private cut: number | null = null;
  private view = new SplitView();
  attached(p: SeriesAttachedParameter<Time>): void { this.chart = p.chart; this.request = p.requestUpdate; }
  detached(): void { this.chart = null; this.request = null; }
  setCut(ms: number | null): void { this.cut = ms; this.request?.(); }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view]; }
  updateAllViews(): void { this.view.x = this.cut === null || !this.chart ? null : this.chart.timeScale().timeToCoordinate((this.cut / 1000) as UTCTimestamp); }
}
```

In `Charts.tsx`, where each price chart attaches its `TradesPrimitive`, also create a `SplitPrimitive`, attach it to the same series, and update it when the run or the split changes:

```ts
const split = useAgent((s) => s.split);
useEffect(() => {
  if (!runId) return;
  void api.runParts(runId).then((p) => splitPrim.current?.setCut(p.cut ? Date.parse(`${p.cut}T00:00:00Z`) : null)).catch(() => splitPrim.current?.setCut(null));
}, [runId, split?.text]);
```

(Chart times in `Charts.tsx` are UTC seconds: `cols.ts[i] / 1000`, which `SplitPrimitive` matches.)

- [ ] **Step 3: Typecheck and build** — `cd packages/web && npx tsc --noEmit -p . && cd ../.. && pnpm -r build` — Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): the split chip, and the test part shaded on the chart"
```

---

### Task 14: Laptop use, browser check, live check, docs, release 0.2.0

**Files:**
- Create: `scripts/agent-ui.e2e.mjs`, `scripts/mcp-live.mjs`
- Modify: `docs/production.md`, `README.md`, `.github/workflows/check.yml`, the four `package.json` versions

- [ ] **Step 1: Browser check** — drives the UI through the MCP tools the way Claude Code would, and asserts what the user sees.

```js
// scripts/agent-ui.e2e.mjs  -- BASE=http://127.0.0.1:8080/ node scripts/agent-ui.e2e.mjs   (a studio with the demo data)
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
```

In `.github/workflows/check.yml`, after the walkthrough step, add:

```yaml
      - name: tools drive the UI - try_change shows a variant, the split follows, Adopt is one undo step
        run: BASE=http://127.0.0.1:8080/ STRATEGY=strategies/ema_cross.qkt node scripts/agent-ui.e2e.mjs
```

(`@modelcontextprotocol/sdk` must resolve from `scripts/`: add it to the root `package.json` devDependencies with `pnpm add -Dw @modelcontextprotocol/sdk@^1.31.0`.)

- [ ] **Step 2: Live check with the real model** (manual, opt-in; spends a little of the user's plan)

```js
// scripts/mcp-live.mjs  -- STUDIO=http://bot2:8080 TOKEN=... node scripts/mcp-live.mjs
// Runs the spec's example requests through Claude Code (Haiku) against the studio's tools; prints pass/fail, turns, tokens.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os"; import path from "node:path";
const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-live-"));
writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { studio: { type: "http", url: `${process.env.STUDIO}/api/mcp`, headers: { Authorization: `Bearer ${process.env.TOKEN}` } } } }));
const ask = (prompt) => JSON.parse(execFileSync("claude", ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--mcp-config", path.join(dir, "mcp.json"), "--allowedTools", "mcp__studio__*", "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence", "--system-prompt", "You drive the qkt studio through its tools. Map the request onto the fewest tool calls (prefer try_change). Be brief."], { input: prompt, encoding: "utf8", timeout: 300_000 }));
const CASES = [
  ["stop 2 percent", "In strategies/ema_cross.qkt make the stop-loss 2 percent and let's see."],
  ["omit a date", "In strategies/ema_cross.qkt omit trading on 2024-01-10 and show the result."],
  ["new idea", "Create a new strategy rsi_live: buy XAUUSD 15m when RSI(14) crosses above 30 and price is above the 4h EMA 200; stop 1%, target 2%."],
];
for (const [name, prompt] of CASES) {
  const r = ask(prompt);
  console.log(`${r.is_error ? "FAIL" : "ok  "} ${name}: turns ${r.num_turns}, in ${r.usage?.input_tokens}+${r.usage?.cache_read_input_tokens} cached, out ${r.usage?.output_tokens}\n     ${String(r.result).replace(/\s+/g, " ").slice(0, 200)}`);
}
```

- [ ] **Step 3: Docs** — add to `docs/production.md` a section "Using the studio's tools from Claude Code":

````markdown
## 5. The studio's tools (MCP)

The studio serves its abilities as MCP tools at `/api/mcp` (same token as the rest of the API): read what you are
looking at, the DSL reference, diagnose a run's exits, try a change on a copy and see it on the chart, propose edits to
strategies, `qkt.config.yaml` and `instruments.yaml`, set the split, run backtests, sweeps and walk-forwards.

From Claude Code on your laptop (Tailscale):

```sh
claude mcp add --transport http qkt-studio http://bot2:8080/api/mcp --header "Authorization: Bearer <STUDIO_TOKEN>"
```

Then ask, in plain English, with the studio open in the browser: "make the stop-loss 2 % and let's see". The change runs
on a copy and appears on the chart with Adopt / Discard / Back; edits to your files appear under **Proposals** until you
apply them. Nothing a tool does changes an existing file without your click.
````

Add one line to `README.md`'s feature list pointing to that section.

- [ ] **Step 4: Full suite, version, release**

Run: `pnpm test && pnpm -r build` — Expected: all pass.
Set `"version": "0.2.0"` in `package.json` and `packages/{core,server,web}/package.json`.

```bash
git add -A
git commit -m "feat: studio MCP tools with try-a-change, proposals and the split (0.2.0)"
```

Open the PR; after CI passes and it is merged: `git tag v0.2.0 && git push origin v0.2.0`, then on bot2 `/root/qkt-studio/run.sh v0.2.0`, then run `scripts/mcp-live.mjs` against bot2 and record the three results in the PR.
