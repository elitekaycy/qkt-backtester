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
