import { describe, it, expect } from "vitest";
import { isTradingDay, nyseHolidays, qktCalendarFor } from "../src/calendars.js";

describe("qkt's trading calendars", () => {
  it("assigns calendars by symbol the way qkt's defaultCalendars does", () => {
    expect(["BTCUSD", "ETHUSD", "BTCF", "SOLUSDT"].map(qktCalendarFor)).toEqual(["crypto", "crypto", "crypto", "crypto"]);
    expect(["SPX", "NDX", "DJI", "RUT"].map(qktCalendarFor)).toEqual(["nyse", "nyse", "nyse", "nyse"]);
    expect(["XAUUSD", "EURUSD", "XAGUSD", "CL", "ES", "NQ", "DX"].map(qktCalendarFor)).toEqual(["fx", "fx", "fx", "fx", "fx", "fx", "fx"]);
  });
  it("fx expects Sunday (session from 22:00 UTC) through Friday, with no holidays", () => {
    expect(isTradingDay("fx", "2022-04-15")).toBe(true);   // Good Friday: qkt still expects data
    expect(isTradingDay("fx", "2022-04-16")).toBe(false);  // Saturday
    expect(isTradingDay("fx", "2022-04-17")).toBe(true);   // Sunday evening session
    expect(isTradingDay("fx", "2024-12-25")).toBe(true);
  });
  it("crypto expects every day", () => {
    expect(isTradingDay("crypto", "2019-02-23")).toBe(true);
  });
  it("nyse holidays match qkt's NyseCalendar", () => {
    expect([...nyseHolidays(2024)].sort()).toEqual(["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"]);
    // Jan 1 2022 was a Saturday. qkt computes the observed day (Fri 2021-12-31) into 2022's set but looks a date up in its
    // own year's set, so it still expects data on 2021-12-31. The port keeps that behaviour.
    expect(isTradingDay("nyse", "2021-12-31")).toBe(true);
    expect(isTradingDay("nyse", "2023-04-07")).toBe(false);    // Good Friday 2023
    expect(isTradingDay("nyse", "2023-04-10")).toBe(true);
  });
});

import { sessionHours, tickDayComplete } from "../src/calendars.js";
describe("qkt's session hours and tick-day check", () => {
  it("fx: Sunday 22-23, Friday 0-21, weekdays all day, Saturday none", () => {
    expect(sessionHours("fx", "2024-03-10")).toEqual([22, 23]);
    expect(sessionHours("fx", "2024-03-15")).toHaveLength(22);
    expect(sessionHours("fx", "2024-03-16")).toEqual([]);
  });
  it("nyse: 13:30-20:00 UTC in summer (hours 14-19 start in session), 14:30-21:00 in winter", () => {
    expect(sessionHours("nyse", "2024-07-10")).toEqual([14, 15, 16, 17, 18, 19]);
    expect(sessionHours("nyse", "2024-01-10")).toEqual([15, 16, 17, 18, 19, 20]);
    expect(sessionHours("nyse", "2024-03-29")).toEqual([]); // Good Friday
  });
  it("one tick per day fails qkt's hourly check; one empty interior hour is tolerated", () => {
    expect(tickDayComplete("fx", "2019-03-05", new Set([0]))).toBe(false);
    const all = new Set(Array.from({ length: 24 }, (_, h) => h));
    all.delete(21);
    expect(tickDayComplete("fx", "2019-03-05", all)).toBe(true);
    all.delete(10);
    expect(tickDayComplete("fx", "2019-03-05", all)).toBe(false);
    expect(tickDayComplete("fx", "2024-03-10", new Set([22]))).toBe(true); // Sunday: 22 and 23 are both boundary hours
    expect(tickDayComplete("fx", "2024-03-16", new Set())).toBe(true);     // Saturday: nothing expected
  });
});
