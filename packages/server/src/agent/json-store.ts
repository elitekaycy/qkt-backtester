import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * A small JSON file, written by at most one writer at a time. Concurrent `write()` calls queue onto one promise
 * chain instead of racing a shared tmp path; each write serializes the value only when its turn comes, so it always
 * captures whatever the in-memory state is by then (pass a thunk, not a snapshot). One write throwing rejects only
 * its own caller — the chain recovers and later writes still run.
 */
export class JsonFile<T> {
  private chain: Promise<void> = Promise.resolve();
  private n = 0;
  constructor(private file: string) {}

  async read(fallback: T): Promise<T> {
    try { return JSON.parse(await fs.readFile(this.file, "utf8")) as T; } catch { return fallback; }
  }

  write(value: () => T): Promise<void> {
    const result = this.chain.then(() => this.writeNow(value));
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async writeNow(value: () => T): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${this.n++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value()));
    await fs.rename(tmp, this.file);
  }
}
