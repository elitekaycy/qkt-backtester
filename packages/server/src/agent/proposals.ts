import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "../config.js";
import type { EventBus } from "./events.js";
import type { Jobs } from "../jobs.js";
import { resolveInJail } from "../jail.js";
import { JsonFile } from "./json-store.js";
import { toolPathRefusal } from "../mcp/util.js";

export interface Proposal {
  id: string; kind: "file" | "job"; title: string;
  path?: string; before?: string; after?: string; diff?: string;
  job?: { symbol: string; tf: string; from: string; to: string };
  created: string; status: "open" | "applying" | "applied" | "rejected" | "stale";
}
/** The files a file proposal may write: the tools' own path policy, or the two workspace files the config tools edit. */
const FIXED_TARGETS = new Set(["qkt.config.yaml", "instruments.yaml"]);
export class ProposalStale extends Error {}

/** Changes a tool wants to make to the user's files (or a data job to start), applied only by the user's click. */
export class Proposals {
  private items: Proposal[] = [];
  private file: string;
  private store: JsonFile<Proposal[]>;
  constructor(private cfg: ServerConfig, private events: EventBus, private jobs: Jobs) {
    this.file = path.join(cfg.workspace, ".qkt-studio", "proposals.json");
    this.store = new JsonFile(this.file);
  }
  async init(): Promise<void> {
    this.items = await this.store.read([]);
    if (!Array.isArray(this.items)) this.items = [];
    for (const p of this.items) if (p.status === "applying") p.status = "open"; // the studio stopped mid-apply: the user can apply again
  }
  private async save(): Promise<void> {
    this.items = this.items.slice(-50);
    await this.store.write(() => this.items);
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
    p.status = "applying"; // before the first await: a second click finds it taken, never applies it twice
    try {
      if (p.kind === "file") {
        // proposals.json can be edited by hand: the target is checked again against the same policy the tools use
        const target = typeof p.path === "string" ? p.path : "";
        const refusal = FIXED_TARGETS.has(target) ? null : target.endsWith(".qkt") ? toolPathRefusal(target) : `${target || "(no path)"} is not a strategy file`;
        if (refusal || typeof p.after !== "string") throw new Error(`refused: ${refusal ?? "no text to write"}`);
        const abs = await resolveInJail(this.cfg.workspace, target);
        const cur = await fs.readFile(abs, "utf8").catch(() => "");
        if (cur !== p.before) { p.status = "stale"; await this.save(); throw new ProposalStale(`${p.path} changed since this was proposed; ask again on the current text`); }
        await fs.writeFile(abs, p.after);
      } else if (p.job) {
        this.jobs.buildBars(p.job);
      }
    } catch (e) {
      if (p.status === "applying") p.status = "open";
      throw e;
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
  // the list carries what the panel shows (title, path, diff, status), never the whole before/after texts
  app.get("/api/proposals", async () => ({ proposals: proposals.list().map(({ before: _b, after: _a, ...p }) => p) }));
  app.post<{ Params: { id: string } }>("/api/proposals/:id/apply", async (req, reply) => {
    try { return await proposals.apply(req.params.id); }
    catch (e) { return reply.code(e instanceof ProposalStale ? 409 : 400).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>("/api/proposals/:id/reject", async (req, reply) => {
    try { return await proposals.reject(req.params.id); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
}
