import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { keywordsIn, parseVocabulary, priceScaleIndicators, streamFieldSet, VOCABULARY_SCHEMA } from "../src/vocabulary.js";

const doc = JSON.parse(readFileSync(new URL("./fixtures/qkt-vocabulary.json", import.meta.url), "utf8"));

describe("the captured qkt vocabulary", () => {
  it("is the qkt-vocabulary-v1 document, keys in qkt's order", () => {
    expect(Object.keys(doc)).toEqual(["schema", "keywords", "keywordCategories", "indicators", "functions", "constants", "streamFields", "metaFields", "seriesSelectors", "members", "shorthands"]);
    const v = parseVocabulary(doc);
    expect(v.schema).toBe(VOCABULARY_SCHEMA);
    expect(keywordsIn(v, "STATE")).toEqual(expect.arrayContaining(["POSITION", "NOW", "ACCOUNT"]));
    expect(keywordsIn(v, "ACTION")).toContain("BUY");
    expect(v.members.POSITION).toContain("mfe");
    expect(streamFieldSet(v).has("close")).toBe(true);
    expect(streamFieldSet(v).has("tick_size")).toBe(true);
  });
  it("derives the price-scale averages from the indicator docs", () => {
    const avg = priceScaleIndicators(parseVocabulary(doc));
    expect([...avg].sort()).toEqual(["dema", "ema", "hma", "sma", "tema", "wma"]);
  });
  it("refuses another schema or a document with a list missing", () => {
    expect(() => parseVocabulary({ ...doc, schema: "qkt-vocabulary-v0" })).toThrow(/schema/);
    expect(() => parseVocabulary({ ...doc, indicators: [] })).toThrow(/indicators/);
    expect(() => parseVocabulary("nope")).toThrow(/JSON object/);
  });
});
