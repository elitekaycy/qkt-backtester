import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { qktLanguage, registerQktLangRoutes } from "../src/qkt-lang.js";
import { haveQkt, qktBin, testConfig } from "./helpers.js";

const VOCABULARY_KEYS = ["schema", "keywords", "keywordCategories", "indicators", "functions", "constants", "streamFields", "metaFields", "seriesSelectors", "members", "shorthands"];
const CATEGORIES = ["SECTION", "FLOW", "ACTION", "ORDER", "SIZING", "BRACKET", "STACKING", "PORTFOLIO", "SESSION", "HOOK", "STATE", "OPERATOR_WORD", "AGGREGATE", "LITERAL"];

describe.skipIf(!haveQkt)("the language of the qkt the studio runs", () => {
  let ws: string, app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ws = mkdtempSync(path.join(os.tmpdir(), "qkt-lang-"));
    writeFileSync(path.join(ws, "qkt.config.yaml"), "starting_balance: 10000\n");
    app = await buildApp(testConfig(ws), async (a) => registerQktLangRoutes(a, await qktLanguage(qktBin)));
  });
  afterAll(async () => { await app.close(); rmSync(ws, { recursive: true, force: true }); });

  it("serves qkt's vocabulary: schema qkt-vocabulary-v1, every key, categories and members filled", async () => {
    const res = await app.inject({ url: "/api/qkt/vocabulary" });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.schema).toBe("qkt-vocabulary-v1");
    expect(Object.keys(v)).toEqual(VOCABULARY_KEYS);
    for (const c of CATEGORIES) expect(v.keywordCategories[c]?.length, c).toBeGreaterThan(0);
    expect(v.keywordCategories.STATE).toEqual(expect.arrayContaining(["POSITION", "NOW", "ACCOUNT", "EXIT"]));
    for (const k of ["ACCOUNT", "COOLDOWN", "EXIT", "NOW", "POSITION", "SEQUENCE", "STREAK", "TRADES"]) expect(v.members[k]?.length, k).toBeGreaterThan(0);
    expect(v.indicators.find((i: { name: string }) => i.name === "ema")).toMatchObject({ arity: 2, variadic: false });
    expect(v.streamFields).toContain("close");
    expect(v.metaFields).toContain("tick_size");
    expect(v.seriesSelectors).toEqual(["candle", "tick"]);
  });
  it("serves qkt's TextMate grammar as JSON with a scopeName", async () => {
    const res = await app.inject({ url: "/api/qkt/grammar" });
    expect(res.statusCode).toBe(200);
    const g = res.json();
    expect(g.scopeName).toBe("source.qkt");
    expect(JSON.stringify(g)).toMatch(/support\.function\.indicator/);
  });
  it("revalidates by ETag (a 304 costs no JSON) and the ETag is shared by both documents", async () => {
    const first = await app.inject({ url: "/api/qkt/vocabulary" });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await app.inject({ url: "/api/qkt/grammar" })).headers.etag).toBe(etag);
    const again = await app.inject({ url: "/api/qkt/vocabulary", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });
  it("is read from the binary once and cached", async () => {
    expect(await qktLanguage(qktBin)).toBe(await qktLanguage(qktBin));
  });
});

describe("a qkt without these commands", () => {
  it("is refused with a message that names the command and the version needed", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "old-qkt-"));
    const fake = path.join(dir, "qkt");
    writeFileSync(fake, "#!/bin/sh\necho \"qkt: unknown subcommand '$1'\" >&2\nexit 2\n", { mode: 0o755 });
    // both commands are asked at once; whichever answers first names itself
    await expect(qktLanguage(fake)).rejects.toThrow(/`qkt (dsl vocabulary --json|editor grammar --format textmate)`, qkt 0\.54 or newer.*unknown subcommand '(dsl|editor)'/s);
    rmSync(dir, { recursive: true, force: true });
  });
});
