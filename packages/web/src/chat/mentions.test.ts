// packages/web/src/chat/mentions.test.ts
import { describe, it, expect } from "vitest";
import { filterMentions, insertMention, mentionOptions, mentionQuery, mentionsIn } from "./mentions.js";

const opts = mentionOptions({ strategies: ["strategies/ema_cross.qkt", "strategies/config.qkt"], runId: "r-9", selectedTrade: 12, symbols: ["XAUUSD"] });

describe("@ mentions", () => {
  it("offers the fixed references, strategies by name, the run, the selected trade and symbols; a keyword wins over a same-named file", () => {
    expect(opts.map((o) => o.label)).toEqual(["@config", "@instruments", "@chart", "@split", "@run", "@trade#12", "@ema_cross", "@XAUUSD"]);
    expect(opts.find((o) => o.label === "@ema_cross")!.ref).toBe("strategies/ema_cross.qkt");
  });
  it("finds the @word being typed at the caret, only at a word start", () => {
    expect(mentionQuery("do the same in @em", 18)).toEqual({ start: 15, query: "em" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail me@example", 15)).toBeNull();
    expect(mentionQuery("@ema then", 9)).toBeNull();
  });
  it("filters by prefix first, then substring", () => {
    expect(filterMentions(opts, "c").map((o) => o.label)).toEqual(["@config", "@chart", "@ema_cross"]);
  });
  it("inserts the chosen label with a space and puts the caret after it", () => {
    expect(insertMention("same in @em please", 8, 11, "@ema_cross")).toEqual({ text: "same in @ema_cross  please", caret: 19 });
  });
  it("collects the known mentions of a message once each, plus any @trade#N", () => {
    expect(mentionsIn("compare @ema_cross with @config, and @trade#3 and @nobody, @ema_cross again", opts)).toEqual([
      { label: "@ema_cross", ref: "strategies/ema_cross.qkt" }, { label: "@config", ref: "qkt.config.yaml" }, { label: "@trade#3", ref: "trade #3 of the run on screen" },
    ]);
  });
});
