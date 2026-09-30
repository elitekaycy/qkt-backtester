import type { FastifyInstance } from "fastify";
import type { ChatEvent } from "@qkt-studio/core";
export type StudioEvent =
  | { t: "variant"; variantId: string; runId: string }
  | { t: "proposal"; id: string }
  | { t: "split" }
  | { t: "open_file"; path: string }
  | { t: "run"; runId: string }
  | { t: "chat"; conversationId: string; messageId: string; seq: number; ev: ChatEvent };
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
