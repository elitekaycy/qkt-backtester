import { useId, useMemo, useRef, useState } from "react";
import type { TripQuery } from "../api/types.js";
import { useStore } from "../state/store.js";
import { Popover } from "../ui/Popover.js";
import { Filter, Search, X } from "../ui/icons.js";
import { parseFilters, suggest, toChips } from "./filterQuery.js";
import { contractNames } from "../util/derivatives.js";
import { useDerivatives } from "./useDerivatives.js";
import { useAnalytics } from "./useAnalytics.js";

const H = 3_600_000;
const HOLDS: Array<[string, number | undefined, number | undefined]> = [["Any", undefined, undefined], ["< 1h", undefined, H], ["1–4h", H, 4 * H], ["4–24h", 4 * H, 24 * H], ["≥ 1d", 24 * H, undefined]];
const RS: Array<[string, number | undefined, number | undefined]> = [["Any", undefined, undefined], ["< 0R", undefined, -0.0001], ["≥ 1R", 1, undefined], ["≥ 2R", 2, undefined]];
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WD_IDX = [1, 2, 3, 4, 5, 6, 0];

function Group<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange(v: T): void }) {
  return (
    <div className="fgroup">
      <span className="label">{label}</span>
      <div className="seg sm" role="group" aria-label={label}>{options.map(([v, l]) => <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>
    </div>
  );
}

/** The same filters as buttons, for people who would rather click than type. */
function FilterPanel() {
  const f = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters);
  const held = HOLDS.findIndex(([, lo, hi]) => lo === f.minHoldMs && hi === f.maxHoldMs);
  const rIdx = RS.findIndex(([, lo, hi]) => lo === f.minR && hi === f.maxR);
  return (
    <div className="fpanel">
      <Group label="Side" value={f.side ?? "all"} options={[["all", "All"], ["long", "Long"], ["short", "Short"]]} onChange={(v) => setFilters({ side: v === "all" ? undefined : v })} />
      <Group label="Outcome" value={f.outcome ?? "all"} options={[["all", "All"], ["win", "Wins"], ["loss", "Losses"]]} onChange={(v) => setFilters({ outcome: v === "all" ? undefined : v })} />
      <Group label="Exit" value={f.exit ?? "all"} options={[["all", "All"], ["target", "Target"], ["stop", "Stop"], ["signal", "Signal"]]} onChange={(v) => setFilters({ exit: v === "all" ? undefined : v })} />
      <Group label="Risk" value={String(rIdx < 0 ? -1 : rIdx)} options={RS.map(([l], i) => [String(i), l] as [string, string])} onChange={(v) => { const r = RS[Number(v)]!; setFilters({ minR: r[1], maxR: r[2] }); }} />
      <Group label="Held" value={String(held < 0 ? -1 : held)} options={HOLDS.map(([l], i) => [String(i), l] as [string, string])} onChange={(v) => { const r = HOLDS[Number(v)]!; setFilters({ minHoldMs: r[1], maxHoldMs: r[2] }); }} />
      <Group label="Entry day" value={f.weekday === undefined ? "all" : String(f.weekday)} options={[["all", "Any"], ...WD_IDX.map((d, i) => [String(d), WD[i]!] as [string, string])]} onChange={(v) => setFilters({ weekday: v === "all" ? undefined : Number(v) })} />
      <div className="hint muted">Or type in the search box: <span className="mono">side:long exit:stop r:&gt;=1 held:&lt;1h day:2024-10-07</span></div>
    </div>
  );
}

/**
 * Filters shared by every Journal section, the trade table and the charts. One search box with completion (type `stop`, `win`,
 * `held:<1h`, a day...), every active filter as a removable chip, and a Filters panel with the same options as buttons.
 * Changing a filter changes every chart and table at once.
 */
export function FilterBar({ compact = false, count }: { compact?: boolean; count?: { shown: number; total: number; capped?: number | null } } = {}) {
  const filters = useStore((s) => s.filters), setFilters = useStore((s) => s.setFilters), clear = useStore((s) => s.clearFilters);
  const meta = useStore((s) => s.results?.meta);
  const { a, base, loading, total } = useAnalytics();
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(-1);
  const [moved, setMoved] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [panel, setPanel] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const panelBtn = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const symbols = useMemo(() => [...new Set((meta?.streams ?? []).map((s) => `${s.broker}:${s.symbol}`))], [meta]);
  const days = useMemo(() => (base ?? a)?.daily.map((d) => d.day) ?? [], [base, a]);
  const chips = toChips(filters);
  const sizes = useMemo(() => [...new Set((base ?? a)?.sizes ?? [])], [base, a]);
  const deriv = useDerivatives().data;
  const contracts = useMemo(() => contractNames(deriv), [deriv]);
  const venue = (meta?.derivatives?.length ?? 0) > 0;
  const sugg = useMemo(() => suggest(text, { symbols, days, active: filters, sizes, contracts, venue, window: meta ? { from: meta.from, to: meta.to } : undefined }), [text, symbols, days, filters, sizes, contracts, venue, meta]);
  const open = focus && sugg.length > 0;

  const apply = (line: string): boolean => {
    const r = parseFilters(line, symbols);
    if (r.errors.length) { setErrors(r.errors); }
    else setErrors([]);
    const patch = r.patch;
    if (Object.keys(patch).length) setFilters(patch);
    return r.errors.length === 0;
  };
  const accept = (i: number) => {
    const s = sugg[i]; if (!s) return;
    const words = text.replace(/\S*$/, "");
    if (s.text.endsWith(":")) { setText(words + s.text); setSel(-1); setMoved(false); return; } // a key template: keep typing its value
    apply(s.text); setText(words.trimEnd() ? words.trimEnd() + " " : ""); setSel(-1); setMoved(false);
    // keep the leftover words (anything before the completed one) so a half-typed line is not lost
    setText(words);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setMoved(true); setSel((i) => (sugg.length ? (i + 1) % sugg.length : -1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setMoved(true); setSel((i) => (sugg.length ? (i <= 0 ? sugg.length - 1 : i - 1) : -1)); }
    else if (e.key === "Tab" && open && text.trim()) { e.preventDefault(); accept(sel >= 0 ? sel : 0); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (open && (moved || (sel >= 0)) && sel >= 0) accept(sel);
      else if (text.trim()) { const words = text.trim().split(/\s+/); const last = words[words.length - 1]!; const ok = apply(text); if (ok) setText(""); else if (open && sugg[0] && !/:\S/.test(last)) accept(0); }
    }
    else if (e.key === "Backspace" && !text && chips.length) { setFilters(chips[chips.length - 1]!.clear); }
    else if (e.key === "Escape") { if (open || text) { e.stopPropagation(); e.preventDefault(); if (open) setFocus(false); else { setText(""); setErrors([]); } } }
  };
  const onChange = (v: string) => {
    setSel(-1); setMoved(false); setFocus(true);
    // a space after a complete token commits it, like a chip in a search field
    if (/\s$/.test(v) && v.trim()) { const r = parseFilters(v, symbols); if (!r.errors.length && r.tokens.length) { setFilters(r.patch); setText(""); setErrors([]); return; } }
    setText(v); if (errors.length) setErrors([]);
  };
  const active = chips.length > 0;

  return (
    <div className={`filterbar${compact ? " compact" : ""}`} role="region" aria-label="Trade filters">
      <div className={`fsearch${focus ? " focus" : ""}${errors.length ? " bad" : ""}`} onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; if (e.target !== input.current) { e.preventDefault(); input.current?.focus(); } }}>
        <Search size={15} className="ico" aria-hidden="true" />
        {chips.map((c) => (
          <span key={c.id} className="chip on" title={c.label}>
            <span className="mono">{c.text}</span>
            <button className="btn ghost icon sm" style={{ width: 18, height: 18 }} aria-label={`Remove filter ${c.text}`} onClick={() => { setFilters(c.clear); input.current?.focus(); }}><X size={12} /></button>
          </span>
        ))}
        <input ref={input} className="fin" value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
          placeholder={active ? "Add a filter…" : compact ? "Search trades: symbol, side, entry:2024-10, held:<1h, pnl:>50…" : "Search or filter: stop, win, side:long, entry:2024-10, held:<1h, size:>=1…"} spellCheck={false} autoComplete="off" role="combobox" aria-label="Search and filter trades"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && sel >= 0 ? `${listId}-${sel}` : undefined} aria-invalid={errors.length > 0} />
        {open && (
          <ul className="fsug" id={listId} role="listbox" aria-label="Filter suggestions" onMouseDown={(e) => e.preventDefault()}>
            {sugg.map((s, i) => (
              <li key={s.text} id={`${listId}-${i}`} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => { accept(i); input.current?.focus(); }}
                ref={(el) => { if (el && i === sel) el.scrollIntoView({ block: "nearest" }); }}>
                <span className="mono k">{s.text}</span><span className="lbl">{s.label}{s.hint ? <span className="muted"> · {s.hint}</span> : null}</span><span className="grp">{s.group}</span>
              </li>
            ))}
            <li className="foot" aria-hidden="true"><span className="kbd">↑</span><span className="kbd">↓</span> move <span className="kbd">Enter</span> add <span className="kbd">Tab</span> complete <span className="kbd">Esc</span> close</li>
          </ul>
        )}
      </div>
      <button ref={panelBtn} className={`btn sm${compact ? " icon-only" : ""}`} aria-label="Filters" title="Filters" aria-haspopup="dialog" aria-expanded={panel} onClick={() => setPanel(!panel)}><Filter size={14} />{!compact && "Filters"}{active && <span className="badge accent" style={{ height: 16 }}>{chips.length}</span>}</button>
      <Popover open={panel} onClose={() => setPanel(false)} anchor={panelBtn} label="Filters" width={440}><FilterPanel /></Popover>
      {active && <button className="btn ghost sm" onClick={() => { clear(); setText(""); setErrors([]); }}>Clear all</button>}
      <span className="stat" aria-live="polite">{count ? <>Showing <b className="num" style={{ color: "var(--ink)" }}>{count.shown.toLocaleString()}</b> of {count.total.toLocaleString()} trades{count.capped ? <> · the first {count.shown.toLocaleString()} of {count.capped.toLocaleString()} matches: narrow the filters to see the rest</> : null}</> : loading ? "Updating…" : a ? <>Showing <b className="num" style={{ color: "var(--ink)" }}>{a.count}</b> of {total} trades</> : ""}</span>
      {errors.length > 0 && <div className="ferr" role="alert">{errors[0]}</div>}
    </div>
  );
}
