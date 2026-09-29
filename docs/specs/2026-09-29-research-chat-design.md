# Research chat: an AI assistant in the studio, driving it through MCP

Status: design for review (2026-09-29). Nothing here is built yet; section 2 records what was verified by throwaway probes.

## 1. What it is for

Turning the thought in the user's head into the exact strategy change, **and seeing it on the chart**, as fast as
possible, in plain English. It is not an idea generator: the user brings the idea; the assistant maps the words onto
the studio's tools, mixes and calls them, and fills the gaps (which alias is gold, which rule, what a date means to the
DSL), so the result appears in seconds.

Examples it must handle in one short exchange each:
- "make the stop-loss 2 percent and let's see" -> the change on a copy, run, shown on the chart next to the original.
- "check for EMA 12 on gold crossing above RSI 14 on fx" -> the condition written against the right aliases and
  timeframes, run, shown (with the studio's one-line warning that these two lines are on different scales).
- "I noticed we lose when we trade on 2026-08-14; omit that date" -> an exclusion on that date (the tool converts it to
  the DSL's day number), run, shown; with a one-line note that excluding past losers fits the past.
- "what's the split? make the test the last 2 months" -> the split changes, and every view recomputes (section 6).
- Also, by hand or through the chat: new strategy files, new keys in `qkt.config.yaml`, new entries in `instruments.yaml`.

Principles: **the user's intent rules** (the studio warns, it never refuses a legal change); **every change is visible and
one click to keep or drop**; **exact numbers come from the studio, never from the model**; **cheap and fast** (Haiku by
default, Sonnet at most; one tool call per simple request).

**Success criteria**
- A simple change ("stop 2 %", "param fast = 12", "skip Fridays") reaches the chart in one tool call and one run: target
  under ~15 s plus the run's own time on Haiku.
- The examples above complete correctly on Haiku; any DSL passes `qkt parse` before the user sees it.
- Uses the user's Claude Pro/Max through the unmodified Claude Code binary: $0 extra, within Anthropic's terms (section 8).
- No change reaches the user's files without their click, except creating a new file they asked for.

## 2. Verified before designing (throwaway probes, 2026-09-29)

| Claim | How it was checked | Result |
|---|---|---|
| Claude Code runs headless with only our tools | `claude -p --tools "" --strict-mcp-config --mcp-config ... --allowedTools "mcp__studio__*" --permission-mode dontAsk --output-format stream-json` (v2.1.284) | works; built-in tools off, only MCP tools callable |
| Haiku can fix the bracket case from a digest | probe MCP server with `diagnose_exits` + `check_strategy` (real `qkt parse`) | 3 turns, 30 s; right diagnosis (median favourable move 3.1 vs a 24 target), proposed TP 6 / SL 12, source passed `qkt parse`; API-equivalent $0.038 |
| Haiku can code a new idea from the docs | probe with `dsl_reference` (qkt's real DSL docs) + `check_strategy` | 8 turns, 41 s; correct multi-timeframe strategy (RSI cross, 4h EMA filter, % bracket), valid first try; $0.070, mostly reading 5 full doc pages |
| MCP over HTTP with a bearer token | `@modelcontextprotocol/sdk` 1.31 streamable HTTP, `"type":"http"` in `--mcp-config` | works |
| Conversations continue | `--session-id <uuid>` then `--resume <uuid>` | works; turn 2 answered from memory with no tool call |
| Sign-in without the studio touching credentials | `claude auth login` / `claude auth status` exist | yes |
| No turn limit flag in the CLI | `claude --help` | none: the studio enforces limits itself (section 5) |

Lessons that shape the design: the model does well when **tools return decisive, exact digests**; cost is dominated by
**reading** (the CLI's ~18k-token system prompt, replaced by ours; full doc pages, replaced by a compact cheat sheet).

## 3. Architecture

```
 browser  Chat tab ── HTTP + SSE ──► studio server (Node, in the container)
                                       │
                                       ├── chat/     conversation manager
                                       │     one `claude -p` process per message, resumed by session id;
                                       │     streams its JSON events to the browser; enforces limits; records usage
                                       │
                                       ├── mcp/      studio MCP server at /mcp (streamable HTTP, token)
                                       │     tools: context · knowledge · analysis · authoring · try/compare/split · runs
                                       │     every tool calls the studio's existing code (runner, file API, check,
                                       │     trip queries, bars) - no second code path
                                       │
                                       └── core/ digests   pure functions: exit/entry diagnostics, what-if brackets,
                                                           run comparison (unit-testable, used by tools and UI)
```

- **The MCP server is the product; the chat is one client of it.** The same `/mcp` endpoint works from Claude Code on the
  user's laptop (over Tailscale, with the token), so phase 1 is useful before any chat UI exists.
- **The agent is replaceable.** The chat manager talks to "an agent process that speaks stream-json with MCP"; Claude
  Code is the first implementation. An API-key backend (section 9) plugs in behind the same interface.
- **`/mcp` authentication**: the studio's access token (what the laptop uses; on the same terms as the rest of the API) or a
  random per-process token the chat manager creates for each agent process and revokes when it exits.
- Chat state lives in the workspace's studio folder (`.qkt-studio/chat/`): conversation index (sqlite, next to the run
  index) and per-message usage. Claude Code keeps its own session transcripts in its config directory.

## 4. The MCP tools (detailed and flexible)

Design rules for every tool:
- **Exact, computed by the studio.** Numbers come from the same derived files the UI shows (roundtrips, summary,
  analytics, bars), never estimated by the model.
- **Compact by default, detail on request.** Outputs are small JSON (target under 2k tokens) with a `more` handle
  (`limit`/`offset`, `fields`) for detail.
- **Structured where common, free-form where needed.** Common edits have structured tools a small model uses reliably;
  anything else goes through a free-form source path that is always validated.
- **Every write is checked.** Parse + lint always; for strategies also a **dry run**: a bars run over the last 5 trading
  days that every stream has data for (skipped, and said so, when there is no such data). The tool returns the diagnostics
  with line numbers; a strategy that does not parse is never saved.
- **Names are stable and descriptions are short**, because every description is sent on every call.

### 4.1 Context
| Tool | Returns |
|---|---|
| `get_context` | the open file (path, text size, cursor line, selection), the run on screen (id, strategy, window, tier, status, headline numbers), the Run settings window, workspace files summary |
| `list_files(dir?)` / `read_file(path, from_line?, to_line?)` | workspace files (strategies, config, instruments, notes); jailed to the workspace |
| `list_runs(strategy?, limit)` / `get_run(id)` | past runs with their window, tier, params, headline numbers, error if failed |

### 4.2 Knowledge (so a cheap model does not need to know qkt)
| Tool | Returns |
|---|---|
| `dsl_reference(topic?)` | no topic: a **cheat sheet** (~2-3k tokens: file shape, SYMBOLS, rules, conditions, CROSSES, POSITION, actions, SIZING, BRACKET forms incl. `BY n PCT` and `AT`, PARAM, common indicators, 3 short examples) plus the topic list; with a topic: that page of qkt's `docs/reference/dsl/*.md` |
| `dsl_examples(query)` | the closest examples from the workspace, qkt's `examples/` and `strategies/` (by keyword) |
| `config_reference(key?)` | every `qkt.config.yaml` key with meaning, type, default (from the studio's config schema and "show every option" reference) |
| `instruments_reference(symbol?)` | instruments.yaml fields and the entry qkt would use for a symbol |
| `data_status(symbol?)` | what data exists: timeframes, first/last day, complete windows (the Data section's scan) |

### 4.3 Analysis (computed, decisive)
| Tool | Returns |
|---|---|
| `run_summary(run?)` | the summary the UI shows (net, trades, win rate, PF, drawdown, Sharpe...), rejections, warnings |
| `diagnose_exits(run?)` | how trades ended (stop / target / rule / end-of-run), per side; distribution of maximum favourable and adverse excursion before exit, in price and in R; bars to exit; **what-if table**: for a small grid of stop/target distances, how many trades would have hit target first, and net, simulated on the run's bars (labelled "estimate on bars; confirm with a variant") |
| `diagnose_entries(run?)` | entries by hour, weekday, session, trend context (price vs a slow EMA), and win rate/avg R in each; streaks |
| `trades(run?, filter, sort, fields, limit)` | the journal's trade query (side, symbol, exit reason, R, P&L, duration, time filters), compact rows |
| `trade_detail(run?, id, bars_before, bars_after)` | one trade: entry/exit/stop/target, and the OHLC bars around it (compact arrays) - what the chart shows |
| `compare_runs(a, b)` | side-by-side headline numbers and the trades that differ |
| `equity_stats(run?)` | drawdown periods, monthly returns, longest flat spell |

### 4.4 Authoring (new files directly; existing files only through the user)
| Tool | Effect |
|---|---|
| `check_strategy(source)` | parse + lint + dry run, nothing saved: the model's scratchpad |
| `create_strategy(name, source, dir?)` | new file in `strategies/` (refused if it exists or does not pass the check); opens in the editor |
| `propose_strategy_edit(path, edits)` | `edits` = list of `{find, replace}` or a full `source`; produces a **proposal** (diff) the user applies or rejects; nothing written |
| `set_bracket(path, rule, stop, target)` / `set_param(path, name, value)` / `set_sizing(path, rule, sizing)` | structured edits, returned as a proposal like the above |
| `get_config()` / `propose_config(changes)` | read the config; propose key changes (`{key: value}`, dotted keys), validated against the config schema before the user sees the diff |
| `get_instrument(symbol)` / `propose_instrument(symbol, fields)` | same for `instruments.yaml` |

`propose_*` never writes. Proposals appear in the chat as diffs with **Apply** / **Reject**; Apply goes through the file
API (etag, conflict banner, one undo step in the editor). A proposal against a file the user changed since is marked stale.

### 4.5 Try a change (the fast path), compare, and the split
| Tool | Effect |
|---|---|
| `try_change(base?, changes, label?, window?, tier?)` | **one call does it all**: copies the base strategy (default: the open file) to `.qkt-studio/variants/`, applies `changes`, checks, runs, and returns the variant's numbers side by side with the base run (split into the two parts when a split is set), plus the studio's warnings. The chart and journal switch to the variant at once (section 7). The user's file is untouched |
| `try_variants(base?, variants: [{label, changes}], window?)` | several at once ("try stop 1, 2 and 3 %"); returns a comparison table |
| `sweep(base?, ranges, window?)` | automatic search over params or bracket distances (the Lab grid) |
| `get_split()` / `set_split(split)` | the current split and changing it: `{none}`, `{test_pct: 25}`, `{test_last: "3 months"}` or `{test_from: "2026-07-01"}`. The change applies at once to every view (section 6) |
| `list_variants()` / `discard_variant(id)` | housekeeping |

**Changes** are a list of operations, so the model maps words to operations rather than writing DSL:

| Operation | Example request -> operation |
|---|---|
| `set_bracket {rule?, stop?, target?}` (`"2 PCT"`, `"12"`, `"AT <expr>"`) | "stop-loss 2 %" -> `{stop: "2 PCT"}` on every bracketed rule |
| `set_param {name, value}` / `set_sizing {rule?, sizing}` | "fast EMA 12" -> `{name: "fast", value: 12}` |
| `add_condition {rule?, expr, mode: and\|or}` / `remove_condition {rule?, match}` | "EMA 12 of gold crosses above RSI 14 of fx" -> `{expr: "ema(gold.close, 12) CROSSES ABOVE rsi(fx.close, 14)"}` |
| `exclude {dates?, weekdays?, hours_utc?, calendar_window?, rule?}` | "omit 2026-08-14" -> `{dates: ["2026-08-14"]}`; the tool writes `AND NOT (NOW.date_utc IN [20679])` |
| `add_rule {source}` / `remove_rule {match}` | new entry or exit rules |
| `add_symbol {alias, symbol, tf}` | "use NZDUSD 4h as fx" |
| `replace_text {find, replace}` / `source {text}` | anything the operations above do not cover (always checked) |

Every operation is applied by the studio's own editor for the DSL (it knows rules, aliases and brackets), validated, and
reported back as the exact diff. Rules are addressed by their order (`rule: 2`) or by a text match.

**Adopt** (a user click, never the model) turns a variant into an edit of the original file, one undo step in the editor.

### 4.6 Runs and jobs
| Tool | Effect |
|---|---|
| `run_backtest(path, from?, to?, tier?, params?)` | a normal run (shows on the chart when it is the open file); waits up to 3 min, else returns the id |
| `run_walkforward(path, ...)` / `job_status(id)` / `cancel(id)` | the Lab's walk-forward and job control |
| `build_bars(symbol, tf, from, to)` | **proposal only**: the user confirms data jobs in the chat |

Not exposed: deleting files, the terminal, settings, data-source changes, anything outside the workspace.

## 5. The agent process (Claude Code on the user's plan)

Per user message, the chat manager runs (as the workspace user, in the container):

```
claude -p --model <haiku|sonnet> --tools "" --strict-mcp-config --mcp-config <studio /mcp + token>
       --allowedTools "mcp__studio__*" --permission-mode dontAsk --system-prompt <studio prompt>
       --output-format stream-json --verbose --include-partial-messages
       (--session-id <new uuid> | --resume <uuid>)
```

- **System prompt** (ours, short): role, "use only studio tools", "map the request onto the fewest tool calls (prefer
  try_change)", "do what the user asks; relay the studio's warnings in one line, never refuse a legal change", "be brief", plus the open file's path and run id. Replacing the CLI's default prompt cuts the
  fixed cost per call.
- **Models**: Haiku by default; the message box has **Think harder** (Sonnet for that message). Sonnet is the ceiling:
  Opus is not offered.
- **Limits enforced by the studio** (the CLI has no turn limit): at most 25 tool calls and 5 minutes per message, one
  message in flight per workspace; Stop kills the process group (the runner's existing mechanism) and any runs it started.
- **Streaming**: stream-json events become chat items: text deltas, tool calls (collapsed "ran backtest · 3.2 s"), tool
  results feeding tables/proposals, and the final `result` (turns, tokens, API-equivalent cost).
- **Usage shown per message**: tokens and "counts toward your Claude plan" (the API-equivalent figure in a tooltip).

## 6. The split, and warnings instead of refusals

**The split is the user's, visible and changeable at will.**
- A setting of the workspace: none, a percentage for the last part (`test 25 %`, the default), the last N days/weeks/
  months, or a start date. Shown as a chip in the chat header and in the variant bar ("Split: last 3 months").
- Changed by clicking the chip or by asking in the chat ("make the test the last 2 months", "no split"): `set_split`.
- **It reflects everywhere at once**: variant and sweep results are recomputed per part from trades already run (no
  re-run needed, the split only partitions them by exit time), the chart shades the test part, and the journal can filter
  to either part.
- In sweeps the model is shown the first part only, the table shows both, and rows better on the first part but worse on
  the second are flagged as likely over-fitted. For the user's own requested changes both parts are shown to everyone.

**Warnings, not refusals.** The request is implemented as asked; what the studio knows goes along in one line:
- **Different scales**: two symbols' prices, or a price against an oscillator (the editor's `cross_scales` check, shipped
  in 0.1.7): "these lines are on different scales and may never cross".
- **Fitting the past**: excluding specific past dates, or a sweep's best row: "this removes the trades you saw lose;
  it will look better on this window by construction" - the split's second part shows whether it holds up.
- **Refused by qkt**: brackets below zero, empty windows, missing data - the studio's normalized error explains it and the
  model proposes the fix (e.g. "use 0.0020 on NZDUSD, or a PCT").

## 7. The Chat tab

- **Dock tab "Chat"** next to Pipeline | Problems | Terminal. It follows the pane rules shipped in 0.1.3 (opening it
  un-maximizes what hides it).
- **Header**: conversation title (per strategy file by default), New conversation, model (Haiku / Think harder), the
  **split chip**, plan status.
- **The variant view**: after `try_change`, the chart, KPIs and journal show the variant's run with a bar above the chart:
  "Variant: stop 2 % · net +190 vs -412 (test part +40 vs -150) · Adopt · Discard · Back to original". The original
  run stays one click away; several variants appear as a small switcher.
- **Messages**: markdown text; tool calls as compact steps you can expand (arguments, result); **variant cards and
  comparison tables** with Adopt; **proposal diffs** (config, instruments, direct edits) with Apply / Reject; run links that open the run on the chart.
- **Context chips** above the box: the open file and the run on screen, attached automatically; removable.
- **Stop** while it works (same place and look as the run Stop).
- **First use**: if Claude Code is not signed in (`claude auth status`), a card explains the one-time sign-in and shows
  the command to run inside the container; the studio never asks for or stores the token.

## 8. Sign-in, terms, and what the studio must never do

From Anthropic's legal and compliance page (checked 2026-09-29): the terms do not prevent "an end user from signing in
to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude
Code"; they forbid routing Pro/Max credentials "on behalf of their users" and require that developers "may not collect,
store, or intermediate Claude.ai credentials or session tokens - sign-in to a Claude account must complete through
Anthropic's own flow"; and plan limits "assume ordinary, individual usage".

So:
- The image ships the **unmodified** Claude Code binary (pinned version, installed as published).
- The user signs in once with `docker exec -it -u 1000 qkt-backtester claude auth login` (Anthropic's flow). Credentials
  live in Claude Code's own config directory on a separate volume (`/home/studio/.claude`), not in the workspace; the
  studio never reads, copies or proxies them. `/mcp` has its own token, unrelated to Claude credentials.
- One person's studio, one person's plan: the chat is not offered to other users of a shared studio unless each signs in
  with their own account (multi-user is out of scope).
- **No background agent loops**: the assistant only runs when the user sends a message.

## 9. Other backends (later)

- **Anthropic API key** (same binary, `ANTHROPIC_API_KEY` in Claude Code's environment, set by the user): pay per token,
  Haiku ~$1/$5 per million in/out; useful when the plan's limit is reached.
- **Cheapest API models** (Gemini Flash-Lite, gpt-5-nano, DeepSeek Flash: fractions of a cent per message) through a
  small in-server loop (Vercel AI SDK + MCP client) against the same `/mcp`. Phase 3, only if needed.
- Gemini CLI's free Google login is no longer available (withdrawn 2026-06) and its terms forbid third-party use of its
  login; Codex with ChatGPT Plus is permitted and would fit the same process interface if the user adds it.

## 10. Failure handling

| Situation | Behaviour |
|---|---|
| Claude Code missing or signed out | setup card (7); chat disabled with the reason |
| Plan limit reached / rate limited | the CLI's message shown as-is, with "try later" and the API-key option |
| Tool error | returned to the model as a tool error with the studio's message (it can correct and retry) |
| DSL does not parse | not saved; the model gets the exact errors from `qkt parse` |
| A run the model started fails | the failure (normalized error, e.g. the bracket-below-zero explanation) goes back to the model and shows in the chat |
| Limits exceeded (25 calls / 5 min) | process stopped; message ends with "stopped at the limit"; partial results kept |
| The user edits the file while the chat works | proposals built on the old text are marked stale; variants are copies, unaffected |
| Studio restart mid-message | the message is marked interrupted; the conversation resumes from Claude Code's session |

## 11. Testing

- **Digests (core)**: pure functions on recorded roundtrips/bars fixtures, including the real "no take-profit" run.
- **MCP tools (server)**: each tool through the real MCP client (SDK) against a scratch workspace with real qkt: jail,
  write rules (no existing-file writes), check-before-save, the split (set_split recomputes results without re-running;
  sweeps give the model only the first part), compact output sizes.
- **Chat manager**: a fake `claude` binary that replays recorded stream-json (including tool calls, errors, limits) to
  test streaming, Stop, limits, resume, usage accounting, without spending tokens.
- **Browser e2e**: the Chat tab with the fake binary: send, see steps, the variant on the chart, change the split and
  see every view recompute, Adopt -> file changed and the run re-done; a proposal going stale.
- **Live check (manual, opt-in)**: the two section-2 tasks against real Haiku, recorded with tokens and pass/fail, before
  each release that changes tools or prompt.

## 12. Phases

1. **MCP server + digests + try_change, the split and the variant view backend** (sections 4, 6). Useful immediately from Claude Code on the laptop.
2. **Chat tab + agent process** (sections 5, 7, 8, 10) in the image, with the sign-in card.
3. **Other backends** (section 9) if the plan's limits or cost make it worthwhile.

## 13. Open questions

- Conversation scope: one per strategy file (default) or free-standing conversations as well.
