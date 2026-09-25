import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeBarDay } from "@qkt-studio/core";

export const validBarFile = (buf: Buffer): boolean => { try { decodeBarDay(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); return true; } catch { return false; } };
export const validGzip = (buf: Buffer): boolean => { try { gunzipSync(buf); return true; } catch { return false; } };

/**
 * After an interrupted build or fetch, remove the files it may have left half-written. Only files modified since the job
 * started are examined, and only ones that fail validation are deleted: a file that decodes cleanly is complete data and
 * stays. Returns the names removed.
 */
export async function cleanupPartialFiles(dir: string, sinceMs: number, pattern: RegExp, validate: (buf: Buffer) => boolean): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    const st = await fs.stat(file).catch(() => null);
    if (!st || !st.isFile() || st.mtimeMs < sinceMs - 2000) continue;
    const ok = validate(await fs.readFile(file).catch(() => Buffer.alloc(0)));
    if (!ok) { await fs.rm(file, { force: true }); removed.push(name); }
  }
  return removed;
}
