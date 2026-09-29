import { createHash } from "node:crypto";

/**
 * Strategy sources `qkt parse` has already accepted, by content hash: the live check parses every edit, so the run that
 * follows a save does not need a second JVM to parse the very same text. Files with IMPORTs are never cached (an imported
 * file can change on its own). Bounded; a restart simply parses again.
 */
const MAX = 500;
const parsed = new Map<string, true>();
const key = (content: string) => createHash("sha256").update(content).digest("hex");
const cacheable = (content: string) => !/^\s*IMPORT\b/m.test(content);

export function rememberParsed(content: string): void {
  if (!cacheable(content)) return;
  const k = key(content);
  parsed.delete(k); parsed.set(k, true);
  if (parsed.size > MAX) parsed.delete(parsed.keys().next().value as string);
}
export function knownParsed(content: string): boolean { return cacheable(content) && parsed.has(key(content)); }
