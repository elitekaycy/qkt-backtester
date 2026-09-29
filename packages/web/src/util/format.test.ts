import { describe, it, expect } from "vitest";
import { fmtNum, fmtMoney, fmtPct, fmtR, fmtRatio, fmtDur, fmtTs, fmtPrice, polarity, glyph, addDays, daysBetween, fmtBytes, DASH } from "./format.js";

describe("format", () => {
  it("fmtNum groups thousands and shows a dash for missing values", () => {
    expect(fmtNum(1234567.891)).toBe("1,234,567.89");
    expect(fmtNum(0, 0)).toBe("0");
    for (const v of [null, undefined, NaN, Infinity]) expect(fmtNum(v as number)).toBe(DASH);
  });
  it("fmtMoney is always signed with a true minus", () => {
    expect(fmtMoney(1234.5)).toBe("+1,234.50");
    expect(fmtMoney(-56)).toBe("−56.00");
    expect(fmtMoney(0)).toBe("0.00");
    expect(fmtMoney(null)).toBe(DASH);
  });
  it("fmtPct converts fractions", () => {
    expect(fmtPct(0.06220635)).toBe("6.22%");
    expect(fmtPct(-0.5, 0)).toBe("−50%");
    expect(fmtPct(undefined)).toBe(DASH);
  });
  it("fmtDur picks the two most useful units", () => {
    expect(fmtDur(850)).toBe("850ms");
    expect(fmtDur(45_000)).toBe("45s");
    expect(fmtDur(3_600_000 * 3 + 25 * 60_000)).toBe("3h 25m");
    expect(fmtDur(60_000)).toBe("1m");
    expect(fmtDur(86_400_000 * 2 + 4 * 3_600_000)).toBe("2d 4h");
    expect(fmtDur(null)).toBe(DASH);
  });
  it("fmtTs is UTC", () => {
    expect(fmtTs(Date.UTC(2024, 9, 2, 14, 15, 59))).toBe("2024-10-02 14:15");
    expect(fmtTs(0)).toBe("1970-01-01 00:00");
  });
  it("fmtPrice scales precision with magnitude", () => {
    expect(fmtPrice(2662.3755)).toBe("2662.38");
    expect(fmtPrice(85.12345)).toBe("85.123");
    expect(fmtPrice(1.08342)).toBe("1.08342");
  });
  it("polarity and glyph never rely on colour alone", () => {
    expect([polarity(3), polarity(-3), polarity(0), polarity(null)]).toEqual(["gain", "loss", "flat", "flat"]);
    expect([glyph(3), glyph(-3), glyph(0)]).toEqual(["▲", "▼", ""]);
  });
  it("date arithmetic uses whole UTC days", () => {
    expect(addDays("2024-10-31", 1)).toBe("2024-11-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(daysBetween("2024-10-01", "2024-10-31")).toBe(30);
  });
  it("fmtBytes", () => { expect(fmtBytes(512)).toBe("512 B"); expect(fmtBytes(1536)).toBe("1.5 kB"); expect(fmtBytes(5 * 1024 ** 2)).toBe("5.0 MB"); });
  it("every signed number uses a true minus, and nothing that rounds to zero keeps a sign", () => {
    expect(fmtNum(-1234.5)).toBe("−1,234.50");
    expect(fmtPct(-0.0525)).toBe("−5.25%");
    expect(fmtRatio(-0.5)).toBe("−0.50");
    expect(fmtMoney(-0.001)).toBe("0.00");
    expect(fmtMoney(0.004)).toBe("0.00");
    expect(fmtNum(-0.001)).toBe("0.00");
    expect(fmtPct(-0.00001)).toBe("0.00%");
    expect(fmtRatio(-0.001)).toBe("0.00");
  });
  it("fmtR signs multiples of risk", () => {
    expect(fmtR(1.254)).toBe("+1.25R");
    expect(fmtR(-0.5, 1)).toBe("−0.5R");
    expect(fmtR(-0.001)).toBe("0.00R");
    expect(fmtR(2, 2, false)).toBe("+2.00");
    expect(fmtR(undefined)).toBe(DASH);
  });
});
