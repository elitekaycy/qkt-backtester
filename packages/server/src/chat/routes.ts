import path from "node:path";
import type { FastifyInstance } from "fastify";
import { VIEW_KEYS, type Mention, type ViewKey } from "@qkt-studio/core";
import { toolPathRefusal } from "../mcp/util.js";
import type { ClaudeStatusCache } from "./auth.js";
import { ChatBusy, ChatNotFound, ChatUnavailable, type ChatLimits, type ChatManager, type SendRequest } from "./manager.js";
import type { ChatStore } from "./store.js";

const STORE_UNUSABLE = "the chat store could not be opened";

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

/** chat and store are null when the chat database could not be opened: the routes then report and refuse, never fail. */
export function registerChatRoutes(app: FastifyInstance, chat: ChatManager | null, store: ChatStore | null, status: ClaudeStatusCache, limits: ChatLimits): void {
  app.get<{ Querystring: { refresh?: string } }>("/api/chat/status", async (req) => ({
    ...(await status.get(req.query.refresh === "1")),
    ...(chat ? { available: true } : { available: false, reason: STORE_UNUSABLE }),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    busy: chat?.busy() ?? null,
    limits: { calls: limits.maxCalls, minutes: Math.round(limits.maxMs / 60_000) },
  }));
  app.get("/api/chat/conversations", async () => ({ conversations: (store?.list(50) ?? []).map((c) => ({ id: c.id, title: c.title, updated: c.updated, messages: c.messages })) }));
  app.get<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const c = store?.conversation(req.params.id);
    if (!store || !c) return reply.code(404).send({ error: "no such conversation" });
    return { conversation: { id: c.id, title: c.title, updated: c.updated }, messages: store.messages(c.id) };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/chat/send", async (req, reply) => {
    if (!chat) return reply.code(503).send({ error: STORE_UNUSABLE });
    try { return reply.code(202).send(await chat.send(parseSend(req.body ?? {}))); }
    catch (e) {
      const code = e instanceof ChatBusy ? 409 : e instanceof ChatUnavailable ? 503 : e instanceof ChatNotFound ? 404 : e instanceof RangeError ? 400 : 0;
      if (!code) throw e;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });
  app.post("/api/chat/stop", async () => ({ stopped: chat ? await chat.stop() : false }));
}
