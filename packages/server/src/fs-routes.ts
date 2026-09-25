import type { FastifyInstance, FastifyReply } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import { JailError, resolveInJail, toRel } from "./jail.js";

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Directories the studio owns; the file API must never mutate them. */
const PROTECTED_TOP = new Set(["runs", ".qkt-studio"]);
const HIDDEN = new Set([".qkt-studio", ".git", "node_modules"]);

export interface TreeEntry { name: string; path: string; type: "file" | "dir"; size: number; mtimeMs: number }

const etagOf = (st: { mtimeMs: number; size: number }) => `"${Math.floor(st.mtimeMs)}-${st.size}"`;

function topSegment(rel: string): string { return rel.split("/")[0] ?? ""; }

function isProtected(rel: string): boolean { return PROTECTED_TOP.has(topSegment(rel)); }

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function registerFsRoutes(app: FastifyInstance, cfg: ServerConfig): void {
  const root = cfg.workspace;
  const fail = (reply: FastifyReply, status: number, message: string) => reply.code(status).send({ error: message });

  const guard = async (rel: string, reply: FastifyReply, opts: { write?: boolean } = {}) => {
    try {
      const abs = await resolveInJail(root, rel);
      const relNorm = toRel(await fs.realpath(root), abs);
      if (opts.write && (relNorm === "" || isProtected(relNorm))) { fail(reply, 403, `'${relNorm || "."}' is managed by the studio and cannot be modified here`); return null; }
      return { abs, rel: relNorm };
    } catch (e) {
      if (e instanceof JailError) { fail(reply, e.status, e.message); return null; }
      throw e;
    }
  };

  app.get<{ Querystring: { path?: string } }>("/api/tree", async (req, reply) => {
    const g = await guard(req.query.path ?? "", reply);
    if (!g) return;
    let names: import("node:fs").Dirent[];
    try { names = await fs.readdir(g.abs, { withFileTypes: true }); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? fail(reply, 404, "not found") : fail(reply, 400, "not a directory"); }
    const entries: TreeEntry[] = [];
    for (const d of names) {
      if (HIDDEN.has(d.name)) continue;
      const abs = path.join(g.abs, d.name);
      let st;
      try { st = await fs.stat(abs); } catch { continue; } // dangling symlink: skip
      const rel = g.rel ? `${g.rel}/${d.name}` : d.name;
      // Symlinks that leave the workspace are shown as nothing rather than as a way out.
      try { await resolveInJail(root, rel); } catch { continue; }
      entries.push({ name: d.name, path: rel, type: st.isDirectory() ? "dir" : "file", size: st.size, mtimeMs: st.mtimeMs });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: g.rel, entries };
  });

  app.get<{ Querystring: { path?: string } }>("/api/file", async (req, reply) => {
    const g = await guard(req.query.path ?? "", reply);
    if (!g) return;
    let st;
    try { st = await fs.stat(g.abs); } catch { return fail(reply, 404, "not found"); }
    if (!st.isFile()) return fail(reply, 400, "not a file");
    if (st.size > MAX_TEXT_BYTES) return fail(reply, 413, `file is larger than ${MAX_TEXT_BYTES} bytes`);
    const buf = await fs.readFile(g.abs);
    if (looksBinary(buf)) return fail(reply, 415, "binary file");
    reply.header("ETag", etagOf(st));
    return { path: g.rel, content: buf.toString("utf8"), etag: etagOf(st) };
  });

  app.post<{ Body: { path: string; type?: "file" | "dir"; content?: string } }>("/api/file", async (req, reply) => {
    const g = await guard(req.body?.path ?? "", reply, { write: true });
    if (!g) return;
    try { await fs.lstat(g.abs); return fail(reply, 409, "already exists"); } catch { /* good */ }
    if (req.body.type === "dir") { await fs.mkdir(g.abs, { recursive: true }); return reply.code(201).send({ path: g.rel }); }
    await fs.mkdir(path.dirname(g.abs), { recursive: true });
    await fs.writeFile(g.abs, req.body.content ?? "", { flag: "wx" });
    const st = await fs.stat(g.abs);
    return reply.code(201).send({ path: g.rel, etag: etagOf(st) });
  });

  app.put<{ Body: { path: string; content: string } }>("/api/file", async (req, reply) => {
    const g = await guard(req.body?.path ?? "", reply, { write: true });
    if (!g) return;
    if (typeof req.body.content !== "string") return fail(reply, 400, "content must be a string");
    const ifMatch = req.headers["if-match"];
    let st;
    try { st = await fs.stat(g.abs); } catch { return fail(reply, 404, "not found (use POST to create)"); }
    if (!ifMatch) return fail(reply, 428, "If-Match is required");
    if (ifMatch !== etagOf(st)) return fail(reply, 412, "file changed on disk since you opened it");
    await fs.writeFile(g.abs, req.body.content);
    const next = await fs.stat(g.abs);
    reply.header("ETag", etagOf(next));
    return { path: g.rel, etag: etagOf(next) };
  });

  app.delete<{ Querystring: { path?: string } }>("/api/file", async (req, reply) => {
    const g = await guard(req.query.path ?? "", reply, { write: true });
    if (!g) return;
    try { await fs.lstat(g.abs); } catch { return fail(reply, 404, "not found"); }
    await fs.rm(g.abs, { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.post<{ Body: { from: string; to: string } }>("/api/rename", async (req, reply) => {
    const a = await guard(req.body?.from ?? "", reply, { write: true });
    if (!a) return;
    const b = await guard(req.body?.to ?? "", reply, { write: true });
    if (!b) return;
    try { await fs.lstat(a.abs); } catch { return fail(reply, 404, "source not found"); }
    try { await fs.lstat(b.abs); return fail(reply, 409, "destination exists"); } catch { /* good */ }
    await fs.mkdir(path.dirname(b.abs), { recursive: true });
    await fs.rename(a.abs, b.abs);
    return { from: a.rel, to: b.rel };
  });
}
