/**
 * qkt's trading calendars, as its backtest coverage check uses them (BacktestContext.defaultCalendars, FxCalendar,
 * CryptoCalendar, NyseCalendar). A day is a trading day when the calendar has any session hour in it (UTC); qkt then
 * requires a bar file for it, and refuses a window that lacks one. The studio answers "is this window complete?" with
 * exactly this rule, so what it calls complete is what qkt runs.
 */
export type QktCalendar = "fx" | "crypto" | "nyse";

/**
 * The calendar qkt uses for a bare symbol: BTC*, ETH*, *USDT trade every day; SPX, NDX, DJI, RUT trade NYSE hours; the
 * rest the fx week. Case-sensitive, like qkt's glob rules.
 */
export function qktCalendarFor(s: string): QktCalendar {
  if (s.startsWith("BTC") || s.startsWith("ETH") || s.endsWith("USDT")) return "crypto";
  if (s === "SPX" || s === "NDX" || s === "DJI" || s === "RUT") return "nyse";
  return "fx";
}

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday

/**
 * Whether qkt expects data on a UTC day. fx: in session Sunday from 22:00 UTC to Friday 22:00 UTC, so every day but
 * Saturday has session hours (no holidays). crypto: every day. nyse: weekdays that are not NYSE holidays.
 */
export function isTradingDay(cal: QktCalendar, iso: string): boolean {
  if (cal === "crypto") return true;
  const d = dow(iso);
  if (cal === "fx") return d !== 6;
  return d !== 0 && d !== 6 && !nyseHolidays(Number(iso.slice(0, 4))).has(iso);
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Saturday -> Friday, Sunday -> Monday. */
const observed = (s: string) => (dow(s) === 6 ? addDays(s, -1) : dow(s) === 0 ? addDays(s, 1) : s);
/** The nth weekday (0 = Sunday) of a month, or the last one when n is -1. */
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  if (n > 0) { const first = dow(iso(y, m, 1)); return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7); }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(), last = dow(iso(y, m, lastDay));
  return iso(y, m, lastDay - ((last - weekday + 7) % 7));
}
/** Easter Sunday (anonymous Gregorian algorithm), the same computation as qkt's NyseCalendar. */
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
const nyseCache = new Map<number, Set<string>>();
/** NYSE full-day holidays of a year, as qkt computes them. */
export function nyseHolidays(y: number): Set<string> {
  let set = nyseCache.get(y);
  if (set) return set;
  set = new Set([
    observed(iso(y, 1, 1)), nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), addDays(easter(y), -2), nthWeekday(y, 5, 1, -1),
    ...(y >= 2022 ? [observed(iso(y, 6, 19))] : []), observed(iso(y, 7, 4)), nthWeekday(y, 9, 1, 1), nthWeekday(y, 11, 4, 4), observed(iso(y, 12, 25)),
  ]);
  nyseCache.set(y, set);
  return set;
}

const nyParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
/** Whether qkt's calendar has the session open at a UTC instant (FxCalendar, CryptoCalendar, NyseCalendar.isInSession). */
function inSession(cal: QktCalendar, t: number): boolean {
  if (cal === "crypto") return true;
  if (cal === "fx") { const d = new Date(t), w = d.getUTCDay(), h = d.getUTCHours(); return w === 6 ? false : w === 0 ? h >= 22 : w === 5 ? h < 22 : true; }
  const p = Object.fromEntries(nyParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun" || nyseHolidays(Number(p.year)).has(`${p.year}-${p.month}-${p.day}`)) return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 570 && m < 960;
}
/** The UTC hours (0-23) of a day whose start is in session, as qkt's tick check computes them. */
export function sessionHours(cal: QktCalendar, iso: string): number[] {
  const t0 = Date.parse(`${iso}T00:00:00Z`);
  return Array.from({ length: 24 }, (_, h) => h).filter((h) => inSession(cal, t0 + h * 3_600_000));
}
/**
 * qkt's verdict on one tick day (TickCompletenessValidator), given the UTC hours that hold at least one tick: a trading
 * day with no ticks is missing; otherwise every interior session hour (first and last exempt) needs a tick, with one
 * empty interior hour tolerated (the daily maintenance break).
 */
export function tickDayComplete(cal: QktCalendar, iso: string, hoursWithTicks: ReadonlySet<number>): boolean {
  const hours = sessionHours(cal, iso);
  if (!hours.length) return true;
  if (!hoursWithTicks.size) return false;
  return hours.slice(1, -1).filter((h) => !hoursWithTicks.has(h)).length <= 1;
}
