/**
 * A stable colour and a one-or-two-letter badge per strategy id, used everywhere a portfolio run shows more than one
 * strategy at once (the chart, the trades list, the journal): assignment is a hash of the id, so the same strategy
 * always gets the same colour across a session and across reruns, never a colour cycled by array position.
 */
const PALETTE = ["#4b8fe6", "#e66767", "#3ec76c", "#c98500", "#a370d8", "#20b2c4", "#d55181", "#8d9a3c"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function strategyColor(id: string): string {
  return PALETTE[hash(id) % PALETTE.length]!;
}

/** Up to two letters, from the alias (the part after the portfolio prefix). `trend` -> `TR`, `a` -> `A`. */
export function strategyBadge(id: string): string {
  const alias = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const words = alias.split(/[_\s-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return alias.slice(0, 2).toUpperCase();
}
