import { describe, it, expect } from "vitest";
import { strategyBadge, strategyColor } from "./strategyColor.js";

describe("strategyColor", () => {
  it("is stable for the same id and a real hex colour", () => {
    expect(strategyColor("book:trend")).toBe(strategyColor("book:trend"));
    expect(strategyColor("book:trend")).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it("usually differs between two different ids", () => {
    expect(strategyColor("book:trend")).not.toBe(strategyColor("book:fade"));
  });
});

describe("strategyBadge", () => {
  it("strips the portfolio prefix and uses the alias", () => {
    expect(strategyBadge("book:trend")).toBe("TR");
    expect(strategyBadge("solo")).toBe("SO");
  });
  it("takes initials from a two-word alias", () => {
    expect(strategyBadge("book:xau_fade")).toBe("XF");
  });
});
