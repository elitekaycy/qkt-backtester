/** Number and time formatting. Everything is UTC, matching qkt's bar store and the studio's window semantics. */

export const DASH = "—";

/** A true minus sign (U+2212) everywhere, so signed columns align and read the same; nothing that rounds to zero keeps a sign. */
const minus = (s: string) => (/^-0(\.0*)?$/.test(s) ? s.slice(1) : s.replace(/^-/, "−"));

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return minus(n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
}

/** Signed money: +1,234.50 / -56.00 (true minus sign so columns align). */
export function fmtMoney(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (/^[0.,]*$/.test(s)) return s; // rounds to zero: no sign
  return n > 0 ? `+${s}` : `−${s}`;
}

/** Fraction -> percent. 0.0622 -> "6.22%". */
export function fmtPct(f: number | null | undefined, dp = 2): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return DASH;
  return `${minus((f * 100).toFixed(dp))}%`;
}

export function fmtRatio(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return minus(n.toFixed(dp));
}

/** Signed multiple of the risk taken: +1.25R / −0.50R (`unit` false for a bare column value). */
export function fmtR(r: number | null | undefined, dp = 2, unit = true): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return DASH;
  const s = Math.abs(r).toFixed(dp), u = unit ? "R" : "";
  return /^[0.]*$/.test(s) ? `${s}${u}` : `${r > 0 ? "+" : "−"}${s}${u}`;
}

/** 3h 25m, 2d 4h, 45s, 850ms. */
export function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(a)}ms`;
  const s = Math.floor(a / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** 2024-10-02 14:15 (UTC). */
export function fmtTs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
export function fmtDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const dp = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 10 ? 3 : 5;
  return minus(n.toFixed(dp));
}

export type Polarity = "gain" | "loss" | "flat";
export const polarity = (n: number | null | undefined): Polarity => (n === null || n === undefined || !Number.isFinite(n) || n === 0 ? "flat" : n > 0 ? "gain" : "loss");
/** Direction glyph so polarity never depends on colour alone. */
export const glyph = (n: number | null | undefined): string => (polarity(n) === "gain" ? "▲" : polarity(n) === "loss" ? "▼" : "");

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** YYYY-MM-DD shifted by whole days (UTC). */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** A run window [from, to) as the inclusive dates it covers: "Oct 1, 2024 → Dec 15, 2024" (same as the top bar). */
export function fmtWindow(from: string, to: string): string {
  const d = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${d(Date.parse(from + "T00:00:00Z"))} → ${d(Date.parse(to + "T00:00:00Z") - 86_400_000)}`;
}
