import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyChanges, lineDiff, textHash, type Change, type Tier } from "@qkt-studio/core";
import type { ServerConfig } from "../config.js";
import type { Runner } from "../runner.js";
import type { EventBus } from "./events.js";
import { checkQueued } from "../check.js";
import { resolveInJail } from "../jail.js";
import { JsonFile } from "./json-store.js";

export interface Variant {
  id: string; label: string; base: string; baseText: string; path: string; changes: Change[]; diff: string; notes: string[];
  created: string; window: { from: string; to: string; tier: Tier }; runId: string | null; baseRunId: string | null;
}
/** A variant built and checked but not yet written or indexed (see `prepare`). */
export type PreparedVariant = Omit<Variant, "id" | "path" | "created" | "runId" | "baseRunId"> & { source: string };
type Submitted = { runId: string; cached: boolean; joined: boolean };

const DIR = ".qkt-studio/variants";
const KEEP = 200;
const WAIT_MS = 180_000;
const errorsOf = (ds: Array<{ severity: string; line: number; message: string }>) => ds.filter((d) => d.severity === "error").map((d) => `line ${d.line}: ${d.message}`).join("; ");
/** Rebasing replays the change list on newer text; a whole-file `source` replacement has nothing to replay. */
export const canRebase = (v: Pick<Variant, "changes">) => Array.isArray(v.changes) && v.changes.length > 0 && !v.changes.some((c) => c.op === "source");

/** Copies of a strategy with changes applied, each run beside its base; the user adopts one or discards it. */
export class Variants {
  private items: Variant[] = [];
  /** Run ids purged by Stop (see discardForRun). */
  private purged = new Set<string>();
  private store: JsonFile<Variant[]>;
  constructor(private cfg: ServerConfig, private runner: Runner, private events: EventBus) {
    this.store = new JsonFile(path.join(cfg.workspace, DIR, "index.json"));
  }
  /** Load the index, and remove variant folders the index no longer knows (dropped past KEEP, or left by a crash). */
  async init(): Promise<void> {
    this.items = await this.store.read([]);
    if (!Array.isArray(this.items)) this.items = [];
    // an unreadable index knows nothing: sweeping against it would delete every variant, so keep the folders
    if (this.store.corrupt || !this.items.length) return;
    const known = new Set(this.items.map((v) => v.id));
    for (const e of await fs.readdir(path.join(this.cfg.workspace, DIR), { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !known.has(e.name)) await this.removeDir(e.name);
    }
  }
  private async removeDir(id: string): Promise<void> {
    if (!/^[\w-]+$/.test(id)) return;
    await fs.rm(path.join(this.cfg.workspace, DIR, id), { recursive: true, force: true }).catch(() => undefined);
  }
  private async save(): Promise<void> {
    const dropped = this.items.slice(0, Math.max(0, this.items.length - KEEP));
    this.items = this.items.slice(-KEEP);
    await this.store.write(() => this.items);
    for (const v of dropped) await this.removeDir(v.id);
  }
  list(base?: string): Variant[] { return this.items.filter((v) => !base || v.base === base).slice().reverse(); }
  get(id: string): Variant | undefined { return this.items.find((v) => v.id === id); }

  /**
   * Build and check a variant without writing anything: the base text is read now, so a save by the user after this call
   * does not change it. Throws when the changes do not apply or the result does not parse.
   */
  async prepare(base: string, label: string, changes: Change[], window: Variant["window"]): Promise<PreparedVariant> {
    const baseAbs = await resolveInJail(this.cfg.workspace, base);
    const baseText = await fs.readFile(baseAbs, "utf8");
    const { source, notes } = applyChanges(baseText, changes); // refuses portfolios and non-strategies first
    if (/^\s*IMPORT\s/m.test(baseText)) throw new Error(`${base} IMPORTs other files; a variant copy cannot resolve relative IMPORTs, so change the imported strategy instead`);
    if (/^\s*IMPORT\s/m.test(source)) throw new Error("a variant cannot IMPORT other files; its copy lives in another folder, where relative IMPORTs do not resolve");
    const check = await checkQueued(this.cfg, source, base);
    if (!check.ok) throw new Error(`the change does not parse: ${errorsOf(check.diagnostics)}`);
    return { label, base, baseText, changes, source, window, diff: lineDiff(baseText, source), notes: [...notes, ...check.diagnostics.filter((d) => d.severity !== "error").map((d) => `warning line ${d.line}: ${d.message}`)] };
  }

  /** Write a prepared variant's copy and index it. */
  async commit(p: PreparedVariant): Promise<Variant> {
    const id = randomBytes(5).toString("hex");
    const rel = `${DIR}/${id}/${path.basename(p.base, ".qkt")}.qkt`;
    await fs.mkdir(path.join(this.cfg.workspace, DIR, id), { recursive: true });
    await fs.writeFile(path.join(this.cfg.workspace, rel), p.source);
    const { source: _s, ...rest } = p;
    const v: Variant = { ...rest, id, path: rel, created: new Date().toISOString(), runId: null, baseRunId: null };
    this.items.push(v);
    await this.save();
    return v;
  }

  async create(base: string, label: string, changes: Change[], window: Variant["window"]): Promise<Variant> {
    return this.commit(await this.prepare(base, label, changes, window));
  }

  /**
   * Run the variant and its base on the same window (the base run is cached when it already exists). `onSubmit` hears each
   * submit the moment it is accepted, so a caller can track the run even if the other submit or the wait fails.
   */
  async run(v: Variant, o: { source?: "user" | "tool"; onSubmit?: (which: "variant" | "base", r: Submitted) => void; onSubmitted?: () => void } = {}): Promise<Variant> {
    const req = { from: v.window.from, to: v.window.to, tier: v.window.tier, source: o.source };
    const submit = (which: "variant" | "base", strategy: string) => this.runner.submit({ ...req, strategy }).then((r) => { o.onSubmit?.(which, r); return r; });
    // both submits settle (accepted or refused) before anything is reported, so no accepted run goes unrecorded
    const settled = await Promise.allSettled([submit("variant", v.path), submit("base", v.base)]);
    o.onSubmitted?.();
    const refused = settled.find((r) => r.status === "rejected");
    if (refused) throw refused.reason;
    const [a, b] = settled.map((r) => (r as PromiseFulfilledResult<Submitted>).value) as [Submitted, Submitted];
    v.runId = a.runId; v.baseRunId = b.runId;
    // Stop purged this variant's run before its id was recorded here: the variant goes with it
    if (this.purged.has(a.runId)) { await this.discard(v.id); return v; }
    await this.save();
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS));
    await Promise.race([Promise.all([this.runner.waitFor(a.runId), this.runner.waitFor(b.runId)]), timeout]);
    this.events.emit({ t: "variant", variantId: v.id, runId: a.runId });
    return v;
  }

  /**
   * The variant's changes replayed on `text` (default: the base file as it is now), checked. For adopting a variant whose
   * base the user has changed since: their newer text is kept and only the variant's own changes are added.
   */
  async rebase(id: string, text?: string): Promise<{ source: string; notes: string[]; baseHash: string }> {
    const v = this.get(id);
    if (!v) throw new RebaseError("no such variant", 404);
    if (!canRebase(v)) throw new RebaseError("this variant replaced the whole file, so its changes cannot be re-applied to newer text", 409);
    const cur = typeof text === "string" ? text : await fs.readFile(await resolveInJail(this.cfg.workspace, v.base), "utf8");
    let out: { source: string; notes: string[] };
    try { out = applyChanges(cur, v.changes); } catch (e) { throw new RebaseError(`the variant's changes do not apply to the current text: ${(e as Error).message}`, 409); }
    const check = await checkQueued(this.cfg, out.source, v.base);
    if (!check.ok) throw new RebaseError(`the variant's changes on the current text do not parse: ${errorsOf(check.diagnostics)}`, 409);
    return { source: out.source, notes: out.notes, baseHash: textHash(cur) };
  }

  async discard(id: string): Promise<void> {
    const v = this.get(id);
    if (!v) throw new Error("no such variant");
    await this.removeDir(id);
    this.items = this.items.filter((x) => x.id !== id);
    await this.save();
    this.events.emit({ t: "variants" }); // every tab's variant list (and a card or chart showing it) follows
  }

  /**
   * A variant's run was purged (Stop cancels what a chat message started): the variant is discarded, so no card, bar or
   * chart points at a run that no longer exists. A variant still being submitted is discarded once its run id is known.
   */
  async discardForRun(runId: string): Promise<void> {
    this.purged.add(runId);
    for (const v of this.items.filter((x) => x.runId === runId)) await this.discard(v.id);
  }
}
export class RebaseError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export function registerVariantRoutes(app: FastifyInstance, cfg: ServerConfig, variants: Variants): void {
  app.get<{ Querystring: { base?: string } }>("/api/variants", async (req) => ({ variants: variants.list(req.query.base).map(({ baseText: _b, ...v }) => v) }));
  /** The variant with its source, and the hash of the text it was made from (not that text itself) plus whether it can be rebased. */
  app.get<{ Params: { id: string } }>("/api/variants/:id", async (req, reply) => {
    const v = variants.get(req.params.id);
    if (!v) return reply.code(404).send({ error: "no such variant" });
    const { baseText, ...rest } = v;
    return { ...rest, baseHash: textHash(baseText), canRebase: canRebase(v), source: await fs.readFile(path.join(cfg.workspace, v.path), "utf8").catch(() => null) };
  });
  app.post<{ Params: { id: string }; Body: { text?: unknown } | undefined }>("/api/variants/:id/rebase", async (req, reply) => {
    const text = req.body?.text;
    if (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)) return reply.code(400).send({ error: "text must be a string under 1 MB" });
    try { return await variants.rebase(req.params.id, text as string | undefined); }
    catch (e) { return reply.code(e instanceof RebaseError ? e.status : 400).send({ error: (e as Error).message }); }
  });
  app.delete<{ Params: { id: string } }>("/api/variants/:id", async (req, reply) => {
    try { await variants.discard(req.params.id); return reply.code(204).send(); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });
}
