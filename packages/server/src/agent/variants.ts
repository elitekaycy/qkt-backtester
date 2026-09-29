import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyChanges, lineDiff, type Change, type Tier } from "@qkt-studio/core";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { EventBus } from "./events.js";
import { checkQktSource } from "../check.js";
import { resolveInJail } from "../jail.js";

export interface Variant {
  id: string; label: string; base: string; baseText: string; path: string; changes: Change[]; diff: string; notes: string[];
  created: string; window: { from: string; to: string; tier: Tier }; runId: string | null; baseRunId: string | null;
}

const DIR = ".qkt-studio/variants";
const WAIT_MS = 180_000;

/** Copies of a strategy with changes applied, each run beside its base; the user adopts one or discards it. */
export class Variants {
  private items: Variant[] = [];
  constructor(private cfg: ServerConfig, private runner: Runner, private events: EventBus) {}
  private index() { return path.join(this.cfg.workspace, DIR, "index.json"); }
  async init(): Promise<void> { try { this.items = JSON.parse(await fs.readFile(this.index(), "utf8")) as Variant[]; } catch { this.items = []; } }
  private async save(): Promise<void> {
    await fs.mkdir(path.join(this.cfg.workspace, DIR), { recursive: true });
    this.items = this.items.slice(-200);
    await fs.writeFile(`${this.index()}.tmp`, JSON.stringify(this.items));
    await fs.rename(`${this.index()}.tmp`, this.index());
  }
  list(base?: string): Variant[] { return this.items.filter((v) => !base || v.base === base).slice().reverse(); }
  get(id: string): Variant | undefined { return this.items.find((v) => v.id === id); }

  /** The base text is read now: a save by the user after this call does not change this variant. */
  async create(base: string, label: string, changes: Change[], window: Variant["window"]): Promise<Variant> {
    const baseAbs = await resolveInJail(this.cfg.workspace, base);
    const baseText = await fs.readFile(baseAbs, "utf8");
    const { source, notes } = applyChanges(baseText, changes);
    const check = await checkQktSource(this.cfg, source, base);
    if (!check.ok) throw new Error(`the change does not parse: ${check.diagnostics.filter((d) => d.severity === "error").map((d) => `line ${d.line}: ${d.message}`).join("; ")}`);
    const id = randomBytes(5).toString("hex");
    const slug = path.basename(base, ".qkt");
    const rel = `${DIR}/${id}/${slug}.qkt`;
    await fs.mkdir(path.join(this.cfg.workspace, DIR, id), { recursive: true });
    await fs.writeFile(path.join(this.cfg.workspace, rel), source);
    const v: Variant = { id, label, base, baseText, path: rel, changes, diff: lineDiff(baseText, source), notes: [...notes, ...check.diagnostics.filter((d) => d.severity !== "error").map((d) => `warning line ${d.line}: ${d.message}`)], created: new Date().toISOString(), window, runId: null, baseRunId: null };
    this.items.push(v);
    await this.save();
    return v;
  }

  /** Run the variant and its base on the same window (the base run is cached when it already exists). */
  async run(v: Variant): Promise<Variant> {
    const req = { from: v.window.from, to: v.window.to, tier: v.window.tier };
    const [a, b] = await Promise.all([this.runner.submit({ ...req, strategy: v.path }), this.runner.submit({ ...req, strategy: v.base })]);
    v.runId = a.runId; v.baseRunId = b.runId;
    await this.save();
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS));
    await Promise.race([Promise.all([this.runner.waitFor(a.runId), this.runner.waitFor(b.runId)]), timeout]);
    this.events.emit({ t: "variant", variantId: v.id, runId: a.runId });
    return v;
  }

  async discard(id: string): Promise<void> {
    const v = this.get(id);
    if (!v) throw new Error("no such variant");
    await fs.rm(path.join(this.cfg.workspace, DIR, id), { recursive: true, force: true });
    this.items = this.items.filter((x) => x.id !== id);
    await this.save();
  }
}

export function registerVariantRoutes(app: FastifyInstance, cfg: ServerConfig, variants: Variants): void {
  app.get<{ Querystring: { base?: string } }>("/api/variants", async (req) => ({ variants: variants.list(req.query.base).map(({ baseText: _b, ...v }) => v) }));
  app.get<{ Params: { id: string } }>("/api/variants/:id", async (req, reply) => {
    const v = variants.get(req.params.id);
    if (!v) return reply.code(404).send({ error: "no such variant" });
    const { baseText: _b, ...rest } = v;
    return { ...rest, source: await fs.readFile(path.join(cfg.workspace, v.path), "utf8").catch(() => null) };
  });
  app.delete<{ Params: { id: string } }>("/api/variants/:id", async (req, reply) => {
    try { await variants.discard(req.params.id); return reply.code(204).send(); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });
}
