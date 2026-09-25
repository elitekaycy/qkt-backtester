import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBuiltin, type TermSession } from "../src/term-builtins.js";
import { checkRestricted } from "../src/terminal.js";

let ws: string, outside: string;
beforeAll(() => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tb-")));
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tb-out-")));
  mkdirSync(path.join(ws, "strategies")); mkdirSync(path.join(ws, "runs")); mkdirSync(path.join(ws, ".qkt-studio"));
  writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 10000\nlog_level: info\n");
  writeFileSync(path.join(ws, "strategies", "a.qkt"), "STRATEGY a VERSION 1\n");
  writeFileSync(path.join(ws, ".env"), "K=v\n");
  writeFileSync(path.join(outside, "secret.txt"), "nope");
  symlinkSync(outside, path.join(ws, "escape"));
});
afterAll(() => { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

const run = (line: string, s: TermSession = { cwd: "" }) => runBuiltin(line.split(" "), ws, s);

describe("restricted terminal builtins", () => {
  it("ls lists the workspace, folders first, hiding studio internals", async () => {
    const r = await run("ls");
    expect(r.code).toBe(0);
    expect(r.out).toContain("strategies/");
    expect(r.out).toContain("qkt.config.yaml");
    expect(r.out).toContain(".env");
    expect(r.out).not.toContain(".qkt-studio");
  });
  it("cd then ls, pwd and cat resolve relative to the session folder", async () => {
    const s: TermSession = { cwd: "" };
    expect((await run("cd strategies", s)).code).toBe(0);
    expect(s.cwd).toBe("strategies");
    expect((await run("pwd", s)).out).toBe("/strategies");
    expect((await run("ls", s)).out).toBe("a.qkt");
    expect((await run("cat a.qkt", s)).out).toBe("STRATEGY a VERSION 1");
    expect((await run("cd ..", s)).code).toBe(0);
    expect(s.cwd).toBe("");
  });
  it("head and tail take -n", async () => {
    expect((await run("head -n 1 qkt.config.yaml")).out).toBe("starting_balance: 10000");
    expect((await run("tail -n 1 qkt.config.yaml")).out).toBe("log_level: info");
  });
  it("cannot leave the workspace, by .. or by a symlink", async () => {
    expect((await run("cd ../..")).code).toBe(1);
    expect((await run("cat ../../etc/passwd")).code).toBe(1);
    expect((await run("cat escape/secret.txt")).out).toMatch(/escapes/);
    expect((await run("ls /etc")).code).toBe(1);
  });
  it("a missing file is an error, not a crash", async () => {
    const r = await run("cat nope.txt");
    expect(r).toMatchObject({ code: 1 });
    expect(r.out).toMatch(/no such file/);
  });
  it("unknown commands point to help instead of a bare refusal", () => {
    expect(checkRestricted(["rm", "-rf", "x"], "/w", "/d")).toMatch(/type 'help'/);
  });
});
