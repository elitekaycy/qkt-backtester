import { describe, it, expect } from "vitest";
import { checkSlots, MAX_CHECKS } from "../src/check.js";

describe("the shared qkt-parse limit", () => {
  it("the editor's check is refused while tools hold every slot, and a tool's check waits its turn instead", async () => {
    const gates: Array<() => void> = [];
    const hold = () => checkSlots.run(() => new Promise<void>((r) => gates.push(r)));
    const held = Array.from({ length: MAX_CHECKS }, hold);
    await new Promise((r) => setTimeout(r, 0));
    expect(checkSlots.busy).toBe(MAX_CHECKS);
    expect(checkSlots.tryRun(async () => "editor")).toBeNull();          // /api/check answers 429 here
    let waited = false;
    const queued = checkSlots.run(async () => { waited = true; return "tool"; });
    await new Promise((r) => setTimeout(r, 10));
    expect(waited).toBe(false);
    gates.shift()!();
    expect(await queued).toBe("tool");
    for (const g of gates) g();
    await Promise.all(held);
    expect(checkSlots.busy).toBe(0);
    expect(await checkSlots.tryRun(async () => "editor")).toBe("editor");
  });
});
