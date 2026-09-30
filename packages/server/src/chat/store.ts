// packages/server/src/chat/store.ts
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMessage } from "@qkt-studio/core";

export interface ConversationRow { id: string; sessionId: string; sessionStarted: boolean; title: string; created: string; updated: string; messages: number }
type Row = Record<string, unknown>;
const conv = (r: Row): ConversationRow => ({ id: String(r.id), sessionId: String(r.session_id), sessionStarted: r.session_started === 1, title: String(r.title), created: String(r.created), updated: String(r.updated), messages: Number(r.messages ?? 0) });
const parse = <T>(text: unknown, fallback: T): T => { try { return JSON.parse(String(text)) as T; } catch { return fallback; } };
const message = (r: Row): ChatMessage => ({
  id: String(r.id), conversationId: String(r.conversation_id), role: r.role === "user" ? "user" : "assistant", text: String(r.text), model: (r.model as string | null) ?? null,
  status: r.status as ChatMessage["status"], error: (r.error as string | null) ?? null, items: parse(r.items, []), usage: r.usage ? parse(r.usage, null) : null, created: String(r.created),
});

/**
 * The chat's conversations and messages (with their steps and usage), next to the run index. Claude Code keeps its own
 * transcripts in its config directory; this is what the Chat tab shows and which session each conversation resumes.
 */
export class ChatStore {
  /**
   * Open the store without ever taking the studio down: a file that is not a usable database is moved aside to
   * `<file>.corrupt-<ms>` (with its -wal/-shm) and a fresh one is made; if that fails too, null (the chat is disabled).
   */
  static open(file: string): ChatStore | null {
    try { return new ChatStore(file); }
    catch (e) {
      const aside = `${file}.corrupt-${Date.now()}`;
      for (const x of ["", "-wal", "-shm"]) if (existsSync(file + x)) { try { renameSync(file + x, aside + x); } catch { /* keep going */ } }
      console.error(`chat: ${path.basename(file)} could not be opened (${(e as Error).message}); kept as ${path.basename(aside)}, starting empty`);
      try { return new ChatStore(file); }
      catch (e2) { console.error(`chat: disabled, the chat store cannot be opened: ${(e2 as Error).message}`); return null; }
    }
  }
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
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
