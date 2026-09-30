import { createHash } from "node:crypto";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import { parseVocabulary, type QktVocabulary } from "@qkt-studio/core";
import { execQkt } from "./proc.js";

/**
 * What the qkt binary says about its own language: the vocabulary (`qkt dsl vocabulary --json`) and the TextMate
 * grammar (`qkt editor grammar --format textmate`). Read once per binary and kept for the life of the process, so the
 * studio's lint, completions and highlighting always describe the qkt that will run the strategy.
 */
export interface QktLanguage {
  vocabulary: QktVocabulary;
  vocabularyJson: string;
  grammarJson: string;
  /** Strong ETag over both documents: changes only with the binary. */
  etag: string;
}

const cache = new Map<string, Promise<QktLanguage>>();

/** The language of `qktBin`, loaded on first use. A binary without these commands fails with a message that says so. */
export function qktLanguage(qktBin: string): Promise<QktLanguage> {
  let p = cache.get(qktBin);
  if (!p) {
    p = load(qktBin);
    p.catch(() => cache.delete(qktBin));
    cache.set(qktBin, p);
  }
  return p;
}

async function load(bin: string): Promise<QktLanguage> {
  const ask = async (args: string[], what: string): Promise<string> => {
    const r = await execQkt(bin, args, { cwd: os.tmpdir(), timeoutMs: 60_000 }).catch((e: Error) => ({ code: null, stdout: "", stderr: e.message }));
    if (r.code !== 0) {
      const said = (r.stderr || r.stdout).trim().split("\n")[0] || `exit code ${r.code}`;
      throw new Error(`qkt-backtester needs a qkt that can print its ${what} (\`qkt ${args.join(" ")}\`, qkt 0.54 or newer). ${bin} answered: ${said}`);
    }
    return r.stdout;
  };
  const [vocabularyJson, grammarJson] = await Promise.all([
    ask(["dsl", "vocabulary", "--json"], "DSL vocabulary"),
    ask(["editor", "grammar", "--format", "textmate"], "TextMate grammar"),
  ]);
  let vocabulary: QktVocabulary;
  try { vocabulary = parseVocabulary(JSON.parse(vocabularyJson)); }
  catch (e) { throw new Error(`${bin}: \`qkt dsl vocabulary --json\` printed something the studio cannot use: ${(e as Error).message}`); }
  let grammar: unknown;
  try { grammar = JSON.parse(grammarJson); } catch { throw new Error(`${bin}: \`qkt editor grammar --format textmate\` did not print JSON`); }
  if (!grammar || typeof grammar !== "object" || typeof (grammar as { scopeName?: unknown }).scopeName !== "string") throw new Error(`${bin}: the TextMate grammar has no scopeName`);
  const etag = `"${createHash("sha256").update(vocabularyJson).update(grammarJson).digest("hex").slice(0, 32)}"`;
  return { vocabulary, vocabularyJson, grammarJson, etag };
}

/** `GET /api/qkt/vocabulary` and `GET /api/qkt/grammar`: the documents as qkt printed them, revalidated by ETag. */
export function registerQktLangRoutes(app: FastifyInstance, lang: QktLanguage): void {
  const serve = (path: string, body: () => string) => app.get(path, async (req, reply) => {
    reply.header("ETag", lang.etag).header("Cache-Control", "private, no-cache");
    if (req.headers["if-none-match"] === lang.etag) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(body());
  });
  serve("/api/qkt/vocabulary", () => lang.vocabularyJson);
  serve("/api/qkt/grammar", () => lang.grammarJson);
}
