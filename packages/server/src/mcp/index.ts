import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { STUDIO_VERSION } from "../postprocess.js";
import { registerContextTools } from "./tools-context.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerAnalysisTools } from "./tools-analysis.js";
import { registerAuthoringTools } from "./tools-authoring.js";
import { registerSplitTools } from "../split.js";
import { registerTryTools } from "./tools-try.js";
import { registerRunTools } from "./tools-runs.js";
import { TeeSet, limitReply, toolCalls, type ChatTokens } from "../chat/tokens.js";
import type { ToolCtx } from "./util.js";

/** Every tool group registers here; later tasks add their `register...` calls to this list. */
export function buildMcp(ctx: ToolCtx): McpServer {
  const s = new McpServer({ name: "qkt-studio", version: STUDIO_VERSION }, { instructions: "Tools of the qkt backtesting studio. Prefer try_change for any strategy change; read dsl_reference before writing DSL." });
  registerContextTools(s, ctx);
  registerKnowledgeTools(s, ctx);
  registerAnalysisTools(s, ctx);
  registerAuthoringTools(s, ctx);
  registerSplitTools(s, ctx);
  registerTryTools(s, ctx);
  registerRunTools(s, ctx);
  return s;
}

/**
 * Stateless streamable HTTP at /api/mcp: a fresh server + transport per request (no session to leak or expire). Under /api,
 * so the token, host and cross-site checks of app.ts apply unchanged.
 */
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
