import { promises as fs } from "node:fs";
import path from "node:path";

export class JailError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** Nearest existing ancestor of p (p itself if it exists). */
async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  for (;;) {
    try { await fs.lstat(cur); return cur; } catch { /* keep walking up */ }
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

/**
 * Resolve a user-supplied relative path inside `root`, or throw JailError. Rejects NUL bytes, absolute paths,
 * `..` escapes (lexical) and symlink escapes (the real path of the target, or of its nearest existing ancestor
 * when it does not exist yet, must stay inside the real root).
 */
export async function resolveInJail(root: string, rel: string): Promise<string> {
  if (typeof rel !== "string") throw new JailError("path must be a string");
  if (rel.includes("\0")) throw new JailError("invalid path");
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) throw new JailError("absolute paths are not allowed");
  const realRoot = await fs.realpath(root);
  const lexical = path.resolve(realRoot, rel);
  if (!within(realRoot, lexical)) throw new JailError("path escapes the workspace", 403);
  const anchor = await nearestExisting(lexical);
  let realAnchor: string;
  try { realAnchor = await fs.realpath(anchor); }
  catch { throw new JailError("path is a dangling symlink or unreadable", 403); }
  if (!within(realRoot, realAnchor)) throw new JailError("path escapes the workspace (symlink)", 403);
  return lexical;
}

export const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");
