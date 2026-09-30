/**
 * `qkt dsl vocabulary --json`: every name the DSL knows, as the qkt the studio runs reports it. The studio keeps no list
 * of its own; lint, completions and highlighting read this document (served by the server, captured in
 * `test/fixtures/qkt-vocabulary.json` for tests; regenerate it with `qkt dsl vocabulary --json > that file`).
 */
export interface QktIndicator { name: string; arity: number; variadic: boolean; signature: string; doc: string }
export interface QktFunction { name: string; arity: number; variadic: boolean }
export interface QktConstant { name: string; value: string }

export interface QktVocabulary {
  schema: "qkt-vocabulary-v1";
  /** Every uppercase lexer keyword. */
  keywords: string[];
  /** SECTION, FLOW, ACTION, ORDER, SIZING, BRACKET, STACKING, PORTFOLIO, SESSION, HOOK, STATE (the pseudo-symbols), OPERATOR_WORD, AGGREGATE, LITERAL. */
  keywordCategories: Record<string, string[]>;
  indicators: QktIndicator[];
  functions: QktFunction[];
  constants: QktConstant[];
  /** `<alias>.<field>` on a candle or tick stream. */
  streamFields: string[];
  /** `<alias>.<field>` from the instrument (tick_size, contract_size...). */
  metaFields: string[];
  /** `<alias>.candle`, `<alias>.tick`. */
  seriesSelectors: string[];
  /** Members of the pseudo-symbols: POSITION.<alias>.<member>, ACCOUNT.<member>, NOW.<member>... */
  members: Record<string, string[]>;
  shorthands: string[];
}

export const VOCABULARY_SCHEMA = "qkt-vocabulary-v1";
const LIST_KEYS = ["keywords", "indicators", "functions", "constants", "streamFields", "metaFields", "seriesSelectors", "shorthands"] as const;

/** Validate a vocabulary document; the error names what is wrong so an old or foreign qkt is recognised at once. */
export function parseVocabulary(doc: unknown): QktVocabulary {
  if (!doc || typeof doc !== "object") throw new Error("qkt vocabulary: not a JSON object");
  const v = doc as Record<string, unknown>;
  if (v.schema !== VOCABULARY_SCHEMA) throw new Error(`qkt vocabulary: schema '${String(v.schema)}' is not ${VOCABULARY_SCHEMA}`);
  for (const k of LIST_KEYS) if (!Array.isArray(v[k]) || v[k].length === 0) throw new Error(`qkt vocabulary: '${k}' is missing or empty`);
  for (const k of ["keywordCategories", "members"]) {
    const o = v[k];
    if (!o || typeof o !== "object" || Object.values(o).some((x) => !Array.isArray(x))) throw new Error(`qkt vocabulary: '${k}' is missing or not lists by name`);
  }
  return v as unknown as QktVocabulary;
}

/** Everything that may follow `<alias>.` on a stream: candle/tick fields plus the instrument's meta fields. */
export const streamFieldSet = (v: QktVocabulary): Set<string> => new Set([...v.streamFields, ...v.metaFields]);

/** The keywords of one category (`ACTION`, `STATE`...); an unknown category is empty. */
export const keywordsIn = (v: QktVocabulary, category: string): string[] => v.keywordCategories[category] ?? [];

/**
 * Indicators that stay on their input's price scale: the moving averages of a value. Read off the vocabulary's own
 * docs and signatures (a "moving average" of a `value`) rather than kept as a list, so a new average in qkt joins
 * without a studio change and one qkt does not have is never named.
 */
export function priceScaleIndicators(v: QktVocabulary): Set<string> {
  return new Set(v.indicators.filter((i) => /moving average/i.test(i.doc) && /^\w+\(value\b/.test(i.signature)).map((i) => i.name));
}
