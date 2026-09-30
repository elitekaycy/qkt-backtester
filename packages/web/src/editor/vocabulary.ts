import { keywordsIn, streamFieldSet, type QktVocabulary } from "@qkt-studio/core/vocabulary";

/**
 * The vocabulary of the qkt the studio runs (`GET /api/qkt/vocabulary`), loaded by setupMonaco before any editor exists.
 * Completions and the local lint read it from here; nothing in the web app names a keyword, field or member on its own.
 */
let current: QktVocabulary | null = null;

export function setVocabulary(v: QktVocabulary): void { current = v; }

export function vocabulary(): QktVocabulary {
  if (!current) throw new Error("qkt vocabulary not loaded: setupMonaco() has not run");
  return current;
}

/** `<alias>.<field>`: candle/tick fields first, then the instrument's meta fields, in qkt's order. */
export const streamFields = (): string[] => [...streamFieldSet(vocabulary())];
export const actionKeywords = (): string[] => keywordsIn(vocabulary(), "ACTION");
export const membersOf = (pseudo: string): string[] => vocabulary().members[pseudo] ?? [];
