import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonFile } from "../../src/agent/json-store.js";

describe("JsonFile", () => {
  it("serializes concurrent writes: 50 concurrent writers all land in the file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jsonstore-"));
    const file = path.join(dir, "sub", "index.json");
    const store = new JsonFile<number[]>(file);
    const seen: number[] = [];
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.write(() => { seen.push(i); return [...seen]; })));
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as number[];
    expect(onDisk.length).toBe(50);
    expect(new Set(onDisk)).toEqual(new Set(Array.from({ length: 50 }, (_, i) => i)));
  });

  it("a write whose thunk throws rejects only its own caller; later writes still run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jsonstore-"));
    const file = path.join(dir, "index.json");
    const store = new JsonFile<string[]>(file);
    await store.write(() => ["first"]);
    await expect(store.write(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await store.write(() => ["after-the-throw"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as string[];
    expect(onDisk).toEqual(["after-the-throw"]);
  });

  it("read() returns the fallback for a missing or corrupt file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jsonstore-"));
    const store = new JsonFile<string[]>(path.join(dir, "missing.json"));
    expect(await store.read(["fallback"])).toEqual(["fallback"]);
  });

  it("a corrupt file is moved aside before the fallback is used, so the next write cannot destroy it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jsonstore-"));
    const file = path.join(dir, "index.json");
    writeFileSync(file, '[{"id":"a"}, {"id":');
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new JsonFile<unknown[]>(file);
    expect(await store.read([])).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
    log.mockRestore();
    await store.write(() => ["new"]);
    const aside = readdirSync(dir).filter((f) => f.startsWith("index.json.corrupt-"));
    expect(aside.length).toBe(1);
    expect(readFileSync(path.join(dir, aside[0]!), "utf8")).toBe('[{"id":"a"}, {"id":');
  });

  it("update() is one read-modify-write step: 30 concurrent updates of different keys all survive", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jsonstore-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ keep: 1 }));
    const store = new JsonFile<Record<string, number>>(file, 2);
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.update({}, (s) => ({ ...s, [`k${i}`]: i }))));
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    expect(Object.keys(onDisk).length).toBe(31);
    expect(onDisk.keep).toBe(1);
    expect(readFileSync(file, "utf8")).toContain('\n  "keep": 1');
  });
});
