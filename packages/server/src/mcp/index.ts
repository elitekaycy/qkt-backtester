import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { STUDIO_VERSION } from "../postprocess.js";
import { registerContextTools } from "./tools-context.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerAnalysisTools } from "./tools-analysis.js";
import { registerAuthoringTools } from "./tools-authoring.js";
import { registerSplitTools } from "../split.js";
import type { ToolCtx } from "./util.js";

/** Every tool group registers here; later tasks add their `register...` calls to this list. */
export function buildMcp(ctx: ToolCtx): McpServer {
  const s = new McpServer({ name: "qkt-studio", version: STUDIO_VERSION }, { instructions: "Tools of the qkt backtesting studio. Prefer try_change for any strategy change; read dsl_reference before writing DSL." });
  registerContextTools(s, ctx);
  registerKnowledgeTools(s, ctx);
  registerAnalysisTools(s, ctx);
  registerAuthoringTools(s, ctx);
  registerSplitTools(s, ctx);
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
