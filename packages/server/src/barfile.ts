import { promises as fs } from "node:fs";

const COLUMNS = 6;      // startTs, open, high, low, close, volume
const BYTES = 8;        // int64 per value

/**
 * Bar count of a qkt bar day file, or null when the file is unreadable, not a bar file, or TRUNCATED. The header holds the
 * count, so the file size must equal header + count x 6 columns x 8 bytes; a shorter file is what an interrupted build leaves.
 */
export async function barCountOf(file: string): Promise<number | null> {
  let fh;
  try { fh = await fs.open(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await fh.read(buf, 0, 256, 0);
    if (bytesRead < 28 || buf.toString("latin1", 0, 4) !== "QKB1") return null;
    const symLen = buf.readInt32LE(20);
    const at = 24 + symLen;
    if (symLen < 0 || at + 4 > bytesRead) return null;
    const n = buf.readInt32LE(at);
    const size = (await fh.stat()).size;
    return n >= 0 && size === at + 4 + n * COLUMNS * BYTES ? n : null;
  } finally { await fh.close(); }
}
