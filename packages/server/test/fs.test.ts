import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInJail, JailError } from "../src/jail.js";
import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

let ws: string, outside: string;
const cfg = (extra: Partial<ServerConfig> = {}): ServerConfig => ({
  workspace: ws, dataRoot: "/nonexistent", qktBin: "qkt", port: 0, host: "127.0.0.1", maxParallel: 1, terminal: "restricted", ...extra,
});

beforeEach(() => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-")));
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "out-")));
  writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  mkdirSync(path.join(ws, "strategies"));
  writeFileSync(path.join(ws, "strategies", "a.qkt"), "STRATEGY a VERSION 1\n");
  writeFileSync(path.join(ws, "qkt.config.yaml"), "source: tv\n");
});
afterEach(() => { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe("resolveInJail", () => {
  it("resolves normal, nested and not-yet-existing paths", async () => {
    expect(await resolveInJail(ws, "strategies/a.qkt")).toBe(path.join(ws, "strategies", "a.qkt"));
    expect(await resolveInJail(ws, "new/dir/file.qkt")).toBe(path.join(ws, "new", "dir", "file.qkt"));
    expect(await resolveInJail(ws, "")).toBe(ws);
    expect(await resolveInJail(ws, "strategies/../qkt.config.yaml")).toBe(path.join(ws, "qkt.config.yaml"));
  });
  it.each(["../x", "../../etc/passwd", "strategies/../../x", "a/../../../x"])("rejects traversal %s", async (p) => {
    await expect(resolveInJail(ws, p)).rejects.toBeInstanceOf(JailError);
  });
  it("rejects absolute, drive-letter and NUL paths", async () => {
    await expect(resolveInJail(ws, "/etc/passwd")).rejects.toThrow(/absolute/);
    await expect(resolveInJail(ws, "C:\\Windows")).rejects.toThrow(/absolute/);
    await expect(resolveInJail(ws, "a\0b")).rejects.toThrow(/invalid/);
  });
  it("rejects a symlink to an outside file and a symlink dir used to create files outside", async () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "leak"));
    symlinkSync(outside, path.join(ws, "outdir"));
    await expect(resolveInJail(ws, "leak")).rejects.toThrow(/symlink/);
    await expect(resolveInJail(ws, "outdir/new.txt")).rejects.toThrow(/symlink/);
  });
  it("rejects a dangling symlink and allows a symlink that stays inside", async () => {
    symlinkSync(path.join(outside, "gone"), path.join(ws, "dangle"));
    await expect(resolveInJail(ws, "dangle")).rejects.toBeInstanceOf(JailError);
    symlinkSync(path.join(ws, "strategies"), path.join(ws, "alias"));
    await expect(resolveInJail(ws, "alias/a.qkt")).resolves.toBeTruthy();
  });
});

describe("file routes", () => {
  it("lists the tree, dirs first, hiding studio internals and outside symlinks", async () => {
    mkdirSync(path.join(ws, ".qkt-studio")); mkdirSync(path.join(ws, "node_modules")); mkdirSync(path.join(ws, "runs"));
    symlinkSync(outside, path.join(ws, "escape"));
    const app = await buildApp(cfg());
    const r = await app.inject({ url: "/api/tree" });
    const names = r.json().entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(["runs", "strategies", "qkt.config.yaml"]);
    expect((await app.inject({ url: "/api/tree?path=strategies" })).json().entries[0].path).toBe("strategies/a.qkt");
  });
  it("reads a file with an etag; edits need a matching If-Match", async () => {
    const app = await buildApp(cfg());
    const g = (await app.inject({ url: "/api/file?path=strategies/a.qkt" })).json();
    expect(g.content).toBe("STRATEGY a VERSION 1\n");
    const noMatch = await app.inject({ method: "PUT", url: "/api/file", payload: { path: "strategies/a.qkt", content: "x" } });
    expect(noMatch.statusCode).toBe(428);
    const stale = await app.inject({ method: "PUT", url: "/api/file", headers: { "if-match": '"1-1"' }, payload: { path: "strategies/a.qkt", content: "x" } });
    expect(stale.statusCode).toBe(412);
    const ok = await app.inject({ method: "PUT", url: "/api/file", headers: { "if-match": g.etag }, payload: { path: "strategies/a.qkt", content: "STRATEGY b VERSION 1\n" } });
    expect(ok.statusCode).toBe(200);
    expect(readFileSync(path.join(ws, "strategies", "a.qkt"), "utf8")).toBe("STRATEGY b VERSION 1\n");
    // the etag moved: reusing the old one now conflicts (two tabs saving the same file)
    const again = await app.inject({ method: "PUT", url: "/api/file", headers: { "if-match": g.etag }, payload: { path: "strategies/a.qkt", content: "y" } });
    expect(again.statusCode).toBe(412);
  });
  it("creates files and dirs (409 on duplicates), renames and deletes", async () => {
    const app = await buildApp(cfg());
    expect((await app.inject({ method: "POST", url: "/api/file", payload: { path: "strategies/new.qkt", content: "hi" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/file", payload: { path: "strategies/new.qkt" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/file", payload: { path: "more/deep", type: "dir" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/rename", payload: { from: "strategies/new.qkt", to: "strategies/renamed.qkt" } })).statusCode).toBe(200);
    expect(existsSync(path.join(ws, "strategies", "renamed.qkt"))).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/rename", payload: { from: "strategies/renamed.qkt", to: "qkt.config.yaml" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/api/file?path=strategies/renamed.qkt" })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/file?path=strategies/renamed.qkt" })).statusCode).toBe(404);
  });
  it("never lets the file API touch runs/, .qkt-studio/ or the workspace root", async () => {
    mkdirSync(path.join(ws, "runs")); writeFileSync(path.join(ws, "runs", "keep.txt"), "k");
    const app = await buildApp(cfg());
    for (const p of ["runs/x.txt", ".qkt-studio/db", ""]) {
      expect((await app.inject({ method: "POST", url: "/api/file", payload: { path: p, content: "x" } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "DELETE", url: "/api/file?path=runs" })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/file?path=" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/rename", payload: { from: "strategies", to: "runs/strategies" } })).statusCode).toBe(403);
    expect(existsSync(path.join(ws, "runs", "keep.txt"))).toBe(true);
  });
  it("refuses binary and oversized files", async () => {
    writeFileSync(path.join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    writeFileSync(path.join(ws, "big.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    const app = await buildApp(cfg());
    expect((await app.inject({ url: "/api/file?path=bin.dat" })).statusCode).toBe(415);
    expect((await app.inject({ url: "/api/file?path=big.txt" })).statusCode).toBe(413);
  });
  it("every endpoint refuses traversal and symlink escapes", async () => {
    symlinkSync(outside, path.join(ws, "outdir"));
    const app = await buildApp(cfg());
    for (const p of ["../etc/passwd", "outdir/secret.txt", "/etc/passwd"]) {
      const enc = encodeURIComponent(p);
      for (const r of [
        await app.inject({ url: `/api/file?path=${enc}` }),
        await app.inject({ url: `/api/tree?path=${enc}` }),
        await app.inject({ method: "POST", url: "/api/file", payload: { path: p, content: "x" } }),
        await app.inject({ method: "DELETE", url: `/api/file?path=${enc}` }),
        await app.inject({ method: "POST", url: "/api/rename", payload: { from: p, to: "x" } }),
      ]) expect([400, 403]).toContain(r.statusCode);
    }
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
  });
  it("404s for missing files and treats a file as a non-directory for /tree", async () => {
    const app = await buildApp(cfg());
    expect((await app.inject({ url: "/api/file?path=nope.qkt" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/tree?path=qkt.config.yaml" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/tree?path=nodir" })).statusCode).toBe(404);
  });
});

describe("token auth", () => {
  it("guards /api when a token is configured, accepts bearer or ?token=", async () => {
    const app = await buildApp(cfg({ token: "s3cret" }));
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/tree", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/tree", headers: { authorization: "Bearer s3cret" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/tree?token=s3cret" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/tree?token=s3cre" })).statusCode).toBe(401);
  });
  it("is open when no token is configured", async () => {
    expect((await (await buildApp(cfg())).inject({ url: "/api/health" })).statusCode).toBe(200);
  });
});
