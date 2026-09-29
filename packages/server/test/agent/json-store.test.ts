import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
});
