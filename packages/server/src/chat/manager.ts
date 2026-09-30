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
    let pending: ChatMessage | null = null;
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
      pending = msg;
      turn.conversationId = conv.id; turn.messageId = msg.id;
      const prompt = composePrompt(viewReference(this.d.view.get(), await this.d.splitText(), r.omit ?? [], r.mentions ?? []), text);
      void this.run(turn, msg, prompt, model)
        .catch((e: unknown) => console.error(`chat: message ${msg.id} could not be ended cleanly: ${(e as Error).message}`))
        .finally(() => { this.turn = null; release(); });
      return { conversationId: conv.id, messageId: msg.id };
    } catch (e) {
      // a failure after the assistant row was added (splitText) must not leave it "running"
      if (pending) this.d.store.saveMessage({ ...pending, status: "error", error: (e as Error).message });
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
    const cancelOne = async (id: string) => {
      try { if (!(await this.d.runner.cancel(id, { purge: true }))) await this.d.jobs.cancel(id); }
      catch (e) { console.error(`chat: Stop could not cancel ${id}: ${(e as Error).message}`); }
    };
    if (grant) grant.afterStop = (id) => void cancelOne(id);
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
    // a retry is the same message: Stop still owes a cancel to whatever the earlier attempt started
    for (const id of turn.grant?.started ?? []) grant.started.add(id);
    turn.grant = grant;
    let cfgFile: string | null = null, timer: NodeJS.Timeout | null = null;
    // everything after issue() sits inside the try: the token and the config file go on every exit, a throw included
    try {
      // a fixed working folder: Claude Code files sessions by working directory, so --resume only finds them from the same one
      const cwd = path.join(this.dir, "cwd");
      await fs.mkdir(cwd, { recursive: true });
      cfgFile = await writeMcpConfig(path.join(this.dir, "run"), turn.messageId, this.mcpUrl!, grant.token);
      const record = this.d.recordDir ? path.join(this.d.recordDir, `${turn.messageId}.jsonl`) : null;
      if (record) await fs.mkdir(this.d.recordDir!, { recursive: true });
      let recording = Promise.resolve(); // appends chained, so the recorded lines keep their order
      const toolStart = new Map<string, number>();
      const box: { result: ResultEv | null } = { result: null };
      const proc = startAgent(this.d.cfg.claudeBin ?? "claude", { model, sessionId: conv.sessionId, resume: conv.sessionStarted, systemPrompt: SYSTEM_PROMPT, mcpConfigPath: cfgFile }, prompt, {
        cwd, env: agentEnv(),
        onRaw: record ? (line) => { recording = recording.then(() => fs.appendFile(record, `${line}\n`)).catch(() => undefined); } : undefined,
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
      timer = setTimeout(() => void this.halt(turn, "limit", `stopped at the limit (${fmtLimit(this.limits.maxMs)})`), this.limits.maxMs);
      const exit = await proc.exited;
      await recording;
      const r = box.result;
      if (r?.ok) return { ok: true, why: "", detail: "", usage: r.usage };
      const stderr = exit.stderr.trim();
      const why = r?.text || (exit.code === 127 ? "Claude Code is not installed in this image" : stderr.split("\n").slice(-3).join(" ") || `Claude Code exited with code ${exit.code}`);
      return { ok: false, why, detail: `${r?.text ?? ""}\n${stderr}`, usage: r?.usage ?? null };
    } finally {
      if (timer) clearTimeout(timer);
      this.d.tokens.revoke(grant.token);
      turn.proc = null;
      if (cfgFile) await fs.rm(cfgFile, { force: true });
    }
  }
}
