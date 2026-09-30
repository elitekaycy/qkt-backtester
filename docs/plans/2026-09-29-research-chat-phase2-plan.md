# Research chat, phase 2: the Chat tab, the Claude Code process and the sign-in card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Chat" dock tab where the user asks in plain English and the unmodified Claude Code binary (on the user's own
Claude plan, signed in once inside the container) drives the studio through the phase 1 MCP tools, with the steps,
variants, proposals and usage shown in the conversation, the limits enforced by the studio, and Stop that really stops.

**Architecture:** `server/src/chat/` owns the conversation: one `claude -p ... --output-format stream-json` process per
user message (resumed by session id), a tolerant stream-json parser that turns its lines into chat events, a per-process
MCP token that only opens `/api/mcp` (and counts tool calls there), limits, usage and a sqlite conversation index in
`.qkt-studio/chat/`. Chat events reach the browser on the existing `/api/events` SSE stream. The chat model (events,
items, the fold) is pure and lives in `@qkt-studio/core/chat`, shared by server and browser. The web UI (`web/src/chat/`)
renders the thread with assistant-ui's unstyled primitives over an external store fed by that stream, lazy-loaded with
the tab; the composer (@ mentions, context chips, Think harder, Send/Stop) is ours. Tests use a fake `claude` that
replays stream-json scenarios and makes real MCP calls, so nothing spends tokens.

**Tech Stack:** Node 22 (`node:sqlite`), TypeScript, Fastify 5, Vitest; React 19 + Zustand; `@assistant-ui/react`
0.15.22, `react-markdown` 10.1.0, `remark-gfm` 4.0.1; `@anthropic-ai/claude-code` 2.1.285 in the image; puppeteer-core
for the browser check.

**Spec:** `docs/specs/2026-09-29-research-chat-design.md` — phase 2 = sections 5, 7, 8, 10, 11 (chat manager and browser
e2e parts), 12. Phase 1 (MCP tools, variants, proposals, the split) is implemented on this branch
(`docs/plans/2026-09-29-research-chat-phase1-plan.md`).

## Global Constraints

- Claude Code: `@anthropic-ai/claude-code@2.1.285`, installed as published with `npm install -g` in the image; never patched, wrapped or re-signed. Build arg `CLAUDE_CODE_VERSION=2.1.285`.
- The CLI is started with exactly these flags (spec section 5, verified against `claude --help` of 2.1.285), prompt on stdin:
  `-p --model <haiku|sonnet> --tools "" --strict-mcp-config --mcp-config <file> --allowedTools "mcp__studio__*" --permission-mode dontAsk --system-prompt <text> --output-format stream-json --verbose --include-partial-messages (--session-id <uuid> | --resume <uuid>)`.
- Models: `haiku` by default, `sonnet` for **Think harder**. Nothing else is accepted; Opus is never offered or passed.
- Limits per message, enforced by the studio: 25 tool calls, 5 minutes; one message in flight per workspace (studio). Stop kills the process group and cancels the runs/jobs that message's tool calls started.
- Credentials: the studio never reads, copies, stores or proxies Claude credentials. It runs only `claude --version` and `claude auth status --json`, and keeps only `loggedIn`, `authMethod`, `subscriptionType` from the latter (the account's email and organisation never leave `chat/auth.ts`).
- Claude Code's config directory is `/home/studio/.claude` in the image (`CLAUDE_CONFIG_DIR`), a separate volume; sign-in: `docker exec -it -u 1000 qkt-backtester claude auth login` (the card shows the studio's real uid).
- Per-process MCP token: 24 random bytes hex, created by the chat manager for one CLI process, accepted on `/api/mcp` only, revoked when the process exits. `STUDIO_TOKEN` is removed from the CLI's environment.
- Chat state: `.qkt-studio/chat/chat.sqlite` (conversations, messages with items and usage, `node:sqlite` like the run index `.qkt-studio/index.sqlite`), `.qkt-studio/chat/cwd/` (the CLI's fixed working directory), `.qkt-studio/chat/run/` (0600 MCP config files, deleted on exit).
- No background agent loops: a CLI process exists only between a user's Send and the end of that message.
- Web dependencies pinned exactly: `@assistant-ui/react` `0.15.22`, `react-markdown` `10.1.0`, `remark-gfm` `4.0.1`. The chat UI is a lazy chunk (`lazy(() => import("../chat/ChatTab.js"))`); the main bundle imports only `chat/state.ts`.
- Commit messages describe the change; they never mention AI, assistants, models or Claude.
- Release at the end: all four `package.json` versions `0.3.0`, tag `v0.3.0`. Deploying is not a task.

## Review Focus

1. **Two Sends at the same moment** (two tabs, a double click) -> exactly one CLI process starts; the other gets 409 "a message is already being answered". The slot is reserved before the first `await` in `send` (test in Task 5).
2. **The chat starts a run while the Chat tab is open** -> the dock stays on Chat; only the user's own runs pop the Pipeline tab open (test in Task 7, `shouldRevealPipeline`).
3. **The first message of a chat failed before Claude Code had a session** (signed out mid-way, a crash) and **a chat whose Claude Code transcript is gone** (the config volume was reset) -> the next message still works: a taken `--session-id` is retried with `--resume`, a missing `--resume` is retried once in a fresh session with a one-line notice (tests in Task 5).
4. **The studio restarts while a message is being answered** -> that message shows "interrupted" and the next message continues the same conversation (tests in Tasks 3 and 6).
5. **The per-process token** -> opens `/api/mcp` and nothing else, stops working when its process ends (including a process killed at the 5-minute limit), and a 26th tool call is refused as a tool error while the process is stopped (tests in Tasks 4, 5 and 6).

## Deviations from the spec (deliberate, phase 2)

- **The view reference travels in each user message, not in the system prompt.** Claude Code 2.1.285 records the system prompt on a conversation's first request and reuses it verbatim on every `--resume` (`--system-prompt-snapshot`, default `on`), so an open file or run id put there would be stale from the second message. The system prompt is fixed text; each message starts with a `<studio-view>` block (open file, run, range, trade, variant, split, @ mentions) the chips can trim.
- **Chat events use the existing `/api/events` stream** (event `chat`), not a second SSE endpoint.
- **The 25-call limit is enforced at `/api/mcp`**: the grant behind the per-process token counts `tools/call`; the 26th is answered with a tool error ("stopped: this message reached its limit ...") and the process is stopped. Counting stream lines would race the call itself.
- **Limits keep what was started; Stop cancels it.** Spec 5 says Stop kills the runs; spec 10 says a limit keeps partial results. So the 25-call and 5-minute limits stop the process only; Stop also cancels (and purges) the runs/jobs that message's tools started.
- **A lost Claude Code session is retried once automatically** in a fresh session with a notice (spec 10 only covers a studio restart).
- **The composer is ours; assistant-ui renders the thread.** Its composer primitive cannot host the @ picker and the removable chips without internal APIs; the thread (message list, parts by type, tool renderers, auto-scroll viewport) is what we reuse.
- **Fixtures are hand-written, not recorded.** No model calls were spent designing this. Event shapes come from the published Agent SDK message types (`SDKMessage` in `@anthropic-ai/claude-agent-sdk` 0.3.285 `sdk.d.ts`: `system/init`, `stream_event`, `assistant`, `user`, `result`, `rate_limit_event`, `system/api_retry`) and `claude --help`. The parser reads only the fields it needs and ignores anything else; `CHAT_RECORD_DIR` makes the studio save real streams, which `scripts/chat-live.mjs` collects and the parser test then replays. The exact wording of the CLI's plan-limit and missing-session messages is not verified; the code shows the CLI's text as-is and matches missing/taken sessions loosely (`/No conversation found/i`, `/already in use/i`).
- **The sign-in command shows the studio's uid** (`process.getuid()`), 1000 by default, since the container runs as the workspace owner.
- **The sweep table with both split parts** (deferred from phase 1) is a chat card for the `sweep` tool; the Lab is unchanged.
- **"The model sees a sweep's first part only" is a convention, not a guarantee (spec M13, phase 1 ledger).** `job_status`
  returns first-part numbers per row, but every row carries its `runId`, and `get_run` / `run_summary` / `trades` on that id
  show the whole window, test part included. Phase 2 does not enforce it and does not claim it: the system prompt asks the
  model to judge sweep rows on the first part and to leave the test part to the user; the Sweep card shows both parts with
  the over-fit flag and says nothing about what the model saw; the docs make no such claim. Enforcing it (hiding a
  message's sweep run ids from the other tools) is out of scope.
- **Stop reaches tool calls still in flight.** A tool handler keeps running inside the studio after its CLI process is killed
  (the HTTP request is gone, the handler is not). Stop sets `grant.afterStop`, so a run such a handler records afterwards is
  cancelled as it is recorded, the same way (`runner.cancel(id, { purge: true })`, else `jobs.cancel(id)`) as the `cancel`
  tool. A variant's base run is never in `started` (phase 1: it may be the user's), so Stop leaves base runs alone.
- **Without `STUDIO_TOKEN` the per-process token is not what guards the API.** The studio then answers only loopback
  hosts and `/api` needs no token at all; the grant is still looked up from the CLI's `Authorization` header, so the call
  limit and Stop's run list work the same, but "opens `/api/mcp` and nothing else" (Review Focus 5) holds only with a token.

### assistant-ui verdict (checked 2026-09-29)

`npm view @assistant-ui/react` -> 0.15.22, peers `react ^18 || ^19`, `react-dom ^18 || ^19` (React 19 OK). No Tailwind or
shadcn requirement: "tailwind" appears only in its `keywords`; the primitives are unstyled (`className` passthrough).
Weight, measured with esbuild (minified, tree-shaken, the primitives + external-store runtime): React alone 223 KB / 69 KB
gzip; with assistant-ui 538 KB / 163 KB gzip, so **+314 KB / +94 KB gzip** (mostly `@assistant-ui/core` 178 KB);
`react-markdown` + `remark-gfm` add 156 KB / 47 KB gzip. Its dependency list includes `radix-ui`, `zod@4`,
`assistant-cloud`; only `@radix-ui/react-slot`/`primitive` end up in the bundle. The exact components used in this plan
(`useExternalStoreRuntime`, `ThreadPrimitive.Root/Viewport/Messages`, `MessagePrimitive.Root/Parts` with `Text`,
`tools.Fallback`, `data.Fallback`, `ThreadMessageLike` with `tool-call` and `data-*` parts, `AppendMessage`) were
type-checked against 0.15.22 in a scratch project. Verdict: **suitable**, loaded only with the Chat tab, pinned exactly
(0.x, and `useExternalStoreRuntime` already sits under `legacy-runtime/` internally).

## Pre-flight scan (2026-09-29)

Checked against `feat/studio-mcp-tools` at `9bb46ef` (phase 1 complete, including the fix wave `cb451c8..9bb46ef`:
`git diff 0df8470..9bb46ef`), the current `docker/`, `.github/workflows/check.yml`, `docs/production.md`, and bot2's
`/root/qkt-studio/run.sh` (read over ssh, not changed). Corrections are already applied in the task text below.

**Pairs (producer -> consumer):**

| Pair | Shared file / interface | Finding |
|---|---|---|
| Phase 1 `mcp/util.ts` -> T4 | `ToolCtx` now has `budget: ToolBudget` (required) besides `started` | T4 Step 6 called `registerMcp` without `budget`: type error. Fixed; the grant counts calls only, run work stays capped by the shared `ToolBudget` (the `{ ...ctx }` spread carries it). |
| Phase 1 `main.ts` -> T4, T6 | `createStudio` returns `budget` | T6's return object dropped `budget`. Fixed in T4 and T6. T4's `tokens` goes after the `budget` line. |
| Phase 1 `test/mcp/client.ts` -> T4 | `mcpClient`, `call` | The plan re-created them in `helpers.ts` ("defined locally in tools.test.ts" is no longer true). Fixed: T4 imports `test/mcp/client.ts`; `helpers.ts` only gains `fakeClaude` (T2). |
| Phase 1 tools (`tools-runs.ts`, `tools-try.ts`) -> T4 `TeeSet` | `ctx.started.add/has` only; variant base runs never added | Consistent: nothing iterates `ctx.started`. Base runs are not the chat's to cancel (phase 1 rule), so Stop leaves them. |
| T4 -> T5 | `TurnGrant`, `TeeSet` | Stop only cancelled ids present when it ran; a tool handler still inside the studio (it outlives the killed CLI) could start a run after. Fixed with `TurnGrant.afterStop`, set by Stop, called by `TeeSet.add`; tests in T4 and T5. |
| Phase 1 `runner.cancel` / `jobs.cancel` -> T5 | `cancel(id, { purge })` returns false for unknown/finished ids; `jobs.cancel(id)` | Stop uses exactly what the `cancel` tool uses (`runner.cancel(id, { purge: true })`, else `jobs.cancel`). No change needed beyond `afterStop`. |
| Phase 1 `app.ts` -> T4 | token hook's last line, `buildApp(cfg, register)` | Anchors match the current file. |
| Phase 1 `proc.ts`, `config.ts` -> T2 | `spawn(...)` line, `ServerConfig`, `testConfig(ws, extra)` | Anchors match; `claudeBin` passes through `Partial<ServerConfig>`. |
| Phase 1 `agent/events.ts` -> T5 -> T7 | `StudioEvent` union (`open` renamed `open_file`), SSE event name = `t` | `chat` clashes with no EventSource built-in (`open`, `message`, `error`); the plan never used `open`. OK. |
| Phase 1 `mcp/util.ts` `toolPathRefusal` -> T6 | the tools' path policy | The chat itself reads no files (every access is a tool call through `toolPath`), but mention refs went into the prompt unchecked. Fixed: `parseSend` drops a path-like mention ref the policy refuses (`.env`, `runs/...`, hidden folders, `..`); test extended. |
| Phase 1 `split.ts` -> T6 | `getSplit(cfg)`, `describeSplit` | Match (`main.ts` already imports `registerSplitRoutes` from `./split.js`; extend that import with `getSplit`). |
| T1 -> T7 | `@qkt-studio/core/chat` subpath | `"./texthash"` is now the last export (phase 1); the insertion point was `"./ranges"`. Fixed. |
| Phase 1 `web/state/agent.ts` -> T7, T9 | `start()` listeners, `adopt(id)` (baseHash / rebase / confirm), `show`, `discard`, `VariantInfo`, `ProposalInfo` | Signatures match; cards call `adopt(id)`, so the rebase/confirm plan applies to Adopt from the chat too. The variant SSE guard (`variantMayTakeOver`) and `shouldRevealPipeline` compose: a chat variant takes the chart unless the tab follows the user's own run. |
| Phase 1 `web/shell/App.tsx` -> T7 | the two pipeline effects (lines 76-77) | Anchors match. |
| Phase 1 `Proposals.tsx`, `proposals.ts` -> T9 | `act` body (em-dash text), status `"applying"`, list without `before`/`after` | The moved body had its dashes changed although called "unchanged": restored. `ProposalCard` gains the `applying` label. The list still carries `diff`, which is all the card needs. |
| Phase 1 `VariantBar.tsx` -> T9 | terminal statuses, `runParts` 404 = no trades | Cards read `runParts(...).catch(() => null)`: a failed or purged run shows "–", consistent. |
| Phase 1 sweep / `job_status` -> T5, T9 | first-part-only rows (spec M13) | Cosmetic, not enforced (row `runId`s are readable through `get_run`/`trades`). Handled honestly: a Deviation, one system-prompt line, a card comment; nothing claims the model could not see the test part. |
| T2 -> T5, T6, T11 | fake CLI: session markers, `fake-signed-out`, scenario regexes | Consistent: `set-split`, `propose`, `stop 1 %` and `keep working` do not cross-match; the view block is stripped before matching. |
| T10 -> T11 | `CLAUDE_BIN` override, `/home/studio/.claude` writable by the workspace owner | Consistent after the T10 fixes (the CI `ws3` owner, uid 1001 on GitHub runners, gets the empty anonymous volume). |
| T10 -> bot2 `run.sh` | container flags | No repo copy exists. Without a mount, every `run.sh vX` (`rm -f` + `run`) starts a new anonymous volume, so the sign-in is lost. Added Step 5b: an exact one-line change the controller applies on bot2 (tested on a local copy of the script). |

**Each task on its own:**

| Task | Finding |
|---|---|
| T1 | Tests match the code (fold, parser: deltas win, 4001-char cut, reset time `2026-09-21 14:13 UTC` for 1790000000). Export insertion point fixed. |
| T2 | Tests match (flags, env, 0600 config, status fields); `fake-claude.mjs` needs `chmod +x` (Step 1 and T11 say so). Files created = files added in the commit. |
| T3 | Consistent. |
| T4 | Helpers duplicated (fixed), `budget` dropped (fixed), `TeeSet` signature changed to take the grant (tests updated, one test added). Commit list no longer adds `helpers.ts`. |
| T5 | 11 tests; the Stop test also checks a late run is cancelled. `stop()` rewritten around `cancelOne`/`afterStop`. |
| T6 | `parseSend` test extended with refused refs; expected output unchanged (the refused ones are dropped before the 10-mention cap). Return keeps `budget`. |
| T7 | Consistent (helpers' tests checked by hand: `2.4k in`, mention filtering and caret maths). |
| T8 | Icons: `MessageSquare`, `Brain` are new; `Square`, `X`, `Plus`, `Copy`, `Info`, `CircleCheck`, `CircleX` exist. `TreeEntry`, `scan.symbols`, `selectedTrip.id`, `focus` exist in the store. |
| T9 | `Proposals.tsx` text restored, `applying` added, SweepCard comment. `api.job`, `api.runParts`, `PartStats`, `fmtMoney` exist. |
| T10 | Anchors (the `RUN chmod +x` line, the `ENV` block, the root branch of `entrypoint.sh`) given against the current files; ownership rule, `--json`, upgrade note and Step 5b added. |
| T11 | Consistent with T2 scenarios and T10; separate container/port/workspace from the phase 1 e2e. |

**Rulings:**

- Ruling: `registerMcp(..., { ..., started, budget }, tokens)` and `createStudio` keeps returning `budget` — `ToolCtx.budget` is required since `3ace510` — cost if wrong: server build fails at T4.
- Ruling: chat tool calls share the one `ToolBudget`; the grant counts calls and records ids, it reserves nothing — a per-message budget would let chat and an outside MCP client together exceed the cap phase 1 set to protect the user's own Run queue — cost if wrong: a chat message can get "busy" while an outside client holds the budget (it reads the error and waits, as designed).
- Ruling: `TurnGrant.afterStop` + `TeeSet(shared, grant)` — a handler outlives its killed CLI and could start a run after Stop's loop — cost if wrong: an extra callback; without it, Stop could leave a run going that nobody asked for.
- Ruling: Stop cancels with `runner.cancel(id, { purge: true })` else `jobs.cancel(id)`, never base runs — the same rule as phase 1's `cancel` tool — cost if wrong: a variant's base run keeps running after Stop (it may be the user's own run; cancelling it would be worse).
- Ruling: reuse `test/mcp/client.ts` instead of new helpers — it exists since phase 1 — cost if wrong: two copies of the MCP test client drifting apart.
- Ruling: `"./chat"` export goes after `"./texthash"` — that entry is now last — cost if wrong: invalid JSON or a missing comma in `core/package.json`.
- Ruling: `parseSend` drops path-like mention refs `toolPathRefusal` refuses — the chat's only path arguments are mention refs; the tools already refuse those paths, the chat should not invite them — cost if wrong: a user's `@.env` mention is silently left out of the message.
- Ruling: sweeps' first-part-only is documented as a convention, a prompt line asks the model to respect it, nothing claims enforcement — spec M13 / phase 1 ledger: it is cosmetic — cost if wrong: the model may still look at a row's test part; the user's table and over-fit flag are unaffected.
- Ruling: `actOnProposal` keeps the current text (em dashes, comment lines) — "moved unchanged" must be literally true — cost if wrong: a visible toast wording change.
- Ruling: `ProposalCard` labels `applying` — phase 1 added the status — cost if wrong: a raw "applying" badge for a moment.
- Ruling: the image creates `/home/studio` owned by 1000 and the entrypoint re-owns an EMPTY sign-in folder whose owner differs from the workspace owner — bot2's host folder will be root-owned, CI's workspace owner is 1001, and `-u 1000 --entrypoint claude` checks skip the entrypoint — cost if wrong: `claude auth login` fails with EACCES and the card never turns green.
- Ruling: CI and manual checks call `auth status --json` and match `"configDirectory": *"..."` loosely — the server itself calls `--json`, and the pretty-printing is the CLI's — cost if wrong: a flaky or falsely failing image job.
- Ruling: `run.sh` is changed by the controller on bot2 with a documented `sed` (Step 5b), no repo template — none exists and the file carries host-specific addresses — cost if wrong: after the next upgrade the chat is signed out again (no data loss).
- Ruling: Review Focus 5 holds only with `STUDIO_TOKEN` set (a Deviation now says so) — without a token `/api` is open on loopback anyway — cost if wrong: none in production (bot2 sets a token).

## File Structure

Layout rule (from phase 1, extended): `server/src/chat/` holds the conversation manager (process, stream-json, limits,
usage, conversation index) and the chat's REST routes; `server/src/mcp/` stays the endpoint and tool adapters (it only
learns to look a per-process token up); `server/src/agent/` stays what tools do on the user's behalf. Pure logic shared
with the browser lives in `core/src/chat.ts`. The web chat UI is `web/src/chat/`.

Created:
- `packages/core/src/chat.ts` — `ChatEvent`, `ChatItem`, `ChatMessage`, `Usage`, `ViewKey`, `Mention`, `foldEvent()`.
- `packages/server/src/chat/stream.ts` — `StreamParser`: stream-json lines -> `ChatEvent[]`.
- `packages/server/src/chat/agent.ts` — `agentArgs()`, `agentEnv()`, `writeMcpConfig()`, `startAgent()`, `mcpHost()`.
- `packages/server/src/chat/auth.ts` — `readClaudeStatus()`, `ClaudeStatusCache`.
- `packages/server/src/chat/store.ts` — `ChatStore` (sqlite): conversations, messages, interrupted-on-restart.
- `packages/server/src/chat/tokens.ts` — `ChatTokens`, `TurnGrant`, `TeeSet`, `toolCalls()`, `limitReply()`.
- `packages/server/src/chat/prompt.ts` — `SYSTEM_PROMPT`, `viewReference()`, `composePrompt()`.
- `packages/server/src/chat/manager.ts` — `ChatManager`: send, stop, limits, resume, usage, events.
- `packages/server/src/chat/routes.ts` — `/api/chat/{status,conversations,send,stop}`.
- `packages/server/test/fixtures/fake-claude/fake-claude.mjs` (executable) and `scenarios/*.jsonl`, `scenarios/scenarios.json`.
- `packages/web/src/chat/` — `state.ts` (Zustand `useChat` + pure helpers), `convert.ts`, `mentions.ts`, `results.ts`, `ChatTab.tsx`, `ChatHeader.tsx`, `Thread.tsx`, `parts.tsx`, `cards.tsx`, `Composer.tsx`, `SetupCard.tsx`, `chat.css`.
- Tests: `packages/core/test/chat.test.ts`, `packages/server/test/chat/{stream,agent,store,tokens,manager,routes}.test.ts`, `packages/web/src/chat/{state,convert,mentions,results}.test.ts`, `scripts/chat-ui.e2e.mjs`, `scripts/chat-live.mjs`.

Modified: `packages/core/{src/index.ts,package.json}`, `packages/server/src/{proc.ts,app.ts,main.ts,config.ts,agent/events.ts,mcp/index.ts}`,
`packages/server/test/helpers.ts`, `packages/web/package.json`, `packages/web/src/{api/client.ts,state/agent.ts,state/ui.ts,dock/Dock.tsx,shell/App.tsx,shell/Proposals.tsx,ui/icons.ts}`,
`docker/Dockerfile`, `docker/entrypoint.sh`, `docs/production.md`, `README.md`, `.github/workflows/check.yml`, the four `package.json` versions.

---

### Task 1: The chat model (core) and the stream-json parser

**Files:**
- Create: `packages/core/src/chat.ts`, `packages/core/test/chat.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./chat.js";`), `packages/core/package.json` (subpath `./chat`)
- Create: `packages/server/src/chat/stream.ts`, `packages/server/test/chat/stream.test.ts`
- Create: `packages/server/test/fixtures/fake-claude/scenarios/stop-2pct.jsonl`, `plan-limit.jsonl`

**Interfaces:**
- Produces (core, also at `@qkt-studio/core/chat` for the browser):
  - `interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; turns: number | null; durationMs: number | null }`
  - `type ChatStatus = "running" | "done" | "error" | "stopped" | "limit" | "interrupted"`; `type EndStatus = Exclude<ChatStatus, "running">`
  - `type ChatEvent = { k: "session"; sessionId: string; model: string | null; toolsConnected: boolean | null } | { k: "text"; text: string } | { k: "tool"; id: string; name: string; input: unknown } | { k: "tool_result"; id: string; isError: boolean; text: string; ms?: number } | { k: "notice"; text: string } | { k: "result"; ok: boolean; text: string; subtype: string; usage: Usage } | { k: "end"; status: EndStatus; error?: string; usage?: Usage | null }`
  - `type ChatItem = { type: "text"; text: string } | { type: "tool"; id: string; name: string; input: unknown; result?: { isError: boolean; text: string; ms?: number } } | { type: "notice"; text: string }`
  - `interface ChatMessage { id: string; conversationId: string; role: "user" | "assistant"; text: string; model: string | null; status: ChatStatus; error: string | null; items: ChatItem[]; usage: Usage | null; created: string }`
  - `const VIEW_KEYS = ["file", "run", "range", "trade", "variant", "split"] as const; type ViewKey`; `interface Mention { label: string; ref: string }`
  - `foldEvent(m: ChatMessage, ev: ChatEvent): ChatMessage` (pure, never mutates); `tokensIn(u: Usage): number`
- Produces (server): `class StreamParser { feed(line: string): ChatEvent[]; sessionId: string | null }`, `toolName(n: string): string` (strips `mcp__studio__`).

- [ ] **Step 1: Write the failing core test**

```ts
// packages/core/test/chat.test.ts
import { describe, it, expect } from "vitest";
import { foldEvent, tokensIn, type ChatEvent, type ChatMessage } from "../src/chat.js";

const empty = (): ChatMessage => ({ id: "m", conversationId: "c", role: "assistant", text: "", model: "haiku", status: "running", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" });
const fold = (evs: ChatEvent[], m = empty()) => evs.reduce(foldEvent, m);
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, costUsd: 0.01, turns: 2, durationMs: 900 };

describe("foldEvent", () => {
  it("joins text deltas into one text item until a tool step, then starts a new one", () => {
    const m = fold([{ k: "text", text: "Trying " }, { k: "text", text: "it." }, { k: "tool", id: "t1", name: "try_change", input: { a: 1 } }, { k: "text", text: "Done." }]);
    expect(m.items.map((i) => i.type)).toEqual(["text", "tool", "text"]);
    expect(m.items[0]).toEqual({ type: "text", text: "Trying it." });
    expect(m.text).toBe("Trying it.\n\nDone.");
  });
  it("attaches a result to its tool step by id, and ignores a repeated tool_use", () => {
    const m = fold([{ k: "tool", id: "t1", name: "run_backtest", input: {} }, { k: "tool", id: "t1", name: "run_backtest", input: {} }, { k: "tool_result", id: "t1", isError: false, text: "{}", ms: 3200 }, { k: "tool_result", id: "nope", isError: true, text: "x" }]);
    expect(m.items).toEqual([{ type: "tool", id: "t1", name: "run_backtest", input: {}, result: { isError: false, text: "{}", ms: 3200 } }]);
  });
  it("a failed result records its text as the error; end sets the status and keeps the usage", () => {
    const m = fold([{ k: "result", ok: false, text: "usage limit reached", subtype: "success", usage }, { k: "end", status: "error" }]);
    expect(m).toMatchObject({ status: "error", error: "usage limit reached", usage });
    expect(fold([{ k: "notice", text: "retrying" }, { k: "end", status: "stopped", error: "Stopped.", usage: null }])).toMatchObject({ status: "stopped", error: "Stopped.", usage: null, items: [{ type: "notice", text: "retrying" }] });
  });
  it("never mutates the message it is given", () => {
    const m = empty();
    fold([{ k: "text", text: "a" }, { k: "tool", id: "t", name: "x", input: {} }], m);
    expect(m).toEqual(empty());
  });
  it("tokensIn counts fresh input, cache reads and cache writes", () => { expect(tokensIn(usage)).toBe(111); });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/core && npx vitest run test/chat.test.ts`
Expected: FAIL, `Cannot find module '../src/chat.js'`.

- [ ] **Step 3: Implement `core/src/chat.ts`**

```ts
// packages/core/src/chat.ts
/** Chat messages and the events that build them: shared by the server (what it stores) and the browser (what it shows). */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; turns: number | null; durationMs: number | null }
export type ChatStatus = "running" | "done" | "error" | "stopped" | "limit" | "interrupted";
export type EndStatus = Exclude<ChatStatus, "running">;
export type ChatEvent =
  | { k: "session"; sessionId: string; model: string | null; toolsConnected: boolean | null }
  | { k: "text"; text: string }
  | { k: "tool"; id: string; name: string; input: unknown }
  | { k: "tool_result"; id: string; isError: boolean; text: string; ms?: number }
  | { k: "notice"; text: string }
  | { k: "result"; ok: boolean; text: string; subtype: string; usage: Usage }
  | { k: "end"; status: EndStatus; error?: string; usage?: Usage | null };
export type ChatItem =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; result?: { isError: boolean; text: string; ms?: number } }
  | { type: "notice"; text: string };
export interface ChatMessage {
  id: string; conversationId: string; role: "user" | "assistant"; text: string; model: string | null;
  status: ChatStatus; error: string | null; items: ChatItem[]; usage: Usage | null; created: string;
}
/** Parts of the view reference the user can leave out of one message (the chips above the message box). */
export const VIEW_KEYS = ["file", "run", "range", "trade", "variant", "split"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];
/** An @ mention: what the user typed and what it refers to (a path, a run id, "the chart"...). */
export interface Mention { label: string; ref: string }

/** Tokens the plan counted as input for a message: fresh input plus cache reads and writes. */
export const tokensIn = (u: Usage): number => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** One event into a message. Pure: returns a new message, never changes the one given. */
export function foldEvent(m: ChatMessage, ev: ChatEvent): ChatMessage {
  switch (ev.k) {
    case "text": {
      const items = m.items.slice(), last = items[items.length - 1];
      if (last?.type === "text") { items[items.length - 1] = { type: "text", text: last.text + ev.text }; return { ...m, items, text: m.text + ev.text }; }
      items.push({ type: "text", text: ev.text });
      return { ...m, items, text: m.text ? `${m.text}\n\n${ev.text}` : ev.text };
    }
    case "tool":
      if (m.items.some((i) => i.type === "tool" && i.id === ev.id)) return m;
      return { ...m, items: [...m.items, { type: "tool", id: ev.id, name: ev.name, input: ev.input }] };
    case "tool_result":
      return { ...m, items: m.items.map((i) => (i.type === "tool" && i.id === ev.id ? { ...i, result: { isError: ev.isError, text: ev.text, ms: ev.ms } } : i)) };
    case "notice":
      return { ...m, items: [...m.items, { type: "notice", text: ev.text }] };
    case "result":
      return { ...m, usage: ev.usage, error: ev.ok ? m.error : ev.text || m.error };
    case "end":
      return { ...m, status: ev.status, error: ev.error ?? m.error, usage: ev.usage === undefined ? m.usage : ev.usage };
    case "session":
      return m;
  }
}
```

The tool_result test expects `ms` kept and `result` absent keys omitted: `{ isError: false, text: "{}", ms: 3200 }` matches.
Add to `packages/core/package.json` `exports`, after the last entry (`"./texthash"`, added in phase 1; put a comma after its closing brace):

```json
    "./chat": {
      "types": "./dist/chat.d.ts",
      "default": "./dist/chat.js"
    }
```

and `export * from "./chat.js";` at the end of `packages/core/src/index.ts`.

- [ ] **Step 4: Run the core test and build**

Run: `cd packages/core && npx vitest run test/chat.test.ts && cd ../.. && pnpm --filter @qkt-studio/core build`
Expected: PASS, build clean.

- [ ] **Step 5: Write the parser fixtures** (hand-written from the Agent SDK's `SDKMessage` types; `{{session}}` is replaced by the session id when replayed, see Task 2)

`packages/server/test/fixtures/fake-claude/scenarios/stop-2pct.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":["mcp__studio__try_change"],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-2"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-3"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Trying a 2 % stop "}},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-4"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"on a copy."}},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-5"}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"changes\""}},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-6"}
{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Trying a 2 % stop on a copy."},{"type":"tool_use","id":"toolu_1","name":"mcp__studio__try_change","input":{"changes":[{"op":"set_bracket","stop":"2 PCT"}],"label":"stop 2 %"}}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-7"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"{\"variantId\":\"v1\",\"label\":\"stop 2 %\"}"}]}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-8"}
{"type":"assistant","message":{"id":"msg_2","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Net +190 vs -412. It is on the chart."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-9"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4200,"duration_api_ms":3900,"num_turns":2,"result":"Net +190 vs -412. It is on the chart.","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0061,"usage":{"input_tokens":1200,"cache_creation_input_tokens":0,"cache_read_input_tokens":3000,"output_tokens":90},"modelUsage":{},"permission_denials":[],"uuid":"u-10"}
```

`packages/server/test/fixtures/fake-claude/scenarios/plan-limit.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1790000000,"rateLimitType":"five_hour"},"uuid":"u-rl","session_id":"{{session}}"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":300,"duration_api_ms":0,"num_turns":1,"result":"Claude AI usage limit reached|1790000000","stop_reason":null,"session_id":"{{session}}","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

- [ ] **Step 6: Write the failing parser test**

```ts
// packages/server/test/chat/stream.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StreamParser } from "../../src/chat/stream.js";

const SCEN = fileURLToPath(new URL("../fixtures/fake-claude/scenarios/", import.meta.url));
const REC = fileURLToPath(new URL("../fixtures/fake-claude/recorded/", import.meta.url));
const parse = (text: string) => { const p = new StreamParser(); return text.split("\n").flatMap((l) => p.feed(l.replaceAll("{{session}}", "s-1"))); };
const file = (f: string) => readFileSync(path.join(SCEN, f), "utf8");

describe("StreamParser", () => {
  it("turns a reply into text, one tool step, its result and usage; streamed deltas win over the whole message", () => {
    expect(parse(file("stop-2pct.jsonl"))).toEqual([
      { k: "session", sessionId: "s-1", model: "claude-haiku-4-5", toolsConnected: true },
      { k: "text", text: "Trying a 2 % stop " },
      { k: "text", text: "on a copy." },
      { k: "tool", id: "toolu_1", name: "try_change", input: { changes: [{ op: "set_bracket", stop: "2 PCT" }], label: "stop 2 %" } },
      { k: "tool_result", id: "toolu_1", isError: false, text: "{\"variantId\":\"v1\",\"label\":\"stop 2 %\"}" },
      { k: "text", text: "Net +190 vs -412. It is on the chart." },
      { k: "result", ok: true, text: "Net +190 vs -412. It is on the chart.", subtype: "success", usage: { inputTokens: 1200, outputTokens: 90, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: 0.0061, turns: 2, durationMs: 4200 } },
    ]);
  });
  it("a plan limit: a notice with the reset time, and a failed result carrying the CLI's text as-is", () => {
    const evs = parse(file("plan-limit.jsonl"));
    expect(evs[1]).toEqual({ k: "notice", text: "Your Claude plan's usage limit is reached; it resets at 2026-09-21 14:13 UTC." });
    expect(evs[2]).toMatchObject({ k: "result", ok: false, text: "Claude AI usage limit reached|1790000000" });
  });
  it("ignores what it does not know: blank and non-JSON lines, unknown types, sub-agent lines", () => {
    const p = new StreamParser();
    for (const l of ["", "not json", "[1,2]", '{"type":"system","subtype":"hook_started"}', '{"type":"tool_progress"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_9","message":{"id":"m","content":[{"type":"text","text":"sub"}]}}']) expect(p.feed(l)).toEqual([]);
  });
  it("says once that the studio's tools did not connect, and reports retries", () => {
    const p = new StreamParser();
    expect(p.feed('{"type":"system","subtype":"init","session_id":"s","mcp_servers":[{"name":"studio","status":"failed"}]}')).toEqual([
      { k: "session", sessionId: "s", model: null, toolsConnected: false },
      { k: "notice", text: "The studio's tools did not connect (failed); the reply cannot use them." },
    ]);
    expect(p.feed('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":500,"error_status":529}')).toEqual([{ k: "notice", text: "Claude's service did not answer; retrying (attempt 2 of 10)." }]);
  });
  it("a tool result given as a plain string, marked as an error, and cut when huge", () => {
    const p = new StreamParser();
    const long = "x".repeat(5000);
    const [ev] = p.feed(JSON.stringify({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: long, is_error: true }] } }));
    expect(ev).toMatchObject({ k: "tool_result", id: "t", isError: true });
    expect((ev as { text: string }).text.length).toBe(4001);
  });
  it("recorded real streams (scripts/chat-live.mjs) parse without throwing and end in a result", () => {
    if (!existsSync(REC)) return;
    for (const f of readdirSync(REC).filter((x) => x.endsWith(".jsonl"))) {
      const evs = parse(readFileSync(path.join(REC, f), "utf8"));
      expect(evs.at(-1)?.k, f).toBe("result");
    }
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/chat/stream.test.ts`
Expected: FAIL, `Cannot find module '../../src/chat/stream.js'`.

- [ ] **Step 8: Implement the parser**

```ts
// packages/server/src/chat/stream.ts
import type { ChatEvent, Usage } from "@qkt-studio/core";

const TOOL_PREFIX = "mcp__studio__";
const MAX_RESULT_CHARS = 4000;
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export const toolName = (n: string): string => (n.startsWith(TOOL_PREFIX) ? n.slice(TOOL_PREFIX.length) : n);
const textOf = (content: unknown): string => (typeof content === "string" ? content : arr(content).map((p) => str(obj(p)?.text) ?? "").join(""));
// the CLI's reset times are epoch seconds; accept milliseconds too
const clock = (t: number): string => `${new Date(t < 1e12 ? t * 1000 : t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function usageOf(o: Obj): Usage {
  const u = obj(o.usage) ?? {};
  return {
    inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) ?? 0, cacheWriteTokens: num(u.cache_creation_input_tokens) ?? 0,
    costUsd: num(o.total_cost_usd), turns: num(o.num_turns), durationMs: num(o.duration_ms),
  };
}

/**
 * Claude Code's `--output-format stream-json` lines -> chat events. Tolerant on purpose: the format is the CLI's and grows new
 * message types, so only the fields below are read; unknown lines and fields are ignored, never an error. With
 * --include-partial-messages the text arrives twice (deltas, then the whole assistant message): the deltas win.
 */
export class StreamParser {
  private streamed = new Set<string>();
  private current: string | null = null;
  sessionId: string | null = null;

  feed(line: string): ChatEvent[] {
    const t = line.trim();
    if (!t.startsWith("{")) return [];
    let o: Obj | null;
    try { o = obj(JSON.parse(t)); } catch { return []; }
    if (!o) return [];
    // a sub-agent's own messages (no sub-agents are enabled, but the format allows them) never reach the chat
    if (o.parent_tool_use_id !== undefined && o.parent_tool_use_id !== null) return [];
    switch (o.type) {
      case "system": return this.system(o);
      case "stream_event": return this.delta(o);
      case "assistant": return this.assistant(o);
      case "user": return this.user(o);
      case "result": return [this.result(o)];
      case "rate_limit_event": return this.rateLimit(o);
      default: return [];
    }
  }

  private system(o: Obj): ChatEvent[] {
    if (o.subtype === "init") {
      const sid = str(o.session_id) ?? "";
      if (sid) this.sessionId = sid;
      const status = str(arr(o.mcp_servers).map(obj).find((s) => s?.name === "studio")?.status);
      const out: ChatEvent[] = [{ k: "session", sessionId: sid, model: str(o.model), toolsConnected: status === null ? null : status === "connected" }];
      if (status !== null && status !== "connected") out.push({ k: "notice", text: `The studio's tools did not connect (${status}); the reply cannot use them.` });
      return out;
    }
    if (o.subtype === "api_retry") return [{ k: "notice", text: `Claude's service did not answer; retrying (attempt ${num(o.attempt) ?? "?"} of ${num(o.max_retries) ?? "?"}).` }];
    return [];
  }

  private delta(o: Obj): ChatEvent[] {
    const e = obj(o.event);
    if (!e) return [];
    if (e.type === "message_start") { this.current = str(obj(e.message)?.id); return []; }
    const d = obj(e.delta);
    if (e.type !== "content_block_delta" || d?.type !== "text_delta" || typeof d.text !== "string" || !d.text) return [];
    if (this.current) this.streamed.add(this.current);
    return [{ k: "text", text: d.text }];
  }

  private assistant(o: Obj): ChatEvent[] {
    const m = obj(o.message);
    if (!m) return [];
    const id = str(m.id), streamed = id !== null && this.streamed.has(id);
    const out: ChatEvent[] = [];
    for (const b of arr(m.content).map(obj)) {
      if (!b) continue;
      if (b.type === "text" && !streamed && typeof b.text === "string" && b.text) out.push({ k: "text", text: b.text });
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") out.push({ k: "tool", id: b.id, name: toolName(b.name), input: b.input ?? {} });
    }
    const err = str(o.error);
    if (err) out.push({ k: "notice", text: `Claude reported: ${err.replace(/_/g, " ")}.` });
    return out;
  }

  private user(o: Obj): ChatEvent[] {
    const out: ChatEvent[] = [];
    for (const b of arr(obj(o.message)?.content).map(obj)) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      let text = textOf(b.content);
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}…`;
      out.push({ k: "tool_result", id: b.tool_use_id, isError: b.is_error === true, text });
    }
    return out;
  }

  private result(o: Obj): ChatEvent {
    const text = str(o.result) ?? arr(o.errors).map((e) => String(e)).join("; ");
    return { k: "result", ok: o.subtype === "success" && o.is_error !== true, text, subtype: str(o.subtype) ?? "unknown", usage: usageOf(o) };
  }

  private rateLimit(o: Obj): ChatEvent[] {
    const i = obj(o.rate_limit_info), resets = num(i?.resetsAt);
    if (i?.status === "rejected") return [{ k: "notice", text: `Your Claude plan's usage limit is reached${resets ? `; it resets at ${clock(resets)}` : ""}.` }];
    if (i?.status === "allowed_warning") return [{ k: "notice", text: "Close to your Claude plan's usage limit." }];
    return [];
  }
}
```

- [ ] **Step 9: Run the parser test**

Run: `cd packages/server && npx vitest run test/chat/stream.test.ts`
Expected: PASS (6 tests; the recorded-streams test returns early while `recorded/` does not exist).

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/chat.ts packages/core/src/index.ts packages/core/package.json packages/core/test/chat.test.ts packages/server/src/chat/stream.ts packages/server/test/chat/stream.test.ts packages/server/test/fixtures/fake-claude/scenarios
git commit -m "feat(chat): chat messages and events shared by server and browser, and a tolerant stream-json reader"
```

---

### Task 2: The fake CLI, the agent process and the sign-in status

**Files:**
- Create: `packages/server/test/fixtures/fake-claude/fake-claude.mjs` (mode 755), `packages/server/test/fixtures/fake-claude/scenarios/{scenarios.json,hello.jsonl,echo.jsonl,hang.jsonl,loop.jsonl,fail-early.jsonl,try-change.jsonl,set-split.jsonl,propose.jsonl}`
- Create: `packages/server/src/chat/agent.ts`, `packages/server/src/chat/auth.ts`
- Modify: `packages/server/src/proc.ts` (stdin `input`), `packages/server/src/config.ts` (`claudeBin`), `packages/server/test/helpers.ts` (`fakeClaude`)
- Test: `packages/server/test/chat/agent.test.ts`

**Interfaces:**
- Consumes: `spawnGroup(bin, args, opts)` from `proc.ts`; `StreamParser` (Task 1).
- Produces:
  - `SpawnOptions.input?: string` — written to stdin, then stdin closed.
  - `ServerConfig.claudeBin?: string` — `CLAUDE_BIN` env, default `"claude"`.
  - `type AgentModel = "haiku" | "sonnet"`; `interface AgentRun { model: AgentModel; sessionId: string; resume: boolean; systemPrompt: string; mcpConfigPath: string }`
  - `agentArgs(r: AgentRun): string[]`; `agentEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`; `writeMcpConfig(dir: string, name: string, url: string, token: string): Promise<string>`; `mcpHost(host: string): string`
  - `interface AgentProcess extends ProcHandle { parser: StreamParser }`; `startAgent(bin: string, run: AgentRun, prompt: string, o: { cwd: string; env?: NodeJS.ProcessEnv; onEvent(ev: ChatEvent): void; onRaw?(line: string): void }): AgentProcess`
  - `interface ClaudeStatus { installed: boolean; version: string | null; loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; error: string | null }`; `readClaudeStatus(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ClaudeStatus>`; `class ClaudeStatusCache { constructor(bin: string, cwd: string, ttlMs?: number); get(force?: boolean): Promise<ClaudeStatus> }`
  - Test helper: `fakeClaude: string` (absolute path of `fake-claude.mjs`).
  - Fake behaviour later tasks rely on: scenario chosen by regex on the user's text (the `<studio-view>` block is removed first); `--session-id` must be new and `--resume` must exist (marker files in `$CLAUDE_CONFIG_DIR/fake-sessions`); `$CLAUDE_CONFIG_DIR/fake-signed-out` makes `auth status` report signed out; `FAKE_CLAUDE_ARGV_LOG=<file>` appends each invocation's argv as a JSON line.

- [ ] **Step 1: The fake CLI**

```js
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
```

Run `chmod +x packages/server/test/fixtures/fake-claude/fake-claude.mjs` (git records the mode; the e2e mounts it into the container).

- [ ] **Step 2: The scenarios**

`scenarios/scenarios.json`:

```json
[
  { "match": "hang|keep working", "file": "hang.jsonl" },
  { "match": "loop", "file": "loop.jsonl" },
  { "match": "echo", "file": "echo.jsonl" },
  { "match": "fail early", "file": "fail-early.jsonl" },
  { "match": "usage limit", "file": "plan-limit.jsonl" },
  { "match": "stop.*1 ?(%|percent)", "file": "try-change.jsonl" },
  { "match": "stop.*2 ?(%|percent)", "file": "stop-2pct.jsonl" },
  { "match": "split", "file": "set-split.jsonl" },
  { "match": "propose", "file": "propose.jsonl" }
]
```

The scenario files (every line is one JSON object; the parser fixtures `stop-2pct.jsonl` and `plan-limit.jsonl` are from Task 1):

`scenarios/hello.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"type":"assistant","message":{"id":"msg_hello","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Hello from the fake."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-msg_hello"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":800,"num_turns":1,"result":"Hello from the fake.","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0012,"usage":{"input_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000,"output_tokens":12},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

`scenarios/echo.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"$echo_prompt":true}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":800,"num_turns":1,"result":"echoed","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0012,"usage":{"input_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000,"output_tokens":12},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

`scenarios/hang.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"type":"assistant","message":{"id":"msg_w","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Working on it."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-msg_w"}
{"$hang":true}
```

`scenarios/loop.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"$call":{"name":"list_files","arguments":{}},"$repeat":30}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":800,"num_turns":1,"result":"done","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0012,"usage":{"input_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000,"output_tokens":12},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

`scenarios/fail-early.jsonl`:

```
{"$stderr":"boom: could not start"}
{"$exit":1}
```

`scenarios/try-change.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"type":"assistant","message":{"id":"msg_t1","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Trying a 1 % stop and 2 % target on a copy."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-msg_t1"}
{"$call":{"name":"try_change","arguments":{"changes":[{"op":"set_bracket","stop":"1%","target":"2%"}],"label":"1% / 2%","from":"2024-01-02","to":"2024-02-01"}}}
{"type":"assistant","message":{"id":"msg_t2","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"It is on the chart beside the original."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-msg_t2"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":800,"num_turns":1,"result":"It is on the chart beside the original.","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0012,"usage":{"input_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000,"output_tokens":12},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

`scenarios/set-split.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"$call":{"name":"set_split","arguments":{"split":{"test_last":"1 weeks"}}}}
{"type":"assistant","message":{"id":"msg_s1","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"The test part is now the last week."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-msg_s1"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":800,"num_turns":1,"result":"The test part is now the last week.","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0012,"usage":{"input_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000,"output_tokens":12},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

`scenarios/propose.jsonl`:

```
{"type":"system","subtype":"init","session_id":"{{session}}","model":"claude-haiku-4-5","tools":[],"mcp_servers":[{"name":"studio","status":"connected"}],"permissionMode":"dontAsk","apiKeySource":"none","cwd":"/tmp","claude_code_version":"2.1.285","uuid":"u-init"}
{"$call":{"name":"propose_strategy_edit","arguments":{"path":"strategies/ema_cross.qkt","changes":[{"op":"set_bracket","stop":"3%","target":"6%"}]}}}
{"type":"assistant","message":{"id":"msg_p1","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Proposed: review the change and Apply it."}]},"parent_tool_use_id":null,"session_id":"{{session}}","uuid":"u-msg_p1"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":800,"num_turns":1,"result":"Proposed: review the change and Apply it.","stop_reason":"end_turn","session_id":"{{session}}","total_cost_usd":0.0012,"usage":{"input_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000,"output_tokens":12},"modelUsage":{},"permission_denials":[],"uuid":"u-result"}
```

- [ ] **Step 3: Write the failing test**

```ts
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
```

Add to `packages/server/test/helpers.ts`:

```ts
import { fileURLToPath } from "node:url";
/** The stand-in `claude` CLI (replays scenarios, calls the real /api/mcp); see test/fixtures/fake-claude. */
export const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude/fake-claude.mjs", import.meta.url));
```

- [ ] **Step 4: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/chat/agent.test.ts`
Expected: FAIL, `Cannot find module '../../src/chat/agent.js'`.

- [ ] **Step 5: stdin in `proc.ts`, `claudeBin` in `config.ts`**

In `SpawnOptions` add:

```ts
  /** Written to the child's stdin, which is then closed; without it stdin is ignored. */
  input?: string;
```

In `spawnGroup`, replace the `spawn(...)` line with:

```ts
  const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  // a child that exits before reading its input must not crash the studio with EPIPE
  if (opts.input !== undefined) { child.stdin!.on("error", () => undefined); child.stdin!.end(opts.input); }
```

In `config.ts`, add to `ServerConfig`:

```ts
  /** The Claude Code CLI the chat runs (`CLAUDE_BIN`, default `claude` on PATH). */
  claudeBin?: string;
```

and to `loadConfig`'s returned object: `claudeBin: env.CLAUDE_BIN || "claude",`.

- [ ] **Step 6: Implement `chat/agent.ts` and `chat/auth.ts`**

```ts
// packages/server/src/chat/agent.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatEvent } from "@qkt-studio/core";
import { spawnGroup, type ProcHandle } from "../proc.js";
import { StreamParser } from "./stream.js";

export type AgentModel = "haiku" | "sonnet";
export interface AgentRun { model: AgentModel; sessionId: string; resume: boolean; systemPrompt: string; mcpConfigPath: string }

/** The design's flags (section 5): only the studio's MCP tools, no built-in ones, no permission prompts, streamed JSON. */
export function agentArgs(r: AgentRun): string[] {
  return ["-p", "--model", r.model, "--tools", "", "--strict-mcp-config", "--mcp-config", r.mcpConfigPath,
    "--allowedTools", "mcp__studio__*", "--permission-mode", "dontAsk", "--system-prompt", r.systemPrompt,
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(r.resume ? ["--resume", r.sessionId] : ["--session-id", r.sessionId])];
}

/** The studio's environment minus its access token: the CLI gets its own per-process token in the MCP config instead. */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.STUDIO_TOKEN;
  return env;
}

/** The --mcp-config file (endpoint + this process's token), readable by this user only; the caller deletes it. */
export async function writeMcpConfig(dir: string, name: string, url: string, token: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.json`);
  await fs.writeFile(file, JSON.stringify({ mcpServers: { studio: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
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
```

```ts
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
    this.inflight ??= readClaudeStatus(this.bin, agentEnv(), this.cwd)
      .then((value) => { this.last = { at: Date.now(), value }; return value; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/server && npx vitest run test/chat/agent.test.ts test/runner.test.ts`
Expected: PASS (the runner test proves the `proc.ts` change left runs alone).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/proc.ts packages/server/src/config.ts packages/server/src/chat/agent.ts packages/server/src/chat/auth.ts packages/server/test/helpers.ts packages/server/test/chat/agent.test.ts packages/server/test/fixtures/fake-claude
git commit -m "feat(chat): start the CLI per message with the design's flags, read the sign-in status, and a replaying stand-in CLI for tests"
```

---

### Task 3: The conversation index

**Files:**
- Create: `packages/server/src/chat/store.ts`
- Test: `packages/server/test/chat/store.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` (Task 1); `node:sqlite` `DatabaseSync` (as `index-db.ts`).
- Produces: `interface ConversationRow { id: string; sessionId: string; sessionStarted: boolean; title: string; created: string; updated: string; messages: number }`;
  `class ChatStore { constructor(file: string); createConversation(title: string): ConversationRow; conversation(id: string): ConversationRow | undefined; list(limit?: number): ConversationRow[]; setSession(id: string, sessionId: string, started: boolean): void; addMessage(m: ChatMessage): void; saveMessage(m: ChatMessage): void; messages(conversationId: string): ChatMessage[]; markInterrupted(): number; close(): void }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/chat/store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatMessage } from "@qkt-studio/core";
import { ChatStore } from "../../src/chat/store.js";

const fresh = () => new ChatStore(path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), "chat-"))), "chat", "chat.sqlite"));
const msg = (conversationId: string, id: string, role: "user" | "assistant", status: ChatMessage["status"] = "done"): ChatMessage =>
  ({ id, conversationId, role, text: `${role} ${id}`, model: role === "assistant" ? "haiku" : null, status, error: null, items: [], usage: null, created: new Date().toISOString() });

describe("ChatStore", () => {
  it("keeps conversations and their messages in order, the most recently used conversation first", async () => {
    const s = fresh();
    const a = s.createConversation("stop 2 %"), b = s.createConversation("skip fridays");
    expect(a.sessionStarted).toBe(false);
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    s.addMessage(msg(a.id, "1", "user")); s.addMessage(msg(a.id, "2", "assistant", "running"));
    await new Promise((r) => setTimeout(r, 5));
    s.saveMessage({ ...msg(a.id, "2", "assistant"), text: "Net +190", items: [{ type: "text", text: "Net +190" }], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.001, turns: 1, durationMs: 10 } });
    expect(s.messages(a.id).map((m) => [m.id, m.role, m.status])).toEqual([["1", "user", "done"], ["2", "assistant", "done"]]);
    expect(s.messages(a.id)[1]).toMatchObject({ text: "Net +190", items: [{ type: "text", text: "Net +190" }], usage: { costUsd: 0.001 } });
    expect(s.list().map((c) => [c.id, c.messages])).toEqual([[a.id, 2], [b.id, 0]]);
    s.close();
  });
  it("marks a message a restart left running as interrupted", () => {
    const s = fresh();
    const c = s.createConversation("x");
    s.addMessage(msg(c.id, "1", "assistant", "running"));
    expect(s.markInterrupted()).toBe(1);
    expect(s.messages(c.id)[0]).toMatchObject({ status: "interrupted", error: "Interrupted: the studio restarted. Send again to continue." });
    s.close();
  });
  it("remembers the Claude Code session and whether it exists yet", () => {
    const s = fresh();
    const c = s.createConversation("x");
    s.setSession(c.id, c.sessionId, true);
    expect(s.conversation(c.id)).toMatchObject({ sessionId: c.sessionId, sessionStarted: true });
    s.setSession(c.id, "00000000-0000-4000-8000-000000000000", false);
    expect(s.conversation(c.id)).toMatchObject({ sessionId: "00000000-0000-4000-8000-000000000000", sessionStarted: false });
    expect(s.conversation("nope")).toBeUndefined();
    s.close();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/chat/store.test.ts`
Expected: FAIL, `Cannot find module '../../src/chat/store.js'`.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/chat/store.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMessage } from "@qkt-studio/core";

export interface ConversationRow { id: string; sessionId: string; sessionStarted: boolean; title: string; created: string; updated: string; messages: number }
type Row = Record<string, unknown>;
const conv = (r: Row): ConversationRow => ({ id: String(r.id), sessionId: String(r.session_id), sessionStarted: r.session_started === 1, title: String(r.title), created: String(r.created), updated: String(r.updated), messages: Number(r.messages ?? 0) });
const message = (r: Row): ChatMessage => ({
  id: String(r.id), conversationId: String(r.conversation_id), role: r.role === "user" ? "user" : "assistant", text: String(r.text), model: (r.model as string | null) ?? null,
  status: r.status as ChatMessage["status"], error: (r.error as string | null) ?? null, items: JSON.parse(String(r.items)), usage: r.usage ? JSON.parse(String(r.usage)) : null, created: String(r.created),
});

/**
 * The chat's conversations and messages (with their steps and usage), next to the run index. Claude Code keeps its own
 * transcripts in its config directory; this is what the Chat tab shows and which session each conversation resumes.
 */
export class ChatStore {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_started INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
        model TEXT, status TEXT NOT NULL, error TEXT, items TEXT NOT NULL, usage TEXT, created TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, seq);
    `);
  }
  createConversation(title: string): ConversationRow {
    const now = new Date().toISOString(), id = randomBytes(6).toString("hex");
    this.db.prepare("INSERT INTO conversations (id, session_id, session_started, title, created, updated) VALUES (?,?,0,?,?,?)").run(id, randomUUID(), title || "New chat", now, now);
    return this.conversation(id)!;
  }
  conversation(id: string): ConversationRow | undefined {
    const r = this.db.prepare("SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages FROM conversations c WHERE c.id = ?").get(id) as Row | undefined;
    return r ? conv(r) : undefined;
  }
  list(limit = 50): ConversationRow[] {
    return (this.db.prepare("SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages FROM conversations c ORDER BY c.updated DESC LIMIT ?").all(limit) as Row[]).map(conv);
  }
  setSession(id: string, sessionId: string, started: boolean): void {
    this.db.prepare("UPDATE conversations SET session_id = ?, session_started = ? WHERE id = ?").run(sessionId, started ? 1 : 0, id);
  }
  addMessage(m: ChatMessage): void {
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?").get(m.conversationId) as { n: number }).n;
    this.db.prepare("INSERT INTO messages (id, conversation_id, seq, role, text, model, status, error, items, usage, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(m.id, m.conversationId, seq, m.role, m.text, m.model, m.status, m.error, JSON.stringify(m.items), m.usage ? JSON.stringify(m.usage) : null, m.created);
    this.touch(m.conversationId);
  }
  saveMessage(m: ChatMessage): void {
    this.db.prepare("UPDATE messages SET text = ?, status = ?, error = ?, items = ?, usage = ? WHERE id = ?")
      .run(m.text, m.status, m.error, JSON.stringify(m.items), m.usage ? JSON.stringify(m.usage) : null, m.id);
    this.touch(m.conversationId);
  }
  messages(conversationId: string): ChatMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId) as Row[]).map(message);
  }
  /** At start-up: a message still "running" was cut off by a restart. The conversation continues from Claude Code's session. */
  markInterrupted(): number {
    const r = this.db.prepare("UPDATE messages SET status = 'interrupted', error = ? WHERE status = 'running'").run("Interrupted: the studio restarted. Send again to continue.");
    return Number(r.changes);
  }
  close(): void { this.db.close(); }
  private touch(id: string): void { this.db.prepare("UPDATE conversations SET updated = ? WHERE id = ?").run(new Date().toISOString(), id); }
}
```

- [ ] **Step 4: Run the test**

Run: `cd packages/server && npx vitest run test/chat/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/chat/store.ts packages/server/test/chat/store.test.ts
git commit -m "feat(chat): conversation index in .qkt-studio/chat, interrupted messages marked at start-up"
```

---
### Task 4: Per-process MCP tokens, their call count, and the runs they start

**Files:**
- Create: `packages/server/src/chat/tokens.ts`
- Modify: `packages/server/src/app.ts` (accept a scoped token on `/api/mcp`), `packages/server/src/mcp/index.ts` (look the token up: count calls, tee started runs), `packages/server/src/main.ts` (create `ChatTokens`, pass it on, return it)
- Reuse (unchanged): `packages/server/test/mcp/client.ts` (`mcpClient`, `call`: the shared MCP test client phase 1 added)
- Test: `packages/server/test/chat/tokens.test.ts`

**Interfaces:**
- Consumes: `buildApp`, `registerMcp`, `ToolCtx` (phase 1, current shape: `{ cfg, runner, jobs, data, events, view, proposals, variants, started, budget }`; `started` records tool-started run/job ids for `cancel`, `budget: ToolBudget` caps tool run work and is shared by every caller of `/api/mcp`, chat or not); `mcpClient`, `call` from `test/mcp/client.ts`.
- Produces:
  - `interface TurnGrant { token: string; started: Set<string>; calls: number; maxCalls: number; onLimit(): void; afterStop: ((id: string) => void) | null }` (`afterStop` is set by Stop: a run/job a tool call of this message records after Stop has run is cancelled at once)
  - `class ChatTokens { issue(o: { maxCalls: number; onLimit(): void }): TurnGrant; lookup(token: string | undefined): TurnGrant | undefined; revoke(token: string): void; size(): number }`
  - `class TeeSet extends Set<string>` — `new TeeSet(shared: Set<string>, grant: Pick<TurnGrant, "started" | "afterStop">)`: `add` writes the shared set and `grant.started` (and calls `grant.afterStop` when set), `has` reads the shared one; `toolCalls(body: unknown): number`; `limitReply(body: unknown, maxCalls: number): unknown`; `LIMIT_TEXT(n: number): string`
  - `buildApp(cfg, register?, opts?: AppOptions)` with `interface AppOptions { mcpToken?: (token: string) => boolean }`
  - `registerMcp(app, ctx, tokens?: ChatTokens)`
  - `createStudio(cfg)` also returns `tokens: ChatTokens` (and still returns `budget`)

- [ ] **Step 1: Write the failing test**

The MCP test client already exists as `packages/server/test/mcp/client.ts` (`mcpClient(base, token?)`, `call(c, name, args?)` -> `{ isError, text, json }`); import it, do not add a second copy to `helpers.ts`.

```ts
// packages/server/test/chat/tokens.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { createStudio } from "../../src/main.js";
import { ChatTokens, TeeSet, toolCalls } from "../../src/chat/tokens.js";
import { testConfig } from "../helpers.js";
import { call as callTool, mcpClient } from "../mcp/client.js";

let studio: Awaited<ReturnType<typeof createStudio>>, base: string;
beforeAll(async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  studio = await createStudio(testConfig(ws, { token: "t0k" }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); });

describe("per-process tokens", () => {
  it("open /api/mcp and nothing else, and stop working once revoked", async () => {
    const g = studio.tokens.issue({ maxCalls: 25, onLimit: () => undefined });
    const c = await mcpClient(base, g.token);
    expect((await c.listTools()).tools.length).toBeGreaterThan(10);
    await c.close();
    for (const url of ["/api/info", "/api/health", "/api/chat/status", "/api/mcp/../info"]) {
      expect((await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${g.token}` } })).status, url).toBe(401);
    }
    studio.tokens.revoke(g.token);
    await expect(mcpClient(base, g.token)).rejects.toThrow(/unauthorized|401/);
    expect(studio.tokens.size()).toBe(0);
  });
  it("count tool calls: past the limit a call is refused as a tool error and the owner is told once per refused call", async () => {
    let told = 0;
    const g = studio.tokens.issue({ maxCalls: 2, onLimit: () => { told++; } });
    const c = await mcpClient(base, g.token);
    expect((await callTool(c, "get_split")).isError).toBe(false);
    expect((await callTool(c, "get_split")).isError).toBe(false);
    const third = await callTool(c, "get_split");
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/limit of 2 tool calls/);
    expect(told).toBe(1);
    await c.close(); studio.tokens.revoke(g.token);
  });
  it("the studio's own token still works on /api/mcp and is never counted", async () => {
    const c = await mcpClient(base, "t0k");
    for (let i = 0; i < 3; i++) expect((await callTool(c, "get_split")).isError).toBe(false);
    await c.close();
  });
});

describe("helpers", () => {
  it("TeeSet records into both sets and answers has() from the shared one", () => {
    const shared = new Set<string>(["user-run"]), grant = { started: new Set<string>(), afterStop: null as ((id: string) => void) | null };
    const t = new TeeSet(shared, grant);
    t.add("r1");
    expect([...shared].sort()).toEqual(["r1", "user-run"]);
    expect([...grant.started]).toEqual(["r1"]);
    expect(t.has("user-run")).toBe(true);
  });
  it("TeeSet hands a run recorded after Stop straight to the stop's cancel", () => {
    const late: string[] = [];
    const grant = { started: new Set<string>(), afterStop: (id: string) => { late.push(id); } };
    new TeeSet(new Set<string>(), grant).add("r-late");
    expect(late).toEqual(["r-late"]);
    expect([...grant.started]).toEqual(["r-late"]);
  });
  it("toolCalls counts tools/call in a request or a batch", () => {
    expect(toolCalls({ method: "tools/call" })).toBe(1);
    expect(toolCalls([{ method: "tools/call" }, { method: "tools/list" }, { method: "tools/call" }])).toBe(2);
    expect(toolCalls({ method: "initialize" })).toBe(0);
    expect(new ChatTokens().lookup(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/chat/tokens.test.ts`
Expected: FAIL, `Cannot find module '../../src/chat/tokens.js'`.

- [ ] **Step 3: Implement `chat/tokens.ts`**

```ts
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
```

- [ ] **Step 4: Accept the scoped token in `app.ts`**

Add above `buildApp`:

```ts
export interface AppOptions {
  /** Accepts a token on /api/mcp only, besides the studio's own: the chat's per-process tokens. */
  mcpToken?: (token: string) => boolean;
}
```

Change the signature to `export async function buildApp(cfg: ServerConfig, register?: (app: FastifyInstance) => void | Promise<void>, opts: AppOptions = {}): Promise<FastifyInstance>` and, in the token hook, replace the last line with:

```ts
      const given = bearer ?? (q ? decodeURIComponent(q) : undefined);
      // a per-process token is good for the MCP endpoint and nothing else (req.url is the raw path: no ../ tricks reach here as /api/mcp)
      if (given && (url === "/api/mcp" || url.startsWith("/api/mcp?")) && opts.mcpToken?.(given)) return;
      if (!tokenOk(given, expected)) return reply.code(401).send({ error: "unauthorized" });
```

- [ ] **Step 5: Count and tee in `mcp/index.ts`**

Replace the whole current `registerMcp` (keep its doc comment); `buildMcp` is unchanged. The spread keeps `ctx.budget`, so
chat tool calls reserve runs from the same `ToolBudget` as any other MCP client (a chat message gets "busy" like anyone else).

```ts
// in packages/server/src/mcp/index.ts: new imports
import { TeeSet, limitReply, toolCalls, type ChatTokens } from "../chat/tokens.js";

export function registerMcp(app: FastifyInstance, ctx: ToolCtx, tokens?: ChatTokens): void {
  app.route({
    method: ["GET", "POST", "DELETE"], url: "/api/mcp",
    handler: async (req, reply) => {
      if (req.method !== "POST") return reply.code(405).header("Allow", "POST").send({ error: "stateless MCP: POST only" });
      const grant = tokens?.lookup(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]);
      if (grant) {
        const n = toolCalls(req.body);
        grant.calls += n;
        // past the budget: a tool error the model can read, and the chat manager stops the process
        if (n && grant.calls > grant.maxCalls) { grant.onLimit(); return reply.code(200).header("Content-Type", "application/json").send(limitReply(req.body, grant.maxCalls)); }
      }
      reply.hijack();
      const server = buildMcp(grant ? { ...ctx, started: new TeeSet(ctx.started, grant) } : ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      reply.raw.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}
```

- [ ] **Step 6: Wire it in `main.ts`**

In `createStudio` (current phase 1 code: `const started = new Set<string>();` is followed by `const budget = new ToolBudget(...)`), after the `budget` line add `const tokens = new ChatTokens();` (import from `./chat/tokens.js`); change the existing call to `registerMcp(a, { cfg, runner, jobs, data, events, view, proposals, variants, started, budget }, tokens);` (`budget` is required by `ToolCtx`; dropping it fails the type check); give `buildApp` its third argument, after the register callback's closing `}`: `}, { mcpToken: (t) => tokens.lookup(t) !== undefined });`; and return `{ app, runner, jobs, data, events, view, proposals, variants, budget, tokens }`.

- [ ] **Step 7: Run the tests**

Run: `cd packages/server && npx vitest run test/chat/tokens.test.ts test/security.test.ts test/mcp/tools.test.ts`
Expected: PASS (tools tests that need real data skip without it).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/chat/tokens.ts packages/server/src/app.ts packages/server/src/mcp/index.ts packages/server/src/main.ts packages/server/test/chat/tokens.test.ts
git commit -m "feat(chat): per-process tokens that open only /api/mcp, with a tool-call budget and their own list of started runs"
```

---

### Task 5: The chat manager (send, stop, limits, resume, usage) and the prompt

**Files:**
- Create: `packages/server/src/chat/prompt.ts`, `packages/server/src/chat/manager.ts`
- Modify: `packages/server/src/agent/events.ts` (the `chat` event)
- Test: `packages/server/test/chat/manager.test.ts`

**Interfaces:**
- Consumes: `ChatEvent`, `ChatMessage`, `EndStatus`, `Mention`, `Usage`, `ViewKey`, `foldEvent` (Task 1); `startAgent`, `agentEnv`, `writeMcpConfig`, `AgentModel`, `AgentProcess` (Task 2); `ClaudeStatusCache` (Task 2); `ChatStore`, `ConversationRow` (Task 3); `ChatTokens`, `TurnGrant` (Task 4); `EventBus`, `ViewState`/`View` (phase 1).
- Produces:
  - `StudioEvent` gains `{ t: "chat"; conversationId: string; messageId: string; ev: ChatEvent }`
  - `SYSTEM_PROMPT: string`; `viewReference(v: View, split: string | null, omit: readonly ViewKey[], mentions: readonly Mention[]): string`; `composePrompt(ref: string, text: string): string`
  - `interface ChatLimits { maxCalls: number; maxMs: number }`; `LIMITS: ChatLimits` (25, 300 000)
  - `class ChatBusy`, `class ChatUnavailable`, `class ChatNotFound` (all `extends Error`)
  - `interface SendRequest { conversationId?: string | null; text: string; think?: boolean; omit?: ViewKey[]; mentions?: Mention[] }`
  - `interface ChatDeps { cfg: ServerConfig; store: ChatStore; tokens: ChatTokens; events: EventBus; view: ViewState; status: ClaudeStatusCache; runner: { cancel(id: string, o?: { purge?: boolean }): Promise<boolean> }; jobs: { cancel(id: string): Promise<boolean> }; splitText(): Promise<string | null>; limits?: ChatLimits; recordDir?: string }`
  - `class ChatManager { constructor(d: ChatDeps); setMcpUrl(url: string): void; busy(): { conversationId: string; messageId: string } | null; activeTurn(): { grant: TurnGrant | null; pid: number | null } | null; send(r: SendRequest): Promise<{ conversationId: string; messageId: string }>; stop(): Promise<boolean>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/chat/manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatEvent, ChatMessage } from "@qkt-studio/core";
import { ChatBusy, ChatManager, ChatUnavailable, type ChatLimits } from "../../src/chat/manager.js";
import { ChatStore } from "../../src/chat/store.js";
import { ChatTokens } from "../../src/chat/tokens.js";
import { ClaudeStatusCache } from "../../src/chat/auth.js";
import { EventBus } from "../../src/agent/events.js";
import { ViewState } from "../../src/agent/view-state.js";
import { fakeClaude, testConfig } from "../helpers.js";

let home: string;
beforeAll(() => { home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-home-"))); process.env.CLAUDE_CONFIG_DIR = home; });
afterAll(() => { delete process.env.CLAUDE_CONFIG_DIR; delete process.env.FAKE_CLAUDE_ARGV_LOG; rmSync(home, { recursive: true, force: true }); });

function setup(o: { limits?: ChatLimits; bin?: string } = {}) {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  const argvLog = path.join(ws, "argv.log");
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  const bin = o.bin ?? fakeClaude;
  const store = new ChatStore(path.join(ws, ".qkt-studio", "chat", "chat.sqlite"));
  const events = new EventBus(), view = new ViewState(), tokens = new ChatTokens();
  const cancelled: string[] = [], got: ChatEvent[] = [];
  events.subscribe((e) => { if (e.t === "chat") got.push(e.ev); });
  const mgr = new ChatManager({ cfg: testConfig(ws, { claudeBin: bin }), store, tokens, events, view, status: new ClaudeStatusCache(bin, ws),
    runner: { cancel: async (id) => { cancelled.push(id); return true; } }, jobs: { cancel: async () => false },
    splitText: async () => "test = last 25 %", limits: o.limits });
  mgr.setMcpUrl("http://127.0.0.1:9/api/mcp");
  const argvs = () => readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a.includes("-p"));
  return { mgr, store, view, tokens, cancelled, got, argvs };
}
const until = async (f: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const reply = (store: ChatStore, conv: string): ChatMessage => store.messages(conv).filter((m) => m.role === "assistant").at(-1)!;
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

describe("ChatManager", () => {
  it("answers, stores the reply with its usage, streams every event and revokes the token", async () => {
    const { mgr, store, got, tokens } = setup();
    const { conversationId } = await mgr.send({ text: "hi" });
    expect(mgr.busy()).not.toBeNull();
    await until(() => mgr.busy() === null);
    expect(reply(store, conversationId)).toMatchObject({ status: "done", text: "Hello from the fake.", model: "haiku", usage: { inputTokens: 400, cacheReadTokens: 2000, outputTokens: 12, costUsd: 0.0012 } });
    expect(store.messages(conversationId)[0]).toMatchObject({ role: "user", text: "hi" });
    expect(got.map((e) => e.k)).toEqual(["session", "text", "result", "end"]);
    expect(tokens.size()).toBe(0);
    expect(store.conversation(conversationId)!.sessionStarted).toBe(true);
  });
  it("starts a session on the first message and resumes it on the next; Think harder is sonnet", async () => {
    const { mgr, argvs } = setup();
    const a = await mgr.send({ text: "hi" }); await until(() => !mgr.busy());
    await mgr.send({ conversationId: a.conversationId, text: "again", think: true }); await until(() => !mgr.busy());
    const [one, two] = argvs();
    expect(flag(two!, "--resume")).toBe(flag(one!, "--session-id"));
    expect([flag(one!, "--model"), flag(two!, "--model")]).toEqual(["haiku", "sonnet"]);
  });
  it("puts the view reference in the message, minus what the user removed, plus mentions", async () => {
    const { mgr, store, view } = setup();
    view.set({ openFile: "strategies/ema.qkt", cursorLine: 4, runId: "r-77", selectedTrade: 3 });
    const a = await mgr.send({ text: "echo this", omit: ["run"], mentions: [{ label: "@config", ref: "qkt.config.yaml" }] });
    await until(() => !mgr.busy());
    const t = reply(store, a.conversationId).text;
    expect(t).toMatch(/open file: strategies\/ema\.qkt \(cursor on line 4\)/);
    expect(t).toMatch(/selected trade: #3/);
    expect(t).toMatch(/split: test = last 25 %/);
    expect(t).toMatch(/mentioned @config: qkt\.config\.yaml/);
    expect(t).not.toMatch(/r-77/);
    expect(t.trimEnd()).toMatch(/echo this$/);
    expect(store.messages(a.conversationId)[0]!.text).toBe("echo this"); // the stored user text is what the user typed
  });
  it("one message at a time: a second send at the same moment is refused", async () => {
    const { mgr } = setup();
    const [a, b] = await Promise.allSettled([mgr.send({ text: "keep working" }), mgr.send({ text: "hi" })]);
    expect(a.status).toBe("fulfilled");
    expect(b.status === "rejected" && b.reason instanceof ChatBusy).toBe(true);
    await mgr.stop();
  });
  it("Stop kills the process group, cancels the runs that message started, and frees the slot", async () => {
    const { mgr, store, cancelled, got, tokens } = setup();
    const a = await mgr.send({ text: "keep working" });
    await until(() => got.some((e) => e.k === "text"));
    const t = mgr.activeTurn()!;
    t.grant!.started.add("run-1");
    expect(await mgr.stop()).toBe(true);
    expect(reply(store, a.conversationId)).toMatchObject({ status: "stopped", error: "Stopped." });
    expect(cancelled).toEqual(["run-1"]);
    t.grant!.afterStop!("run-late"); // a tool call that was still inside the studio records its run after Stop (TeeSet calls this)
    await until(() => cancelled.includes("run-late"));
    expect(() => process.kill(t.pid!, 0)).toThrow();
    expect(tokens.size()).toBe(0);
    expect(mgr.busy()).toBeNull();
    expect(await mgr.stop()).toBe(false);
  });
  it("the time limit stops the process, keeps what was started, and says so", async () => {
    const { mgr, store, cancelled, tokens } = setup({ limits: { maxCalls: 25, maxMs: 500 } });
    const a = await mgr.send({ text: "keep working" });
    await until(() => !mgr.busy());
    expect(reply(store, a.conversationId)).toMatchObject({ status: "limit", error: "stopped at the limit (1 seconds)" });
    expect(cancelled).toEqual([]);
    expect(tokens.size()).toBe(0);
  });
  it("a plan limit ends the message with the CLI's own text and the reset notice", async () => {
    const { mgr, store } = setup();
    const a = await mgr.send({ text: "hit the usage limit" }); await until(() => !mgr.busy());
    const m = reply(store, a.conversationId);
    expect(m.status).toBe("error");
    expect(m.error).toMatch(/usage limit reached/i);
    expect(m.items.some((i) => i.type === "notice" && /resets at/.test(i.text))).toBe(true);
  });
  it("a chat whose Claude Code transcript is gone continues in a fresh session, once, with a notice", async () => {
    const { mgr, store, argvs } = setup();
    const c = store.createConversation("old");
    store.setSession(c.id, "11111111-1111-4111-8111-111111111111", true);
    await mgr.send({ conversationId: c.id, text: "hi" }); await until(() => !mgr.busy());
    const m = reply(store, c.id);
    expect(m.status).toBe("done");
    expect(m.items.some((i) => i.type === "notice" && /fresh session/.test(i.text))).toBe(true);
    expect(store.conversation(c.id)!.sessionId).not.toBe("11111111-1111-4111-8111-111111111111");
    const [x, y] = argvs();
    expect(x).toContain("--resume"); expect(y).toContain("--session-id");
  });
  it("a first message that failed before a session existed: the next message recovers the taken id with --resume", async () => {
    const { mgr, store, argvs } = setup();
    const a = await mgr.send({ text: "fail early" }); await until(() => !mgr.busy());
    expect(reply(store, a.conversationId)).toMatchObject({ status: "error", error: "boom: could not start" });
    expect(store.conversation(a.conversationId)!.sessionStarted).toBe(false);
    await mgr.send({ conversationId: a.conversationId, text: "hi" }); await until(() => !mgr.busy());
    expect(reply(store, a.conversationId).status).toBe("done");
    const [first, taken, resumed] = argvs();
    expect(flag(taken!, "--session-id")).toBe(flag(first!, "--session-id"));
    expect(flag(resumed!, "--resume")).toBe(flag(first!, "--session-id"));
  });
  it("refuses to start when Claude Code is signed out or missing, and frees the slot", async () => {
    const { mgr } = setup();
    writeFileSync(path.join(home, "fake-signed-out"), "");
    try { await expect(mgr.send({ text: "hi" })).rejects.toBeInstanceOf(ChatUnavailable); }
    finally { rmSync(path.join(home, "fake-signed-out")); }
    expect(mgr.busy()).toBeNull();
    const missing = setup({ bin: "/nonexistent/claude" });
    await expect(missing.mgr.send({ text: "hi" })).rejects.toThrow(/not installed/);
  });
  it("refuses an empty or huge message", async () => {
    const { mgr } = setup();
    await expect(mgr.send({ text: "   " })).rejects.toBeInstanceOf(RangeError);
    await expect(mgr.send({ text: "x".repeat(8001) })).rejects.toBeInstanceOf(RangeError);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/chat/manager.test.ts`
Expected: FAIL, `Cannot find module '../../src/chat/manager.js'`.

- [ ] **Step 3: The `chat` event**

In `packages/server/src/agent/events.ts`, add `import type { ChatEvent } from "@qkt-studio/core";` and the union member:

```ts
  | { t: "chat"; conversationId: string; messageId: string; ev: ChatEvent };
```

- [ ] **Step 4: The prompt**

```ts
// packages/server/src/chat/prompt.ts
import type { Mention, ViewKey } from "@qkt-studio/core";
import type { View } from "../agent/view-state.js";

/**
 * Fixed text, never per message: Claude Code records a conversation's system prompt on its first request and reuses it
 * verbatim on --resume, so what changes (open file, run...) goes in each message's <studio-view> block instead.
 */
export const SYSTEM_PROMPT = [
  "You work inside the qkt backtesting studio. The user brings the idea; you turn their words into the exact change and show it.",
  "Use only the studio's tools. Map each request onto the fewest tool calls: for any strategy change prefer try_change (one call changes a copy, runs it and shows it on the user's chart).",
  "Each message starts with a <studio-view> block: resolve \"this file\", \"this run\", \"this trade\" from it; find other files and runs with list_files and list_runs. If a name is ambiguous, ask one short question.",
  "Do what the user asks. When a tool returns a warning (different scales, fitting the past, a refused value), relay it in one line; never refuse a legal change.",
  "Numbers come from the tools only; never estimate them. Read dsl_reference before writing DSL.",
  "When you pick among sweep rows, judge them on the first part (what job_status gives you); do not open the rows' runs to look at the test part: it is the user's check on your pick.",
  "Be brief: a sentence or two; a small table only to compare.",
].join("\n");

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** What the user is looking at, as references (never file contents): the model fetches what it needs with the tools. */
export function viewReference(v: View, split: string | null, omit: readonly ViewKey[], mentions: readonly Mention[]): string {
  const skip = new Set<ViewKey>(omit), lines: string[] = [];
  if (!skip.has("file") && v.openFile) lines.push(`open file: ${v.openFile}${v.cursorLine ? ` (cursor on line ${v.cursorLine})` : ""}${v.selection ? " (text selected; get_context has it)" : ""}`);
  if (!skip.has("run") && v.runId) lines.push(`run on screen: ${v.runId}${v.runWindow ? ` (${v.runWindow.from} to ${v.runWindow.to}, ${v.runWindow.tier})` : ""}`);
  if (!skip.has("range") && v.visibleFrom !== null && v.visibleTo !== null) lines.push(`chart shows: ${minute(v.visibleFrom)} to ${minute(v.visibleTo)} UTC`);
  if (!skip.has("trade") && v.selectedTrade !== null) lines.push(`selected trade: #${v.selectedTrade}`);
  if (!skip.has("variant") && v.variantId) lines.push(`variant showing: ${v.variantId}`);
  if (!skip.has("split") && split) lines.push(`split: ${split}`);
  for (const m of mentions.slice(0, 10)) lines.push(`mentioned ${m.label}: ${m.ref}`);
  return lines.length ? `<studio-view>\n${lines.join("\n")}\n</studio-view>` : "";
}

export const composePrompt = (ref: string, text: string): string => (ref ? `${ref}\n\n${text}` : text);
```

- [ ] **Step 5: The manager**

```ts
// packages/server/src/chat/manager.ts
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { foldEvent, type ChatEvent, type ChatMessage, type EndStatus, type Mention, type Usage, type ViewKey } from "@qkt-studio/core";
import type { ServerConfig } from "../config.js";
import type { EventBus } from "../agent/events.js";
import type { ViewState } from "../agent/view-state.js";
import { agentEnv, startAgent, writeMcpConfig, type AgentModel, type AgentProcess } from "./agent.js";
import type { ClaudeStatusCache } from "./auth.js";
import { composePrompt, SYSTEM_PROMPT, viewReference } from "./prompt.js";
import type { ChatStore, ConversationRow } from "./store.js";
import type { ChatTokens, TurnGrant } from "./tokens.js";

export interface ChatLimits { maxCalls: number; maxMs: number }
export const LIMITS: ChatLimits = { maxCalls: 25, maxMs: 5 * 60_000 };
export class ChatBusy extends Error {}
export class ChatUnavailable extends Error {}
export class ChatNotFound extends Error {}
export interface SendRequest { conversationId?: string | null; text: string; think?: boolean; omit?: ViewKey[]; mentions?: Mention[] }
export interface ChatDeps {
  cfg: ServerConfig; store: ChatStore; tokens: ChatTokens; events: EventBus; view: ViewState; status: ClaudeStatusCache;
  /** Stop cancels the runs and jobs the message's tool calls started, through these. */
  runner: { cancel(id: string, o?: { purge?: boolean }): Promise<boolean> }; jobs: { cancel(id: string): Promise<boolean> };
  splitText(): Promise<string | null>;
  limits?: ChatLimits;
  /** When set, the CLI's raw stream-json lines are also saved as <dir>/<messageId>.jsonl (parser fixtures). */
  recordDir?: string;
}
interface Turn { conversationId: string; messageId: string; grant: TurnGrant | null; proc: AgentProcess | null; halted: { status: EndStatus; error: string } | null; done: Promise<void> }
type ResultEv = Extract<ChatEvent, { k: "result" }>;
interface Outcome { ok: boolean; why: string; detail: string; usage: Usage | null }

const fmtLimit = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.ceil(ms / 1000)} seconds`);
const titleOf = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 60);
// the CLI's wording for a missing or already-used session id: matched loosely (not verified against every version)
const NO_SESSION = /No conversation found/i, SESSION_TAKEN = /already in use/i;

/**
 * The conversation manager: one CLI process per user message, one message at a time, limits enforced here (the CLI has
 * no turn limit), every event streamed to the browser and stored, the session resumed by id.
 */
export class ChatManager {
  private turn: Turn | null = null;
  private mcpUrl: string | null = null;
  private limits: ChatLimits;
  constructor(private d: ChatDeps) { this.limits = d.limits ?? LIMITS; }

  setMcpUrl(url: string): void { this.mcpUrl = url; }
  busy(): { conversationId: string; messageId: string } | null { return this.turn?.messageId ? { conversationId: this.turn.conversationId, messageId: this.turn.messageId } : null; }
  /** For tests: the running message's grant and process id. */
  activeTurn(): { grant: TurnGrant | null; pid: number | null } | null { return this.turn ? { grant: this.turn.grant, pid: this.turn.proc?.pid ?? null } : null; }
  private get dir(): string { return path.join(this.d.cfg.workspace, ".qkt-studio", "chat"); }

  async send(r: SendRequest): Promise<{ conversationId: string; messageId: string }> {
    if (this.turn) throw new ChatBusy("a message is already being answered; wait for it or press Stop");
    // reserve the slot before the first await: two sends at the same moment must not both start a process
    let release!: () => void;
    const turn: Turn = { conversationId: "", messageId: "", grant: null, proc: null, halted: null, done: new Promise<void>((res) => { release = res; }) };
    this.turn = turn;
    try {
      const text = (r.text ?? "").trim();
      if (!text) throw new RangeError("the message is empty");
      if (text.length > 8000) throw new RangeError("the message is longer than 8000 characters");
      let st = await this.d.status.get();
      if (st.installed && !st.loggedIn) st = await this.d.status.get(true); // signed in a moment ago: do not wait for the cache
      if (!st.installed) throw new ChatUnavailable("Claude Code is not installed in this image");
      if (!st.loggedIn) throw new ChatUnavailable("Claude Code is not signed in: run `claude auth login` in the container (the Chat tab shows the command)");
      if (!this.mcpUrl) throw new ChatUnavailable("the studio is still starting");
      let conv: ConversationRow;
      if (r.conversationId) {
        const c = this.d.store.conversation(r.conversationId);
        if (!c) throw new ChatNotFound("no such conversation");
        conv = c;
      } else conv = this.d.store.createConversation(titleOf(text));
      const model: AgentModel = r.think ? "sonnet" : "haiku";
      const now = new Date().toISOString();
      this.d.store.addMessage({ id: randomUUID(), conversationId: conv.id, role: "user", text, model: null, status: "done", error: null, items: [], usage: null, created: now });
      const msg: ChatMessage = { id: randomUUID(), conversationId: conv.id, role: "assistant", text: "", model, status: "running", error: null, items: [], usage: null, created: now };
      this.d.store.addMessage(msg);
      turn.conversationId = conv.id; turn.messageId = msg.id;
      const prompt = composePrompt(viewReference(this.d.view.get(), await this.d.splitText(), r.omit ?? [], r.mentions ?? []), text);
      void this.run(turn, msg, prompt, model).finally(() => { this.turn = null; release(); });
      return { conversationId: conv.id, messageId: msg.id };
    } catch (e) {
      this.turn = null; release();
      throw e;
    }
  }

  /**
   * Stop: the process group, then the runs and jobs this message started, the way the `cancel` tool does (runner.cancel
   * with purge, else jobs.cancel). A tool call already inside the studio when the CLI dies keeps running there and may
   * record a run after this loop: grant.afterStop cancels those as they are recorded (TeeSet). Resolves once the message has ended.
   */
  async stop(): Promise<boolean> {
    const turn = this.turn;
    if (!turn?.messageId) return false;
    const grant = turn.grant;
    const cancelOne = async (id: string) => { if (!(await this.d.runner.cancel(id, { purge: true }))) await this.d.jobs.cancel(id); };
    if (grant) grant.afterStop = (id) => void cancelOne(id).catch(() => undefined);
    await this.halt(turn, "stopped", "Stopped.");
    for (const id of [...(grant?.started ?? [])]) await cancelOne(id);
    await turn.done;
    return true;
  }

  /** The studio is shutting down: end a message in flight as interrupted. */
  async close(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    await this.halt(turn, "interrupted", "Interrupted: the studio stopped. Send again to continue.");
    await turn.done;
  }

  private async halt(turn: Turn, status: EndStatus, error: string): Promise<void> {
    if (turn.halted) return;
    turn.halted = { status, error };
    await turn.proc?.kill(2000);
  }

  private async run(turn: Turn, first: ChatMessage, prompt: string, model: AgentModel): Promise<void> {
    let msg = first;
    const emit = (ev: ChatEvent) => {
      msg = foldEvent(msg, ev);
      this.d.store.saveMessage(msg); // every event: a tab that (re)loads the conversation mid-stream sees it all
      this.d.events.emit({ t: "chat", conversationId: msg.conversationId, messageId: msg.id, ev });
    };
    try {
      for (let attempt = 0; ; attempt++) {
        const conv = this.d.store.conversation(msg.conversationId)!;
        const out = await this.once(turn, conv, prompt, model, emit);
        if (attempt === 0 && !out.ok && !turn.halted) {
          if (conv.sessionStarted && NO_SESSION.test(out.detail)) {
            this.d.store.setSession(conv.id, randomUUID(), false);
            emit({ k: "notice", text: "This chat's earlier context is gone from Claude Code (its folder was reset); continuing in a fresh session." });
            continue;
          }
          if (!conv.sessionStarted && SESSION_TAKEN.test(out.detail)) { this.d.store.setSession(conv.id, conv.sessionId, true); continue; }
        }
        const halted = turn.halted as Turn["halted"];
        emit({ k: "end", status: halted?.status ?? (out.ok ? "done" : "error"), error: halted?.error ?? (out.ok ? undefined : out.why), usage: out.usage });
        return;
      }
    } catch (e) {
      emit({ k: "end", status: "error", error: (e as Error).message });
    }
  }

  private async once(turn: Turn, conv: ConversationRow, prompt: string, model: AgentModel, emit: (ev: ChatEvent) => void): Promise<Outcome> {
    const grant = this.d.tokens.issue({ maxCalls: this.limits.maxCalls, onLimit: () => void this.halt(turn, "limit", `stopped at the limit (${this.limits.maxCalls} tool calls)`) });
    turn.grant = grant;
    // a fixed working folder: Claude Code files sessions by working directory, so --resume only finds them from the same one
    const cwd = path.join(this.dir, "cwd");
    await fs.mkdir(cwd, { recursive: true });
    const cfgFile = await writeMcpConfig(path.join(this.dir, "run"), turn.messageId, this.mcpUrl!, grant.token);
    const record = this.d.recordDir ? path.join(this.d.recordDir, `${turn.messageId}.jsonl`) : null;
    if (record) await fs.mkdir(this.d.recordDir!, { recursive: true });
    const toolStart = new Map<string, number>();
    const box: { result: ResultEv | null } = { result: null };
    const proc = startAgent(this.d.cfg.claudeBin ?? "claude", { model, sessionId: conv.sessionId, resume: conv.sessionStarted, systemPrompt: SYSTEM_PROMPT, mcpConfigPath: cfgFile }, prompt, {
      cwd, env: agentEnv(),
      onRaw: record ? (line) => { void fs.appendFile(record, `${line}\n`); } : undefined,
      onEvent: (ev) => {
        if (ev.k === "session" && !this.d.store.conversation(conv.id)?.sessionStarted) this.d.store.setSession(conv.id, conv.sessionId, true);
        if (ev.k === "tool") toolStart.set(ev.id, Date.now());
        if (ev.k === "tool_result") { const t0 = toolStart.get(ev.id); if (t0 !== undefined) ev = { ...ev, ms: Date.now() - t0 }; }
        if (ev.k === "result") box.result = ev;
        emit(ev);
      },
    });
    turn.proc = proc;
    if (turn.halted) void proc.kill(2000); // Stop pressed while this process was being set up
    const timer = setTimeout(() => void this.halt(turn, "limit", `stopped at the limit (${fmtLimit(this.limits.maxMs)})`), this.limits.maxMs);
    try {
      const exit = await proc.exited;
      const r = box.result;
      if (r?.ok) return { ok: true, why: "", detail: "", usage: r.usage };
      const stderr = exit.stderr.trim();
      const why = r?.text || (exit.code === 127 ? "Claude Code is not installed in this image" : stderr.split("\n").slice(-3).join(" ") || `Claude Code exited with code ${exit.code}`);
      return { ok: false, why, detail: `${r?.text ?? ""}\n${stderr}`, usage: r?.usage ?? null };
    } finally {
      clearTimeout(timer);
      this.d.tokens.revoke(grant.token);
      turn.proc = null;
      await fs.rm(cfgFile, { force: true });
    }
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/server && npx vitest run test/chat/manager.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/chat/prompt.ts packages/server/src/chat/manager.ts packages/server/src/agent/events.ts packages/server/test/chat/manager.test.ts
git commit -m "feat(chat): conversation manager - one process per message, resume by session, limits, Stop, usage, streamed events"
```

---

### Task 6: Chat routes and the studio wiring

**Files:**
- Create: `packages/server/src/chat/routes.ts`
- Modify: `packages/server/src/main.ts` (store, status cache, manager, routes, MCP URL on listen, shutdown)
- Test: `packages/server/test/chat/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-5; `describeSplit`, `getSplit`, `toolPathRefusal` (`mcp/util.ts`), the `budget` that `createStudio` already builds (phase 1).
- Produces (HTTP, all under `/api`, same token/host/origin rules):
  - `GET /api/chat/status[?refresh=1]` -> `{ installed, version, loggedIn, authMethod, subscriptionType, error, uid: number | null, busy: { conversationId, messageId } | null, limits: { calls: 25, minutes: 5 } }`
  - `GET /api/chat/conversations` -> `{ conversations: Array<{ id, title, updated, messages }> }`
  - `GET /api/chat/conversations/:id` -> `{ conversation: { id, title, updated }, messages: ChatMessage[] }` | 404
  - `POST /api/chat/send` body `{ conversationId?, text, think?, omit?: ViewKey[], mentions?: Mention[] }` -> 202 `{ conversationId, messageId }` | 400 | 404 | 409 busy | 503 unavailable
  - `POST /api/chat/stop` -> `{ stopped: boolean }`
  - SSE `/api/events`: `event: chat`, data `{ t: "chat", conversationId, messageId, ev }`
  - `parseSend(body): SendRequest` (exported for tests); `createStudio` also returns `chat: ChatManager`, `chatStore: ChatStore`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/chat/routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { ChatMessage } from "@qkt-studio/core";
import type { StudioEvent } from "../../src/agent/events.js";
import { createStudio } from "../../src/main.js";
import { parseSend } from "../../src/chat/routes.js";
import { fakeClaude, testConfig } from "../helpers.js";

let studio: Awaited<ReturnType<typeof createStudio>>, base: string, home: string, ws: string;
const H = { Authorization: "Bearer t0k", "Content-Type": "application/json" };
const get = async (u: string) => { const r = await fetch(`${base}${u}`, { headers: H }); return { status: r.status, body: await r.json() as any }; };
const post = async (u: string, b: unknown = {}) => { const r = await fetch(`${base}${u}`, { method: "POST", headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
const last = async (conv: string): Promise<ChatMessage> => (await get(`/api/chat/conversations/${conv}`)).body.messages.at(-1);
const settle = async (conv: string) => { const end = Date.now() + 30_000; for (;;) { const m = await last(conv); if (m.status !== "running") return m; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

beforeAll(async () => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-home-")));
  process.env.CLAUDE_CONFIG_DIR = home;
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "strategies", "ema.qkt"), "STRATEGY ema VERSION 1\n");
  studio = await createStudio(testConfig(ws, { token: "t0k", claudeBin: fakeClaude }));
  await studio.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await studio.app.close(); delete process.env.CLAUDE_CONFIG_DIR; rmSync(home, { recursive: true, force: true }); });

describe("/api/chat", () => {
  it("status says signed in and on which plan, never the account", async () => {
    const s = await get("/api/chat/status");
    expect(s.body).toMatchObject({ installed: true, loggedIn: true, subscriptionType: "max", busy: null, limits: { calls: 25, minutes: 5 } });
    expect(JSON.stringify(s.body)).not.toMatch(/person@example|org-123/);
  });
  it("a whole message: tool calls go through /api/mcp with the per-process token; the 26th is refused and the message ends at the limit", async () => {
    const seen: StudioEvent[] = [];
    const off = studio.events.subscribe((e) => { if (e.t === "chat") seen.push(e); });
    const r = await post("/api/chat/send", { text: "loop over the files" });
    expect(r.status).toBe(202);
    const m = await settle(r.body.conversationId);
    off();
    expect(m).toMatchObject({ status: "limit", error: "stopped at the limit (25 tool calls)" });
    const tools = m.items.filter((i) => i.type === "tool");
    expect(tools.slice(0, 25).every((t) => t.type === "tool" && t.result && !t.result.isError)).toBe(true);
    expect(seen.some((e) => e.t === "chat" && e.ev.k === "end" && e.ev.status === "limit")).toBe(true);
    expect(studio.tokens.size()).toBe(0);
    expect((await get("/api/chat/conversations")).body.conversations[0]).toMatchObject({ id: r.body.conversationId, title: "loop over the files", messages: 2 });
  });
  it("one message at a time over HTTP, and Stop", async () => {
    const a = await post("/api/chat/send", { text: "keep working" });
    expect(a.status).toBe(202);
    expect((await post("/api/chat/send", { text: "hi" })).status).toBe(409);
    expect((await get("/api/chat/status")).body.busy).toEqual({ conversationId: a.body.conversationId, messageId: a.body.messageId });
    expect((await post("/api/chat/stop")).body).toEqual({ stopped: true });
    expect((await last(a.body.conversationId)).status).toBe("stopped");
  });
  it("signed out: status says so and a send is refused with the reason", async () => {
    writeFileSync(path.join(home, "fake-signed-out"), "");
    try {
      expect((await get("/api/chat/status?refresh=1")).body.loggedIn).toBe(false);
      const r = await post("/api/chat/send", { text: "hi" });
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/not signed in/);
    } finally { rmSync(path.join(home, "fake-signed-out")); await get("/api/chat/status?refresh=1"); }
  });
  it("bad input: empty text 400, unknown conversation 404, and the body is cleaned", async () => {
    expect((await post("/api/chat/send", { text: "" })).status).toBe(400);
    expect((await post("/api/chat/send", { text: "hi", conversationId: "nope" })).status).toBe(404);
    expect(parseSend({ text: "x", omit: ["run", "evil"], think: "yes", mentions: [{ label: "@a", ref: "b" }, { label: 1 }, { label: "@env", ref: ".env" }, { label: "@r", ref: "runs/abc/result.json" }, { label: "@up", ref: "../etc/passwd" }, ...Array(20).fill({ label: "@c", ref: "d" })] }))
      .toEqual({ conversationId: null, text: "x", think: false, omit: ["run"], mentions: [{ label: "@a", ref: "b" }, ...Array(9).fill({ label: "@c", ref: "d" })] });
  });
  it("a studio restart marks a message cut off mid-answer as interrupted; the conversation continues", async () => {
    const a = await post("/api/chat/send", { text: "keep working" });
    await new Promise((r) => setTimeout(r, 300));
    await studio.app.close(); // shutdown ends the message in flight as interrupted
    studio = await createStudio(testConfig(ws, { token: "t0k", claudeBin: fakeClaude }));
    await studio.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(studio.app.server.address() as { port: number }).port}`;
    expect((await last(a.body.conversationId)).status).toBe("interrupted");
    const b = await post("/api/chat/send", { conversationId: a.body.conversationId, text: "hi" });
    expect(b.status).toBe(202);
    expect((await settle(a.body.conversationId)).status).toBe("done");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/server && npx vitest run test/chat/routes.test.ts`
Expected: FAIL, `Cannot find module '../../src/chat/routes.js'`.

- [ ] **Step 3: The routes**

```ts
// packages/server/src/chat/routes.ts
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { VIEW_KEYS, type Mention, type ViewKey } from "@qkt-studio/core";
import { toolPathRefusal } from "../mcp/util.js";
import type { ClaudeStatusCache } from "./auth.js";
import { ChatBusy, ChatNotFound, ChatUnavailable, type ChatLimits, type ChatManager, type SendRequest } from "./manager.js";
import type { ChatStore } from "./store.js";

/**
 * A mention's ref is text in the prompt, never read by the chat itself (every file access is a tool call, which goes
 * through toolPath). A ref that is a single path-like word (no spaces: "strategies/x.qkt", ".env", "runs/abc") is still held
 * to the tools' path policy here, so the chat never points the model at a file the tools would refuse. Refs with spaces
 * ("run r-9", "trade #3 of the run on screen") are descriptions, not paths.
 */
const mentionAllowed = (ref: string) => /\s/.test(ref) || toolPathRefusal(path.posix.normalize(ref.replace(/\\/g, "/")).replace(/^(\.\/)+/, "")) === null;

/** The browser's send body, validated and trimmed to what the manager accepts. */
export function parseSend(b: Record<string, unknown>): SendRequest {
  if (typeof b.text !== "string") throw new RangeError("text is required");
  const omit = Array.isArray(b.omit) ? b.omit.filter((k): k is ViewKey => (VIEW_KEYS as readonly unknown[]).includes(k)) : [];
  const mentions: Mention[] = Array.isArray(b.mentions)
    ? b.mentions.flatMap((m) => { const x = (m ?? {}) as Record<string, unknown>; return typeof x.label === "string" && typeof x.ref === "string" && mentionAllowed(x.ref) ? [{ label: x.label.slice(0, 60), ref: x.ref.slice(0, 200) }] : []; }).slice(0, 10)
    : [];
  return { conversationId: typeof b.conversationId === "string" ? b.conversationId : null, text: b.text, think: b.think === true, omit, mentions };
}

export function registerChatRoutes(app: FastifyInstance, chat: ChatManager, store: ChatStore, status: ClaudeStatusCache, limits: ChatLimits): void {
  app.get<{ Querystring: { refresh?: string } }>("/api/chat/status", async (req) => ({
    ...(await status.get(req.query.refresh === "1")),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    busy: chat.busy(),
    limits: { calls: limits.maxCalls, minutes: Math.round(limits.maxMs / 60_000) },
  }));
  app.get("/api/chat/conversations", async () => ({ conversations: store.list(50).map((c) => ({ id: c.id, title: c.title, updated: c.updated, messages: c.messages })) }));
  app.get<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const c = store.conversation(req.params.id);
    if (!c) return reply.code(404).send({ error: "no such conversation" });
    return { conversation: { id: c.id, title: c.title, updated: c.updated }, messages: store.messages(c.id) };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/chat/send", async (req, reply) => {
    try { return reply.code(202).send(await chat.send(parseSend(req.body ?? {}))); }
    catch (e) {
      const code = e instanceof ChatBusy ? 409 : e instanceof ChatUnavailable ? 503 : e instanceof ChatNotFound ? 404 : e instanceof RangeError ? 400 : 0;
      if (!code) throw e;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });
  app.post("/api/chat/stop", async () => ({ stopped: await chat.stop() }));
}
```

- [ ] **Step 4: Wire it into `createStudio`**

In `packages/server/src/main.ts` add imports:

```ts
import path from "node:path";
import { describeSplit } from "@qkt-studio/core";
import { getSplit } from "./split.js";
import { ChatStore } from "./chat/store.js";
import { ClaudeStatusCache } from "./chat/auth.js";
import { ChatManager, LIMITS } from "./chat/manager.js";
import { registerChatRoutes } from "./chat/routes.js";
import { mcpHost } from "./chat/agent.js";
```

(`registerSplitRoutes` is already imported from `./split.js`; extend that import with `getSplit`.) After `const tokens = new ChatTokens();`:

```ts
  const chatStore = new ChatStore(path.join(cfg.workspace, ".qkt-studio", "chat", "chat.sqlite"));
  chatStore.markInterrupted(); // a message cut off by a restart
  const claude = new ClaudeStatusCache(cfg.claudeBin ?? "claude", cfg.workspace);
  const chat = new ChatManager({ cfg, store: chatStore, tokens, events, view, status: claude, runner, jobs,
    splitText: async () => describeSplit(await getSplit(cfg)), recordDir: process.env.CHAT_RECORD_DIR || undefined });
```

Inside the `buildApp` register callback add `registerChatRoutes(a, chat, chatStore, claude, LIMITS);`. Replace the existing `onClose` hook and add the listen hook:

```ts
  // the CLI reaches /api/mcp over loopback; the port is known only once the server listens (0 in tests)
  app.addHook("onListen", async () => {
    const addr = app.server.address();
    if (addr && typeof addr === "object") chat.setMcpUrl(`http://${mcpHost(cfg.host)}:${addr.port}/api/mcp`);
  });
  app.addHook("onClose", async () => { await chat.close(); chatStore.close(); await runner.close(); });
  return { app, runner, jobs, data, events, view, proposals, variants, budget, tokens, chat, chatStore };
```

- [ ] **Step 5: Run the server suite**

Run: `cd packages/server && npx vitest run test/chat && pnpm --filter @qkt-studio/server build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/chat/routes.ts packages/server/src/main.ts packages/server/test/chat/routes.test.ts
git commit -m "feat(chat): /api/chat routes, events on the studio stream, interrupted messages after a restart"
```

---
### Task 7: Web - chat state, message conversion, @ mentions, and the dock rule

**Files:**
- Create: `packages/web/src/chat/state.ts`, `packages/web/src/chat/convert.ts`, `packages/web/src/chat/mentions.ts`
- Modify: `packages/web/package.json` (dependencies), `packages/web/src/api/client.ts` (chat calls), `packages/web/src/state/agent.ts` (the `chat` SSE event), `packages/web/src/state/ui.ts` (`DockTab` gains `"chat"`), `packages/web/src/shell/App.tsx` (the run pipeline does not take over the Chat tab)
- Test: `packages/web/src/chat/state.test.ts`, `packages/web/src/chat/convert.test.ts`, `packages/web/src/chat/mentions.test.ts`

**Interfaces:**
- Consumes: `ChatEvent`, `ChatMessage`, `Mention`, `Usage`, `ViewKey`, `foldEvent`, `tokensIn` from `@qkt-studio/core/chat` (Task 1); the HTTP routes and SSE event of Task 6; `ThreadMessageLike` type from `@assistant-ui/react`.
- Produces:
  - `interface ChatStatusInfo { installed: boolean; version: string | null; loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; error: string | null; uid: number | null; busy: { conversationId: string; messageId: string } | null; limits: { calls: number; minutes: number } }`; `interface ConversationInfo { id: string; title: string; updated: string; messages: number }`; `interface ChatWire { conversationId: string; messageId: string; ev: ChatEvent }`
  - `useChat` (Zustand): `{ status: ChatStatusInfo | null; conversations: ConversationInfo[]; conversationId: string | null; messages: ChatMessage[]; busy: boolean; think: boolean; omit: ViewKey[]; sendError: string | null; loadStatus(refresh?: boolean): Promise<void>; loadConversations(): Promise<void>; open(id: string): Promise<void>; newChat(): void; send(text: string, mentions: Mention[]): Promise<boolean>; stop(): Promise<void>; onEvent(w: ChatWire): void; setThink(b: boolean): void; toggleOmit(k: ViewKey): void }`
  - Pure: `applyWire(messages, conversationId, w): ChatMessage[] | null`; `shouldRevealPipeline({ dockOpen, dockTab, chatBusy }): boolean`; `viewChips({ activePath, runId, visible, selectedTrade, variantLabel, splitText }): Array<{ key: ViewKey; label: string }>`; `planText(status): string`; `usageText(u: Usage | null): { text: string; title: string } | null`; `LONG_CHAT = 20`
  - `toThreadMessage(m: ChatMessage): ThreadMessageLike`; `stepLabel(toolName: string): string`; `interface FooterData { status: ChatMessage["status"]; error: string | null; usage: Usage | null; model: string | null }`
  - `interface MentionOption { label: string; ref: string; hint: string }`; `mentionOptions(c: { strategies: string[]; runId: string | null; selectedTrade: number | null; symbols: string[] }): MentionOption[]`; `mentionQuery(text: string, caret: number): { start: number; query: string } | null`; `filterMentions(opts, query, max?): MentionOption[]`; `insertMention(text, start, caret, label): { text: string; caret: number }`; `mentionsIn(text: string, opts: MentionOption[]): Mention[]`
  - `api.chatStatus(refresh?)`, `api.chatConversations()`, `api.chatConversation(id)`, `api.chatSend(body)`, `api.chatStop()`

- [ ] **Step 1: Add the dependencies**

Run: `cd packages/web && pnpm add --save-exact @assistant-ui/react@0.15.22 react-markdown@10.1.0 remark-gfm@4.0.1`
Expected: `package.json` dependencies gain exactly those three versions; `pnpm-lock.yaml` updated.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/web/src/chat/state.test.ts
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@qkt-studio/core/chat";
import { applyWire, planText, shouldRevealPipeline, usageText, viewChips } from "./state.js";

const msg = (id: string): ChatMessage => ({ id, conversationId: "c1", role: "assistant", text: "", model: "haiku", status: "running", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" });

describe("chat state helpers", () => {
  it("applies a streamed event to the open conversation; unknown message -> null (refetch); other conversation -> unchanged", () => {
    const ms = [msg("m1")];
    expect(applyWire(ms, "c1", { conversationId: "c1", messageId: "m1", ev: { k: "text", text: "hi" } })![0]!.text).toBe("hi");
    expect(applyWire(ms, "c1", { conversationId: "c1", messageId: "m2", ev: { k: "text", text: "hi" } })).toBeNull();
    expect(applyWire(ms, "c1", { conversationId: "c9", messageId: "m1", ev: { k: "text", text: "hi" } })).toBe(ms);
  });
  it("the pipeline pops up for runs, except over an open Chat tab that is answering", () => {
    expect(shouldRevealPipeline({ dockOpen: true, dockTab: "chat", chatBusy: true })).toBe(false);
    expect(shouldRevealPipeline({ dockOpen: true, dockTab: "chat", chatBusy: false })).toBe(true);
    expect(shouldRevealPipeline({ dockOpen: false, dockTab: "chat", chatBusy: true })).toBe(true);
    expect(shouldRevealPipeline({ dockOpen: true, dockTab: "terminal", chatBusy: true })).toBe(true);
  });
  it("chips show what the view reference will carry", () => {
    expect(viewChips({ activePath: "strategies/ema.qkt", runId: "r1", visible: true, selectedTrade: 7, variantLabel: "stop 2 %", splitText: "test = last 25 %" }))
      .toEqual([{ key: "file", label: "ema.qkt" }, { key: "run", label: "run r1" }, { key: "range", label: "chart range" }, { key: "trade", label: "trade #7" }, { key: "variant", label: "variant: stop 2 %" }, { key: "split", label: "split: test = last 25 %" }]);
    expect(viewChips({ activePath: null, runId: null, visible: false, selectedTrade: null, variantLabel: null, splitText: null })).toEqual([]);
  });
  it("plan and usage lines", () => {
    expect(planText({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })).toBe("Signed in · Claude Max");
    expect(planText({ loggedIn: true, authMethod: "api_key", subscriptionType: null })).toBe("Signed in with an API key");
    expect(planText(null)).toBe("Not signed in");
    expect(usageText({ inputTokens: 400, outputTokens: 1200, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.0123, turns: 2, durationMs: 1 }))
      .toEqual({ text: "2.4k in · 1.2k out · counts toward your Claude plan", title: "API-equivalent cost: $0.012" });
    expect(usageText(null)).toBeNull();
  });
});
```

```ts
// packages/web/src/chat/convert.test.ts
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@qkt-studio/core/chat";
import { stepLabel, toThreadMessage } from "./convert.js";

const base: ChatMessage = { id: "m", conversationId: "c", role: "assistant", text: "", model: "haiku", status: "done", error: null, items: [], usage: null, created: "2026-09-29T00:00:00Z" };

describe("toThreadMessage", () => {
  it("a user message is exactly what the user typed", () => {
    expect(toThreadMessage({ ...base, role: "user", text: "stop 2 %" })).toMatchObject({ id: "m", role: "user", content: [{ type: "text", text: "stop 2 %" }] });
  });
  it("assistant items become text, tool-call and notice parts in order, then a footer once finished", () => {
    const t = toThreadMessage({ ...base, items: [{ type: "text", text: "Trying." }, { type: "tool", id: "t1", name: "try_change", input: { label: "x" }, result: { isError: false, text: "{}", ms: 3100 } }, { type: "notice", text: "retrying" }], usage: null });
    expect(t.content).toEqual([
      { type: "text", text: "Trying." },
      { type: "tool-call", toolCallId: "t1", toolName: "try_change", args: { label: "x" }, result: "{}", isError: false, artifact: { ms: 3100 } },
      { type: "data-notice", data: { text: "retrying" } },
      { type: "data-footer", data: { status: "done", error: null, usage: null, model: "haiku" } },
    ]);
    expect(t.status).toEqual({ type: "complete", reason: "stop" });
  });
  it("maps the message status; a running message has no footer; a non-object tool input becomes {}", () => {
    const run = toThreadMessage({ ...base, status: "running", items: [{ type: "tool", id: "t", name: "x", input: "odd" }] });
    expect(run.status).toEqual({ type: "running" });
    expect(run.content).toEqual([{ type: "tool-call", toolCallId: "t", toolName: "x", args: {}, result: undefined, isError: undefined, artifact: { ms: null } }]);
    expect(toThreadMessage({ ...base, status: "stopped" }).status).toEqual({ type: "incomplete", reason: "cancelled" });
    expect(toThreadMessage({ ...base, status: "error", error: "boom" }).status).toEqual({ type: "incomplete", reason: "error", error: "boom" });
    expect(toThreadMessage({ ...base, status: "limit" }).status).toEqual({ type: "incomplete", reason: "other" });
  });
  it("names tool steps in plain words", () => {
    expect(stepLabel("run_backtest")).toBe("ran backtest");
    expect(stepLabel("something_new")).toBe("something new");
  });
});
```

```ts
// packages/web/src/chat/mentions.test.ts
import { describe, it, expect } from "vitest";
import { filterMentions, insertMention, mentionOptions, mentionQuery, mentionsIn } from "./mentions.js";

const opts = mentionOptions({ strategies: ["strategies/ema_cross.qkt", "strategies/config.qkt"], runId: "r-9", selectedTrade: 12, symbols: ["XAUUSD"] });

describe("@ mentions", () => {
  it("offers the fixed references, strategies by name, the run, the selected trade and symbols; a keyword wins over a same-named file", () => {
    expect(opts.map((o) => o.label)).toEqual(["@config", "@instruments", "@chart", "@split", "@run", "@trade#12", "@ema_cross", "@XAUUSD"]);
    expect(opts.find((o) => o.label === "@ema_cross")!.ref).toBe("strategies/ema_cross.qkt");
  });
  it("finds the @word being typed at the caret, only at a word start", () => {
    expect(mentionQuery("do the same in @em", 18)).toEqual({ start: 15, query: "em" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail me@example", 15)).toBeNull();
    expect(mentionQuery("@ema then", 9)).toBeNull();
  });
  it("filters by prefix first, then substring", () => {
    expect(filterMentions(opts, "c").map((o) => o.label)).toEqual(["@config", "@chart", "@ema_cross"]);
  });
  it("inserts the chosen label with a space and puts the caret after it", () => {
    expect(insertMention("same in @em please", 8, 11, "@ema_cross")).toEqual({ text: "same in @ema_cross  please", caret: 19 });
  });
  it("collects the known mentions of a message once each, plus any @trade#N", () => {
    expect(mentionsIn("compare @ema_cross with @config, and @trade#3 and @nobody, @ema_cross again", opts)).toEqual([
      { label: "@ema_cross", ref: "strategies/ema_cross.qkt" }, { label: "@config", ref: "qkt.config.yaml" }, { label: "@trade#3", ref: "trade #3 of the run on screen" },
    ]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd packages/web && npx vitest run src/chat`
Expected: FAIL, modules `./state.js`, `./convert.js`, `./mentions.js` not found.

- [ ] **Step 4: Implement `mentions.ts`**

```ts
// packages/web/src/chat/mentions.ts
import type { Mention } from "@qkt-studio/core/chat";

export interface MentionOption { label: string; ref: string; hint: string }
const stem = (p: string) => p.split("/").pop()!.replace(/\.qkt$/, "");

/** What "@" can refer to. Mentions are optional precision: the view reference already names what is on screen. */
export function mentionOptions(c: { strategies: string[]; runId: string | null; selectedTrade: number | null; symbols: string[] }): MentionOption[] {
  const out: MentionOption[] = [
    { label: "@config", ref: "qkt.config.yaml", hint: "qkt.config.yaml" },
    { label: "@instruments", ref: "instruments.yaml", hint: "instruments.yaml" },
    { label: "@chart", ref: "the chart: the run on screen, visible range, selected trade and variant (get_context)", hint: "what the chart shows" },
    { label: "@split", ref: "the split into a first part and a test part (get_split)", hint: "the split" },
  ];
  if (c.runId) out.push({ label: "@run", ref: `run ${c.runId}`, hint: c.runId });
  if (c.selectedTrade !== null) out.push({ label: `@trade#${c.selectedTrade}`, ref: `trade #${c.selectedTrade} of the run on screen`, hint: "the selected trade" });
  for (const p of c.strategies) out.push({ label: `@${stem(p)}`, ref: p, hint: p });
  for (const s of c.symbols) out.push({ label: `@${s}`, ref: `symbol ${s}`, hint: "symbol" });
  const seen = new Set<string>();
  return out.filter((o) => { const k = o.label.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The "@word" being typed at the caret: "@" at the start or after whitespace, up to the caret. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\w#.-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

export function filterMentions(opts: MentionOption[], query: string, max = 8): MentionOption[] {
  const q = query.toLowerCase();
  const starts = opts.filter((o) => o.label.slice(1).toLowerCase().startsWith(q));
  const has = opts.filter((o) => !starts.includes(o) && o.label.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, max);
}

export function insertMention(text: string, start: number, caret: number, label: string): { text: string; caret: number } {
  return { text: `${text.slice(0, start)}${label} ${text.slice(caret)}`, caret: start + label.length + 1 };
}

/** The mentions a message carries: each known "@label" once, plus "@trade#N" for any N. */
export function mentionsIn(text: string, opts: MentionOption[]): Mention[] {
  const out: Mention[] = [], seen = new Set<string>();
  for (const m of text.matchAll(/(^|\s)(@[\w#.-]+)/g)) {
    const label = m[2]!.replace(/[.,;:!?]+$/, ""), key = label.toLowerCase();
    if (seen.has(key)) continue;
    const o = opts.find((x) => x.label.toLowerCase() === key), trade = /^@trade#(\d+)$/i.exec(label);
    if (o) out.push({ label: o.label, ref: o.ref });
    else if (trade) out.push({ label, ref: `trade #${trade[1]} of the run on screen` });
    else continue;
    seen.add(key);
  }
  return out;
}
```

- [ ] **Step 5: Implement `convert.ts`**

```ts
// packages/web/src/chat/convert.ts
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage, Usage } from "@qkt-studio/core/chat";

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type ToolArgs = Extract<Part, { type: "tool-call" }>["args"];
export interface FooterData { status: ChatMessage["status"]; error: string | null; usage: Usage | null; model: string | null }

function statusOf(m: ChatMessage): ThreadMessageLike["status"] {
  switch (m.status) {
    case "running": return { type: "running" };
    case "done": return { type: "complete", reason: "stop" };
    case "stopped": return { type: "incomplete", reason: "cancelled" };
    case "error": return { type: "incomplete", reason: "error", error: m.error ?? undefined };
    default: return { type: "incomplete", reason: "other" };
  }
}

/** Our stored message -> the chat UI's message: text, tool steps, notices, and a footer (status, usage) once finished. */
export function toThreadMessage(m: ChatMessage): ThreadMessageLike {
  if (m.role === "user") return { id: m.id, role: "user", content: [{ type: "text", text: m.text }], createdAt: new Date(m.created) };
  const content: Part[] = m.items.map((i): Part => {
    if (i.type === "text") return { type: "text", text: i.text };
    if (i.type === "notice") return { type: "data-notice", data: { text: i.text } };
    const args = (i.input && typeof i.input === "object" && !Array.isArray(i.input) ? i.input : {}) as ToolArgs;
    return { type: "tool-call", toolCallId: i.id, toolName: i.name, args, result: i.result?.text, isError: i.result?.isError, artifact: { ms: i.result?.ms ?? null } };
  });
  if (m.status !== "running") content.push({ type: "data-footer", data: { status: m.status, error: m.error, usage: m.usage, model: m.model } satisfies FooterData });
  return { id: m.id, role: "assistant", content, createdAt: new Date(m.created), status: statusOf(m) };
}

const VERBS: Record<string, string> = {
  try_change: "tried a change", try_variants: "tried variants", run_backtest: "ran backtest", run_walkforward: "started a walk-forward",
  sweep: "started a sweep", job_status: "checked a job", cancel: "cancelled", get_context: "read the view", list_files: "listed files",
  read_file: "read a file", list_runs: "listed runs", get_run: "read a run", dsl_reference: "read the DSL reference", dsl_examples: "looked up examples",
  config_reference: "read the config reference", instruments_reference: "read the instruments reference", data_status: "checked the data",
  run_summary: "read the run summary", diagnose_exits: "diagnosed exits", diagnose_entries: "diagnosed entries", trades: "listed trades",
  trade_detail: "read a trade", compare_runs: "compared runs", check_strategy: "checked DSL", create_strategy: "created a strategy",
  propose_strategy_edit: "proposed an edit", get_config: "read the config", propose_config: "proposed a config change", get_instrument: "read an instrument",
  propose_instrument: "proposed an instrument change", get_split: "read the split", set_split: "changed the split", list_variants: "listed variants",
  discard_variant: "discarded a variant", propose_build_bars: "proposed a data build",
};
export const stepLabel = (name: string): string => VERBS[name] ?? name.replace(/_/g, " ");
```

- [ ] **Step 6: Implement `state.ts` and the API calls**

```ts
// packages/web/src/chat/state.ts
import { create } from "zustand";
import { foldEvent, tokensIn, type ChatEvent, type ChatMessage, type Mention, type Usage, type ViewKey } from "@qkt-studio/core/chat";
import { api } from "../api/client.js";
import type { DockTab } from "../state/ui.js";

export interface ChatStatusInfo {
  installed: boolean; version: string | null; loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; error: string | null;
  uid: number | null; busy: { conversationId: string; messageId: string } | null; limits: { calls: number; minutes: number };
}
export interface ConversationInfo { id: string; title: string; updated: string; messages: number }
export interface ChatWire { conversationId: string; messageId: string; ev: ChatEvent }
/** A chat this long re-reads a lot on every message: the header offers a fresh one. */
export const LONG_CHAT = 20;

/** Pure: one streamed event into the open conversation. Another conversation: unchanged; an unknown message: null (refetch). */
export function applyWire(messages: ChatMessage[], conversationId: string | null, w: ChatWire): ChatMessage[] | null {
  if (w.conversationId !== conversationId) return messages;
  const i = messages.findIndex((m) => m.id === w.messageId);
  if (i < 0) return null;
  const next = messages.slice();
  next[i] = foldEvent(next[i]!, w.ev);
  return next;
}

/** Pure: a run normally pops the Pipeline tab open; not over an open Chat tab that is answering (its own tools start runs). */
export function shouldRevealPipeline(a: { dockOpen: boolean; dockTab: DockTab; chatBusy: boolean }): boolean {
  return !(a.dockOpen && a.dockTab === "chat" && a.chatBusy);
}

/** Pure: the chips above the message box, one per part of the view reference that will be sent. */
export function viewChips(s: { activePath: string | null; runId: string | null; visible: boolean; selectedTrade: number | null; variantLabel: string | null; splitText: string | null }): Array<{ key: ViewKey; label: string }> {
  const out: Array<{ key: ViewKey; label: string }> = [];
  if (s.activePath) out.push({ key: "file", label: s.activePath.split("/").pop()! });
  if (s.runId) out.push({ key: "run", label: `run ${s.runId}` });
  if (s.visible) out.push({ key: "range", label: "chart range" });
  if (s.selectedTrade !== null) out.push({ key: "trade", label: `trade #${s.selectedTrade}` });
  if (s.variantLabel) out.push({ key: "variant", label: `variant: ${s.variantLabel}` });
  if (s.splitText) out.push({ key: "split", label: `split: ${s.splitText}` });
  return out;
}

export function planText(s: { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null } | null): string {
  if (!s?.loggedIn) return "Not signed in";
  if (s.authMethod && /api/i.test(s.authMethod)) return "Signed in with an API key";
  return s.subscriptionType ? `Signed in · Claude ${s.subscriptionType[0]!.toUpperCase()}${s.subscriptionType.slice(1)}` : "Signed in";
}

export function usageText(u: Usage | null): { text: string; title: string } | null {
  if (!u) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return { text: `${k(tokensIn(u))} in · ${k(u.outputTokens)} out · counts toward your Claude plan`, title: u.costUsd === null ? "" : `API-equivalent cost: $${u.costUsd.toFixed(3)}` };
}

// one refetch at a time; events arriving meanwhile ask for one more when it lands
let opening: Promise<void> | null = null, again = false;

export const useChat = create<{
  status: ChatStatusInfo | null; conversations: ConversationInfo[]; conversationId: string | null; messages: ChatMessage[];
  busy: boolean; think: boolean; omit: ViewKey[]; sendError: string | null;
  loadStatus(refresh?: boolean): Promise<void>; loadConversations(): Promise<void>; open(id: string): Promise<void>; newChat(): void;
  send(text: string, mentions: Mention[]): Promise<boolean>; stop(): Promise<void>; onEvent(w: ChatWire): void;
  setThink(b: boolean): void; toggleOmit(k: ViewKey): void;
}>((set, get) => ({
  status: null, conversations: [], conversationId: null, messages: [], busy: false, think: false, omit: [], sendError: null,
  async loadStatus(refresh = false) {
    try { const s = await api.chatStatus(refresh); set({ status: s, busy: !!s.busy }); }
    catch (e) { set({ sendError: (e as Error).message }); }
  },
  async loadConversations() { try { set({ conversations: (await api.chatConversations()).conversations }); } catch { /* the list refreshes on the next message */ } },
  async open(id) { const r = await api.chatConversation(id); set({ conversationId: id, messages: r.messages }); },
  newChat() { set({ conversationId: null, messages: [], sendError: null }); },
  async send(text, mentions) {
    set({ sendError: null });
    try {
      const r = await api.chatSend({ conversationId: get().conversationId, text, think: get().think, omit: get().omit, mentions });
      set({ busy: true, omit: [], think: false, conversationId: r.conversationId }); // Think harder and removed chips are for one message
      await get().open(r.conversationId);
      void get().loadConversations();
      return true;
    } catch (e) { set({ sendError: (e as Error).message }); return false; }
  },
  async stop() { await api.chatStop().catch(() => undefined); },
  onEvent(w) {
    if (w.ev.k === "end") { set({ busy: false }); void get().loadConversations(); }
    else if (!get().busy) set({ busy: true }); // a message sent from another tab
    const next = applyWire(get().messages, get().conversationId, w);
    if (next === null) {
      if (opening) { again = true; return; }
      const id = w.conversationId;
      opening = get().open(id).catch(() => undefined).finally(() => { opening = null; if (again) { again = false; void get().open(id); } });
      return;
    }
    if (next !== get().messages) set({ messages: next });
  },
  setThink(b) { set({ think: b }); },
  toggleOmit(k) { const o = get().omit; set({ omit: o.includes(k) ? o.filter((x) => x !== k) : [...o, k] }); },
}));
```

In `api/client.ts`, add to `api` (type-only imports, as the phase 1 calls do, so no import cycle):

```ts
  chatStatus: (refresh = false) => req<import("../chat/state.js").ChatStatusInfo>(`/api/chat/status${refresh ? "?refresh=1" : ""}`),
  chatConversations: () => req<{ conversations: import("../chat/state.js").ConversationInfo[] }>("/api/chat/conversations"),
  chatConversation: (id: string) => req<{ conversation: { id: string; title: string; updated: string }; messages: import("@qkt-studio/core/chat").ChatMessage[] }>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  chatSend: (b: { conversationId: string | null; text: string; think: boolean; omit: import("@qkt-studio/core/chat").ViewKey[]; mentions: import("@qkt-studio/core/chat").Mention[] }) =>
    req<{ conversationId: string; messageId: string }>("/api/chat/send", { method: "POST", body: JSON.stringify(b) }),
  chatStop: () => req<{ stopped: boolean }>("/api/chat/stop", { method: "POST" }),
```

- [ ] **Step 7: Wire the stream, the dock tab type and the pipeline rule**

`state/ui.ts`: `export type DockTab = "pipeline" | "problems" | "terminal" | "chat";`

`state/agent.ts`: add `import { useChat, type ChatWire } from "../chat/state.js";` and, in `start()` next to the other listeners:

```ts
    src.addEventListener("chat", (m) => useChat.getState().onEvent(JSON.parse((m as MessageEvent).data as string) as ChatWire));
```

`shell/App.tsx`: import `{ shouldRevealPipeline, useChat } from "../chat/state.js"` and replace the two pipeline effects with:

```ts
  // the output panel opens by itself when a run starts or fails, so the steps are never hidden; but not over an open Chat
  // tab while it is answering: the chat's own tool calls start runs, and its steps already show them
  useEffect(() => {
    const reveal = () => { const u = useUi.getState(); if (shouldRevealPipeline({ dockOpen: u.dockOpen, dockTab: u.dockTab, chatBusy: useChat.getState().busy })) u.set({ dockOpen: true, dockTab: "pipeline" }); };
    if (running || run?.status === "failed") reveal();
  }, [running, run?.status]);
```

- [ ] **Step 8: Run the tests and the type check**

Run: `cd packages/web && npx vitest run src/chat src/state && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/web/package.json pnpm-lock.yaml packages/web/src/chat/state.ts packages/web/src/chat/convert.ts packages/web/src/chat/mentions.ts packages/web/src/chat/*.test.ts packages/web/src/api/client.ts packages/web/src/state/agent.ts packages/web/src/state/ui.ts packages/web/src/shell/App.tsx
git commit -m "feat(web): chat state fed by the studio's event stream, @ mentions, and the pipeline no longer takes over an answering chat"
```

---

### Task 8: Web - the Chat tab (thread, composer, header, sign-in card)

**Files:**
- Create: `packages/web/src/chat/ChatTab.tsx`, `ChatHeader.tsx`, `Thread.tsx`, `parts.tsx`, `Composer.tsx`, `SetupCard.tsx`, `chat.css`
- Modify: `packages/web/src/dock/Dock.tsx` (the tab, lazy), `packages/web/src/ui/icons.ts` (`MessageSquare`, `Brain`)
- Test: type check and build here; the browser check in Task 11

**Interfaces:**
- Consumes: `useChat`, `viewChips`, `planText`, `usageText`, `LONG_CHAT` (Task 7); `toThreadMessage`, `stepLabel`, `FooterData` (Task 7); `mentionOptions`, `mentionQuery`, `filterMentions`, `insertMention`, `mentionsIn` (Task 7); `useStore` (`activePath`, `runId`, `selectedTrip`, `focus`, `tree`, `scan`), `useAgent` (`showing`, `split`), `SplitChip` (phase 1).
- Produces: `ChatTab` (default dock body for `"chat"`); `parts.tsx` exports `MarkdownText`, `UserText`, `ToolStep`, `DataPart` (Task 9 adds cards inside `ToolStep`).

- [ ] **Step 1: Icons** — add `MessageSquare, Brain` to the export list in `ui/icons.ts`.

- [ ] **Step 2: The parts**

```tsx
// packages/web/src/chat/parts.tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DataMessagePartProps, TextMessagePartProps, ToolCallMessagePartProps } from "@assistant-ui/react";
import { CircleCheck, CircleX, Info } from "../ui/icons.js";
import { stepLabel, type FooterData } from "./convert.js";
import { usageText } from "./state.js";

/** The reply's text: markdown (no raw HTML), links open outside the studio. */
export function MarkdownText({ text }: TextMessagePartProps) {
  return <div className="chat-md"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{text}</Markdown></div>;
}
export function UserText({ text }: TextMessagePartProps) { return <div className="chat-user-text">{text}</div>; }

/** One tool call as a compact step ("ran backtest · 3.2 s"), expandable to its arguments and result. */
export function ToolStep({ toolName, args, result, isError, artifact }: ToolCallMessagePartProps) {
  const ms = (artifact as { ms?: number | null } | undefined)?.ms ?? null, done = result !== undefined;
  return (
    <details className={`chat-step${isError ? " bad" : ""}`}>
      <summary>
        {done ? (isError ? <CircleX size={13} /> : <CircleCheck size={13} />) : <span className="spin" />}
        <span>{stepLabel(toolName)}</span>
        {ms !== null && <span className="muted num">· {(ms / 1000).toFixed(1)} s</span>}
      </summary>
      <pre className="mono chat-json">{JSON.stringify(args, null, 1)}</pre>
      {done && <pre className="mono chat-json">{String(result)}</pre>}
    </details>
  );
}

function Footer({ f }: { f: FooterData }) {
  const u = usageText(f.usage);
  const msg = f.status === "stopped" ? "Stopped." : f.status === "interrupted" ? "Interrupted by a studio restart. Send again to continue." : f.error;
  const planLimit = f.status === "error" && !!msg && /limit/i.test(msg);
  return (
    <div className="chat-foot">
      {f.status !== "done" && msg && <div className={`chat-end ${f.status}`} role="status">{msg}{planLimit && <span className="muted"> Try again later, or give Claude Code an Anthropic API key (see docs/production.md).</span>}</div>}
      {u && <div className="muted chat-usage" title={u.title}>{f.model === "sonnet" ? "Think harder · " : ""}{u.text}</div>}
    </div>
  );
}

/** Notices (retries, plan limit, a lost session) and the footer (how it ended, tokens). */
export function DataPart({ name, data }: DataMessagePartProps) {
  if (name === "notice") return <div className="chat-notice muted"><Info size={13} />{(data as { text: string }).text}</div>;
  if (name === "footer") return <Footer f={data as FooterData} />;
  return null;
}
```

- [ ] **Step 3: The thread (assistant-ui over our store)**

```tsx
// packages/web/src/chat/Thread.tsx
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { toThreadMessage } from "./convert.js";
import { DataPart, MarkdownText, ToolStep, UserText } from "./parts.js";
import { useChat } from "./state.js";

const textOf = (m: AppendMessage) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
function UserMessage() { return <MessagePrimitive.Root className="msg user"><MessagePrimitive.Parts components={{ Text: UserText }} /></MessagePrimitive.Root>; }
function AssistantMessage() {
  return <MessagePrimitive.Root className="msg assistant"><MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolStep }, data: { Fallback: DataPart } }} /></MessagePrimitive.Root>;
}
function EmptyHint() {
  return (
    <div className="chat-empty muted">
      <p>Say what to change or ask about what you see, in plain English:</p>
      <ul><li>make the stop-loss 2 percent and let's see</li><li>skip Fridays</li><li>why did this trade lose?</li><li>make the test part the last 2 months</li></ul>
      <p>The open file, the run on screen and the selected trade go with each message (the chips below). Type @ to name something else.</p>
    </div>
  );
}

/** The conversation, rendered by assistant-ui's unstyled primitives; the messages come from our store (the studio's stream). */
export function Thread() {
  const messages = useChat((s) => s.messages), busy = useChat((s) => s.busy);
  const runtime = useExternalStoreRuntime({
    messages, isRunning: busy, convertMessage: toThreadMessage,
    onNew: async (m: AppendMessage) => { await useChat.getState().send(textOf(m), []); },
    onCancel: async () => { await useChat.getState().stop(); },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport">
          {messages.length === 0 && <EmptyHint />}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
```

- [ ] **Step 4: The composer**

```tsx
// packages/web/src/chat/Composer.tsx
import { useMemo, useRef, useState } from "react";
import { useAgent } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { Brain, Square, X } from "../ui/icons.js";
import { filterMentions, insertMention, mentionOptions, mentionQuery, mentionsIn, type MentionOption } from "./mentions.js";
import { useChat, viewChips } from "./state.js";

/** Message box: context chips (removable for one message), @ mentions, Think harder, Send / Stop. Enter sends, Shift+Enter is a new line. */
export function Composer() {
  const [text, setText] = useState(""), [caret, setCaret] = useState(0), [active, setActive] = useState(0), [closedAt, setClosedAt] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const busy = useChat((s) => s.busy), think = useChat((s) => s.think), omit = useChat((s) => s.omit), err = useChat((s) => s.sendError);
  const activePath = useStore((s) => s.activePath), runId = useStore((s) => s.runId), trip = useStore((s) => s.selectedTrip), focus = useStore((s) => s.focus);
  const tree = useStore((s) => s.tree), scan = useStore((s) => s.scan);
  const showing = useAgent((s) => s.showing), split = useAgent((s) => s.split);
  const options = useMemo(() => mentionOptions({
    strategies: (tree["strategies"] ?? []).filter((e) => e.type === "file" && e.name.endsWith(".qkt")).map((e) => e.path),
    runId, selectedTrade: trip?.id ?? null, symbols: (scan?.symbols ?? []).map((s) => s.symbol).slice(0, 40),
  }), [tree, runId, trip, scan]);
  const q = mentionQuery(text, caret);
  const picks = q && closedAt !== q.start ? filterMentions(options, q.query) : [];
  const chips = viewChips({ activePath, runId, visible: !!focus, selectedTrade: trip?.id ?? null, variantLabel: showing?.label ?? null, splitText: split?.text ?? null });

  const choose = (o: MentionOption) => {
    if (!q) return;
    const r = insertMention(text, q.start, caret, o.label);
    setText(r.text); setCaret(r.caret);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(r.caret, r.caret); });
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (await useChat.getState().send(t, mentionsIn(t, options))) { setText(""); setCaret(0); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picks.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % picks.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + picks.length) % picks.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(picks[Math.min(active, picks.length - 1)]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setClosedAt(q!.start); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };

  return (
    <div className="chat-composer">
      {chips.length > 0 && (
        <div className="chat-chips" aria-label="Sent with this message">
          {chips.map((c) => {
            const off = omit.includes(c.key);
            return <button key={c.key} className={`chip${off ? " off" : ""}`} aria-pressed={!off} title={off ? "Left out of this message: click to include" : "Sent with this message: click to leave out"} onClick={() => useChat.getState().toggleOmit(c.key)}>{c.label}{!off && <X size={12} />}</button>;
          })}
        </div>
      )}
      {picks.length > 0 && (
        <ul className="chat-picker" role="listbox" aria-label="Mention">
          {picks.map((o, i) => <li key={o.label} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); choose(o); }}><b>{o.label}</b> <span className="muted">{o.hint}</span></li>)}
        </ul>
      )}
      <textarea ref={ta} className="input chat-input" rows={2} value={text} aria-label="Message"
        placeholder="Say what to change, or ask about what you see (@ to name a file, run or trade)"
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setActive(0); setClosedAt(null); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={onKey} />
      <div className="chat-actions">
        <button className={`btn sm${think ? " primary" : ""}`} aria-pressed={think} title="Use Sonnet instead of Haiku for this message (slower, uses more of your plan)" onClick={() => useChat.getState().setThink(!think)}><Brain size={14} />Think harder</button>
        {err && <span className="chat-err" role="alert">{err}</span>}
        <span className="grow" />
        {busy
          ? <button className="btn danger" onClick={() => void useChat.getState().stop()}><Square size={14} fill="currentColor" />Stop</button>
          : <button className="btn primary" disabled={!text.trim()} onClick={() => void send()}>Send</button>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Header, sign-in card, the tab**

```tsx
// packages/web/src/chat/ChatHeader.tsx
import { SplitChip } from "../preview/SplitChip.js";
import { Plus } from "../ui/icons.js";
import { LONG_CHAT, planText, useChat } from "./state.js";

/** New chat, past chats, the split chip, and whose plan the chat runs on. */
export function ChatHeader() {
  const convs = useChat((s) => s.conversations), id = useChat((s) => s.conversationId), status = useChat((s) => s.status), busy = useChat((s) => s.busy), n = useChat((s) => s.messages.length);
  const chat = () => useChat.getState();
  return (
    <>
      <div className="chat-head">
        <button className="btn sm" disabled={busy} onClick={() => chat().newChat()}><Plus size={14} />New chat</button>
        <select className="select sm" aria-label="Past chats" value={id ?? ""} disabled={busy} onChange={(e) => (e.target.value ? void chat().open(e.target.value) : chat().newChat())}>
          <option value="">{id ? "New chat" : "Past chats…"}</option>
          {convs.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <SplitChip />
        <span className="grow" />
        <span className="muted chat-plan" title={status?.version ? `Claude Code ${status.version}` : undefined}>{planText(status)}</span>
      </div>
      {n >= LONG_CHAT && (
        <div className="banner info chat-long">
          This chat is long, and every message re-reads all of it.
          <button className="btn sm" disabled={busy} onClick={() => chat().newChat()}>Start a new chat</button>
          <span className="muted">What you are looking at carries over.</span>
        </div>
      )}
    </>
  );
}
```

```tsx
// packages/web/src/chat/SetupCard.tsx
import { useState } from "react";
import { Copy } from "../ui/icons.js";
import { useChat } from "./state.js";

/** Claude Code missing or signed out: the one-time sign-in, done in Anthropic's own flow inside the container. */
export function SetupCard() {
  const s = useChat((x) => x.status)!;
  const [checking, setChecking] = useState(false);
  const cmd = `docker exec -it -u ${s.uid ?? 1000} qkt-backtester claude auth login`;
  if (!s.installed) return (
    <div className="card pad chat-setup"><b>Claude Code is not in this image</b>
      <p className="muted">The chat runs the Claude Code CLI inside the studio's container. Use the qkt-backtester image 0.3.0 or newer.</p></div>
  );
  return (
    <div className="card pad chat-setup">
      <b>Sign in to Claude Code (once)</b>
      <p>The chat runs Claude Code on your own Claude plan. Sign in with Anthropic's own flow, inside the container, from a terminal on the machine that runs it:</p>
      <pre className="mono chat-cmd">{cmd}</pre>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(cmd)}><Copy size={14} />Copy</button>
        <button className="btn sm primary" disabled={checking} onClick={async () => { setChecking(true); await useChat.getState().loadStatus(true); setChecking(false); }}>{checking ? "Checking…" : "Check again"}</button>
      </div>
      <p className="muted">If your container has another name, use that name. The sign-in stays in Claude Code's own folder in the container (<code>/home/studio/.claude</code>); the studio never sees, stores or forwards it.{s.error ? ` (${s.error})` : ""}</p>
    </div>
  );
}
```

```tsx
// packages/web/src/chat/ChatTab.tsx
import { useEffect } from "react";
import { ChatHeader } from "./ChatHeader.js";
import { Composer } from "./Composer.js";
import { SetupCard } from "./SetupCard.js";
import { Thread } from "./Thread.js";
import { useChat } from "./state.js";
import "./chat.css";

/** The Chat dock tab. Lazy-loaded: the chat UI library and markdown load only when the tab is first opened. */
export function ChatTab() {
  const status = useChat((s) => s.status);
  useEffect(() => { void useChat.getState().loadStatus(); void useChat.getState().loadConversations(); }, []);
  if (!status) return <div className="empty"><span className="spin" />Checking Claude Code…</div>;
  if (!status.installed || !status.loggedIn) return <SetupCard />;
  return <div className="chat"><ChatHeader /><Thread /><Composer /></div>;
}
```

```css
/* packages/web/src/chat/chat.css */
.chat { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.chat-head { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line); }
.chat-head .select { max-width: 220px; }
.chat-plan { font-size: var(--fs-xs); white-space: nowrap; }
.chat-long { margin: var(--s2) var(--s3) 0; align-items: center; }
.chat-thread { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.chat-viewport { flex: 1; overflow-y: auto; padding: var(--s3); display: flex; flex-direction: column; gap: var(--s3); }
.chat-empty ul { margin: var(--s1) 0; padding-left: 18px; }
.msg { max-width: 100%; font-size: var(--fs-sm); line-height: 1.5; }
.msg.user { align-self: flex-end; max-width: 85%; background: var(--card-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s2) var(--s3); white-space: pre-wrap; }
.msg.assistant { display: flex; flex-direction: column; gap: var(--s2); }
.chat-md p { margin: 0 0 var(--s2); } .chat-md table { border-collapse: collapse; } .chat-md td, .chat-md th { border: 1px solid var(--line); padding: 2px 6px; }
.chat-step { border: 1px solid var(--line); border-radius: var(--r-md); padding: 2px var(--s2); font-size: var(--fs-xs); }
.chat-step > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; }
.chat-step.bad > summary { color: var(--loss-ink); }
.chat-json { max-height: 180px; overflow: auto; margin: var(--s1) 0; font-size: var(--fs-xs); white-space: pre-wrap; }
.chat-notice { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); }
.chat-foot { display: flex; flex-direction: column; gap: 2px; }
.chat-end { font-size: var(--fs-sm); } .chat-end.error, .chat-end.limit { color: var(--loss-ink); }
.chat-usage { font-size: var(--fs-xs); }
.chat-composer { position: relative; border-top: 1px solid var(--line); padding: var(--s2) var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.chat-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chat-chips .chip { height: 22px; font-size: var(--fs-xs); }
.chat-chips .chip.off { text-decoration: line-through; opacity: .6; }
.chat-input { resize: vertical; min-height: 44px; font: inherit; }
.chat-actions { display: flex; align-items: center; gap: var(--s2); }
.chat-err { color: var(--loss-ink); font-size: var(--fs-xs); }
.chat-picker { position: absolute; bottom: 100%; left: var(--s3); margin: 0; padding: 4px; list-style: none; background: var(--card-2); border: 1px solid var(--line-2); border-radius: var(--r-md); min-width: 260px; max-height: 240px; overflow: auto; z-index: 5; }
.chat-picker li { padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: var(--fs-sm); }
.chat-picker li.on { background: var(--accent-soft); }
.chat-setup { margin: var(--s4); display: flex; flex-direction: column; gap: var(--s2); max-width: 640px; }
.chat-cmd { padding: var(--s2); background: var(--card-2); border-radius: var(--r-md); overflow-x: auto; }
.chat-card { border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s2) var(--s3); display: flex; flex-direction: column; gap: var(--s2); font-size: var(--fs-sm); }
.chat-table { border-collapse: collapse; font-size: var(--fs-xs); } .chat-table td, .chat-table th { padding: 2px 8px; text-align: right; } .chat-table td:first-child, .chat-table th:first-child { text-align: left; }
.chat-table tr.flag td { color: var(--warn); }
.dock-chat { display: flex; flex: 1; min-height: 0; }
```

- [ ] **Step 6: The dock tab**

In `dock/Dock.tsx`: `const ChatTab = lazy(() => import("../chat/ChatTab.js").then((m) => ({ default: m.ChatTab })));`, import `MessageSquare` from `../ui/icons.js` and `useChat` from `../chat/state.js`; in `DockBar` read `const chatBusy = useChat((s) => s.busy);` and append the tab:

```tsx
    { id: "chat", label: "Chat", icon: <MessageSquare size={15} />, badge: chatBusy ? <span className="dot run" /> : null },
```

In `DockBody`, before the terminal panel:

```tsx
      {tab === "chat" && <div role="tabpanel" id="dock-panel-chat" aria-labelledby="dock-tab-chat" className="dock-chat"><Suspense fallback={<div className="empty"><span className="spin" />Loading the chat…</div>}><ChatTab /></Suspense></div>}
```

(`showDock("chat")` already un-maximizes whatever hides the dock: the 0.1.3 pane rules apply unchanged.)

- [ ] **Step 7: Type check, build, and confirm the chat is a separate chunk**

Run: `cd packages/web && npx tsc --noEmit -p . && cd ../.. && pnpm -r build && ls packages/web/dist/assets | grep -i chattab`
Expected: no type errors; build passes; a `ChatTab-*.js` chunk exists (the main `index-*.js` does not contain `@assistant-ui`: `grep -L assistant-ui packages/web/dist/assets/index-*.js` prints the file).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/chat packages/web/src/dock/Dock.tsx packages/web/src/ui/icons.ts
git commit -m "feat(web): Chat tab - conversation with steps, message box with mentions and chips, sign-in card"
```

---

### Task 9: Web - cards in the conversation (variants, comparisons, proposals, sweeps, runs)

**Files:**
- Create: `packages/web/src/chat/results.ts`, `packages/web/src/chat/results.test.ts`, `packages/web/src/chat/cards.tsx`
- Modify: `packages/web/src/shell/Proposals.tsx` (export `actOnProposal` and `DiffView`), `packages/web/src/chat/parts.tsx` (`ToolStep` shows the card)

**Interfaces:**
- Consumes: tool result shapes of phase 1 — `try_change` -> `{ variantId, label, diff, notes, variant: { runId, status, error?, net, trades, ... }, base: {...} }`; `try_variants` -> `{ base, variants: Array<{ variantId, label, runId, net, trades, ... }> }`; `propose_*` -> `{ proposalId, ... }`; `sweep` -> `{ jobId }`; `run_backtest` -> `{ runId, ... }`. `useAgent` (`variants`, `proposals`, `split`, `show`, `adopt`, `discard`), `api.runParts`, `api.job`, `useStore.selectRun`, `fmtMoney`.
- Produces: `parseResult(text: string): Record<string, unknown> | null`; `overfitFlags(rows: Array<{ first: number | null; test: number | null }>): boolean[]`; `ToolCard({ name, text })`; from `Proposals.tsx`: `actOnProposal(id: string, apply: boolean, path?: string): Promise<void>`, `DiffView({ diff }: { diff: string })`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/chat/results.test.ts
import { describe, it, expect } from "vitest";
import { overfitFlags, parseResult } from "./results.js";

describe("tool results", () => {
  it("parses a tool's JSON result; plain text, arrays and truncated results give null", () => {
    expect(parseResult('{"variantId":"v1"}')).toEqual({ variantId: "v1" });
    expect(parseResult("no such run")).toBeNull();
    expect(parseResult("[1]")).toBeNull();
    expect(parseResult('{"truncated":true,"head":"..."}')).toBeNull();
  });
  it("flags sweep rows better than the median on the first part but below it on the test part", () => {
    expect(overfitFlags([{ first: 10, test: -5 }, { first: 8, test: 6 }, { first: 1, test: 7 }, { first: 0, test: 2 }])).toEqual([true, false, false, false]);
    expect(overfitFlags([{ first: 10, test: -5 }, { first: 1, test: 7 }])).toEqual([false, false]);
    expect(overfitFlags([{ first: 10, test: null }, { first: 8, test: 6 }, { first: 1, test: 7 }, { first: 0, test: 2 }])[0]).toBe(false);
  });
});
```

Run: `cd packages/web && npx vitest run src/chat/results.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `results.ts`**

```ts
// packages/web/src/chat/results.ts
/** A tool's result text as an object, or null (plain-text errors, lists, results cut at the 8k cap). */
export function parseResult(text: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) && !(j as { truncated?: unknown }).truncated ? (j as Record<string, unknown>) : null;
  } catch { return null; }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
/** Sweep rows better than the median on the first part but below the median on the test part: likely over-fitted (spec 6). */
export function overfitFlags(rows: Array<{ first: number | null; test: number | null }>): boolean[] {
  const f = rows.flatMap((r) => (r.first === null ? [] : [r.first])), t = rows.flatMap((r) => (r.test === null ? [] : [r.test]));
  if (f.length < 3 || t.length < 3) return rows.map(() => false);
  const mf = median(f), mt = median(t);
  return rows.map((r) => r.first !== null && r.test !== null && r.first > mf && r.test < mt);
}
```

- [ ] **Step 3: Share the proposal actions** — in `shell/Proposals.tsx` (current phase 1 file: `ProposalsButton` with the `useMemo` open-filter selector, then `if (!open.length) return null;`, then `const act = ...`), move the body of the component's `act` function out unchanged (its comments and toast keep their em dashes) as

```ts
/** Apply (or start) / reject a proposal, then bring an open editor tab in line with the file on disk. Shared with the chat's cards. */
export async function actOnProposal(id: string, apply: boolean, path?: string): Promise<void> {
  try {
    if (apply) {
      await api.applyProposal(id);
      if (path) {
        await useStore.getState().refreshTree("");
        const action = decideApplyProposalAction(useStore.getState().openFiles.find((f) => f.path === path));
        if (action === "reload") {
          // the tab is clean: it takes the new text as its saved state (no conflict banner)
          await useStore.getState().reloadFromDisk(path);
        } else if (action === "conflict") {
          // the tab has unsaved edits: never discard them silently — flag the same conflict state the
          // file-watch path uses, so the existing banner (Reload from disk / Overwrite) handles it
          useStore.setState((s) => ({ openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, conflict: true } : f)) }));
          useStore.getState().toast("info", `Applied to ${path} — your unsaved edits are kept; the editor shows the file changed on disk.`);
        }
      }
    } else await api.rejectProposal(id);
  } catch (e) { useStore.getState().toast("error", (e as Error).message); }
  await useAgent.getState().refresh();
}
export function DiffView({ diff }: { diff: string }) {
  return <pre className="diff mono">{diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}</pre>;
}
```

(this is the component's former `act` body, moved to module scope unchanged), delete `act` from the component, make its buttons call `actOnProposal(p.id, true, p.path)` / `actOnProposal(p.id, false)`, and render `{p.diff && <DiffView diff={p.diff} />}` in place of the inline `<pre className="diff mono">`.

- [ ] **Step 4: The cards**

```tsx
// packages/web/src/chat/cards.tsx
import { useEffect, useState } from "react";
import { api, type PartStats } from "../api/client.js";
import { actOnProposal, DiffView } from "../shell/Proposals.js";
import { useAgent, type VariantInfo } from "../state/agent.js";
import { useStore } from "../state/store.js";
import { fmtMoney } from "../util/format.js";
import { overfitFlags, parseResult } from "./results.js";

type Parts = { cut: string | null; first: PartStats; test: PartStats | null };
interface RunNums { runId?: string; status?: string; error?: string; net?: number | null; trades?: number | null }

/** Test-part numbers for a set of runs, recomputed whenever the split changes (the split only regroups trades). */
function useParts(runIds: Array<string | undefined>): Array<Parts | null> {
  const split = useAgent((s) => s.split?.text);
  const key = runIds.join(",");
  const [parts, setParts] = useState<Array<Parts | null>>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(runIds.map((id) => (id ? api.runParts(id).catch(() => null) : Promise.resolve(null)))).then((p) => { if (live) setParts(p); });
    return () => { live = false; };
  }, [key, split]); // eslint-disable-line react-hooks/exhaustive-deps
  return parts;
}

function VariantButtons({ v }: { v: VariantInfo | undefined }) {
  const showing = useAgent((s) => s.showing);
  if (!v) return <span className="muted">discarded</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn sm primary" onClick={() => void useAgent.getState().adopt(v.id)}>Adopt</button>
      <button className="btn sm" onClick={() => void useAgent.getState().discard(v.id)}>Discard</button>
      {showing?.id !== v.id && <button className="btn sm ghost" onClick={() => void useAgent.getState().show(v)}>Show on the chart</button>}
    </span>
  );
}

function VariantCard({ r }: { r: { variantId: string; label: string; variant?: RunNums; base?: RunNums } }) {
  const v = useAgent((s) => s.variants.find((x) => x.id === r.variantId)), split = useAgent((s) => s.split);
  const [pv, pb] = useParts([r.variant?.runId, r.base?.runId]);
  return (
    <div className="chat-card">
      <div className="row"><b className="grow">Variant: {r.label}</b><VariantButtons v={v} /></div>
      <table className="chat-table num">
        <thead><tr><th /><th>Variant</th><th>Original</th></tr></thead>
        <tbody>
          <tr><td>Net</td><td>{fmtMoney(r.variant?.net)}</td><td>{fmtMoney(r.base?.net)}</td></tr>
          <tr><td>Trades</td><td>{r.variant?.trades ?? "–"}</td><td>{r.base?.trades ?? "–"}</td></tr>
          {pv?.test && <tr><td>Test part ({split?.text})</td><td>{fmtMoney(pv.test.net)}</td><td>{fmtMoney(pb?.test?.net)}</td></tr>}
        </tbody>
      </table>
      {r.variant?.error && <div className="chat-end error">{r.variant.error}</div>}
    </div>
  );
}

function VariantTable({ r }: { r: { base?: RunNums; variants: Array<RunNums & { variantId: string; label: string }> } }) {
  const all = useAgent((s) => s.variants), split = useAgent((s) => s.split);
  const parts = useParts([r.base?.runId, ...r.variants.map((x) => x.runId)]);
  return (
    <div className="chat-card">
      <table className="chat-table num">
        <thead><tr><th /><th>Net</th><th>Trades</th><th>Test part{split?.text ? ` (${split.text})` : ""}</th><th /></tr></thead>
        <tbody>
          <tr><td>Original</td><td>{fmtMoney(r.base?.net)}</td><td>{r.base?.trades ?? "–"}</td><td>{fmtMoney(parts[0]?.test?.net)}</td><td /></tr>
          {r.variants.map((x, i) => (
            <tr key={x.variantId}><td>{x.label}</td><td>{fmtMoney(x.net)}</td><td>{x.trades ?? "–"}</td><td>{fmtMoney(parts[i + 1]?.test?.net)}</td>
              <td><VariantButtons v={all.find((v) => v.id === x.variantId)} /></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "applying" exists since phase 1's fix wave (set before the first await of apply; a restart turns it back into "open")
const PROPOSAL_STATUS: Record<string, string> = { applying: "applying…", applied: "applied", rejected: "rejected", stale: "out of date" };
function ProposalCard({ id }: { id: string }) {
  const p = useAgent((s) => s.proposals.find((x) => x.id === id));
  if (!p) return <div className="chat-card muted">This proposal is no longer listed.</div>;
  return (
    <div className="chat-card">
      <div className="row" style={{ gap: 6 }}>
        <b className="grow">{p.title}</b>
        {p.status === "open"
          ? <><button className="btn sm primary" onClick={() => void actOnProposal(p.id, true, p.path)}>{p.kind === "job" ? "Start" : "Apply"}</button>
              <button className="btn sm ghost" onClick={() => void actOnProposal(p.id, false)}>Reject</button></>
          : <span className={`badge ${p.status === "applied" ? "ok" : p.status === "stale" ? "warn" : ""}`}>{PROPOSAL_STATUS[p.status] ?? p.status}</span>}
      </div>
      {p.status === "stale" && <p className="muted">The file changed since this was proposed; ask again on the current text.</p>}
      {p.diff && <DiffView diff={p.diff} />}
    </div>
  );
}

/**
 * A sweep's rows with both parts, for the user, with the over-fit flag (spec 6). job_status gave the model first-part rows
 * only, but that is a convention, not a guarantee (each row carries a runId the model can open with get_run/trades), so
 * this card never says the test part was hidden from the model.
 */
function SweepCard({ jobId }: { jobId: string }) {
  const split = useAgent((s) => s.split?.text);
  const [status, setStatus] = useState("running");
  const [rows, setRows] = useState<Array<{ params: Record<string, string>; runId?: string; first: number | null; test: number | null }>>([]);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const j = await api.job(jobId).catch(() => null);
      if (!live || !j) return;
      setStatus(j.status);
      if (j.status === "running") { setTimeout(() => void tick(), 2000); return; }
      const out = [];
      for (const r of ((j.result as { rows?: Array<{ params: Record<string, string>; runId?: string }> } | undefined)?.rows ?? []).slice(0, 30)) {
        const p = r.runId ? await api.runParts(r.runId).catch(() => null) : null;
        out.push({ params: r.params, runId: r.runId, first: p?.first.net ?? null, test: p?.test?.net ?? null });
      }
      if (live) setRows(out);
    };
    void tick();
    return () => { live = false; };
  }, [jobId, split]);
  const flags = overfitFlags(rows);
  return (
    <div className="chat-card">
      <b>Sweep {status === "running" ? "(running…)" : status === "done" ? "" : `(${status})`}</b>
      {rows.length > 0 && (
        <table className="chat-table num">
          <thead><tr><th>Params</th><th>First part</th><th>Test part</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className={flags[i] ? "flag" : ""}>
              <td>{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" ")}</td><td>{fmtMoney(r.first)}</td><td>{fmtMoney(r.test)}</td>
              <td>{flags[i] ? "likely over-fitted" : ""}{r.runId && <button className="btn sm ghost" onClick={() => void useStore.getState().selectRun(r.runId!)}>Open</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

/** What a tool's result shows beside its step: the variant with Adopt, a comparison, a proposal's diff, a sweep, a run link. */
export function ToolCard({ name, text }: { name: string; text: string }) {
  const r = parseResult(text);
  if (!r) return null;
  if (name === "try_change" && typeof r.variantId === "string") return <VariantCard r={r as Parameters<typeof VariantCard>[0]["r"]} />;
  if (name === "try_variants" && Array.isArray(r.variants)) return <VariantTable r={r as Parameters<typeof VariantTable>[0]["r"]} />;
  if (typeof r.proposalId === "string") return <ProposalCard id={r.proposalId} />;
  if (name === "sweep" && typeof r.jobId === "string") return <SweepCard jobId={r.jobId} />;
  if (typeof r.runId === "string") return <button className="btn sm ghost" onClick={() => void useStore.getState().selectRun(r.runId as string)}>Open run {r.runId} on the chart</button>;
  return null;
}
```

- [ ] **Step 5: Show the card under its step** — in `parts.tsx`, import `ToolCard` from `./cards.js` and replace `ToolStep` with:

```tsx
export function ToolStep({ toolName, args, result, isError, artifact }: ToolCallMessagePartProps) {
  const ms = (artifact as { ms?: number | null } | undefined)?.ms ?? null, done = result !== undefined;
  return (
    <>
      <details className={`chat-step${isError ? " bad" : ""}`}>
        <summary>
          {done ? (isError ? <CircleX size={13} /> : <CircleCheck size={13} />) : <span className="spin" />}
          <span>{stepLabel(toolName)}</span>
          {ms !== null && <span className="muted num">· {(ms / 1000).toFixed(1)} s</span>}
        </summary>
        <pre className="mono chat-json">{JSON.stringify(args, null, 1)}</pre>
        {done && <pre className="mono chat-json">{String(result)}</pre>}
      </details>
      {done && !isError && <ToolCard name={toolName} text={String(result)} />}
    </>
  );
}
```

- [ ] **Step 6: Tests, type check, build**

Run: `cd packages/web && npx vitest run src/chat && npx tsc --noEmit -p . && cd ../.. && pnpm -r build`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/chat packages/web/src/shell/Proposals.tsx
git commit -m "feat(web): variant, comparison, proposal and sweep cards in the conversation, recomputed when the split changes"
```

---
### Task 10: The image ships Claude Code; its sign-in lives on its own volume

**Files:**
- Modify: `docker/Dockerfile`, `docker/entrypoint.sh`, `docs/production.md`, `README.md`, `.github/workflows/check.yml` (image checks)

**Interfaces:**
- Consumes: `CLAUDE_BIN`, `CLAUDE_CONFIG_DIR` (read by the server through `loadConfig` and the CLI itself).
- Produces: image with `/usr/local/bin/claude` -> Claude Code 2.1.285 as published; `ENV CLAUDE_CONFIG_DIR=/home/studio/.claude DISABLE_AUTOUPDATER=1 CLAUDE_BIN=/usr/local/bin/claude`; `VOLUME /home/studio/.claude`; a passwd entry for the uid the studio runs as.

- [ ] **Step 1: Dockerfile** — a separate stage, so the 240 MB CLI is cached apart from the studio's sources:

```dockerfile
# Claude Code for the chat, installed exactly as published (its postinstall places the native binary) and pinned; the
# studio never modifies it. To move to another version: --build-arg CLAUDE_CODE_VERSION=<x.y.z>.
FROM node AS claude
ARG CLAUDE_CODE_VERSION=2.1.285
RUN npm install -g --prefix /out/claude "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && /out/claude/bin/claude --version
```

(placed after the `build` stage, before `FROM ${QKT_IMAGE} AS runtime`; `node` is the existing `FROM ${NODE_IMAGE} AS node`
alias, and `npm install -g --prefix` leaves `bin/claude` as a relative symlink into `lib/node_modules`, which `COPY --from`
keeps). In the `runtime` stage, after `COPY tools /app/tools` (and after phase 1's `COPY packages/server/assets /app/server/assets`):

```dockerfile
COPY --from=claude /out/claude /opt/claude
```

The current line is `RUN chmod +x /usr/local/bin/studio-entrypoint && mkdir -p /workspace /data /tmp/home && chmod 1777 /tmp/home /data`;
extend it with ` && ln -s /opt/claude/bin/claude /usr/local/bin/claude && mkdir -p /home/studio/.claude && chown -R 1000:1000 /home/studio`
(1000 = the default `PUID`, so `docker run -u 1000 --entrypoint claude ...`, which skips the entrypoint, can write its
config folder; the entrypoint hands it to the real workspace owner when that is someone else). Add to the `ENV` block, after
the `QKT_BIN=... STUDIO_CDS_DIR=/tmp/home/cds \` line:

```dockerfile
    CLAUDE_BIN=/usr/local/bin/claude CLAUDE_CONFIG_DIR=/home/studio/.claude DISABLE_AUTOUPDATER=1 \
```

and change the volumes to `VOLUME ["/workspace", "/data", "/home/studio/.claude"]`. A declared volume that is not mounted
becomes an anonymous volume per container: `docker rm -f` + `docker run` (what bot2's `run.sh` does on every upgrade)
starts a new, empty one, so a deployment that wants to stay signed in must mount a host folder there (Step 5). `CLAUDE_CONFIG_DIR` is in the image's environment, so `docker exec ... claude auth login` and the studio's own processes use the same folder (checked: `CLAUDE_CONFIG_DIR=<dir> claude auth status` reports `"configDirectory": "<dir>"`).

- [ ] **Step 2: entrypoint.sh** — replace the whole current root branch (`if [ "$(id -u)" = 0 ] && [ -d /workspace ] && [ -z "${STUDIO_KEEP_ROOT:-}" ]; then ... fi`, the block ending with the "owned by root" note) with the one below. It computes the workspace owner first, gives an EMPTY sign-in folder owned by anyone else (root: a host folder `mkdir`ed by root, as on bot2; 1000: the image's default) to that owner (the studio runs as it, and so must `claude`), and makes sure that uid has a passwd entry (the CLI may look its user up). A non-empty folder is never re-owned: it holds someone's sign-in.

```sh
if [ "$(id -u)" = 0 ] && [ -d /workspace ] && [ -z "${STUDIO_KEEP_ROOT:-}" ]; then
  mkdir -p /workspace /data /home/studio/.claude
  for d in /workspace /data; do
    if [ "$(stat -c %u "$d")" = 0 ] && [ -z "$(ls -A "$d" 2>/dev/null)" ] && [ -w "$d" ]; then
      chown "${PUID:-1000}:${PGID:-1000}" "$d" && say "note: $d was an empty root-owned folder; gave it to ${PUID:-1000}:${PGID:-1000} (set PUID/PGID to change)"
    fi
  done
  ws_uid=$(stat -c %u /workspace 2>/dev/null || echo 0)
  ws_gid=$(stat -c %g /workspace 2>/dev/null || echo 0)
  if [ "$ws_uid" != 0 ]; then
    # Claude Code's sign-in folder (a volume): the studio runs the CLI as the workspace owner, so that owner must own it
    c=/home/studio/.claude
    if [ "$(stat -c %u "$c")" != "$ws_uid" ] && [ -z "$(ls -A "$c" 2>/dev/null)" ]; then chown "$ws_uid:$ws_gid" "$c" /home/studio; fi
    getent passwd "$ws_uid" >/dev/null 2>&1 || echo "studio:x:$ws_uid:$ws_gid:studio:/home/studio:/bin/sh" >> /etc/passwd
    exec setpriv --reuid="$ws_uid" --regid="$ws_gid" --clear-groups /usr/local/bin/studio-entrypoint "$@"
  fi
  say "note: /workspace is owned by root, so files created there will be root-owned. Create the folder yourself (mkdir workspace) before the first run."
fi
```

- [ ] **Step 3: Build and check the image by hand**

Run:

```bash
docker build -f docker/Dockerfile -t qkt-backtester:local .
docker run --rm --entrypoint claude qkt-backtester:local --version
(docker run --rm -u 1000 --entrypoint claude qkt-backtester:local auth status --json || true)
mkdir -p /tmp/ws-chat && docker run -d --name chat-check -v /tmp/ws-chat:/workspace qkt-backtester:local && sleep 20
docker exec -u "$(stat -c %u /tmp/ws-chat)" chat-check sh -c 'claude auth status; ls -ld /home/studio/.claude'
docker rm -f chat-check
```

Expected: `2.1.285 (Claude Code)`; the status JSON has `"loggedIn": false` and `"configDirectory": "/home/studio/.claude"`; inside the running container the folder is owned by the workspace owner and `auth status` works for that uid (no "unknown user" error).

- [ ] **Step 4: The same checks in CI** — in `.github/workflows/check.yml`, `image` job, after "first run on an empty workspace and empty data":

```yaml
      - name: the image carries Claude Code as published, configured on its own volume
        run: |
          docker run --rm --entrypoint claude qkt-backtester:ci --version | grep -q '^2.1.285 '
          (docker run --rm -u 1000 --entrypoint claude qkt-backtester:ci auth status --json || true) | grep -q '"configDirectory": *"/home/studio/.claude"'
          docker exec -u "$(id -u)" studio sh -c 'test -w /home/studio/.claude'
```

- [ ] **Step 5: Docs** — `docs/production.md`:

In section 2, the one-time setup gains `mkdir -p /srv/qkt-studio/claude` (an empty folder; the container hands it to the workspace owner on start) and `docker run` gains `-v /srv/qkt-studio/claude:/home/studio/.claude \` after the workspace volume; add a bullet: "**Claude Code sign-in** (`/home/studio/.claude`): the chat's sign-in, kept by Claude Code itself. Mount it from its own folder: without a mount it lives in an anonymous volume that `docker rm` + `docker run` (every upgrade) replaces with an empty one, and you would sign in again after each upgrade. It is never inside the workspace." In "Health, logs, upgrades", after `docker run ... v0.2.1  # same flags as before`, add the line `# same flags includes the /home/studio/.claude mount, or the chat is signed out after the upgrade`. Settings table gains:

```markdown
| `CLAUDE_BIN` | `/usr/local/bin/claude` (image) | The Claude Code CLI the chat runs. |
| `CLAUDE_CONFIG_DIR` | `/home/studio/.claude` (image) | Claude Code's own folder: its sign-in and conversation transcripts. Mount it as a volume. |
| `CHAT_RECORD_DIR` | unset | Also save each chat message's raw CLI output there (test fixtures; see `scripts/chat-live.mjs`). |
```

New section:

````markdown
## 6. The research chat

The **Chat** tab (next to Pipeline, Problems, Terminal) takes plain English ("make the stop-loss 2 % and let's see",
"skip Fridays", "make the test part the last 2 months") and does it with the studio's tools (section 5): changes are
tried on a copy and shown on the chart with Adopt / Discard, edits to your files are proposals you Apply or Reject.

It runs the **unmodified Claude Code CLI** shipped in the image, on **your own Claude plan** (Pro or Max): Haiku by
default, Sonnet when you press **Think harder**. Sign in once, with Anthropic's own flow, inside the container:

```sh
docker exec -it -u 1000 qkt-backtester claude auth login     # -u: the owner of your workspace folder (the Chat tab shows it)
```

The sign-in stays in Claude Code's folder (`/home/studio/.claude`, its own volume); the studio never reads, stores or
forwards it, and only asks `claude auth status` whether you are signed in. Each message starts one CLI process that can
use the studio's tools and nothing else (no shell, no files), with its own short-lived token for `/api/mcp`. Limits per
message: 25 tool calls and 5 minutes; one message at a time. **Stop** ends the process and cancels the runs it started.
Nothing runs in the background: the CLI only starts when you send a message. Usage is shown under each reply ("counts
toward your Claude plan"; the API-equivalent cost is in its tooltip). When the plan's limit is reached the CLI's own
message is shown; with `-e ANTHROPIC_API_KEY=...` Claude Code bills the API instead.
````

Section 4 gains: "the Chat tab end to end with a stand-in CLI that replays recorded replies (no tokens)". `README.md` feature list gains: "- **Research chat**: say what to change in plain English; it is tried on a copy and shown on the chart (Claude Code on your own Claude plan; see docs/production.md section 6)."

- [ ] **Step 5b: bot2's `run.sh` (not a repo file; the controller applies this on bot2 at deploy time, not the implementer)**

There is no copy or template of `run.sh` in the repo (checked 2026-09-29: only this plan and the phase 1 plan mention it),
and `docs/production.md` does not describe it. What it does today (read from bot2, `/root/qkt-studio/run.sh`):
`docker pull ghcr.io/elitekaycy/qkt-backtester:$V`, `docker rm -f qkt-backtester`, then `docker run -d --name qkt-backtester
--restart unless-stopped` with `-p 127.0.0.1:8080:8080 -p 100.114.39.64:8080:8080`, `-v /root/qkt-studio/workspace:/workspace`,
`-v /root/qkt-studio/data:/data`, `-v /root/projects/qkt-forge/run/data:/forge:ro`, `--env-file /root/qkt-studio/studio.env`,
`-e QKT_DEMO=0 -e STUDIO_TERMINAL=restricted -e MAX_PARALLEL=4 -e STUDIO_ALLOWED_HOSTS=...`, `--memory 12g --cpus 6`. The 0.3.0
image works with it unchanged (the chat just shows the sign-in card), but because `rm -f` + `run` makes a new anonymous
volume, the sign-in would be lost on every upgrade. The one change, applied once on bot2 before `run.sh v0.3.0`:

```sh
mkdir -p /root/qkt-studio/claude          # empty and root-owned: the entrypoint hands it to the workspace owner (1000) on start
sed -i 's#^  -v /root/qkt-studio/workspace:/workspace \\$#&\n  -v /root/qkt-studio/claude:/home/studio/.claude \\#' /root/qkt-studio/run.sh
grep -n 'home/studio/.claude' /root/qkt-studio/run.sh   # exactly one line, right after the workspace mount
```

Then `run.sh v0.3.0`, and the one-time sign-in: `docker exec -it -u 1000 qkt-backtester claude auth login` (1000 = the owner
of `/root/qkt-studio/workspace` on bot2). The folder is outside the workspace backup and outside `/root/qkt-studio/data`.

- [ ] **Step 6: Commit**

```bash
git add docker/Dockerfile docker/entrypoint.sh docs/production.md README.md .github/workflows/check.yml
git commit -m "build: ship the published CLI pinned at 2.1.285, its sign-in on a separate volume owned by the workspace owner"
```

---

### Task 11: Browser check with the stand-in CLI, the live check, release 0.3.0

**Files:**
- Create: `scripts/chat-ui.e2e.mjs`, `scripts/chat-live.mjs`
- Modify: `.github/workflows/check.yml`, the four `package.json` versions

**Interfaces:**
- Consumes: the whole feature; the stand-in CLI and its scenarios (Task 2: `try-change`, `set-split`, `propose`, `hang`, signed-out marker); `window.__qktStore`, `window.__qktEditor` (existing test hooks).
- Produces: CI step "the Chat tab end to end"; `scripts/chat-live.mjs` (manual, opt-in).

- [ ] **Step 1: The browser check**

```js
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
ok("the split chip follows", await bodyHas(/Split: test = last 1 weeks/, 30_000));
ok("the variant card recomputes its test part", await bodyHas(/Test part \(test = last 1 weeks\)/, 15_000));
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
```

The scenario files name `strategies/ema_cross.qkt` and the window 2024-01-02..2024-02-01 (the seeded sample and the synthetic demo data). The `docker exec` runs as root, so the marker is writable whatever the owner.

- [ ] **Step 2: Run it locally against the image**

```bash
mkdir -p /tmp/ws-chat-e2e
docker run -d --name studio-chat -p 127.0.0.1:8081:8080 -v /tmp/ws-chat-e2e:/workspace \
  -v "$PWD/packages/server/test/fixtures/fake-claude:/fake:ro" -e CLAUDE_BIN=/fake/fake-claude.mjs qkt-backtester:local
for i in $(seq 1 120); do curl -fs http://127.0.0.1:8081/api/health >/dev/null && break; sleep 2; done
BASE=http://127.0.0.1:8081/ CONTAINER=studio-chat node scripts/chat-ui.e2e.mjs
docker rm -f studio-chat
```

Expected: `chat-ui: all passed`.

- [ ] **Step 3: CI** — in `.github/workflows/check.yml`, `image` job, after the `agent-ui.e2e.mjs` step:

```yaml
      - name: the Chat tab end to end with a stand-in CLI (no tokens) - steps, variant, split, Adopt, stale proposal, Stop, sign-in card
        run: |
          mkdir -p ws3
          docker run -d --name studio-chat -p 127.0.0.1:8081:8080 -v "$PWD/ws3:/workspace" \
            -v "$PWD/packages/server/test/fixtures/fake-claude:/fake:ro" -e CLAUDE_BIN=/fake/fake-claude.mjs qkt-backtester:ci
          for i in $(seq 1 120); do curl -fs http://127.0.0.1:8081/api/health >/dev/null && break; sleep 2; done
          BASE=http://127.0.0.1:8081/ CONTAINER=studio-chat STRATEGY=strategies/ema_cross.qkt node scripts/chat-ui.e2e.mjs
```

and add `docker logs studio-chat || true` to the "container logs" step.

- [ ] **Step 4: The live check** (manual, opt-in; spends a little of the signed-in plan)

```js
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
```

- [ ] **Step 5: Full suite, versions, commit**

Run: `pnpm test && pnpm -r build`
Expected: all pass (tests needing real qkt data skip without it).
Set `"version": "0.3.0"` in `package.json` and `packages/{core,server,web}/package.json`.

```bash
chmod +x packages/server/test/fixtures/fake-claude/fake-claude.mjs
git add scripts/chat-ui.e2e.mjs scripts/chat-live.mjs .github/workflows/check.yml package.json packages/core/package.json packages/server/package.json packages/web/package.json
git commit -m "feat: research chat tab with sign-in card, per-message CLI process and limits (0.3.0)"
```

After CI passes and the PR is merged: `git tag v0.3.0 && git push origin v0.3.0`. Deploying (bot2's `run.sh` with the new `/home/studio/.claude` volume as in Task 10 Step 5b, the one-time sign-in, then `scripts/chat-live.mjs` with its results recorded in the PR) is done by the controller, not in this plan.
