import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * A small JSON file, written by at most one writer at a time. Concurrent `write()` / `update()` calls queue onto one
 * promise chain instead of racing a shared tmp path; each write serializes the value only when its turn comes, so it
 * always captures whatever the in-memory state is by then (pass a thunk, not a snapshot). Writes are atomic (tmp +
 * rename), so a reader never sees half a file. One write throwing rejects only its own caller — the chain recovers and
 * later writes still run.
 */
export class JsonFile<T> {
  private chain: Promise<void> = Promise.resolve();
  private n = 0;
  constructor(private file: string, private indent?: number) {}

  /**
   * The file's value, or `fallback` when it does not exist. A file that exists but does not parse is moved aside to
   * `<file>.corrupt-<ms>` first, so the next write cannot overwrite what it held.
   */
  async read(fallback: T): Promise<T> {
    let text: string;
    try { text = await fs.readFile(this.file, "utf8"); }
    catch { return fallback; }
    try { return JSON.parse(text) as T; }
    catch {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      await fs.rename(this.file, aside).catch(() => undefined);
      console.error(`${this.file} was not valid JSON: kept as ${path.basename(aside)}, starting empty`);
      return fallback;
    }
  }

  write(value: () => T): Promise<void> {
    return this.enqueue(() => this.writeNow(value));
  }

  /** Read-modify-write as one step of the chain: no other write of this file can land between the read and the write. */
  update(fallback: T, change: (current: T) => T): Promise<T> {
    return this.enqueue(async () => {
      const next = change(await this.read(fallback));
      await this.writeNow(() => next);
      return next;
    });
  }

  private enqueue<R>(step: () => Promise<R>): Promise<R> {
    const result = this.chain.then(step);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async writeNow(value: () => T): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${this.n++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value(), null, this.indent));
    await fs.rename(tmp, this.file);
  }
}
