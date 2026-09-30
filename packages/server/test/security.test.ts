import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, originAllowed } from "../src/app.js";
import { checkRestricted } from "../src/terminal.js";
import { seedIfEmpty } from "../src/main.js";
import type { ServerConfig } from "../src/config.js";
import { qktBin } from "./helpers.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const cfgFor = (ws: string, extra: Partial<ServerConfig> = {}): ServerConfig => ({ workspace: ws, dataRoot: tmp("data-"), qktBin, port: 0, host: "0.0.0.0", maxParallel: 1, terminal: "restricted", allowedHosts: [], allowedOrigins: [], ...extra });

describe("cross-site protection", () => {
  it("refuses a WebSocket or write from another site's page, allows the studio's own page and non-browser clients", async () => {
    const app = await buildApp(cfgFor(tmp("ws-")), (a) => { a.post("/api/thing", async () => ({ ok: true })); });
    const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/thing", headers: { host: "localhost:8080", ...headers }, payload: {} });
    expect((await post({ origin: "http://evil.example" })).statusCode).toBe(403);
    expect((await post({ origin: "http://localhost:8080" })).statusCode).toBe(200);
    expect((await post({})).statusCode).toBe(200); // curl, scripts: no Origin
    const ws = await app.inject({ method: "GET", url: "/ws/term", headers: { host: "localhost:8080", origin: "https://evil.example", connection: "upgrade", upgrade: "websocket" } });
    expect(ws.statusCode).toBe(403);
    await app.close();
  });
  it("without a token only loopback Host names are served (no DNS rebinding); STUDIO_ALLOWED_HOSTS or a token opens it up", async () => {
    const open = await buildApp(cfgFor(tmp("ws-")));
    expect((await open.inject({ url: "/api/health", headers: { host: "attacker.example:8080" } })).statusCode).toBe(403);
    for (const h of ["localhost:8080", "127.0.0.1:8080", "[::1]:8080"]) expect((await open.inject({ url: "/api/health", headers: { host: h } })).statusCode).toBe(200);
    await open.close();
    const listed = await buildApp(cfgFor(tmp("ws-"), { allowedHosts: ["studio.lan"] }));
    expect((await listed.inject({ url: "/api/health", headers: { host: "studio.lan:8080" } })).statusCode).toBe(200);
    await listed.close();
    const withToken = await buildApp(cfgFor(tmp("ws-"), { token: "s3cret" }));
    expect((await withToken.inject({ url: "/api/health", headers: { host: "studio.example.com", authorization: "Bearer s3cret" } })).statusCode).toBe(200);
    expect((await withToken.inject({ url: "/api/health", headers: { host: "studio.example.com" } })).statusCode).toBe(401);
    await withToken.close();
  });
  it("originAllowed: own origin, listed origins, and loopback dev servers only when the studio is on loopback", () => {
    expect(originAllowed("http://localhost:8080", "localhost:8080", [])).toBe(true);
    expect(originAllowed("http://localhost:5173", "localhost:8080", [])).toBe(true);
    expect(originAllowed("http://localhost:5173", "studio.example.com", [])).toBe(false);
    expect(originAllowed("https://tools.example", "studio.example.com", ["https://tools.example"])).toBe(true);
    expect(originAllowed("null", "localhost:8080", [])).toBe(false);
  });
});

describe("restricted terminal paths", () => {
  it("checks the value of --flag=value too", () => {
    expect(checkRestricted(["qkt", "backtest", "s.qkt", "--report-dir=/tmp/pwn"], "/w", "/d")).toMatch(/outside the workspace/);
    expect(checkRestricted(["qkt", "backtest", "s.qkt", "--data-root=/tmp/pwn"], "/w", "/d")).toMatch(/outside the workspace/);
    expect(checkRestricted(["qkt", "backtest", "s.qkt", "--report-dir=../x"], "/w", "/d")).toMatch(/\.\./);
    expect(checkRestricted(["qkt", "backtest", "s.qkt", "--report-dir=/w/runs/x"], "/w", "/d")).toBeNull();
    expect(checkRestricted(["qkt", "parse", "/dx/secret"], "/w", "/d")).toMatch(/outside/); // prefix of the data root is not inside it
    expect(checkRestricted(["qkt", "parse", "/d/bars/x"], "/w", "/d")).toBeNull();
  });
});

describe("first-run seeding", () => {
  it("seeds an empty workspace, also one that only has the studio's own runs/ and .qkt-studio/, and never a user's", async () => {
    const fresh = tmp("seed-");
    expect(await seedIfEmpty(cfgFor(fresh))).toEqual(expect.arrayContaining(["qkt.config.yaml", "instruments.yaml", ".env"]));
    expect(existsSync(path.join(fresh, "qkt.config.yaml"))).toBe(true);
    const restarted = tmp("seed-");
    mkdirSync(path.join(restarted, "runs")); mkdirSync(path.join(restarted, ".qkt-studio"));
    expect(await seedIfEmpty(cfgFor(restarted))).not.toBeNull();
    const users = tmp("seed-");
    writeFileSync(path.join(users, "notes.txt"), "mine");
    expect(await seedIfEmpty(cfgFor(users))).toBeNull();
    expect(existsSync(path.join(users, "qkt.config.yaml"))).toBe(false);
  });
});
